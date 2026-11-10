# Key Backup Restore

## Purpose

Verify that encrypted captured originals have a portable recovery path before encrypted image downloads are added.

## Preconditions

- The extension is installed in a clean Brave or Chromium profile.
- The panel can capture encrypted originals.
- Browser downloads are allowed for the test profile.

## Steps

1. Open a page with at least one image and open Image Trail.
2. Create the encrypted originals key with an encryption password.
3. Select an image and capture its original bytes.
4. Export a key backup from the encrypted originals section with a separate backup password.
5. Confirm the downloaded key backup file is JSON and does not expose raw unwrapped key material.
6. Clear or reinstall the profile so IndexedDB extension data is empty.
7. Reinstall or reload the extension and open Image Trail.
8. Import the key backup JSON with the backup password.
9. Unlock encrypted originals with the original encryption password.
10. Restore the bookmark or history record that references the captured original, then preview or download the captured original.

## Expected Result

- Export succeeds only when a backup password is provided.
- Import validates the backup file and stores the restored blob key record.
- Unlock works with the original encryption password after import.
- The captured original created before export can be retrieved after restore.
- Importing with the wrong backup password fails closed and does not write a key.
- Re-importing an existing key reference is idempotent or reports that the key is already imported without duplicating it.
- Creating the encrypted originals key stores the key before the session unlocks. If the key cannot be stored, setup fails and storage stays locked.
- Setup refuses to create a second key while one exists, and the panel offers unlock instead.
- Restoring a full backup never replaces an original already stored under the same id; the summary counts those originals as kept unchanged.
- Full-backup originals are restored in bounded batches. If a batch fails, the error says how many originals were restored first, and no bookmarks are imported.
- Orphan cleanup deletes nothing while any bookmark record cannot be read, because that record could link any original.

## Manual check: restore keeps existing originals

1. Capture an original into a pin, then export a full backup.
2. Without clearing the profile, restore the same full backup and confirm the preview.
3. Confirm the summary reports the original as already stored and kept unchanged, and the pin still previews its original.

## Manual check: another device's key does not lock out local data

Restoring a key backup from a second profile must not change which password unlocks this profile's own data.

1. In profile A, create the encrypted originals key with password `alpha`, pin an image privately, and capture one original.
2. In a fresh profile B, create the encrypted originals key with password `bravo` (after step 1, so B's key is newer) and export a key backup.
3. In profile A, import profile B's key backup with its backup password.
4. Lock encrypted storage, then unlock it with `alpha`.
5. Confirm A's private pin shows its details and A's captured original previews or downloads.
6. Lock again, unlock with a password neither key uses, and confirm the panel reports the password did not unlock and stays locked.
7. Repeat steps 1-5 with both profiles using the same password, and confirm A's private pin and original still open and a new capture in A previews afterwards.

Expected: A's own password unlocks A's key whether or not B's newer key shares that password, and A's key stays the one new captures are sealed with. Records sealed with B's key are not readable while A's key is unlocked; unlocking with B's password, when it differs, opens B's key instead.

## Manual check: exports stay out of the host page

Automated tests run against a DOM double, so confirm this once per release in a packaged Chromium build.

1. Open a page with an image, open DevTools on that page, and run in the page console (top frame, page context):
   `window.__seen = []; for (const t of ['click', 'DOMNodeInserted']) document.addEventListener(t, (e) => { if (e.target instanceof HTMLAnchorElement) window.__seen.push([t, e.target.href]); }, true); new MutationObserver((m) => m.forEach((r) => r.addedNodes.forEach((n) => n instanceof HTMLAnchorElement && window.__seen.push(['added', n.href])))).observe(document, { childList: true, subtree: true });`
2. Export a key backup, an encrypted image export, and a plaintext bookmark export from the panel.
3. Confirm each export starts a real browser download with the expected file name and readable contents.
4. Run `window.__seen` in the page console.

Expected: `window.__seen` is empty. The page sees no download link, no click on one, and no export URL.

## Notes

- The backup contains the stored password-wrapped blob key record, not the active non-extractable `CryptoKey`.
- Encrypted image download UI should depend on this recovery path in the next slice.
