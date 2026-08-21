# Tab Switcher

An audited fork of [Tab Flick](https://chromewebstore.google.com/detail/kdddoanokjocdkbkmgnkkcemjepknlgm)
0.2.0 by Eugene Gluhotorenko. Alt+Tab, but for browser tabs: hold `Ctrl+Q`, keep tapping to cycle
through recent tabs, release to jump.

This exists so the code that runs in the browser is code that has been read. A Web Store extension
updates itself silently, so installing one is a bet on the developer's future behaviour as much as
their present code. This repository freezes v0.2.0 at a reviewed state and severs the update channel.

**Read [AUDIT.md](AUDIT.md) before loading this.** Short version: no network egress, no dynamic code,
no obfuscation, all permissions justified — and it screenshots every page you visit into memory,
which the store listing never mentions.

## Layout

| Path | What it is |
|---|---|
| `vendor/tab-flick-0.2.0.crx` | The exact bytes Google served, plus its sha256 |
| `vendor/tab-flick-0.2.0/` | Pristine unpack. Never edited — `git diff` against it is meaningful |
| `tools/unpack-crx.py` | CRX3/CRX2 header stripper, so the unpack is reproducible |
| `AUDIT.md` | The security review |
| `src/` | The fork. This is what you load |

Commit history mirrors that order: import, then audit, then fork. The `src/` commit diffs against
code that was already reviewed.

## Install

```
chrome://extensions  →  enable Developer mode  →  Load unpacked  →  select src/
```

Confirm at `chrome://extensions/shortcuts` that `Ctrl+Q` is bound (macOS: `MacCtrl+Q`, i.e. the
physical Control key, not Command). Chrome sometimes leaves a suggested shortcut unassigned when
another extension holds it.

Chrome will silently skip a suggested shortcut that another extension already claims, leaving the
command unbound — if `chrome.commands.getAll()` reports an empty `shortcut`, assign it by hand in
that UI. On ordinary web pages the in-page fallback below covers that case anyway, but binding it
properly is what makes the shortcut work on the new tab page and other internal pages.

Wanted **`Ctrl+Tab`**? Chrome will not bind it — but an OS-level remapper that rewrites `Ctrl+Tab`
to the bound shortcut before Chrome sees it does work, and combines with the layout handling below.
[docs/ctrl-tab.md](docs/ctrl-tab.md) has a working Karabiner-Elements rule and records everything
that was tried inside Chrome first.

## Keyboard layouts

Chrome matches its shortcut accelerators against the *character* the active keyboard layout
produces. Bind `Ctrl+Q` while typing English, switch your input language to Hebrew, Russian, Greek,
or anything else that does not put `q` on that key, and Chrome no longer sees `Ctrl+Q` — the command
simply stops firing.

This fork works around that. Alongside Chrome's accelerator, the content script watches for the same
combination using `KeyboardEvent.code`, which identifies the physical key position and does not
change with the layout. The key next to `Tab` triggers the switcher whatever it happens to type.

Consequences worth knowing:

- Both paths can fire for one keypress. The service worker collapses triggers of the same command
  arriving within 50 ms, which is far below a human double-tap and far above the millisecond gap
  between the two paths.
- The fallback runs in the page, so it is unavailable exactly where content scripts are — on
  `chrome://` pages, the Web Store, other extensions' pages, and the PDF viewer. Chrome's own
  accelerator is the only thing that works there, which is why binding it still matters.
- The matcher is derived from whatever shortcut is actually bound, and falls back to the manifest's
  suggestion when Chrome has bound nothing. Rebinding at `chrome://extensions/shortcuts` fires no
  event, so the new binding is picked up when you next open the extension popup, or at the next
  browser start.
- Physical positions mean a remapped *layout* like Dvorak or Colemak triggers on the key where
  QWERTY puts `Q`, not on wherever that layout prints `q`. This is the right behaviour for switching
  input languages and the wrong one for a permanently remapped layout; rebind to suit.

Prefer to avoid the whole problem instead? Bind a key that is identical in every layout — a digit,
`Space`, an arrow, `Home`/`End`/`PageUp`/`PageDown`. Note that `Ctrl+Space` is a poor choice on
macOS: it is the system shortcut for switching input source, which is the very thing you would be
switching.

**Reload your open tabs after reloading the extension.** Tabs keep running the content script from
the version that was loaded when they were opened, and reloading the extension leaves those
instances alive but unable to talk to the service worker. They now detect that and unhook
themselves, so the page behaves normally — but the switcher does not work in those tabs until they
are reloaded.

No build step. `src/` is loadable as-is — for 32 KB of dependency-free code, a toolchain would be
more to maintain than it saves.

## Privacy: it screenshots your tabs

On every tab switch and page load the extension calls `captureVisibleTab` and keeps a low-quality
JPEG so the switcher can show previews. That includes your email, your bank, and anything else you
have open.

Verified about those images: they never touch the network, they live only in
`chrome.storage.session` (in-memory, discarded when Chrome closes), they are never synced, and since
the shadow root here is closed, web pages cannot read them.

To turn it off, delete or gate `captureScreenshot()` in [src/background.js](src/background.js) — the
single capture site, kept in one place for exactly this reason. You lose thumbnails and nothing
else; the switcher falls back to favicons.

## Changes from upstream

Behaviour is intentionally unchanged. The differences are the three audit findings plus source
readability.

**Security**

- Overlay shadow root is `closed`, not `open`. Upstream let any script on the host page read
  `host.shadowRoot` and pull the titles, URLs, and screenshots of every other tab while the switcher
  was up. This is the one fix that closes a reachable hole.
- Every interpolated value is escaped. Upstream escaped tab titles but not `favIconUrl`, which is
  equally page-controlled.
- `content.js` dropped from `web_accessible_resources`. `executeScript` with `files:` does not need
  it; only the images do.

**Store decoupling**

- `update_url` removed, so it can never pull a new version from the Web Store.
- `_metadata/verified_contents.json` (Google's signing manifest) dropped.
- Renamed, so it is visibly not the store extension. No `key`, so Chrome derives a fresh ID.

**Behaviour**

- **The shortcut survives a change of input language.** See [Keyboard layouts](#keyboard-layouts)
  above — a `KeyboardEvent.code` matcher in the content script backs up Chrome's accelerator, which
  is character-based and stops matching under a non-Latin layout. The same fallback keeps the
  switcher usable when Chrome has left the command unbound.

**Correctness**

Mostly bugs inherited from upstream, found while porting or during review.

- **Highlight no longer slides after closing a tab.** Closing an entry *above* the highlight shifted
  everything down but only clamped `selectedIndex`, so releasing the modifier switched to a
  different tab than the highlighted one.
- **`onMessage` returns `true` instead of a Promise.** Chrome ignores a returned Promise, so the
  reply channel closed immediately, the content script's close-failure handling was dead code, and
  worker rejections went unhandled. The worker now replies `{ok}` explicitly.
- **Screenshots are scoped to the right window.** Capture resolved the window via
  `chrome.windows.getCurrent()` (the *focused* one) while the tab id came from `onActivated`, which
  fires for background windows too — so activity in a background window could screenshot the
  foreground one and file it under the wrong tab.
- **The "overlay is open" flag expires.** It suppresses screenshotting while the switcher is up, but
  a page torn down mid-overlay never cleared it, silently disabling thumbnails for the rest of the
  browser session. Now timestamped and expired after 15s.
- **Re-injection after an extension update works.** The content script tears down a previous
  instance rather than bailing out on an "already loaded" flag — the isolated world survives an
  update while its `chrome.runtime` listeners do not, so bailing out would leave every open tab
  without a working switcher.
- **Outside-click dismissal actually works.** The guard tested `event.target.closest('.overlay')`
  from a window listener, but shadow-DOM retargeting rewrites the target to the host, so it never
  matched. Now compared against the host.
- **Rapid `Ctrl+Q` presses no longer race.** A second press arriving while the first was still
  awaiting storage restarted the overlay instead of advancing the highlight.
- **SVG documents recover their `viewBox`.** Re-rendering remounted the overlay and re-saved an
  already-blanked `viewBox`, permanently breaking the page's scale.
- **Blank shortcut pill fixed.** `chrome.commands` reports an unassigned command as `""`, so the
  `??` fallback never fired.
- Dropped a `chrome.windows.getCurrent()` fallback in the content script — that API is unavailable
  to content scripts, so the branch could only ever have thrown.
- Dropped tracked `activeTabId` module state; an MV3 worker is terminated after ~30s idle, so it was
  reset to 0 between events. The active tab is now queried live.
- `chrome.action.openPopup()` moved ahead of the `await`s in the install handler, where it is still
  honoured.
- Theme lookup falls back to the default instead of throwing on an unrecognised colour.
- Image `error` handler attached once at construction rather than on every render.
- Debug `console.log` calls removed; `console.warn` on genuine failures kept.

## Re-verifying

The greps behind the audit, to run yourself:

```bash
# No network egress anywhere in the fork
grep -rnE 'fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts' src/

# No dynamic code execution (the only hit should be the comment in content.js
# explaining why DOMParser is used instead of innerHTML)
grep -rnE '\beval\(|new Function|document\.write|innerHTML|insertAdjacentHTML' src/

# Every URL literal (the only hits should be Web Store classification and SVG namespaces)
grep -rnE '(https?|ws|wss)://[^"'"'"' )<>`]*' src/

# Reproduce the unpack from the .crx and confirm vendor/ is untampered
shasum -a 256 -c vendor/tab-flick-0.2.0.crx.sha256
python3 tools/unpack-crx.py vendor/tab-flick-0.2.0.crx /tmp/verify && diff -r /tmp/verify vendor/tab-flick-0.2.0
```

Runtime check, which catches what static review cannot: open DevTools on both the service worker
(via the extension card's "service worker" link) and an ordinary tab, watch the Network panel, and
exercise the switcher. There should be zero outbound requests.

## Known limits

- **The overlay cannot appear on `chrome://` pages, the Web Store, or other extensions' pages.**
  Chrome forbids content scripts there. Pressing `Ctrl+Q` on such a tab switches to a tab that *can*
  host the overlay and draws it there, so you see a tab change before the switcher appears. Platform
  limit, not a bug.
- Fullscreen is exited when the switcher opens, since a fullscreen element would cover it.
- Tabs are scoped to the current window.
- The overlay renders other tabs' favicons, so opening it issues favicon requests to those origins
  from the current page. Inherent to showing favicons at all.
- The in-page fallback calls `preventDefault()` on the shortcut, so a page that wanted that
  combination for itself no longer receives it.

## Upstream

Eugene Gluhotorenko · e.gluhotorenko@gmail.com · v0.2.0, published 2025-10-30.
Credit for the design and implementation is theirs; this fork is a reviewed copy, not original work.
