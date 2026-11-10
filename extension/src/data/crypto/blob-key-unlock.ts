import { activateWrappedBlobKey } from './blob-keyring.js';
import type { StoredKeyRecord } from './types.js';
import type { SessionInactivityTimeoutMinutes } from '../runtime/session-unlock.js';

/**
 * Orders stored blob keys for a password unlock: keys created on this device before keys
 * imported from a backup, then oldest first, with the reference as a stable tie-break. The
 * first key the password opens becomes the sealing key, so a newer key restored from another
 * device's backup never displaces this device's own key. Imported keys from releases that did
 * not stamp `importedAt` are indistinguishable from local ones and fall back to oldest first.
 */
export function orderBlobKeysForUnlock(keys: readonly StoredKeyRecord<'blob'>[]): StoredKeyRecord<'blob'>[] {
  return [...keys].sort(
    (left, right) =>
      Number(left.importedAt !== undefined) - Number(right.importedAt !== undefined) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.reference.localeCompare(right.reference),
  );
}

/**
 * Tries each candidate in order and activates the first one the password unwraps. A failed
 * unwrap throws before the session is touched, so nothing is unlocked unless a key matches.
 */
export async function activateFirstMatchingBlobKey(
  candidates: readonly StoredKeyRecord<'blob'>[],
  password: string,
  timeoutMinutes: SessionInactivityTimeoutMinutes,
): Promise<StoredKeyRecord<'blob'> | null> {
  for (const candidate of candidates) {
    try {
      await activateWrappedBlobKey(candidate, password, timeoutMinutes);
      return candidate;
    } catch {
      // Wrong password for this key (or unusable wrapping metadata); try the next one.
    }
  }
  return null;
}
