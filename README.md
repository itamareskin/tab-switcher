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

**Correctness**

- Re-entry guard in the content script. Upstream registered a second set of listeners if a tab
  received both the declared content script and the startup injection.
- Dropped a `chrome.windows.getCurrent()` fallback in the content script — that API is unavailable
  to content scripts, so the branch could only ever have thrown.
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

# No dynamic code execution
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

## Upstream

Eugene Gluhotorenko · e.gluhotorenko@gmail.com · v0.2.0, published 2025-10-30.
Credit for the design and implementation is theirs; this fork is a reviewed copy, not original work.
