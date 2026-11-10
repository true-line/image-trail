import { sha256 } from '../../core/interop/transport.js';
import type { EncryptedBookmarkRecord } from '../repositories/bookmarks-repository.js';
import type { EncryptedPinRecord } from '../repositories/encrypted-pins-repository.js';

/**
 * The sealed bytes of a Move source: the bookmark row and, for a protected pin, its encrypted-pin row.
 * Every re-seal draws a fresh IV, so any edit or original capture changes this even when the
 * envelope `updatedAt` is deliberately reused (queue order must not depend on it).
 */
export function moveSourceSealedMaterial(bookmark: EncryptedBookmarkRecord, pin?: EncryptedPinRecord | undefined): string {
  return JSON.stringify([bookmark.envelope.iv, bookmark.envelope.ciphertext, pin?.envelope.iv ?? null, pin?.envelope.ciphertext ?? null]);
}

export function moveSourceFingerprint(bookmark: EncryptedBookmarkRecord, pin?: EncryptedPinRecord | undefined): Promise<string> {
  return sha256(new TextEncoder().encode(moveSourceSealedMaterial(bookmark, pin)));
}
