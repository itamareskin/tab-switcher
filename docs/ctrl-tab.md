# Ctrl+Tab: not achievable

**Conclusion: you cannot bind this extension to `Ctrl+Tab` on Chrome 151.** Tested 2026-08-19 on
macOS, Chrome 151.0.7922.140. This page records what was tried so the same ground is not re-covered.

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

## What to do instead

Pick a key the `commands` API allows and assign it at `chrome://extensions/shortcuts` by clicking
the field and pressing the combination. Manual assignment is reliable; the manifest's `suggested_key`
is only a suggestion, and Chrome silently skips it when the combination is already claimed by
another extension — which is why the commands can show up unbound after a fresh install.

`Q` sits directly above `Tab` on QWERTY, so `MacCtrl+Q` (this fork's default, and upstream's) keeps
almost the same hand position as the `Ctrl+Tab` you were after.
