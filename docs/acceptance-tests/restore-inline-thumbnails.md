# Restore Keeps Inline Thumbnails Only

Purpose: verify that a restored record never makes an extension page load a thumbnail from a remote address.

## Product Rules

- Thumbnails the extension generates are inline `data:image/` URLs.
- Restore keeps a thumbnail only when it is an inline `data:image/` URL. Any other value is dropped and the record shows the placeholder.
- Queue and Recall tiles on extension pages apply the same rule when rendering.

## Manual Acceptance

1. Export bookmarks as plaintext JSON.
2. Edit one record's `thumbnail` to `https://example.com/pixel.gif` and restore the file.
3. Open the Recall page with DevTools Network open.
4. Confirm the edited record shows the `IMG` placeholder and no request to `example.com` is made.
5. Confirm unedited records still show their thumbnails.

## Automated Coverage

- `tests/restore-import-preview.test.ts`: history and bookmark payload mapping keeps inline thumbnails and drops other URLs.

## Expected Result

- No restored record causes a remote thumbnail request from an extension page.
