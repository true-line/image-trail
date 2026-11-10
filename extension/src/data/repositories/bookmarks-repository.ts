import * as v from 'valibot';
import { openValidatedJsonEnvelope, sealJsonEnvelope } from '../crypto/envelope.js';
import type { EncryptedEnvelope, RecordEnvelopeMetadata } from '../crypto/types.js';
import { encryptedEnvelopeSchema } from '../crypto/types.schema.js';
import type { StorageUsageSummary } from '../../core/image/capture-result.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { DataStore, SchemaIndex } from '../schema.js';
import type { DurableBookmarkPayloadV1 } from '../types.js';
import { durableBookmarkPayloadSchema } from '../types.schema.js';
import { hydrateRecord, hydrateRecords } from './hydration.js';

export interface EncryptedBookmarkRecord {
  readonly uuid: string;
  readonly url: string;
  readonly queueUpdatedAt: string;
  readonly encryptedByteLength?: number | undefined;
  readonly inlineThumbnailByteLength?: number | undefined;
  readonly envelope: EncryptedEnvelope<RecordEnvelopeMetadata<'bookmark'>>;
}

const encryptedBookmarkRecordSchema = v.object({
  uuid: v.string(),
  url: v.string(),
  queueUpdatedAt: v.string(),
  encryptedByteLength: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  inlineThumbnailByteLength: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  envelope: encryptedEnvelopeSchema('bookmark'),
}) as v.GenericSchema<unknown, EncryptedBookmarkRecord>;

const textEncoder = new TextEncoder();
const INTEROP_CUSTODY_PRESENCE_KEY = 'bookmarkInteropCustodyPresence:v1';

export class BookmarksRepository {
  constructor(private readonly db: IDBDatabase) {}

  async putEncrypted(record: EncryptedBookmarkRecord): Promise<void> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readwrite');
    transaction.objectStore(DataStore.Bookmarks).put(record);
    await transactionDone(transaction);
  }

  async getEncrypted(uuid: string): Promise<EncryptedBookmarkRecord | undefined> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readonly');
    const result = await requestToPromise<unknown>(transaction.objectStore(DataStore.Bookmarks).get(uuid));
    await transactionDone(transaction);
    return hydrateRecord(DataStore.Bookmarks, encryptedBookmarkRecordSchema, result);
  }

  async listEncrypted(): Promise<readonly EncryptedBookmarkRecord[]> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readonly');
    const result = await requestToPromise<unknown[]>(transaction.objectStore(DataStore.Bookmarks).getAll());
    await transactionDone(transaction);
    return hydrateRecords(DataStore.Bookmarks, encryptedBookmarkRecordSchema, result);
  }

  async countEncrypted(): Promise<number> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readonly');
    const result = await requestToPromise<number>(transaction.objectStore(DataStore.Bookmarks).count());
    await transactionDone(transaction);
    return result;
  }

  async getStorageUsage(key?: CryptoKey): Promise<StorageUsageSummary> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readonly');
    const request = transaction.objectStore(DataStore.Bookmarks).openCursor();
    let totalBytes = 0;
    let blobCount = 0;
    let thumbnailCount = 0;
    let thumbnailBytes = 0;
    const legacyRecords: EncryptedBookmarkRecord[] = [];

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value as EncryptedBookmarkRecord;
        totalBytes += record.encryptedByteLength ?? encryptedEnvelopeByteLength(record.envelope);
        blobCount += 1;
        if (record.inlineThumbnailByteLength === undefined) {
          if (key) legacyRecords.push(record);
        } else if (record.inlineThumbnailByteLength > 0) {
          thumbnailCount += 1;
          thumbnailBytes += record.inlineThumbnailByteLength;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await transactionDone(transaction);
    if (!key) return { totalBytes, blobCount, thumbnails: { count: thumbnailCount, totalBytes: thumbnailBytes } };
    const backfills: BookmarkStorageUsageBackfill[] = [];
    for (const record of legacyRecords) {
      try {
        const payload = await this.openRecord(record, key);
        const inlineThumbnailByteLength = thumbnailByteLength(payload);
        if (inlineThumbnailByteLength > 0) {
          thumbnailCount += 1;
          thumbnailBytes += inlineThumbnailByteLength;
        }
        backfills.push({
          uuid: record.uuid,
          envelopeIv: record.envelope.iv,
          envelopeCiphertext: record.envelope.ciphertext,
          encryptedByteLength: record.encryptedByteLength ?? encryptedEnvelopeByteLength(record.envelope),
          inlineThumbnailByteLength,
        });
      } catch {
        // Unreadable rows still count as queue metadata, but their inline thumbnail size is unknown.
      }
    }
    if (backfills.length > 0) await this.backfillStorageUsageMetadata(backfills);
    return { totalBytes, blobCount, thumbnails: { count: thumbnailCount, totalBytes: thumbnailBytes } };
  }

  async getInteropCustodyPresence(): Promise<boolean | undefined> {
    const transaction = this.db.transaction(DataStore.Metadata, 'readonly');
    const raw = await requestToPromise<unknown>(transaction.objectStore(DataStore.Metadata).get(INTEROP_CUSTODY_PRESENCE_KEY));
    await transactionDone(transaction);
    return isInteropCustodyPresenceRecord(raw) ? raw.present : undefined;
  }

  async setInteropCustodyPresence(present: boolean): Promise<void> {
    const transaction = this.db.transaction(DataStore.Metadata, 'readwrite');
    const store = transaction.objectStore(DataStore.Metadata);
    if (!present) {
      const current = await requestToPromise<unknown>(store.get(INTEROP_CUSTODY_PRESENCE_KEY));
      if (isInteropCustodyPresenceRecord(current) && current.present) {
        await transactionDone(transaction);
        return;
      }
    }
    store.put({ key: INTEROP_CUSTODY_PRESENCE_KEY, present });
    await transactionDone(transaction);
  }

  async listEncryptedPage(input: { readonly offset: number; readonly limit: number }): Promise<readonly EncryptedBookmarkRecord[]> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readonly');
    const index = transaction.objectStore(DataStore.Bookmarks).index(SchemaIndex.BookmarksByQueueUpdatedAt);
    const request = index.openCursor(null, 'prev');
    const result: EncryptedBookmarkRecord[] = [];
    const offset = Math.max(0, input.offset);
    const limit = Math.max(0, input.limit);
    let skipped = 0;

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || result.length >= limit) {
          resolve();
          return;
        }
        const record = hydrateRecord(DataStore.Bookmarks, encryptedBookmarkRecordSchema, cursor.value);
        // Quarantined rows count toward neither the offset nor the page, so `offset` indexes
        // the stream of valid records and pages can't duplicate or skip bookmarks around a
        // corrupted row.
        if (!record) {
          cursor.continue();
          return;
        }
        if (skipped < offset) {
          skipped += 1;
          cursor.continue();
          return;
        }
        result.push(record);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await transactionDone(transaction);
    return result;
  }

  async listEncryptedNewestFirst(): Promise<readonly EncryptedBookmarkRecord[]> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readonly');
    const index = transaction.objectStore(DataStore.Bookmarks).index(SchemaIndex.BookmarksByQueueUpdatedAt);
    const request = index.openCursor(null, 'prev');
    const result: EncryptedBookmarkRecord[] = [];

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = hydrateRecord(DataStore.Bookmarks, encryptedBookmarkRecordSchema, cursor.value);
        if (record) result.push(record);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await transactionDone(transaction);
    return result;
  }

  async getEncryptedByUrl(url: string): Promise<EncryptedBookmarkRecord | undefined> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readonly');
    const result = await requestToPromise<unknown>(transaction.objectStore(DataStore.Bookmarks).index(SchemaIndex.BookmarksByUrl).get(url));
    await transactionDone(transaction);
    return hydrateRecord(DataStore.Bookmarks, encryptedBookmarkRecordSchema, result);
  }

  async updateUrlIndexes(updates: readonly { readonly uuid: string; readonly url: string }[]): Promise<readonly EncryptedBookmarkRecord[]> {
    if (updates.length === 0) return [];
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readwrite');
    const store = transaction.objectStore(DataStore.Bookmarks);
    const urlIndex = store.index(SchemaIndex.BookmarksByUrl);
    const updated: EncryptedBookmarkRecord[] = [];
    for (const update of updates) {
      const existing = await requestToPromise<EncryptedBookmarkRecord | undefined>(store.get(update.uuid));
      if (!existing || existing.url === update.url) continue;
      const collision = await requestToPromise<unknown>(urlIndex.get(update.url));
      if (collision !== undefined) continue;
      const next = { ...existing, url: update.url };
      await requestToPromise(store.put(next));
      updated.push(next);
    }
    await transactionDone(transaction);
    return updated;
  }

  async remove(uuid: string): Promise<void> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readwrite');
    transaction.objectStore(DataStore.Bookmarks).delete(uuid);
    await transactionDone(transaction);
  }

  async updateQueueUpdatedAt(
    updates: readonly { readonly uuid: string; readonly queueUpdatedAt: string }[],
  ): Promise<readonly EncryptedBookmarkRecord[]> {
    if (updates.length === 0) return [];
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readwrite');
    const store = transaction.objectStore(DataStore.Bookmarks);
    const updated: EncryptedBookmarkRecord[] = [];
    for (const update of updates) {
      const existing = await requestToPromise<EncryptedBookmarkRecord | undefined>(store.get(update.uuid));
      if (!existing) continue;
      const next = { ...existing, queueUpdatedAt: update.queueUpdatedAt };
      store.put(next);
      updated.push(next);
    }
    await transactionDone(transaction);
    return updated;
  }

  async sealAndPut(
    uuid: string,
    payload: DurableBookmarkPayloadV1,
    key: CryptoKey,
    keyReference: EncryptedBookmarkRecord['envelope']['key'],
    now?: string,
    indexUrl = payload.url,
    queueUpdatedAt = now ?? new Date().toISOString(),
  ): Promise<EncryptedBookmarkRecord> {
    const envelope = await sealJsonEnvelope({
      payload,
      payloadVersion: 1,
      key,
      keyReference,
      authenticatedMetadata: { recordType: 'bookmark' as const, recordId: uuid },
      now,
    });
    const record = {
      uuid,
      url: indexUrl,
      queueUpdatedAt,
      encryptedByteLength: encryptedEnvelopeByteLength(envelope),
      inlineThumbnailByteLength: thumbnailByteLength(payload),
      envelope,
    };
    if (payload.interop) {
      const transaction = this.db.transaction([DataStore.Bookmarks, DataStore.Metadata], 'readwrite');
      transaction.objectStore(DataStore.Bookmarks).put(record);
      transaction.objectStore(DataStore.Metadata).put({ key: INTEROP_CUSTODY_PRESENCE_KEY, present: true });
      await transactionDone(transaction);
    } else {
      await this.putEncrypted(record);
    }
    return record;
  }

  async open(uuid: string, key: CryptoKey): Promise<DurableBookmarkPayloadV1 | null> {
    const record = await this.getEncrypted(uuid);
    return record ? openValidatedJsonEnvelope(record.envelope, key, durableBookmarkPayloadSchema, record.uuid) : null;
  }

  async openRecord(record: EncryptedBookmarkRecord, key: CryptoKey): Promise<DurableBookmarkPayloadV1> {
    return openValidatedJsonEnvelope(record.envelope, key, durableBookmarkPayloadSchema, record.uuid);
  }

  private async backfillStorageUsageMetadata(backfills: readonly BookmarkStorageUsageBackfill[]): Promise<void> {
    const transaction = this.db.transaction(DataStore.Bookmarks, 'readwrite');
    const store = transaction.objectStore(DataStore.Bookmarks);
    for (const backfill of backfills) {
      const raw = await requestToPromise<unknown>(store.get(backfill.uuid));
      const current = hydrateRecord(DataStore.Bookmarks, encryptedBookmarkRecordSchema, raw);
      if (
        !current ||
        current.envelope.iv !== backfill.envelopeIv ||
        current.envelope.ciphertext !== backfill.envelopeCiphertext ||
        current.inlineThumbnailByteLength !== undefined
      ) {
        continue;
      }
      store.put({
        ...(raw as Record<string, unknown>),
        encryptedByteLength: backfill.encryptedByteLength,
        inlineThumbnailByteLength: backfill.inlineThumbnailByteLength,
      });
    }
    await transactionDone(transaction);
  }
}

interface BookmarkStorageUsageBackfill {
  readonly uuid: string;
  readonly envelopeIv: string;
  readonly envelopeCiphertext: string;
  readonly encryptedByteLength: number;
  readonly inlineThumbnailByteLength: number;
}

function encryptedEnvelopeByteLength(envelope: EncryptedBookmarkRecord['envelope']): number {
  return textEncoder.encode(JSON.stringify(envelope)).byteLength;
}

function thumbnailByteLength(payload: DurableBookmarkPayloadV1): number {
  return payload.thumbnail ? textEncoder.encode(payload.thumbnail).byteLength : 0;
}

function isInteropCustodyPresenceRecord(value: unknown): value is { readonly key: string; readonly present: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    value.key === INTEROP_CUSTODY_PRESENCE_KEY &&
    'present' in value &&
    typeof value.present === 'boolean'
  );
}
