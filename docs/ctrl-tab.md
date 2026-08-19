# Binding the switcher to Ctrl+Tab

Chrome will not let you set `Ctrl+Tab` through the normal routes, but it will honour it once
it is in the binding store. This is how to get it there.

## Why the normal routes fail

- **The manifest cannot express it.** `commands[].suggested_key` accepts only `A`–`Z`, `0`–`9`,
  `Comma`, `Period`, `Home`, `End`, `PageUp`, `PageDown`, `Space`, `Insert`, `Delete`, the arrow
  keys, and media keys. `Tab` is not on that list, so putting it in `manifest.json` is a validation
  error and the extension will not load. **Do not edit the manifest for this.**
- **The shortcuts UI rejects it.** `chrome://extensions/shortcuts` enforces the same allow-list plus
  a reserved-shortcut filter.

What is *not* blocked is the binding store itself. `chrome.developerPrivate.updateExtensionCommand`
is the internal API the shortcuts UI calls; invoking it directly skips the UI's filter, and Chrome
then dispatches the shortcut like any other user-assigned binding. The technique is not specific to
this extension — it is documented publicly by
[QuicKey](https://fwextensions.github.io/QuicKey/ctrl-tab/), whose snippet this adapts.

## Steps

1. Get the extension's ID from `chrome://extensions` with Developer mode on — it is on the card,
   under the name. Unpacked extensions derive their ID from the install path, so it changes if you
   move the directory.
2. Open `chrome://extensions/shortcuts` and open DevTools on that page (DevTools works on Chrome's
   internal pages).
3. Paste into the console, replacing `YOUR_EXTENSION_ID`:

```js
const id = "YOUR_EXTENSION_ID";

// macOS: MacCtrl is the real Control key. Plain "Ctrl" is remapped to Command,
// which macOS itself intercepts for the app switcher — that binding would never fire.
chrome.developerPrivate.updateExtensionCommand({
  extensionId: id, commandName: "next-tab", keybinding: "MacCtrl+Tab",
});
chrome.developerPrivate.updateExtensionCommand({
  extensionId: id, commandName: "prev-tab", keybinding: "MacCtrl+Shift+Tab",
});
```

On Windows or Linux use `Ctrl+Tab` and `Ctrl+Shift+Tab` instead.

4. Reload `chrome://extensions/shortcuts` and confirm the new bindings are displayed.

## Confirm the extension agrees

Displayed bindings are not quite the whole story: the content script derives the
hold-to-cycle modifier by parsing the bound shortcut string, so it matters what Chrome *reports*.
Open the service worker console from the extension's card and run:

```js
chrome.commands.getAll(console.log);
```

Check the `shortcut` field on `next-tab`. `getModifierKey()` in `background.js` takes the first
chunk — splitting on `+`, or character-by-character for the macOS glyph form — and maps it. Both
`"Ctrl+Tab"` and `"⌃Tab"` resolve to `Control`, which is what you want. If you instead see `⌘` or
`Command`, the binding landed on Command; redo step 3 with the other modifier spelling.

Then test on an ordinary web page. Content scripts do not run on `chrome://` pages, so nothing will
happen while you are still sitting on the extensions page — that is not a failure.

## Trade-offs and caveats

- **You lose native `Ctrl+Tab` / `Ctrl+Shift+Tab`** for positional next/previous tab. Replacing that
  is the point, but the fallbacks are `Cmd+Option+→` / `←` on macOS and `Ctrl+PageDown` / `PageUp`
  elsewhere.
- **The binding is as durable as any user-assigned one, and as fragile.** It lives in the profile's
  preferences, so it survives restarts — but touching this extension's row in the shortcuts UI, or
  resetting the profile, can drop it. Re-run the snippet if that happens.
- **Reinstalling from a different path changes the extension ID**, which orphans the binding.
- **Untested:** whether the `Tab` keydown still reaches the page while the overlay is open. Chrome
  should consume it in dispatching the command, but if it leaks through, focus may move underneath
  the overlay. Worth watching the first time you use it; if it happens, the fix is a
  `preventDefault()` for `Tab` in `onKeyDown` while `isOpen`.
