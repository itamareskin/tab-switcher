# Security audit — Tab Flick 0.2.0

**Subject:** `vendor/tab-flick-0.2.0/`, unpacked from `vendor/tab-flick-0.2.0.crx`
**SHA-256:** `774f486175f1841efcd1e7d557396246f9c638466e73a9e18222ba24fa035763`
**Source:** Google's own update endpoint for extension ID `kdddoanokjocdkbkmgnkkcemjepknlgm`
**Size:** 33,185 bytes (32.41 KiB — matches the store listing exactly)
**Reviewed:** 2026-08-19
**Method:** full manual read of every shipped `.js`, `.json`, `.html`, `.css`, and `.svg`, plus
greps used to prove negatives across the whole tree.

## Verdict

**Pass, with three defects fixed in the fork.** No network egress, no dynamic code execution, no
obfuscation, and no high-risk Chrome APIs. The extension does what it claims. Nothing it collects
leaves the browser.

The defects below are not evidence of bad intent — they read as ordinary oversights. They are fixed
in `src/` anyway, because the point of a fork is that the code you run is code you vouch for.

One behavior is **undisclosed rather than defective**, and you should decide about it consciously:
see "Screenshot capture" below.

## What it actually does

1. A service worker tracks tabs and keeps them ordered by `lastAccessed` (MRU).
2. On every tab activation and page-load completion it screenshots the visible tab
   (`captureVisibleTab`, JPEG quality 10) and stores the image in `chrome.storage.session`.
3. `Ctrl+Q` (`chrome.commands`) messages the current tab's content script, which renders an overlay
   in a shadow DOM listing recent tabs with those thumbnails.
4. Repeat presses cycle the highlight; releasing the modifier (`keyup`) sends `ACTIVATE_TAB` back to
   the worker, which calls `chrome.tabs.update`. `Escape`, blur, tab-hide, and outside-click cancel.

That matches the store description. Beyond it: per-tab close buttons in the overlay, a preferences
popup, and the screenshot capture — none of which the listing mentions, though only the third has
privacy weight.

## Findings

### Network egress — none

Proven absent across all files: `fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`,
`EventSource`, `importScripts`, `navigator.connection`, `axios`, `.ajax`.

Every URL literal in the package is accounted for:

| Literal | Where | Why it is not egress |
|---|---|---|
| `https://chromewebstore.google.com/`, `https://chrome.google.com/webstore` | `background.js` | String comparison to *classify* those tabs as `unknown`; content scripts are banned on Web Store pages. Never fetched. |
| `http://www.w3.org/2000/svg` | SVGs, `content.js` | XML namespace identifiers. Not network addresses. |
| `https://clients2.google.com/service/update2/crx` | `manifest.json` | The store auto-update channel. **Removed in the fork.** |

The CSS has no `@import` and no `url()` — no remote fonts or assets.

### Dynamic code execution — none

Absent: `eval(`, `new Function`, string-valued `setTimeout`/`setInterval`, `document.write`,
`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `createElement('script')`.

The single `chrome.scripting.executeScript` call is local-file-only:

```js
chrome.scripting.executeScript({target:{tabId:t.id},files:["src/content/content.js"]})
```

No `func:`, no string body, no remote URL. The manifest declares no
`content_security_policy` override, so MV3's default policy (no eval, no remote script) is in force.

Notably, the overlay is built with `DOMParser().parseFromString` + `adoptNode` + `replaceChildren`
rather than `innerHTML`. Scripts created via `DOMParser` do not execute on insertion, so this is a
deliberately safer pattern than the usual one.

### Obfuscation — none

No `atob`/`btoa`, no `fromCharCode` decoders, no hex-escape blobs, no string-array indirection. The
code is minified by a bundler (hashed filenames, single-letter identifiers) but the control flow
maps cleanly onto plausible hand-written source — which is why reconstructing `src/` was possible.

### Permissions — all four justified

| Permission | Justification found in code |
|---|---|
| `tabs` | `query`/`update`/`remove`, and `title`/`url` for the overlay. Core. |
| `storage` | `session` for thumbnails, `sync` for three UI prefs. |
| `scripting` | One `executeScript` at install/startup to inject into *already-open* tabs — `content_scripts` alone only auto-inject on navigation. Legitimate, and the standard workaround. |
| `webNavigation` | `getAllFrames` to detect error pages, where content scripts cannot run, so the overlay can fall back to another tab. Narrow use of a broad permission. |
| `<all_urls>` | Required both to inject the overlay anywhere and for `captureVisibleTab`. |

Confirmed **absent**: `cookies`, `history`, `webRequest`, `debugger`, `management`, `downloads`,
`proxy`, `privacy`, `identity`, `desktopCapture`, `tabCapture`. No `externally_connectable`, so no
website can message the extension directly.

### Data handling

The only write that leaves the machine is preferences:

```js
chrome.storage.sync.set({color, layout, tabCount})
```

Three UI settings, synced to your Google account like any Chrome setting. No tab data, no URLs, no
screenshots go to `sync`.

Screenshots and tab metadata go to `chrome.storage.session`, which is **in-memory, cleared when the
browser closes, and never synced**. This is the correct choice for this data.

## Defects fixed in the fork

### 1. Open shadow root exposed other tabs' data to the host page — *the significant one*

`content.js` attached the overlay with `attachShadow({mode:"open"})`. An open shadow root is
readable by the host page's own JavaScript. While the overlay is open, any script on the page you
happen to be on could reach:

```js
document.querySelector('.g7Kf9x_container').shadowRoot.innerHTML
```

and read the **titles, URLs, and JPEG screenshots of all your other tabs**. The container prefix
`g7Kf9x` is a hard-coded constant, not a per-session random, so it is trivially discoverable. The
window is short (only while the overlay is up), but a `MutationObserver` closes that gap.

This is the one finding that could plausibly matter in practice. **Fixed:** `mode:"closed"`, which
removes the page's `.shadowRoot` handle entirely. Nothing in the extension relies on external access
— all internal lookups go through the module-scoped `overlayHost` reference.

### 2. `favIconUrl` interpolated into an attribute without escaping

Tab titles are correctly escaped before interpolation:

```js
${e.title ? e.title.replace(/[&<>"']/g, e => t[e]) : "(untitled)"}
```

but the adjacent favicon URL is not:

```js
<img class="..." src="${e.favIconUrl || c}" alt="favicon">
```

`favIconUrl` is attacker-influenced — a page chooses its own favicon `href`. Exploitation is
unlikely because Chrome percent-encodes `"` as `%22` when serializing the URL, and `DOMParser`
prevents `<script>` from running. But an injected `onerror=` attribute *would* run, and the
inconsistency with the escaped title suggests an oversight rather than a considered decision.
**Fixed:** the same escaping applied to every interpolated value.

### 3. `content.js` needlessly exposed as a web-accessible resource

The manifest listed `src/content/content.js` in `web_accessible_resources` with `matches:
["<all_urls>"]`, letting any website load the extension's own script text. `executeScript` with
`files:` does **not** require this — only the images do, because the page's renderer resolves their
URLs. Most likely a build artifact. **Fixed:** removed from the list; images retained.

## Screenshot capture — undisclosed, your call

Not a defect, but the thing I would want flagged if this were my browser: **the extension
screenshots every page you visit.** JPEG quality 10, on every tab activation and page load.

Mitigating facts, all verified above: images never leave the browser, live only in
`chrome.storage.session` (in-memory, dropped on browser close), are never synced, and with finding
#1 fixed are no longer reachable by web pages. The feature is what makes the switcher look like
Alt+Tab, and it is the honest reason `<all_urls>` is needed.

Still: your online banking, your email, and your password manager get captured to memory alongside
everything else, and the store listing does not say so. That is a reasonable trade for the feature
if you know about it — so now you know.

The capture is a single call site (`captureScreenshot` in `src/background.js`), deliberately left in
one place so it is easy to gate behind a preference or delete outright. Doing so costs the
thumbnails and nothing else; the switcher falls back to favicons.

## Limits of this review

Static review of one snapshot. It says nothing about any other version, and a clean read is not a
formal proof of absence.

**It has not yet been corroborated at runtime.** The switcher has never been exercised with DevTools
Network open on the service worker and on a page, so the "zero outbound requests" claim rests on
reading alone. `README.md` has the procedure; it is still outstanding.

This review covers `vendor/tab-flick-0.2.0/` and the port of it in `src/`. Code added to the fork
*after* the review is out of scope and called out here as it lands:

- **In-page shortcut fallback** (`matchesHotkey`/`onKeyDown` in `src/content/content.js`, the
  `TRIGGER` message in `src/background.js`). Adds one message type the content script can send. It
  is not new attack surface from the page's side: with no `externally_connectable`, page scripts
  cannot message the extension at all, and the worker only ever acts on the two command names it
  already accepted from `chrome.commands`. It does mean the content script now calls
  `preventDefault()` on a key combination the page would otherwise receive.
