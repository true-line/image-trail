# Panel Password Entry Is Isolated

## Purpose

Verify that passwords entered while the panel is open on a website are typed into an extension-owned frame, so the website cannot observe the keystrokes.

## Preconditions

- The extension is installed in a clean Brave or Chromium profile from a packaged build.
- A page with at least one image is open and Image Trail is open on it.

## Steps

1. Open DevTools on the page and run in the page console (top frame, page context):
   `window.__keys = []; for (const t of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input']) window.addEventListener(t, (e) => window.__keys.push([t, e.key ?? e.data]), true);`
2. Open Settings, then Encrypted originals, click into the password field and type a new password.
3. Press Enter (or use **Create first key**) and confirm the key is created.
4. Lock encrypted originals, then unlock with the same password from the workspace lock screen.
5. Type a password into each of: Key backup, Encrypted export password, Encrypted import password, Cloud backup password.
6. Run `window.__keys` in the page console.
7. Repeat steps 2–4 on a site with a strict Content-Security-Policy (for example a GitHub page).
8. Open the Library (extension page) while locked and unlock it there.

## Expected Result

- `window.__keys` contains none of the typed password characters.
- Each password field accepts typing, shows the placeholder, and looks like the other panel inputs.
- Create, unlock, export and import actions use the typed password; Enter submits in the encrypted originals field and on the lock screen.
- After an action that consumes a password, the field is empty.
- A disabled field cannot be typed into.
- Password entry works on the strict-CSP site.
- The Library lock screen (an extension page) still uses an ordinary password input and unlocks.

## Notes

- The frame is `src/password-field/field.html`. It sends the value to the panel with extension messaging (`chrome.tabs.sendMessage`), never `postMessage`.
- The lock-screen field no longer takes focus automatically on a website; click into it first.
