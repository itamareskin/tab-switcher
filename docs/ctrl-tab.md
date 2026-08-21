# Ctrl+Tab: not bindable in Chrome, reachable with a remapper

**Conclusion: you cannot bind this extension to `Ctrl+Tab` from inside Chrome on Chrome 151** — not
via the manifest, not via the shortcuts UI, and not via the `developerPrivate` workaround. You *can*
get the behaviour by remapping the keystroke below the browser, which is what
[What does work](#what-does-work-remap-below-the-browser) covers.

Tested 2026-08-19 on macOS, Chrome 151.0.7922.140. This page records what was tried so the same
ground is not re-covered.

## The two normal routes are blocked by design

- **The manifest cannot express it.** `commands[].suggested_key` accepts only `A`–`Z`, `0`–`9`,
  `Comma`, `Period`, `Home`, `End`, `PageUp`, `PageDown`, `Space`, `Insert`, `Delete`, the arrow
  keys, and media keys. `Tab` is not on that list, so putting it in `manifest.json` is a validation
  error and the extension will not load. **Do not try this.**
- **The shortcuts UI rejects it.** `chrome://extensions/shortcuts` enforces the same allow-list plus
  a reserved-shortcut filter, and `Ctrl+Tab` is Chrome's own next-tab accelerator.

## The DevTools workaround does not work either

A [publicly documented technique](https://fwextensions.github.io/QuicKey/ctrl-tab/) calls
`chrome.developerPrivate.updateExtensionCommand` — the internal API behind the shortcuts UI — from
the DevTools console on `chrome://extensions/shortcuts`, on the theory that it skips the UI's filter
while Chrome still honours the resulting binding.

On Chrome 151 it does not. The call **reports success and writes nothing**:

```js
bind("next-tab", "MacCtrl+Tab");   // logs: next-tab -> MacCtrl+Tab : ok
// getExtensionsInfo afterwards still shows keybinding: '', isActive: false
```

There is no `chrome.runtime.lastError`, so the failure is silent. Critically, this is **not specific
to `Tab`** — the same call with a plainly legal key (`MacCtrl+E`) also reports `ok` and also leaves
the binding empty. The API path itself is inert, so no choice of key rescues it.

If you want to re-test on a future Chrome, the control experiment is the whole thing: bind an
*allowed* key programmatically and re-read `getExtensionsInfo`. If a boring key will not stick,
`Tab` certainly will not.

## Staying inside Chrome

If you would rather not add an OS-level remapper, pick a key the `commands` API allows and assign it at `chrome://extensions/shortcuts` by clicking
the field and pressing the combination. Manual assignment is reliable; the manifest's `suggested_key`
is only a suggestion, and Chrome silently skips it when the combination is already claimed by
another extension — which is why the commands can show up unbound after a fresh install.

`Q` sits directly above `Tab` on QWERTY, so `MacCtrl+Q` (this fork's default, and upstream's) keeps
almost the same hand position as the `Ctrl+Tab` you were after.

## What does work: remap below the browser

Everything above concerns getting *Chrome* to bind `Tab`. An OS-level remapper sidesteps the
question entirely — it rewrites the event before Chrome ever sees it, so Chrome only ever handles a
key it is willing to bind, and Chrome's reservation of `Ctrl+Tab` for "next tab" never comes into
play either.

With Karabiner-Elements, scoped to Chrome so the rest of the system is untouched:

```json
{
  "description": "Ctrl+Tab / Ctrl+Shift+Tab cycle tabs via Tab Switcher",
  "manipulators": [
    {
      "type": "basic",
      "conditions": [
        { "type": "frontmost_application_if", "bundle_identifiers": ["^com\\.google\\.Chrome$"] }
      ],
      "from": { "key_code": "tab", "modifiers": { "mandatory": ["control"] } },
      "to": [{ "key_code": "q", "modifiers": ["left_control"] }]
    }
  ]
}
```

Karabiner works in HID usage codes, so `key_code: q` means *the physical Q key*, not "whatever types
q". It emits physical-Q regardless of input language — which pairs exactly with the
`KeyboardEvent.code` matcher described below.

Note that this does **not** by itself survive a language switch. Karabiner emits physical-Q; macOS
then applies the input source, so under Hebrew that key produces `/` and Chrome's own accelerator
sees `Ctrl+/`, not `Ctrl+Q`. The remapper solves `Tab`; the in-page matcher solves the layout. Both
are needed for `Ctrl+Tab` to work in every language.

One thing to verify on any such setup: Karabiner consumes the `mandatory` modifier and re-posts it
with the `to` event, and hold-to-cycle depends on Control staying down across taps. If a `keyup` for
Control appears between taps, the switcher will commit and close after the first one. Check with:

```js
addEventListener('keydown', e => console.log('down', e.code, e.ctrlKey, e.repeat), true);
addEventListener('keyup',   e => console.log('up  ', e.key), true);
```

Hold Control and tap Tab a few times. Wanted: repeated `down KeyQ true false` with a single
`up Control` at the end.

## Does the in-page fallback rescue it?

The fork now also matches the shortcut inside the page, on `KeyboardEvent.code`, so that a change of
input language does not break it — see the *Keyboard layouts* section of the README. That matcher is
not restricted to the `commands` API's key list, so `Ctrl+Tab` would be expressible.

**Untested, and expected not to work.** Chrome reserves `Ctrl+Tab` as a browser-level shortcut for
"next tab", and reserved combinations are handled in the browser process without being delivered to
the renderer — a page cannot see or `preventDefault()` them. If that holds, the content script never
receives the keydown and there is nothing to match.

Worth thirty seconds if you care: run `addEventListener('keydown', e => console.log(e.code, e.ctrlKey))`
in a page console and press Control+Tab. If it logs, this is achievable without a remapper after all.
The remapper route above does not depend on the answer, since it never lets Chrome see `Tab`.
