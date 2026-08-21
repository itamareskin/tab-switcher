/**
 * Service worker: owns tab state, the keyboard commands, and thumbnail capture.
 *
 * The switcher is driven from here. The worker keeps tabs ordered most-recently-used,
 * and on Ctrl+Q it messages the *current tab's* content script to draw the overlay.
 * The overlay lives in the page rather than in an extension window because Chrome
 * gives extensions no way to draw a floating window over the viewport.
 *
 * That indirection is the source of most of the complexity below: the current tab may
 * be a page where content scripts cannot run (chrome://, the Web Store, an error page),
 * in which case we have to switch to a tab that can host the overlay first.
 */

/**
 * Modifier names as they appear in a shortcut string, mapped to the flag a
 * KeyboardEvent carries.
 *
 * `Ctrl` is deliberately absent: it means Command on macOS and Control everywhere
 * else, so it is resolved per-platform in parseShortcut(). `MacCtrl` is how a manifest
 * asks for the physical Control key on a Mac. The macOS display glyphs are unambiguous
 * and map directly.
 */
const SHORTCUT_MODIFIERS = {
  Control: "ctrl",
  MacCtrl: "ctrl",
  Alt: "alt",
  Option: "alt",
  Shift: "shift",
  Command: "meta",
  Meta: "meta",
  Win: "meta",
  Search: "meta",
  "⊞": "meta",
  "⌃": "ctrl",
  "⌥": "alt",
  "⇧": "shift",
  "⌘": "meta",
};

/** Non-alphanumeric shortcut key names, mapped to their KeyboardEvent.code. */
const SHORTCUT_CODES = {
  Comma: "Comma",
  Period: "Period",
  Space: "Space",
  Home: "Home",
  End: "End",
  Insert: "Insert",
  Delete: "Delete",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

/** KeyboardEvent.key for each modifier flag, for the hold-to-cycle release test. */
const MODIFIER_EVENT_KEYS = { meta: "Meta", ctrl: "Control", alt: "Alt" };

/** Internal pages we ship a recognisable icon for; anything else falls back to "unknown". */
const KNOWN_INTERNAL_PAGES = new Set([
  "newtab",
  "extensions",
  "history",
  "settings",
  "downloads",
  "bookmarks",
]);

/** chrome://, edge://, brave://… — capture group 2 is the host, e.g. "settings". */
const INTERNAL_URL = /^(chrome|edge|brave|opera|vivaldi):\/\/([^/]+)/i;

const DEFAULT_PREFS = {
  shortcut: "Ctrl+Q",
  color: "blue",
  layout: "overlays",
  tabCount: 6,
};

/**
 * We keep more thumbnails than the overlay shows, so cycling past the visible
 * window still has images ready.
 */
const THUMBNAIL_OVERSCAN = 1.5;

/**
 * How long the content script's "overlay is open" flag is trusted.
 *
 * The flag is set by the overlay and cleared when it closes, but a page torn down
 * mid-overlay (navigation, discard) never runs the clear. Without an expiry that
 * would disable thumbnail capture for the rest of the browser session.
 */
const OVERLAY_FLAG_TTL_MS = 15_000;

// ---------------------------------------------------------------------------
// Tab classification
// ---------------------------------------------------------------------------

/**
 * Decide how a tab should be represented, and — more importantly — whether it can
 * host the overlay at all. Only "normal" tabs can: Chrome forbids content scripts
 * on its internal pages and on the Web Store.
 *
 * @returns {"normal"|"unknown"|`chrome.${string}`}
 */
function classifyTab(tab) {
  const url = tab.url ?? tab.pendingUrl ?? "";

  // Explicitly excluded by Chrome, and not matched by the INTERNAL_URL pattern below
  // because they are ordinary https:// URLs.
  if (
    url.startsWith("https://chromewebstore.google.com/") ||
    url.startsWith("https://chrome.google.com/webstore")
  ) {
    return "unknown";
  }

  const internal = url.match(INTERNAL_URL);
  if (internal) {
    const page = internal[2].toLowerCase();
    return KNOWN_INTERNAL_PAGES.has(page) ? `chrome.${page}` : "unknown";
  }

  return /^(https?|file|ftp):/.test(url) ? "normal" : "unknown";
}

/**
 * True when the tab's main frame failed to load. Content scripts do not run on
 * Chrome's error pages, so the overlay has to go somewhere else.
 *
 * This is the only use of the webNavigation permission.
 */
async function isErrorPage(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  return (
    !frames?.[0] ||
    (frames[0].frameType === "outermost_frame" && frames[0].errorOccurred)
  );
}

// ---------------------------------------------------------------------------
// Preferences and shortcuts
// ---------------------------------------------------------------------------

/** The shortcut the user has actually bound, which may differ from our suggestion. */
async function getShortcut() {
  const commands = await chrome.commands.getAll();
  return commands.find((command) => command.name === "next-tab")?.shortcut;
}

/** KeyboardEvent.code for a shortcut's key, or null if it has no in-page equivalent. */
function shortcutKeyToCode(key) {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return SHORTCUT_CODES[key] ?? null;
}

/**
 * Turn a shortcut string into a matcher that a keydown can be tested against.
 *
 * The key is reduced to a KeyboardEvent.code — a physical key *position* rather than
 * the character it produces. That is the point: `code` is "KeyQ" for the Q key whatever
 * the active input language types with it.
 *
 * @returns {{code: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean}|null}
 */
function parseShortcut(shortcut, isMac) {
  if (!shortcut) return null;

  // "Ctrl+Q" -> ["Ctrl","Q"], but macOS reports glyph runs like "⌃Q" with no separator.
  const parts = shortcut.includes("+")
    ? shortcut.split("+").map((part) => part.trim())
    : [...shortcut];

  // Media keys and anything unrecognised have no keydown equivalent — no fallback there.
  const code = shortcutKeyToCode(parts.pop() ?? "");
  if (!code) return null;

  const matcher = { code, ctrl: false, alt: false, shift: false, meta: false };
  for (const part of parts) {
    const flag = part === "Ctrl" ? (isMac ? "meta" : "ctrl") : SHORTCUT_MODIFIERS[part];
    if (!flag) return null;
    matcher[flag] = true;
  }

  // Shift alone would fire while typing.
  if (!matcher.ctrl && !matcher.alt && !matcher.meta) return null;

  return matcher;
}

/**
 * Matchers for both commands: what is actually bound, falling back to what the manifest
 * suggested.
 *
 * The fallback earns its place — Chrome silently drops a suggested shortcut that another
 * extension already claims, leaving the command bound to nothing at all.
 */
async function buildHotkeys() {
  const [{ os }, commands] = await Promise.all([
    chrome.runtime.getPlatformInfo(),
    chrome.commands.getAll(),
  ]);
  const isMac = os === "mac";
  const declared = chrome.runtime.getManifest().commands ?? {};

  const forCommand = (name) => {
    const bound = commands.find((command) => command.name === name)?.shortcut;
    const suggested = declared[name]?.suggested_key ?? {};
    return (
      parseShortcut(bound, isMac) ??
      parseShortcut(isMac ? (suggested.mac ?? suggested.default) : suggested.default, isMac)
    );
  };

  return { "next-tab": forCommand("next-tab"), "prev-tab": forCommand("prev-tab") };
}

/**
 * Publish the matchers where content scripts can read them.
 *
 * Session storage rather than a message: a content script reads it directly without
 * waking this worker, and chrome.storage.onChanged pushes later edits to every open tab.
 * Chrome fires no event when a shortcut is rebound, so this is refreshed at startup and
 * whenever the popup is opened.
 */
async function publishHotkeys() {
  return chrome.storage.session.set({ hotkeys: await buildHotkeys() });
}

/**
 * The modifier the user must keep held for the switcher to stay open. Derived from the
 * bound shortcut, so rebinding to e.g. Alt+E keeps the hold-to-cycle behaviour.
 */
async function getModifierKey() {
  const next = (await buildHotkeys())["next-tab"];
  if (!next) return null;

  const flag = ["meta", "ctrl", "alt"].find((name) => next[name]);
  return MODIFIER_EVENT_KEYS[flag] ?? null;
}

async function getPrefs() {
  const stored = await chrome.storage.sync.get(["color", "layout", "tabCount"]);
  const shortcut = await getShortcut();

  return {
    // `||`, not `??`: an unassigned command is reported as "", not null.
    shortcut: shortcut || DEFAULT_PREFS.shortcut,
    color: stored.color ?? DEFAULT_PREFS.color,
    layout: stored.layout ?? DEFAULT_PREFS.layout,
    tabCount: stored.tabCount ?? DEFAULT_PREFS.tabCount,
  };
}

// ---------------------------------------------------------------------------
// Tab list
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function activateTab(tabId) {
  return chrome.tabs.update(tabId, { active: true });
}

/**
 * Tabs of the current window in most-recently-used order, trimmed and reduced to
 * just what the overlay needs to draw.
 */
async function buildTabList() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const { tabCount } = await getPrefs();

  tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));

  // Several identical "New Tab" entries are noise in a switcher — keep the most
  // recent one only. Everything else stays, duplicates included.
  let seenNewTab = false;
  const deduped = tabs.filter((tab) => {
    if (classifyTab(tab) !== "chrome.newtab") return true;
    if (seenNewTab) return false;
    seenNewTab = true;
    return true;
  });

  deduped.length = Math.min(deduped.length, Math.round(tabCount * THUMBNAIL_OVERSCAN));

  return deduped.map((tab) => ({
    id: tab.id,
    title: tab.title ?? tab.url ?? tab.pendingUrl,
    favIconUrl: tab.favIconUrl,
    url: tab.url,
    type: classifyTab(tab),
    isPinned: tab.pinned,
  }));
}

// ---------------------------------------------------------------------------
// Thumbnails
//
// PRIVACY: captureScreenshot() photographs whatever is on screen — including pages
// you are logged into. Images stay in chrome.storage.session, which is in-memory,
// dropped when the browser closes, and never synced. Nothing here touches the network.
// This is the single capture path; gate or delete it and the feature is gone.
// ---------------------------------------------------------------------------

/**
 * Read the session-storage bucket for a window. Keyed by window id so two windows
 * do not show each other's thumbnails.
 *
 * The window id is always passed explicitly. Resolving it here via
 * chrome.windows.getCurrent() would return the *focused* window, which is not
 * necessarily the window the tab being captured belongs to.
 *
 * @returns {[string, {thumbnails: Array<{tabId: number, thumbnail: string}>}|undefined]}
 */
async function getWindowBucket(windowId) {
  const key = windowId.toString();
  const stored = await chrome.storage.session.get(key);
  return [key, stored[key]];
}

/** Quality 10 JPEG: these are 140px-wide previews, so the loss is invisible and the bytes matter. */
async function captureScreenshot(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 10,
    });
  } catch (error) {
    // Expected on chrome:// pages and whenever the tab is not renderable yet.
    console.warn("Failed to capture screenshot", error);
    return undefined;
  }
}

/** Store a thumbnail, most-recent-first, evicting the oldest past the overscan limit. */
async function setThumbnail(tabId, dataUrl, windowId) {
  const [key, bucket] = await getWindowBucket(windowId);
  const { tabCount } = await getPrefs();

  const thumbnails = bucket?.thumbnails ?? [];
  const existing = thumbnails.findIndex((entry) => entry.tabId === tabId);
  if (existing !== -1) thumbnails.splice(existing, 1);
  thumbnails.unshift({ tabId, thumbnail: dataUrl });

  thumbnails.length = Math.min(
    thumbnails.length,
    Math.round(tabCount * THUMBNAIL_OVERSCAN),
  );

  return chrome.storage.session.set({ [key]: { thumbnails } });
}

/**
 * Whether an overlay is currently on screen anywhere.
 *
 * Treated as closed once the flag goes stale — see OVERLAY_FLAG_TTL_MS. Erring
 * towards "closed" costs at most one screenshot of the switcher; erring the other
 * way silently kills thumbnail capture until the browser restarts.
 */
async function isOverlayOpen() {
  const { isOverlayOpen: flag } = await chrome.storage.session.get("isOverlayOpen");
  if (!flag?.open) return false;
  return Date.now() - (flag.at ?? 0) < OVERLAY_FLAG_TTL_MS;
}

/**
 * Capture the given tab, but only if it is genuinely what the user is looking at and
 * the overlay is not up — otherwise we would photograph the switcher itself.
 *
 * The "is it active" test is a live query rather than tracked module state: an MV3
 * service worker is terminated after roughly 30s idle, so anything held in a module
 * variable is gone by the next event.
 */
async function captureThumbnailFor(tabId, windowId) {
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (active?.id !== tabId) return;

  if (await isOverlayOpen()) return;

  const screenshot = await captureScreenshot(windowId);
  if (screenshot) await setThumbnail(tabId, screenshot, windowId);
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

/** First item matching an async predicate, evaluated in order. */
async function findAsync(items, predicate) {
  for (const item of items) {
    if (await predicate(item)) return item;
  }
  return undefined;
}

async function sendOpenOverlay(tabId, tabs, command, fromCurrentTab) {
  const [modifierKey, window, prefs] = await Promise.all([
    getModifierKey(),
    chrome.windows.getCurrent(),
    getPrefs(),
  ]);

  return chrome.tabs.sendMessage(tabId, {
    type: "OPEN_OVERLAY",
    tabs,
    modifierKey,
    direction: command === "next-tab" ? 1 : -1,
    windowId: window.id.toString(),
    tabId,
    fromCurrentTab,
    prefs,
  });
}

/**
 * Last resort: the current tab cannot host the overlay, so switch to one that can
 * and draw it there. The user sees a tab change before the switcher appears, which
 * is the price of Chrome not allowing overlays on its own pages.
 */
async function openOverlayElsewhere(currentTabId, tabs, command) {
  const host = await findAsync(
    tabs,
    async (tab) =>
      tab.id !== currentTabId &&
      tab.type === "normal" &&
      !(await isErrorPage(tab.id)),
  );
  if (!host) return false;

  await activateTab(host.id);

  // Activating changed the MRU order, so rebuild rather than reusing the stale list.
  const refreshed = await buildTabList();
  try {
    await sendOpenOverlay(host.id, refreshed, command, false);
  } catch (error) {
    console.warn("OPEN_OVERLAY fallback failed", error);
    return false;
  }
  return true;
}

/**
 * Preferred path: draw on the tab the user is already on. Falls back if the content
 * script is missing — it may not have been injected yet, or the page may block it.
 */
async function openOverlayHere(tabId, tabs, command) {
  try {
    await sendOpenOverlay(tabId, tabs, command, true);
  } catch (error) {
    console.warn("OPEN_OVERLAY failed", error);
    return openOverlayElsewhere(tabId, tabs, command);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Declared content scripts only auto-inject on navigation, so tabs already open when
 * the extension installs or the browser starts have no overlay code in them. Inject
 * once to cover them. This is the only use of the scripting permission.
 */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});

  const injectable = tabs.filter(
    (tab) =>
      tab.id &&
      classifyTab(tab) === "normal" &&
      !tab.frozen &&
      !tab.discarded &&
      tab.status !== "unloaded",
  );

  // allSettled: a tab that refuses injection must not stop the rest.
  await Promise.allSettled(
    injectable.map((tab) =>
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/content.js"],
      }),
    ),
  );
}

async function initialize() {
  // Content scripts count as an untrusted context; without this they cannot read the
  // thumbnails they need to render. Still unreachable from page JavaScript, which has
  // no access to chrome.storage at all.
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
  });
  await publishHotkeys();
  await injectIntoOpenTabs();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install" && reason !== "update") return;

  // Fire before any await: openPopup() is only honoured close to the install event.
  if (reason === "install") chrome.action.openPopup();

  await initialize();

  const tab = await getActiveTab();
  if (tab?.id) await captureThumbnailFor(tab.id, tab.windowId);
});

chrome.runtime.onStartup.addListener(initialize);

// windowId comes from the event: onActivated fires for background windows too, so
// capturing "the current window" here would photograph the wrong one.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await captureThumbnailFor(tabId, windowId);
});

// Re-capture once a page finishes loading, so the thumbnail is not of a blank page.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    await captureThumbnailFor(tabId, tab.windowId);
  }
});

/**
 * Chrome ignores a Promise returned from an onMessage listener — only `return true`
 * keeps the channel open. Without it the caller's await resolves immediately with
 * undefined, so the content script cannot tell a failed tab close from a successful
 * one, and rejections here surface as unhandled.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    if (message.type === "ACTIVATE_TAB") return activateTab(message.id);
    if (message.type === "TRY_CLOSE_TAB") return chrome.tabs.remove(message.id);
    // Only our own content scripts and popup can reach this: with no
    // externally_connectable, page scripts cannot message the extension at all.
    if (message.type === "TRIGGER") return handleTrigger(message.command);
    if (message.type === "REFRESH_HOTKEYS") return publishHotkeys();
  };

  handle().then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: String(error) }),
  );

  return true;
});

/**
 * Two things can trigger the switcher: Chrome's own accelerator, and the content
 * script's in-page fallback for when that accelerator does not fire. Where both work,
 * one keypress produces both — a millisecond or two apart, where a genuine second tap
 * is 100ms away at best. So a short suppression window separates them reliably.
 */
const TRIGGER_DEDUP_MS = 50;
let lastTrigger = { command: null, at: 0 };

function isDuplicateTrigger(command) {
  const now = Date.now();
  // Deliberately not restamped on a duplicate: the window must stay anchored to the
  // original keypress, or a stream of duplicates would keep pushing it forward.
  if (command === lastTrigger.command && now - lastTrigger.at < TRIGGER_DEDUP_MS) {
    return true;
  }

  lastTrigger = { command, at: now };
  return false;
}

async function handleTrigger(command) {
  if (command !== "next-tab" && command !== "prev-tab") return;
  if (isDuplicateTrigger(command)) return;

  const currentTab = await getActiveTab();
  if (!currentTab) return;

  const tabs = await buildTabList();
  if (tabs.length < 2) return;

  const canHostOverlay =
    classifyTab(currentTab) === "normal" && !(await isErrorPage(currentTab.id));

  const opened = canHostOverlay
    ? await openOverlayHere(currentTab.id, tabs, command)
    : await openOverlayElsewhere(currentTab.id, tabs, command);

  // No tab could host the overlay — at least honour the keypress by switching.
  if (!opened) {
    console.warn("No suitable tab found to show overlay");
    const target = tabs.find((tab) => tab.id !== currentTab.id);
    if (target) await activateTab(target.id);
  }
}

chrome.commands.onCommand.addListener(handleTrigger);
