# Private Pins Stay Private

Purpose: verify that a pin stored as private is never written again as an unencrypted pin by a later save or a restore.

## Product Rules

- A URL that already has a private pin is only ever saved through encrypted storage. While encryption is locked, pinning it again changes nothing and reports the existing private pin.
- A new pin made while encryption is locked or unavailable still falls back to an unencrypted pin and says so; that fallback is unchanged.
- Bookmark exports and backups mark which pins were private.
- Restore saves a marked pin encrypted regardless of the pin storage setting. If encryption is locked, the pin is left out and the completion message says how many were not restored and to unlock and restore again.

## Manual Acceptance

1. Unlock encryption, set pin storage to encrypted, and pin image A.
2. Lock encryption and pin image A again. Unlock and confirm the Queue shows one record for A.
3. Export bookmarks. Confirm A's entry carries a `protectedPin` marker.
4. Clear the Queue, lock encryption, and restore the export.
5. Confirm the message reports one private pin not restored and A is absent from the Queue.
6. Unlock encryption and restore again. Confirm A is restored as a private pin.

## Automated Coverage

- `tests/indexeddb-private-pin-custody.test.ts`: locked re-pin writes no second row; a required-encrypted save fails while locked and ignores the plaintext preference when unlocked; export marks private pins; restore skips and counts them when the store cannot encrypt.

## Expected Result

- No unencrypted copy of a private pin is created by re-pinning or restoring.
