/**
 * Content script: draws the switcher overlay inside the page.
 *
 * Chrome gives extensions no way to float a window over the viewport, so the overlay
 * is injected into whatever page you are on. It lives in a *closed* shadow root to keep
 * it out of reach of the page's own scripts and styles.
 *
 * Runs at document_start on every page, and is also injected once into already-open
 * tabs at install/startup — hence the re-entry guard below.
 */

(() => {
  // A tab can receive this script more than once: the declared content script plus the
  // startup injection, and again after an extension update — where the previous
  // instance's isolated world survives but its chrome.runtime listeners are dead.
  //
  // Tearing the old instance down rather than refusing to load handles both. A plain
  // "already loaded, bail out" flag would make post-update re-injection a silent no-op
  // and leave the tab permanently without a working switcher.
  if (typeof window.__tabSwitcherTeardown === "function") {
    try {
      window.__tabSwitcherTeardown();
    } catch {
      /* previous instance's extension context is already invalidated */
    }
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** Unlikely-to-collide prefix for our class names, since they share the page's DOM. */
  const PREFIX = "g7Kf9x";

  const CLASS = {
    container: `${PREFIX}_container`,
    overlay: `${PREFIX}_overlay`,
    item: `${PREFIX}_item`,
    preview: `${PREFIX}_preview`,
    text: `${PREFIX}_text`,
    thumbnail: `${PREFIX}_thumbnail`,
    icon_thumbnail: `${PREFIX}_icon_thumbnail`,
    active: `${PREFIX}_active`,
    icon: `${PREFIX}_icon`,
    close_button: `${PREFIX}_close_button`,
    close_button_wrapper: `${PREFIX}_close_button_wrapper`,
  };

  /** Used only when the host document is itself an SVG — see mountOverlay(). */
  const SVG_FOREIGN_OBJECT_ID = `${PREFIX}-fo`;
  const SVG_STYLE_ID = `${PREFIX}-style`;

  const FALLBACK_FAVICON = chrome.runtime.getURL("images/favicon.png");

  const THEMES = {
    pink: { main: "#ff8ad4", thumbBg: "rgba(255, 138, 212, 0.3)", overlayBg: "#3d2236a1" },
    blue: { main: "#7aa2ff", thumbBg: "rgba(122, 162, 255, 0.3)", overlayBg: "#25314da1" },
    yellow: { main: "#ffd43b", thumbBg: "rgba(255, 212, 59, 0.3)", overlayBg: "#3a300da8" },
    green: { main: "#5ee17c", thumbBg: "rgba(94, 225, 124, 0.25)", overlayBg: "#1f3225a1" },
    red: { main: "#ff6b6b", thumbBg: "rgba(255, 107, 107, 0.3)", overlayBg: "#3a1b1ba8" },
    white: { main: "#d9d9d9", thumbBg: "rgba(217, 217, 217, 0.25)", overlayBg: "#222222a6" },
  };

  const DEFAULT_PREFS = { shortcut: "Ctrl+Q", color: "blue", layout: "overlays", tabCount: 6 };

  const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let tabs = [];
  let selectedIndex = 0;
  let isOpen = false;
  /** In-flight open, so a rapid second press advances the highlight instead of racing. */
  let opening = null;
  let modifierKey = "Control";
  let prefs = DEFAULT_PREFS;
  /** Keydown matchers for each command, published by the worker. See matchesHotkey(). */
  let hotkeys = { "next-tab": null, "prev-tab": null };

  /**
   * The shadow root is closed, so `host.shadowRoot` is null even to us. These
   * references are the only handles that exist — which is exactly the point.
   */
  let host = null;
  let shadow = null;
  let overlay = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Escape a value for interpolation into the markup below.
   *
   * Applied to *every* interpolated value, not just the obviously risky ones. Tab
   * titles and favicon URLs are chosen by the pages they come from, so both are
   * attacker-influenced; treating them uniformly is what keeps that from mattering.
   */
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  /**
   * Parse a markup string into a detached element.
   *
   * DOMParser rather than innerHTML: scripts created this way carry the
   * "already started" flag and never execute, even if one were somehow injected.
   */
  function parseElement(markup, mimeType = "text/html") {
    const parsed = new DOMParser().parseFromString(markup, mimeType);
    const rootTag = markup.match(/<\s*([a-zA-Z0-9-]+)/)[1];
    return document.adoptNode(parsed.querySelector(rootTag));
  }

  /**
   * True once the extension has been reloaded, updated, or removed out from under us.
   *
   * The isolated world this script runs in outlives that: the code keeps executing and
   * its listeners keep firing, but chrome.runtime is dead and every call throws
   * "Extension context invalidated". chrome.runtime.id going undefined is the signal.
   */
  function isOrphaned() {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  /**
   * Stand down if we are orphaned.
   *
   * This matters more than it looks. onKeyDown claims the shortcut with
   * preventDefault(), so an orphaned instance that stayed wired up would swallow the
   * keystroke and then fail to act on it — the shortcut would be worse than dead until
   * the page was reloaded. Tearing down restores the page to as if we were never here.
   */
  function standDownIfOrphaned() {
    if (!isOrphaned()) return false;
    window.__tabSwitcherTeardown?.();
    return true;
  }

  async function sendToWorker(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (standDownIfOrphaned()) return undefined;
      throw error;
    }
  }

  /**
   * Does this keydown match one of our shortcuts?
   *
   * This is the in-page fallback for Chrome's own accelerator, and it exists because
   * Chrome matches a shortcut against the *character* the active keyboard layout
   * produces. Bind Ctrl+Q under a Latin layout, switch the input language to one where
   * that key types something else — Hebrew, Russian, Greek — and Chrome stops seeing
   * Ctrl+Q, so the command never fires.
   *
   * KeyboardEvent.code is the physical key position and does not change with the
   * layout, so matching on it keeps the shortcut working in every language. It also
   * covers a command Chrome left unbound because another extension claimed the
   * combination.
   *
   * Modifiers are compared for equality, not just presence, so Ctrl+Shift+Q cannot also
   * satisfy Ctrl+Q. When both this and Chrome's accelerator fire for one keypress, the
   * worker collapses the duplicate.
   */
  function matchesHotkey(event, matcher) {
    return (
      !!matcher &&
      event.code === matcher.code &&
      event.ctrlKey === matcher.ctrl &&
      event.altKey === matcher.alt &&
      event.shiftKey === matcher.shift &&
      event.metaKey === matcher.meta
    );
  }

  async function loadHotkeys() {
    const stored = await chrome.storage.session.get("hotkeys");
    if (stored.hotkeys) {
      hotkeys = stored.hotkeys;
      return;
    }

    // Session storage is empty at browser start, and after an unpacked reload the worker
    // may not have republished yet. Re-read rather than waiting on onStorageChanged: the
    // worker only writes when the value changed, so if it raced ahead of us and wrote the
    // same matchers, no change event would ever arrive.
    await sendToWorker({ type: "REFRESH_HOTKEYS" });
    const republished = await chrome.storage.session.get("hotkeys");
    if (republished.hotkeys) hotkeys = republished.hotkeys;
  }

  /**
   * windowId always arrives in the OPEN_OVERLAY message. Upstream had a fallback that
   * called chrome.windows.getCurrent() — an API content scripts cannot reach, so it
   * could only ever have thrown. Dropped rather than carried forward.
   */
  async function getThumbnails(windowId) {
    const stored = await chrome.storage.session.get(windowId);
    return stored[windowId]?.thumbnails ?? [];
  }

  /**
   * Lets the worker skip screenshotting while the switcher itself is on screen.
   *
   * Timestamped so the worker can expire it. If this document is torn down while the
   * overlay is up (navigation, tab discard), the clearing write never happens, and an
   * un-expiring flag would disable thumbnail capture for the whole browser session.
   */
  function setOverlayOpenFlag(open) {
    return chrome.storage.session.set({
      isOverlayOpen: { open, at: Date.now() },
    });
  }

  async function withThumbnails(tabList, windowId) {
    const thumbnails = await getThumbnails(windowId);
    return tabList.map((tab) => ({
      ...tab,
      thumbnail: thumbnails.find((entry) => entry.tabId === tab.id)?.thumbnail,
    }));
  }

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  const OVERLAY_STYLES = `
    <style>
      .${CLASS.overlay} {
        --gap: 20px;
        --color-main: currentColor;
        --color-thumbnail: currentColor;
        --color-overlay: currentColor;
        border: 1px solid #55555557;
        user-select: none;
        display: flex;
        background: var(--color-overlay);
        box-shadow: 3px 4px 16px 3px #0b0c1285;
        backdrop-filter: blur(10px);
        border-radius: 20px;
        padding: var(--gap) var(--gap) 8px var(--gap);
        gap: var(--gap);
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font: 12px sans-serif;
        color: white;
        flex-wrap: wrap;
        width: max-content;
        max-width: calc(100dvw - 2*var(--gap) - 2px);
        box-sizing: border-box;
        align-content: flex-start;
        justify-content: center;
        transition: opacity 150ms ease-out;
        outline: 0 solid transparent;
        opacity: 0;
        &.show {
          opacity: 1;
        }
        &.exportable {
          position: static;
          transform: none;
        }
      }

      .${CLASS.item} {
        padding-bottom: 6px;
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        flex: 0 0 140px;
        max-width: 140px;
        box-sizing: border-box;
        position: relative;
        transition: transform 200ms ease-out;

        &:hover {
          cursor: pointer;
          transform: scale(1.05);
          .${CLASS.preview} {
            outline: 2px solid var(--color-main);
          }
          .${CLASS.close_button_wrapper} {
            display: flex;
          }
        }
        &.${CLASS.active}, &:hover.${CLASS.active} {
          transform: scale(1.1);
          .${CLASS.preview} {
            background: var(--color-thumbnail);
            outline: 2px solid var(--color-main);
            box-shadow: 2px 4px 10px #1f223570;
          }
        }
      }
      .${CLASS.preview} {
        background: rgba(255, 255, 255, 0.08);
        height: 90px;
        margin-bottom: 6px;
        border-radius: 8px;
        overflow: hidden;
        border: 2px solid transparent;
        transition: outline-color 200ms ease-out;
        outline: 0 solid transparent;
      }
      .${CLASS.text} {
        font-size: 14px;
        font-family: system-ui;
        display: flex;
        gap: 4px;
        align-items: center;
        min-width: 0;
        filter: drop-shadow(1px 1px 4px rgba(34,34,34,0.52));
        span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          min-width: 0;
          flex: 1;
        }
      }
      .${CLASS.thumbnail} {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top center;
        display: block;
        overflow: visible;
      }
      .${CLASS.icon_thumbnail} {
        width: 48px;
        position: relative;
        top: calc(50% - 24px);
        left: calc(50% - 24px);
        opacity: 0.3;
      }
      .${CLASS.icon} {
        height: 14px;
        width: 14px;
        vertical-align: bottom;
      }
      .${CLASS.close_button_wrapper} {
        display: none;
        align-items: center;
        justify-content: center;
        position: absolute;
        height: 24px;
        width: 24px;
        top: -10px;
        right: -10px;
      }
      .${CLASS.close_button} {
        height: 20px;
        width: 20px;
        align-items: center;
        justify-content: center;
        padding: 0;
        border-radius: 50%;
        border: 0;
        background: #ff6b6b;
        display: flex;
        cursor: pointer;
        &:hover {
          background: #ff8282;
        }
      }

      @media (max-width: 600px) {
        .${CLASS.overlay} {
          --gap: 0;
          padding: 8px;
          flex-direction: column;

          .${CLASS.item} {
            flex: 1;
            max-width: 180px;

            .${CLASS.text} {
              padding: 8px;
              border-radius: 8px;
            }

            &:hover, &.${CLASS.active}, &:hover.${CLASS.active} {
              transform: scale(1);
              .${CLASS.text} {
                color: white;
                outline: 2px solid var(--color-main);
              }
            }
          }

          .${CLASS.preview} {
            display: none;
          }
        }
      }
    </style>
  `;

  const CLOSE_ICON = `<svg height="18px" width="18px" viewBox="0 -960 960 960" fill="white"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>`;

  /** Thumbnail if we have one, a stock glyph for internal pages, otherwise empty. */
  function previewMarkup(tab) {
    if (tab.thumbnail) {
      return `<img class="${CLASS.thumbnail}" src="${escapeHtml(tab.thumbnail)}" alt="thumb">`;
    }
    if (tab.type !== "normal") {
      const icon = chrome.runtime.getURL(`images/${tab.type}.svg`);
      return `<img class="${CLASS.icon_thumbnail}" src="${escapeHtml(icon)}" alt="thumb">`;
    }
    return "";
  }

  function itemMarkup(tab, index, activeIndex) {
    const closeButton = tab.isPinned
      ? ""
      : `<div class="${CLASS.close_button_wrapper}">
           <button data-tabid="${escapeHtml(tab.id)}" class="${CLASS.close_button}">${CLOSE_ICON}</button>
         </div>`;

    return `
      <div data-index="${escapeHtml(index)}" class="${CLASS.item} ${index === activeIndex ? CLASS.active : ""}">
        <div class="${CLASS.preview}">${previewMarkup(tab)}</div>
        <span class="${CLASS.text}">
          <img class="${CLASS.icon}" src="${escapeHtml(tab.favIconUrl || FALLBACK_FAVICON)}" alt="favicon">
          <span>${tab.title ? escapeHtml(tab.title) : "(untitled)"}</span>
        </span>
        ${closeButton}
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Build the host element and its shadow root, once per page.
   *
   * `mode: "closed"` is a deliberate change from upstream, which used "open". An open
   * root is readable via `host.shadowRoot` by any script on the page, which exposed the
   * titles, URLs, and screenshots of every other tab while the switcher was up.
   */
  function createHost() {
    const container = parseElement(`
      <div class="${CLASS.container}" style="position: fixed; top: 0; left: 0; z-index: 2147483647"/>
    `);

    shadow = container.attachShadow({ mode: "closed" });

    const wrapper = parseElement(`<div tabindex="-1"></div>`);
    overlay = parseElement(`<div class="${CLASS.overlay}" tabindex="-1"></div>`);

    overlay.addEventListener("pointerdown", onPointerDown);

    // Attached once here rather than per render, or the handlers accumulate.
    overlay.addEventListener(
      "error",
      (event) => {
        if (event.target instanceof HTMLImageElement) event.target.src = FALLBACK_FAVICON;
      },
      true,
    );

    wrapper.appendChild(overlay);
    shadow.appendChild(parseElement(OVERLAY_STYLES));
    shadow.appendChild(wrapper);

    return container;
  }

  /**
   * Put the host into the document.
   *
   * An SVG document has no <body> and will not lay out HTML children, so we hide the
   * page's own content and wrap the overlay in a <foreignObject>. Rare, but a plain
   * appendChild renders nothing at all there.
   */
  function mountOverlay(element) {
    if (!(document.documentElement instanceof SVGSVGElement)) {
      document.body.appendChild(element);
      return;
    }

    const root = document.documentElement;

    // Only on the first mount. Re-running after the attribute has been blanked would
    // save "" as the original and make the page's real viewBox unrecoverable.
    if (!("originalViewBox" in root.dataset)) {
      root.dataset.originalViewBox = root.getAttribute("viewBox") ?? "";
    }
    root.setAttribute("viewBox", "");

    root.insertBefore(
      parseElement(
        `<style id="${SVG_STYLE_ID}" xmlns="http://www.w3.org/2000/svg">
           :root { width: 100vw !important; height: 100vh !important; display: block !important; }
           :root > :not(#${SVG_FOREIGN_OBJECT_ID}) { visibility: hidden !important; }
         </style>`,
      ),
      root.firstChild,
    );

    const foreignObject = parseElement(
      `<foreignObject id="${SVG_FOREIGN_OBJECT_ID}" xmlns="http://www.w3.org/2000/svg" x="0" y="0" width="100%" height="100%"></foreignObject>`,
      "image/svg+xml",
    );
    foreignObject.appendChild(element);
    root.appendChild(foreignObject);
  }

  async function render(tabList) {
    // Fullscreen video would cover the overlay entirely.
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* not fatal — the overlay may just be hidden behind the fullscreen element */
      }
    }

    if (!host) host = createHost();

    const theme = THEMES[prefs.color] ?? THEMES[DEFAULT_PREFS.color];
    overlay.style.setProperty("--color-main", theme.main);
    overlay.style.setProperty("--color-thumbnail", theme.thumbBg);
    overlay.style.setProperty("--color-overlay", theme.overlayBg);

    const items = parseElement(
      `<div>${tabList.map((tab, i) => itemMarkup(tab, i, selectedIndex)).join("")}</div>`,
    );
    overlay.replaceChildren(...Array.from(items.childNodes));

    // Re-renders (closing a tab from the overlay) must not remount an attached host —
    // in the SVG branch that would duplicate the foreignObject and clobber the saved
    // viewBox.
    if (!host.isConnected) mountOverlay(host);

    requestAnimationFrame(() => overlay?.classList.add("show"));

    isOpen = true;
    await setOverlayOpenFlag(true);
  }

  function highlight(index) {
    selectedIndex = index;
    Array.from(overlay?.children ?? []).forEach((child, i) =>
      child.classList.toggle(CLASS.active, i === selectedIndex),
    );
  }

  function hideOverlay() {
    if (!isOpen) return;

    overlay?.classList.remove("show");

    if (host) {
      if (document.documentElement instanceof SVGSVGElement) {
        const root = document.documentElement;
        // `in`, not truthiness: a document whose original viewBox was genuinely absent
        // stores "" here, and that still needs restoring.
        if ("originalViewBox" in root.dataset) {
          root.setAttribute("viewBox", root.dataset.originalViewBox);
          delete root.dataset.originalViewBox;
        }
        // The style element was inserted into the SVG document, not the shadow root.
        document.getElementById(SVG_STYLE_ID)?.remove();
        host.parentElement?.remove();
      }
      host.remove();
    }

    // host/shadow/overlay are kept for reuse; only the DOM attachment is undone.
    isOpen = false;
    setOverlayOpenFlag(false);
  }

  function activateSelected() {
    const tab = tabs[selectedIndex];
    if (tab?.id) return sendToWorker({ type: "ACTIVATE_TAB", id: tab.id });
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  async function onWorkerMessage(message) {
    if (message.type === "OPEN_OVERLAY") await handleOpenOverlay(message);
    else if (message.type === "RELEASED") await commitSelection();
  }

  async function handleOpenOverlay(message) {
    if (!message.tabs?.length) return;

    modifierKey = message.modifierKey ?? "Control";
    prefs = message.prefs;

    // Opening is async (storage read, then render). A second Ctrl+Q arriving inside
    // that window would otherwise take the "not open yet" branch and restart the
    // overlay instead of advancing the highlight, losing the keypress.
    if (opening) {
      await opening;
      highlight((selectedIndex + message.direction + tabs.length) % tabs.length);
      overlay?.focus();
      return;
    }

    if (isOpen) {
      // Already up: just move the highlight, wrapping in the requested direction.
      highlight((selectedIndex + message.direction + tabs.length) % tabs.length);
    } else {
      opening = (async () => {
        const visible = message.tabs.slice(0, prefs.tabCount);
        const currentIndex = visible.findIndex((tab) => tab.id === message.tabId);

        // Opening from the tab you are on should preselect the *previous* tab, so a
        // tap-and-release lands where Alt+Tab would.
        selectedIndex = message.fromCurrentTab && currentIndex !== 1 ? 1 : 0;

        tabs = await withThumbnails(visible, message.windowId);
        await render(tabs);
      })();

      try {
        await opening;
      } finally {
        opening = null;
      }
    }

    overlay?.focus();
  }

  async function commitSelection() {
    if (!isOpen) return;
    hideOverlay();
    await activateSelected();
  }

  /** Releasing the modifier commits, mirroring Alt+Tab. */
  async function onKeyUp(event) {
    if (event.key === modifierKey) await commitSelection();
  }

  function onKeyDown(event) {
    // Checked before anything is claimed, so an orphaned instance never eats the key.
    if (standDownIfOrphaned()) return;

    // Skip auto-repeat: holding the key down should not cycle on its own.
    if (!event.repeat) {
      for (const command of ["prev-tab", "next-tab"]) {
        if (!matchesHotkey(event, hotkeys[command])) continue;
        event.preventDefault();
        event.stopImmediatePropagation();
        sendToWorker({ type: "TRIGGER", command }).catch((error) =>
          console.warn("Failed to trigger the switcher", error),
        );
        return;
      }
    }

    if (event.key === modifierKey) return;
    if (event.key === "Escape" && isOpen) {
      hideOverlay();
      // Stop the page from also acting on Escape (closing its own modal, etc).
      event.stopImmediatePropagation();
    }
  }

  function onPointerDown(event) {
    const closeButton = event.target.closest(`.${CLASS.close_button}`);
    if (closeButton) {
      closeTab(closeButton);
      return;
    }

    const item = event.target.closest(`.${CLASS.item}`);
    if (!item) return;

    const index = Number(item.dataset.index);
    if (index === 0) {
      // Index 0 is the tab you are already on — just dismiss. The delay lets the
      // click finish before the overlay is torn out from under it.
      setTimeout(hideOverlay, 50);
      return;
    }

    selectedIndex = index;
    activateSelected();
  }

  async function closeTab(button) {
    const tabId = Number(button.dataset.tabid);

    let response;
    try {
      response = await sendToWorker({ type: "TRY_CLOSE_TAB", id: tabId });
    } catch (error) {
      // Leave the item in place if the tab would not close.
      console.warn("Tab close error:", error);
      return;
    }
    // The worker reports failure in the payload, not by rejecting.
    if (!response?.ok) {
      console.warn("Tab close error:", response?.error);
      return;
    }

    // Removing an entry *before* the highlight shifts everything after it down by one.
    // Clamping alone would leave the highlight pointing at a different tab than the one
    // the user is looking at — and releasing the modifier would switch to it.
    const removedIndex = tabs.findIndex((tab) => tab.id === tabId);
    tabs = tabs.filter((tab) => tab.id !== tabId);

    if (removedIndex !== -1 && removedIndex < selectedIndex) selectedIndex -= 1;
    selectedIndex = Math.max(0, Math.min(selectedIndex, tabs.length - 1));

    await render(tabs);
  }

  /**
   * Dismiss on a click outside the switcher.
   *
   * The test is against the shadow *host*, not `.overlay`. This listener is on window,
   * outside the shadow tree, so shadow-DOM retargeting rewrites event.target to the host
   * container for any click inside the overlay — a `.overlay` selector never matches and
   * the guard would dismiss on every click, including our own.
   */
  function onClick(event) {
    if (isOpen && event.target !== host) hideOverlay();
  }

  function onContextMenu(event) {
    if (isOpen) event.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function onBlur() {
    hideOverlay();
  }

  function onVisibilityChange() {
    if (document.hidden) hideOverlay();
  }

  /** The worker republishes matchers when the shortcut may have changed. */
  function onStorageChanged(changes, area) {
    if (area === "session" && changes.hotkeys) {
      hotkeys = changes.hotkeys.newValue ?? hotkeys;
    }
  }

  chrome.runtime.onMessage.addListener(onWorkerMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  loadHotkeys().catch((error) => console.warn("Failed to read shortcuts", error));

  // Capture phase: pages that swallow key events must not break the switcher.
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("keydown", onKeyDown, true);

  // Losing focus or visibility means the switcher can no longer be driven — dismiss
  // rather than stranding it on screen.
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);

  window.addEventListener("click", onClick);
  document.addEventListener("contextmenu", onContextMenu);

  /**
   * Unregister everything this instance owns, so a later injection into the same
   * isolated world can take over cleanly. Called by the next instance, not by us.
   */
  window.__tabSwitcherTeardown = () => {
    chrome.runtime.onMessage.removeListener(onWorkerMessage);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("click", onClick);
    document.removeEventListener("contextmenu", onContextMenu);
    host?.remove();
  };
})();
