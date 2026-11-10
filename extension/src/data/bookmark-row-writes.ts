import type { DurableBookmarkKeyContext } from './durable-bookmark-key.js';
import type { BlobsRepository } from './repositories/blobs-repository.js';
import type { BookmarksRepository } from './repositories/bookmarks-repository.js';
import type { EncryptedPinsRepository } from './repositories/encrypted-pins-repository.js';
import type { EncryptedPinThumbnailsRepository } from './repositories/encrypted-pin-thumbnails-repository.js';
import type { DurableBookmarkPayloadV1 } from './types.js';

let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs `work` after every earlier bookmark-row write in this context has settled (#946).
 *
 * Saves read a row, await WebCrypto, then write the whole row back; IndexedDB commits a
 * transaction as soon as it awaits non-IDB work, so the read and write cannot share one.
 * Every writer of bookmark, relationship, or encrypted-pin rows goes through this queue so a
 * write never lands between another writer's read and write. The queue is in memory: it
 * covers the service worker's single bookmark store, which owns all of these writes.
 * A rejected `work` releases the queue; a `work` that never settles blocks it.
 */
export function withBookmarkRowWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work);
  tail = run.catch(() => undefined);
  return run;
}

interface BookmarkRowRemovalContext {
  readonly repository: BookmarksRepository;
  readonly bookmarkKey: DurableBookmarkKeyContext;
  readonly encryptedPins: EncryptedPinsRepository;
  readonly encryptedThumbnails: EncryptedPinThumbnailsRepository;
  readonly blobs: BlobsRepository;
}

/**
 * Applies a Recall move to the relationship rows and, when `includeProtected`, to the encrypted-pin
 * rows they link, as one locked operation: two overlapping moves cannot interleave their row updates
 * and leave a pin's two rows with different queue positions.
 */
export function moveBookmarkRowsToFront(
  context: Pick<BookmarkRowRemovalContext, 'repository' | 'bookmarkKey' | 'encryptedPins'>,
  moves: readonly { readonly uuid: string; readonly queueUpdatedAt: string }[],
  includeProtected: boolean,
): Promise<Awaited<ReturnType<BookmarksRepository['updateQueueUpdatedAt']>>> {
  return withBookmarkRowWriteLock(async () => {
    const updated = await context.repository.updateQueueUpdatedAt(moves);
    if (!includeProtected) return updated;
    const protectedUpdates: Array<{ readonly id: string; readonly queueUpdatedAt: string }> = [];
    for (const update of updated) {
      try {
        const payload = await context.repository.openRecord(update, context.bookmarkKey.key);
        if (payload.protectedPin?.encryptedPinId) {
          protectedUpdates.push({ id: payload.protectedPin.encryptedPinId, queueUpdatedAt: update.queueUpdatedAt });
        }
      } catch {
        // Undecryptable relationship rows cannot be moved in the protected store.
      }
    }
    await context.encryptedPins.updateQueueUpdatedAt(protectedUpdates);
    return updated;
  });
}

/** Removes each row and its linked protected storage under the row-write lock; returns how many rows existed. */
export function removeBookmarkRows(context: BookmarkRowRemovalContext, ids: readonly string[]): Promise<number> {
  return withBookmarkRowWriteLock(async () => {
    let removedCount = 0;
    for (const id of [...new Set(ids)].filter(Boolean)) {
      const existing = await context.repository.getEncrypted(id);
      if (!existing) continue;
      try {
        const payload = await context.repository.openRecord(existing, context.bookmarkKey.key);
        await removeLinkedPinStorage(context, payload);
      } catch {
        // Still remove the relationship row if its protected side cannot be opened.
      }
      await context.repository.remove(existing.uuid);
      removedCount += 1;
    }
    return removedCount;
  });
}

async function removeLinkedPinStorage(context: BookmarkRowRemovalContext, payload: DurableBookmarkPayloadV1): Promise<void> {
  if (payload.protectedPin?.encryptedPinId) await context.encryptedPins.remove(payload.protectedPin.encryptedPinId);
  if (payload.protectedPin?.encryptedThumbnailId) await context.encryptedThumbnails.remove(payload.protectedPin.encryptedThumbnailId);
  const protectedOriginalBlobId = payload.protectedPin?.storedOriginalBlobId;
  if (protectedOriginalBlobId) {
    await context.blobs.remove(protectedOriginalBlobId);
    return;
  }
  if (payload.storedOriginal?.blobId) await context.blobs.remove(payload.storedOriginal.blobId);
}
