import { ensureDurableBookmarkKey } from '../durable-bookmark-key.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { BookmarksRepository, type EncryptedBookmarkRecord } from '../repositories/bookmarks-repository.js';
import { EncryptedPinsRepository, type EncryptedPinRecord } from '../repositories/encrypted-pins-repository.js';
import { KeysRepository } from '../repositories/keys-repository.js';
import { DataStore } from '../schema.js';
import type { StoredBlobRecord } from '../types.js';
import { moveSourceFingerprint, moveSourceSealedMaterial } from './move-source-fingerprint.js';

const FINALIZATION_STORES = [
  DataStore.Bookmarks,
  DataStore.EncryptedPins,
  DataStore.EncryptedPinThumbnails,
  DataStore.Blobs,
  DataStore.OriginalBlobIndex,
];

const SOURCE_CHANGED = 'Move source changed after review; finalization was stopped.';

/**
 * Deletes a Move source only while it is byte-for-byte the record that was reviewed. A review recorded
 * without a fingerprint (made before fingerprints existed) cannot prove that, so it never deletes.
 */
export async function finalizeInteropMoveSource(
  db: IDBDatabase,
  sourceLocalId: string,
  reviewedSourceUpdatedAt: string,
  reviewedSourceFingerprint?: string | undefined,
): Promise<boolean> {
  const bookmarks = new BookmarksRepository(db);
  const encrypted = await bookmarks.getEncrypted(sourceLocalId);
  if (!encrypted) return false;
  const key = await ensureDurableBookmarkKey(new KeysRepository(db));
  const payload = await bookmarks.openRecord(encrypted, key.key);
  const encryptedPinId = payload.protectedPin?.encryptedPinId;
  const encryptedPin = encryptedPinId ? await new EncryptedPinsRepository(db).get(encryptedPinId) : undefined;
  if (reviewedSourceFingerprint === undefined || reviewedSourceFingerprint !== (await moveSourceFingerprint(encrypted, encryptedPin))) {
    throw new Error(SOURCE_CHANGED);
  }
  const transaction = db.transaction(FINALIZATION_STORES, 'readwrite');
  const bookmarkStore = transaction.objectStore(DataStore.Bookmarks);
  const current = await requestToPromise<EncryptedBookmarkRecord | undefined>(bookmarkStore.get(sourceLocalId));
  const currentPin = encryptedPinId
    ? await requestToPromise<EncryptedPinRecord | undefined>(transaction.objectStore(DataStore.EncryptedPins).get(encryptedPinId))
    : undefined;
  if (
    !current ||
    current.envelope.updatedAt !== encrypted.envelope.updatedAt ||
    current.envelope.updatedAt !== reviewedSourceUpdatedAt ||
    moveSourceSealedMaterial(current, currentPin) !== moveSourceSealedMaterial(encrypted, encryptedPin)
  ) {
    transaction.abort();
    throw new Error(SOURCE_CHANGED);
  }
  if (payload.protectedPin?.encryptedPinId) transaction.objectStore(DataStore.EncryptedPins).delete(payload.protectedPin.encryptedPinId);
  if (payload.protectedPin?.encryptedThumbnailId) {
    transaction.objectStore(DataStore.EncryptedPinThumbnails).delete(payload.protectedPin.encryptedThumbnailId);
  }
  const blobId = payload.protectedPin?.storedOriginalBlobId ?? payload.storedOriginal?.blobId;
  if (blobId) await removeBlobReference(transaction, blobId);
  bookmarkStore.delete(sourceLocalId);
  await transactionDone(transaction);
  return true;
}

async function removeBlobReference(transaction: IDBTransaction, blobId: string): Promise<void> {
  const blobs = transaction.objectStore(DataStore.Blobs);
  const existing = await requestToPromise<StoredBlobRecord | undefined>(blobs.get(blobId));
  if (!existing) return;
  if (existing.referenceCount <= 1) {
    blobs.delete(blobId);
    transaction.objectStore(DataStore.OriginalBlobIndex).delete(blobId);
  } else {
    blobs.put({ ...existing, referenceCount: existing.referenceCount - 1 } satisfies StoredBlobRecord);
  }
}
