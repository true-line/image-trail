import type { BookmarksRepository } from './repositories/bookmarks-repository.js';

export interface OriginalBlobReferences {
  readonly ids: ReadonlySet<string>;
  /**
   * Rows whose linked original is unknown: undecryptable, or quarantined by schema validation.
   * The blob link lives only inside the encrypted payload, so any such row could reference any original.
   */
  readonly unreadableCount: number;
}

/** Collects the original blob ids that durable bookmark rows reference, counting rows that cannot be read. */
export async function collectOriginalBlobReferences(repository: BookmarksRepository, key: CryptoKey): Promise<OriginalBlobReferences> {
  const records = await repository.listEncryptedNewestFirst();
  const ids = new Set<string>();
  let unreadableCount = Math.max(0, (await repository.countEncrypted()) - records.length);
  for (const record of records) {
    const payload = await repository.openRecord(record, key).catch(() => null);
    if (!payload) unreadableCount += 1;
    if (payload?.storedOriginal?.blobId) ids.add(payload.storedOriginal.blobId);
    if (payload?.protectedPin?.storedOriginalBlobId) ids.add(payload.protectedPin.storedOriginalBlobId);
  }
  return { ids, unreadableCount };
}
