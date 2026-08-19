# Fork Tab Flick into an audited, self-owned extension

## Context

Tab Flick is a Chrome Web Store extension (`kdddoanokjocdkbkmgnkkcemjepknlgm`, v0.2.0, 32.41 KiB,
updated 2025-10-30, ~1,000 users) that reimplements Alt+Tab-style switching for browser tabs:
hold Ctrl+Q, keep tapping to cycle through recently-used tabs, release to jump. Its store listing
declares it "will not collect or use your data."

The point of this exercise is to stop trusting that declaration — and, more importantly, to stop
trusting the developer's *future* updates. A store extension auto-updates silently; a benign v0.2.0
can become something else in v0.3.0 without any action from you. Taking a local, audited copy
freezes the code at a version you have personally read.

The original has **never been installed on this machine**. Nothing from this package runs until the
audit in Phase 3 comes back clean. That ordering is the whole value of the exercise, so it is a hard
gate, not a formality.

Outcome: a git repository containing a pristine vendor snapshot of the shipped package, a written
audit, and a readable source tree that you own and can extend.

## Target structure

```
tab-switcher/
├── README.md                     # what this is, how to load it, how to re-verify
├── AUDIT.md                      # the security review (Phase 3 output)
├── tools/
│   └── unpack-crx.py             # CRX3/CRX2 header stripper, kept for reproducibility
├── vendor/
│   ├── tab-flick-0.2.0.crx       # the exact bytes Google served, + recorded sha256
│   └── tab-flick-0.2.0/          # pristine unpack, never edited
└── src/                          # the fork — this is what gets loaded unpacked
    ├── manifest.json
    ├── ...                       # names follow whatever the original ships
    └── icons/
```

`vendor/` is committed untouched and never edited again. Every later change of yours is then a clean
`git diff` against the code that was actually audited.

## Phase 1 — Acquire

```bash
curl -L -o vendor/tab-flick-0.2.0.crx \
  'https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=135.0.0.0&x=id%3Dkdddoanokjocdkbkmgnkkcemjepknlgm%26uc'
shasum -a 256 vendor/tab-flick-0.2.0.crx | tee vendor/tab-flick-0.2.0.crx.sha256
```

Sanity checks before going further: file is ~32 KB (matching the listing — a wildly different size
means the endpoint served something unexpected), and `head -c 4` is the magic `Cr24`. If curl
returns HTML instead, the redirect was not followed or the ID is wrong; do not proceed.

## Phase 2 — Unpack

Write `tools/unpack-crx.py` rather than relying on `unzip` tolerating the prepended header, so the
step is reproducible and version-aware:

- Bytes 0–4: magic `Cr24`; bytes 4–8: format version (LE uint32).
- **CRX3** (version 3): bytes 8–12 are the header length; the zip archive begins at `12 + header_len`.
- **CRX2** (version 2): bytes 8–12 public-key length, 12–16 signature length; zip begins at
  `16 + pk_len + sig_len`.
- Slice from that offset, feed to `zipfile.ZipFile`, extract to `vendor/tab-flick-0.2.0/`.

Then, before reading anything:

```bash
find vendor/tab-flick-0.2.0 -type f | sort
wc -c $(find vendor/tab-flick-0.2.0 -type f -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.css')
```

Reconcile the file list against the 32 KB total. **A file that is large relative to the whole
package, or one nobody would expect (a bundled library, a `.wasm`, an oversized JSON), is the first
thing to read, not the last.**

## Phase 3 — Audit (the gate)

Read every shipped `.js`, `.json`, `.html`, and `.css` file in full. At this size that is a single
sitting; do not skim and do not rely solely on greps — greps confirm suspicions, reading finds them.
Greps are for proving a *negative* across the whole tree.

**Manifest.** `permissions` and `host_permissions` (a tab switcher needs `tabs` and probably
`storage`; `<all_urls>`, `webRequest`, `cookies`, `history`, `management`, or `debugger` would each
demand a specific justification), `content_scripts.matches` breadth, `content_security_policy`
(any `unsafe-eval` / remote script source is disqualifying), `externally_connectable` (lets other
sites message the extension), `web_accessible_resources`, and `background.service_worker`.

**No network egress.** Prove absent across the tree:
`fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `importScripts`,
`navigator.connection`, `new Image` with an assigned `.src`, `<form action>`, `<link>`/`<script>`
pointing off-origin, and any literal `http://` or `https://` URL. Every URL literal found gets
explained or the fork does not ship.

**No dynamic code.** `eval(`, `new Function(`, string-valued `setTimeout`/`setInterval`,
`document.write`, `innerHTML`/`outerHTML`/`insertAdjacentHTML` assignment,
`document.createElement('script')`, and `chrome.scripting.executeScript` with anything other than a
local file or a static function.

**No obfuscation.** Long hex/base64 string literals, string-array-plus-index decoders,
`String.fromCharCode` / `atob` chains, or minified code that does not correspond to plausible
hand-written source. Obfuscation in a 32 KB tab switcher has no legitimate explanation and by itself
fails the audit.

**Data handling.** The extension necessarily sees tab titles and URLs. Trace where those values go:
rendering into the overlay is expected; `chrome.storage.sync`, serialization, or accumulation into a
long-lived list is not, and anything leaving the process is disqualifying.

**Behavior matches the claim.** Confirm the keyup/keydown/overlay logic is what the listing
describes: a `chrome.commands` handler for Ctrl+Q, MRU ordering maintained from `chrome.tabs`
events, cycling on repeat presses, commit on modifier release, `chrome.tabs.update` to activate.
Note anything the code does that the listing never mentions.

Findings go to `AUDIT.md`: what was checked, what was found, verbatim quotes for anything
questionable, and an explicit verdict.

**Gate.** Clean → Phase 4. Anything unexplained → stop, report, and we decide together whether to
strip it or abandon the fork. Nothing is loaded into Chrome before this verdict.

## Phase 4 — Build the source tree

Copy `vendor/` → `src/`, then:

1. **Strip store coupling.** Delete `_metadata/` (Google's `verified_contents.json`, which breaks or
   confuses load-unpacked). Remove `key` from the manifest so Chrome derives a fresh extension ID
   rather than reusing the store one, and remove `update_url` if present so it can never phone the
   store for an update. These two lines are the difference between a fork and a mirror.
2. **Make it readable.** If the shipped JS is minified or bundled, reconstruct it into readable
   source — real names, sensible line breaks, split by responsibility (MRU tracking / command
   handling / overlay rendering). If it already ships readable, just normalize formatting. Add
   comments explaining the non-obvious parts you had to work out during the audit; that
   understanding is the asset here and it evaporates if not written down.
3. **Rename** to distinguish it from the original — manifest `name` and `description`, and reset
   `version` to `0.2.0` as the inherited baseline.
4. Keep Ctrl+Q as the default `commands` binding. Since the original was never installed, there is
   no shortcut conflict to work around.

No build step or bundler: `src/` stays directly loadable as an unpacked extension. Introducing a
toolchain for 32 KB of dependency-free code would add more to maintain than it saves.

## Phase 5 — Git

```bash
git init
```

Three commits, in this order, so history itself records the provenance:

1. `vendor/` + `tools/` — "Import Tab Flick 0.2.0 from Chrome Web Store (unmodified)", with the
   sha256 in the commit message.
2. `AUDIT.md` — the review of exactly that snapshot.
3. `src/` — "Fork: readable source tree", which now diffs cleanly against the audited original.

## Verification

1. `chrome://extensions` → Developer mode → **Load unpacked** → `src/`. It must load with no errors
   and no warnings in the extension card.
2. Confirm at `chrome://extensions/shortcuts` that Ctrl+Q is bound to the fork.
3. Open ~6 tabs and exercise the real behavior: tap Ctrl+Q → jumps to previous tab; hold Ctrl and
   tap Q repeatedly → cycles back through MRU order; release → lands on the highlighted tab.
4. Edge cases worth trying, since these are where a small extension usually breaks: a single-tab
   window, a pinned tab, two windows, and a `chrome://` or Web Store tab — content scripts are
   forbidden on those pages, so the overlay cannot render there. Note the actual behavior in
   `README.md` rather than treating it as a bug to fix; it is a platform limit.
5. Inspect the service worker console and the page console for errors during all of the above.
6. Final egress check with the extension actually running: open DevTools → Network on the service
   worker and on a normal tab, exercise the switcher, and confirm zero outbound requests. This
   catches at runtime what static review could have missed.
