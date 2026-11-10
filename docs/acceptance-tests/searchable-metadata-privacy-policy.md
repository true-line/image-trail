# Searchable Metadata Privacy Policy

Purpose: prove that optional searchable metadata follows its configured at-rest policy while thumbnail bytes are always encrypted.

## Storage contract

- URL-derived metadata and album names may be configured as `plaintext` or `encrypted`.
- Thumbnail policy is always `encrypted`; Settings must not offer a plaintext thumbnail mode.
- Compatibility-path thumbnails live inside the AES-GCM bookmark relationship envelope encrypted by the durable non-extractable bookmark key.
- Protected-pin thumbnails live in the blob-key-encrypted thumbnail repository.
- A locked blob key may prevent protected storage and original-photo access, but it must never cause raw thumbnail bytes to be written to a plaintext IndexedDB field.
- The `encrypted` mode is protection against casual reading of the profile's storage, not against someone who holds the profile: the durable bookmark and metadata keys are stored in the same IndexedDB, and the URL lookup key is an unsalted SHA-256 of the URL. Settings must say so and must not present this mode as password protection. Password protection applies to private pins and stored originals.
- Legacy save requests containing `searchableMetadataPolicy.thumbnail: plaintext` are valid migration input and must persist as `encrypted`.

## Automated coverage

- `tests/thumbnail-at-rest.test.ts` saves a thumbnail while the blob key is locked, inspects the raw IndexedDB record, and recovers the thumbnail only after decrypting the bookmark envelope.
- `tests/searchable-metadata-policy.test.ts` covers defaults, guards, hashing, sanitization, and legacy policy migration.
- `tests/schema-validation.test.ts` proves the save-request boundary accepts the legacy thumbnail label.
- `tests/local-settings-handlers.test.ts` proves the accepted legacy request persists the encrypted policy.
- `tests/dom/privacy-settings-view.test.ts` and `tests/dom/extension-destination-surfaces.test.tsx` cover both Settings surfaces.
- `tests/e2e/design-baseline.spec.ts` verifies the packaged Privacy surface exposes a disabled Thumbnails control fixed to Encrypted.

## Manual release script

1. Run `npm run ci`, `npm run test:e2e`, and `npm run test:stories:ci`.
2. Load `extension/dist` as an unpacked Chromium extension and open Settings > Privacy.
3. Verify Thumbnails displays Encrypted, is disabled, and offers no plaintext option in both the panel and Settings extension page.
4. With the blob key locked, pin an image that produces a thumbnail. Verify the pin remains available after reopening the panel.
5. Inspect extension-owned IndexedDB. Verify the raw bookmark relationship record contains only the encrypted envelope and bookkeeping fields, not the thumbnail data URL or its base64 payload.
6. Inject or import a legacy settings object whose thumbnail policy is `plaintext`, save an unrelated setting, and reload Settings. Verify the save succeeds and Thumbnails displays Encrypted.

## Expected result

- No Settings surface claims thumbnails are plaintext.
- The Searchable metadata description states that the encrypted mode is not password protection.
- No locked or fallback save exposes raw thumbnail bytes at rest.
- Legacy settings remain save-compatible but normalize immediately to the encrypted-only contract.
- URL and album policy behavior, durable queue ordering, Recall, Recents, and original-photo encryption remain unchanged.
