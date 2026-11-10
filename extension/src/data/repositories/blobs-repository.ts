import * as v from 'valibot';
import type { StorageUsageSummary } from '../../core/image/capture-result.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { DataStore, SchemaIndex } from '../schema.js';
import type { StoredBlobRecord } from '../types.js';
import { storedBlobRecordSchema } from '../types.schema.js';
import { hydrateRecord, hydrateRecords } from './hydration.js';

export class BlobsRepository {
  constructor(private readonly db: IDBDatabase) {}

  async put(record: StoredBlobRecord): Promise<StoredBlobRecord> {
    const transaction = this.db.transaction([DataStore.Blobs, DataStore.OriginalBlobIndex], 'readwrite');
    transaction.objectStore(DataStore.Blobs).put(record);
    const originalBlobIndex = transaction.objectStore(DataStore.OriginalBlobIndex);
    const parsed = v.safeParse(storedBlobRecordSchema, record);
    if (parsed.success && parsed.output.kind === 'original') originalBlobIndex.put({ id: parsed.output.id });
    else originalBlobIndex.delete(record.id);
    await transactionDone(transaction);
    return record;
  }

  /** Stores `record` only when no blob has its id, checking and writing in one transaction. Returns whether it was stored. */
  async putIfAbsent(record: StoredBlobRecord): Promise<boolean> {
    const transaction = this.db.transaction([DataStore.Blobs, DataStore.OriginalBlobIndex], 'readwrite');
    const done = transactionDone(transaction);
    const blobs = transaction.objectStore(DataStore.Blobs);
    const absent = (await requestToPromise<IDBValidKey | undefined>(blobs.getKey(record.id))) === undefined;
    if (absent) {
      blobs.put(record);
      const parsed = v.safeParse(storedBlobRecordSchema, record);
      if (parsed.success && parsed.output.kind === 'original') transaction.objectStore(DataStore.OriginalBlobIndex).put({ id: record.id });
    }
    await done;
    return absent;
  }

  async get(id: string): Promise<StoredBlobRecord | undefined> {
    const transaction = this.db.transaction(DataStore.Blobs, 'readonly');
    const result = await requestToPromise<unknown>(transaction.objectStore(DataStore.Blobs).get(id));
    await transactionDone(transaction);
    return hydrateRecord(DataStore.Blobs, storedBlobRecordSchema, result);
  }

  async findMissingOriginalIds(ids: readonly string[]): Promise<readonly string[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];

    const transaction = this.db.transaction(DataStore.OriginalBlobIndex, 'readonly');
    const store = transaction.objectStore(DataStore.OriginalBlobIndex);
    const keys = await Promise.all(uniqueIds.map((id) => requestToPromise<IDBValidKey | undefined>(store.getKey(id))));
    await transactionDone(transaction);
    return uniqueIds.filter((_id, index) => keys[index] === undefined);
  }

  async list(): Promise<readonly StoredBlobRecord[]> {
    const transaction = this.db.transaction(DataStore.Blobs, 'readonly');
    const result = await requestToPromise<unknown[]>(transaction.objectStore(DataStore.Blobs).getAll());
    await transactionDone(transaction);
    return hydrateRecords(DataStore.Blobs, storedBlobRecordSchema, result);
  }

  async listOriginalCleanupCandidates(): Promise<readonly { readonly id: string; readonly createdAt: string }[]> {
    const transaction = this.db.transaction([DataStore.Blobs, DataStore.OriginalBlobIndex], 'readonly');
    const done = transactionDone(transaction);
    const originalKeys = requestToPromise<IDBValidKey[]>(transaction.objectStore(DataStore.OriginalBlobIndex).getAllKeys());
    const createdAtKeys = new Promise<readonly { readonly id: string; readonly createdAt: string }[]>((resolve, reject) => {
      const candidates: { id: string; createdAt: string }[] = [];
      const request = transaction.objectStore(DataStore.Blobs).index(SchemaIndex.BlobsByCreatedAt).openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(candidates);
          return;
        }
        if (typeof cursor.primaryKey === 'string' && typeof cursor.key === 'string') {
          candidates.push({ id: cursor.primaryKey, createdAt: cursor.key });
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    const [keys, candidates] = await Promise.all([originalKeys, createdAtKeys]);
    await done;
    const originalIds = new Set(keys.filter((key): key is string => typeof key === 'string'));
    return candidates.filter((candidate) => originalIds.has(candidate.id));
  }

  async remove(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;

    const transaction = this.db.transaction([DataStore.Blobs, DataStore.OriginalBlobIndex], 'readwrite');
    const store = transaction.objectStore(DataStore.Blobs);
    if (existing.referenceCount <= 1) {
      store.delete(id);
      transaction.objectStore(DataStore.OriginalBlobIndex).delete(id);
    } else {
      const updated: StoredBlobRecord = { ...existing, referenceCount: existing.referenceCount - 1 };
      store.put(updated);
    }
    await transactionDone(transaction);
  }

  async deleteMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const transaction = this.db.transaction([DataStore.Blobs, DataStore.OriginalBlobIndex], 'readwrite');
    const store = transaction.objectStore(DataStore.Blobs);
    const originalBlobIndex = transaction.objectStore(DataStore.OriginalBlobIndex);
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds) {
      store.delete(id);
      originalBlobIndex.delete(id);
    }
    await transactionDone(transaction);
    return uniqueIds.length;
  }

  async getStorageUsage(): Promise<StorageUsageSummary> {
    const transaction = this.db.transaction(DataStore.Blobs, 'readonly');
    const store = transaction.objectStore(DataStore.Blobs);
    const done = transactionDone(transaction);
    const count = requestToPromise<number>(store.count());
    const request = store.index(SchemaIndex.BlobsByEncryptedByteLength).openKeyCursor();
    let totalBytes = 0;

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (typeof cursor.key === 'number' && Number.isFinite(cursor.key) && cursor.key >= 0) totalBytes += cursor.key;
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });

    const blobCount = await count;
    await done;
    return { totalBytes, blobCount };
  }
}
