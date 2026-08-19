/**
 * Preferences popup.
 *
 * Three settings, persisted to chrome.storage.sync so they follow your Chrome profile:
 * accent colour, thumbnail count, and layout. The keyboard shortcut is deliberately
 * *not* stored here — Chrome owns it, and it is only displayed, with a link out to
 * chrome://extensions/shortcuts where it can actually be changed.
 */

const DEFAULT_PREFS = {
  shortcut: "Ctrl+Q",
  color: "blue",
  layout: "overlays",
  tabCount: 6,
};

const themeOptions = document.getElementById("themeOptions");
const shortcutValue = document.getElementById("shortcutValue");
const thumbCount = document.getElementById("thumbCount");
const thumbCountValue = document.getElementById("thumbCountValue");

async function getShortcut() {
  const commands = await chrome.commands.getAll();
  return commands.find((command) => command.name === "next-tab")?.shortcut;
}

async function loadPrefs() {
  const stored = await chrome.storage.sync.get(["color", "layout", "tabCount"]);
  const shortcut = await getShortcut();

  return {
    // `||`, not `??`: chrome.commands reports an unassigned command as "", which is
    // not nullish, so `??` would render an empty shortcut pill.
    shortcut: shortcut || DEFAULT_PREFS.shortcut,
    color: stored.color ?? DEFAULT_PREFS.color,
    layout: stored.layout ?? DEFAULT_PREFS.layout,
    tabCount: stored.tabCount ?? DEFAULT_PREFS.tabCount,
  };
}

/** Setters keep the DOM in step with the values, so there is one place to update each. */
const prefs = {
  _shortcut: "",
  _color: DEFAULT_PREFS.color,
  _layout: DEFAULT_PREFS.layout,
  _tabCount: DEFAULT_PREFS.tabCount,

  get shortcut() {
    return this._shortcut;
  },
  set shortcut(value) {
    this._shortcut = value;
    shortcutValue.textContent = value;
  },

  get color() {
    return this._color;
  },
  set color(value) {
    this._color = value;
    const radio = themeOptions.querySelector(`input[name="theme"][value="${value}"]`);
    if (radio) radio.checked = true;
  },

  get layout() {
    return this._layout;
  },
  set layout(value) {
    this._layout = value;
  },

  get tabCount() {
    return this._tabCount;
  },
  set tabCount(value) {
    this._tabCount = value;
    thumbCount.value = value.toString();
    thumbCountValue.textContent = value.toString();
  },
};

function save() {
  chrome.storage.sync.set({
    color: prefs.color,
    layout: prefs.layout,
    tabCount: prefs.tabCount,
  });
}

// chrome:// URLs cannot be opened by a plain link, so route through the tabs API.
document.getElementById("shortcutsLink")?.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// Pressing the shortcut while the popup is focused should switch tabs, not sit here.
chrome.commands.onCommand.addListener((command) => {
  if (command === "next-tab" || command === "prev-tab") window.close();
});

document.getElementById("ok")?.addEventListener("click", () => window.close());

themeOptions.addEventListener("change", (event) => {
  if (event.target?.name !== "theme") return;
  prefs.color = event.target.value;
  save();
});

thumbCount.addEventListener("input", () => {
  prefs.tabCount = parseInt(thumbCount.value, 10);
  save();
});

loadPrefs().then((stored) => {
  prefs.color = stored.color;
  prefs.layout = stored.layout;
  prefs.shortcut = stored.shortcut;
  prefs.tabCount = stored.tabCount;
});
