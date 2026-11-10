import * as v from 'valibot';
import type { StorageUsageSummary } from '../../core/image/capture-result.js';
import { openValidatedJsonEnvelope, sealJsonEnvelope } from '../crypto/envelope.js';
import type { EncryptedEnvelope, RecordEnvelopeMetadata, KeyReference } from '../crypto/types.js';
import { encryptedEnvelopeSchema } from '../crypto/types.schema.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { DataStore, SchemaIndex } from '../schema.js';
import type { DurableEncryptedPinPayloadV1 } from '../types.js';
import { durableEncryptedPinPayloadSchema } from '../types.schema.js';
import { hydrateRecord } from './hydration.js';

export interface EncryptedPinRecord {
  readonly id: string;
  readonly plainPinId: string;
  readonly urlHash: string;
  readonly queueUpdatedAt: string;
  readonly envelope: EncryptedEnvelope<RecordEnvelopeMetadata<'encryptedPin'>>;
}

const encryptedPinRecordSchema = v.object({
  id: v.string(),
  plainPinId: v.string(),
  urlHash: v.string(),
  queueUpdatedAt: v.string(),
  envelope: encryptedEnvelopeSchema('encryptedPin'),
}) as v.GenericSchema<unknown, EncryptedPinRecord>;

export class EncryptedPinsRepository {
  constructor(private readonly db: IDBDatabase) {}

  async put(record: EncryptedPinRecord): Promise<EncryptedPinRecord> {
    const transaction = this.db.transaction(DataStore.EncryptedPins, 'readwrite');
    transaction.objectStore(DataStore.EncryptedPins).put(record);
    await transactionDone(transaction);
    return record;
  }

  async get(id: string): Promise<EncryptedPinRecord | undefined> {
    const transaction = this.db.transaction(DataStore.EncryptedPins, 'readonly');
    const result = await requestToPromise<unknown>(transaction.objectStore(DataStore.EncryptedPins).get(id));
    await transactionDone(transaction);
    return hydrateRecord(DataStore.EncryptedPins, encryptedPinRecordSchema, result);
  }

  async getByPlainPinId(plainPinId: string): Promise<EncryptedPinRecord | undefined> {
    const transaction = this.db.transaction(DataStore.EncryptedPins, 'readonly');
    const result = await requestToPromise<unknown>(
      transaction.objectStore(DataStore.EncryptedPins).index(SchemaIndex.EncryptedPinsByPlainPinId).get(plainPinId),
    );
    await transactionDone(transaction);
    return hydrateRecord(DataStore.EncryptedPins, encryptedPinRecordSchema, result);
  }

  async getByUrlHash(urlHash: string): Promise<EncryptedPinRecord | undefined> {
    const transaction = this.db.transaction(DataStore.EncryptedPins, 'readonly');
    const result = await requestToPromise<unknown>(
      transaction.objectStore(DataStore.EncryptedPins).index(SchemaIndex.EncryptedPinsByUrlHash).get(urlHash),
    );
    await transactionDone(transaction);
    return hydrateRecord(DataStore.EncryptedPins, encryptedPinRecordSchema, result);
  }

  async listNewestFirst(): Promise<readonly EncryptedPinRecord[]> {
    const transaction = this.db.transaction(DataStore.EncryptedPins, 'readonly');
    const index = transaction.objectStore(DataStore.EncryptedPins).index(SchemaIndex.EncryptedPinsByQueueUpdatedAt);
    const request = index.openCursor(null, 'prev');
    const result: EncryptedPinRecord[] = [];

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = hydrateRecord(DataStore.EncryptedPins, encryptedPinRecordSchema, cursor.value);
        if (record) result.push(record);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await transactionDone(transaction);
    return result;
  }

  async getStorageUsage(): Promise<StorageUsageSummary> {
    const transaction = this.db.transaction(DataStore.EncryptedPins, 'readonly');
    const request = transaction.objectStore(DataStore.EncryptedPins).openCursor();
    let totalBytes = 0;
    let blobCount = 0;

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value as EncryptedPinRecord;
        totalBytes += new TextEncoder().encode(JSON.stringify(record.envelope)).byteLength;
        blobCount += 1;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await transactionDone(transaction);
    return { totalBytes, blobCount };
  }

  async updateQueueUpdatedAt(updates: readonly { readonly id: string; readonly queueUpdatedAt: string }[]): Promise<void> {
    if (updates.length === 0) return;
    const transaction = this.db.transaction(DataStore.EncryptedPins, 'readwrite');
    const store = transaction.objectStore(DataStore.EncryptedPins);
    for (const update of updates) {
      const existing = await requestToPromise<EncryptedPinRecord | undefined>(store.get(update.id));
      if (existing) store.put({ ...existing, queueUpdatedAt: update.queueUpdatedAt });
    }
    await transactionDone(transaction);
  }

  async remove(id: string): Promise<void> {
    const transaction = this.db.transaction(DataStore.EncryptedPins, 'readwrite');
    transaction.objectStore(DataStore.EncryptedPins).delete(id);
    await transactionDone(transaction);
  }

  async sealAndPut(input: {
    readonly id: string;
    readonly plainPinId: string;
    readonly urlHash: string;
    readonly queueUpdatedAt: string;
    readonly payload: DurableEncryptedPinPayloadV1;
    readonly key: CryptoKey;
    readonly keyReference: KeyReference<'blob'>;
    readonly now?: string | undefined;
  }): Promise<EncryptedPinRecord> {
    const envelope = await sealJsonEnvelope({
      payload: input.payload,
      payloadVersion: 1,
      key: input.key,
      keyReference: input.keyReference,
      authenticatedMetadata: { recordType: 'encryptedPin' as const, recordId: input.id },
      now: input.now,
    });
    return this.put({
      id: input.id,
      plainPinId: input.plainPinId,
      urlHash: input.urlHash,
      queueUpdatedAt: input.queueUpdatedAt,
      envelope,
    });
  }

  async openRecord(record: EncryptedPinRecord, key: CryptoKey): Promise<DurableEncryptedPinPayloadV1> {
    return openValidatedJsonEnvelope(record.envelope, key, durableEncryptedPinPayloadSchema, record.id);
  }
}
