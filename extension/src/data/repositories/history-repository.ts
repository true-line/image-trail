import * as v from 'valibot';
import { openValidatedJsonEnvelope, sealJsonEnvelope } from '../crypto/envelope.js';
import type { EncryptedEnvelope, RecordEnvelopeMetadata } from '../crypto/types.js';
import { encryptedEnvelopeSchema } from '../crypto/types.schema.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { DataStore } from '../schema.js';
import type { DurableHistoryPayloadV1 } from '../types.js';
import { durableHistoryPayloadSchema } from '../types.schema.js';
import { hydrateRecord, hydrateRecords } from './hydration.js';

export interface EncryptedHistoryRecord {
  readonly uuid: string;
  readonly envelope: EncryptedEnvelope<RecordEnvelopeMetadata<'history'>>;
}

const encryptedHistoryRecordSchema = v.object({
  uuid: v.string(),
  envelope: encryptedEnvelopeSchema('history'),
}) as v.GenericSchema<unknown, EncryptedHistoryRecord>;

export class HistoryRepository {
  constructor(private readonly db: IDBDatabase) {}

  async putEncrypted(record: EncryptedHistoryRecord): Promise<void> {
    const transaction = this.db.transaction(DataStore.History, 'readwrite');
    transaction.objectStore(DataStore.History).put(record);
    await transactionDone(transaction);
  }

  async getEncrypted(uuid: string): Promise<EncryptedHistoryRecord | undefined> {
    const transaction = this.db.transaction(DataStore.History, 'readonly');
    const result = await requestToPromise<unknown>(transaction.objectStore(DataStore.History).get(uuid));
    await transactionDone(transaction);
    return hydrateRecord(DataStore.History, encryptedHistoryRecordSchema, result);
  }

  async listEncrypted(): Promise<readonly EncryptedHistoryRecord[]> {
    const transaction = this.db.transaction(DataStore.History, 'readonly');
    const result = await requestToPromise<unknown[]>(transaction.objectStore(DataStore.History).getAll());
    await transactionDone(transaction);
    return hydrateRecords(DataStore.History, encryptedHistoryRecordSchema, result);
  }

  async sealAndPut(
    uuid: string,
    payload: DurableHistoryPayloadV1,
    key: CryptoKey,
    keyReference: EncryptedHistoryRecord['envelope']['key'],
  ): Promise<EncryptedHistoryRecord> {
    const envelope = await sealJsonEnvelope({
      payload,
      payloadVersion: 1,
      key,
      keyReference,
      authenticatedMetadata: { recordType: 'history' as const, recordId: uuid },
    });
    const record = { uuid, envelope };
    await this.putEncrypted(record);
    return record;
  }

  async open(uuid: string, key: CryptoKey): Promise<DurableHistoryPayloadV1 | null> {
    const record = await this.getEncrypted(uuid);
    return record ? openValidatedJsonEnvelope(record.envelope, key, durableHistoryPayloadSchema, record.uuid) : null;
  }
}
