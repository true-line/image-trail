import { decryptAesGcm } from '../crypto/webcrypto.js';
import { deriveEncryptionKey } from '../crypto/password-wrap.js';
import { parseExportFile, fromBase64 } from '../import-export/encrypted-file-format.js';
import * as v from 'valibot';
import { openValidatedJsonEnvelope, sealJsonEnvelope } from '../crypto/envelope.js';
import type { EncryptedEnvelope, RecordEnvelopeMetadata } from '../crypto/types.js';
import { encryptedEnvelopeSchema } from '../crypto/types.schema.js';
import { findDownloadDuplicate } from '../../core/image/downloads.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { DataStore, SchemaIndex } from '../schema.js';
import type { DurableDownloadPayloadV1 } from '../types.js';
import { durableDownloadPayloadSchema } from '../types.schema.js';
import { hydrateRecord } from './hydration.js';

export interface EncryptedDownloadRecord {
  readonly uuid: string;
  readonly envelope: EncryptedEnvelope<RecordEnvelopeMetadata<'download'>>;
}

const encryptedDownloadRecordSchema = v.object({
  uuid: v.string(),
  envelope: encryptedEnvelopeSchema('download'),
}) as v.GenericSchema<unknown, EncryptedDownloadRecord>;

const decryptedDownloadPayloadSchema = v.object({
  mimeType: v.string(),
  sourceUrl: v.string(),
  data: v.string(),
});

export interface DownloadDuplicateResult {
  readonly record: EncryptedDownloadRecord;
  readonly payload: DurableDownloadPayloadV1;
  readonly matchedBy: 'fingerprint' | 'url';
}

export class DownloadsRepository {
  constructor(private readonly db: IDBDatabase) {}

  async putEncrypted(record: EncryptedDownloadRecord): Promise<void> {
    const transaction = this.db.transaction(DataStore.Downloads, 'readwrite');
    transaction.objectStore(DataStore.Downloads).put(record);
    await transactionDone(transaction);
  }

  async getEncrypted(uuid: string): Promise<EncryptedDownloadRecord | undefined> {
    const transaction = this.db.transaction(DataStore.Downloads, 'readonly');
    const result = await requestToPromise<unknown>(transaction.objectStore(DataStore.Downloads).get(uuid));
    await transactionDone(transaction);
    return hydrateRecord(DataStore.Downloads, encryptedDownloadRecordSchema, result);
  }

  async listEncryptedNewestFirst(): Promise<readonly EncryptedDownloadRecord[]> {
    const transaction = this.db.transaction(DataStore.Downloads, 'readonly');
    const index = transaction.objectStore(DataStore.Downloads).index(SchemaIndex.DownloadsByDownloadedAt);
    const request = index.openCursor(null, 'prev');
    const result: EncryptedDownloadRecord[] = [];

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = hydrateRecord(DataStore.Downloads, encryptedDownloadRecordSchema, cursor.value);
        if (record) result.push(record);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });

    await transactionDone(transaction);
    return result;
  }

  async sealAndPut(
    uuid: string,
    payload: DurableDownloadPayloadV1,
    key: CryptoKey,
    keyReference: EncryptedDownloadRecord['envelope']['key'],
    now = payload.downloadedAt,
  ): Promise<EncryptedDownloadRecord> {
    const envelope = await sealJsonEnvelope({
      payload,
      payloadVersion: 1,
      key,
      keyReference,
      authenticatedMetadata: { recordType: 'download' as const, recordId: uuid },
      now,
    });
    const record = { uuid, envelope };
    await this.putEncrypted(record);
    return record;
  }

  async openRecord(record: EncryptedDownloadRecord, key: CryptoKey): Promise<DurableDownloadPayloadV1> {
    return openValidatedJsonEnvelope(record.envelope, key, durableDownloadPayloadSchema, record.uuid);
  }

  async findDuplicate(
    candidate: { readonly sourceUrl: string; readonly fingerprint?: string },
    key: CryptoKey,
  ): Promise<DownloadDuplicateResult | null> {
    const opened: Array<{ readonly record: EncryptedDownloadRecord; readonly payload: DurableDownloadPayloadV1 }> = [];
    for (const record of await this.listEncryptedNewestFirst()) {
      try {
        opened.push({ record, payload: await this.openRecord(record, key) });
      } catch {
        // Records encrypted with unavailable keys cannot participate in this dedupe check.
      }
    }

    const duplicate = findDownloadDuplicate(
      opened.map(({ payload }) => payload),
      candidate,
    );
    if (!duplicate) return null;
    const match = opened.find(({ payload }) => payload === duplicate.record);
    return match ? { ...match, matchedBy: duplicate.matchedBy } : null;
  }
}

export interface DecryptedDownloadResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly sourceUrl: string;
}

export async function openEncryptedDownload(fileContent: string, password: string): Promise<DecryptedDownloadResult> {
  const envelope = parseExportFile(fileContent);
  const salt = fromBase64(envelope.header.salt);
  const iv = fromBase64(envelope.header.iv);
  const ciphertext = fromBase64(envelope.payload);

  const encryptionKey = await deriveEncryptionKey(password, {
    salt,
    iterations: envelope.header.iterations,
  });

  const plaintext = await decryptAesGcm(encryptionKey, ciphertext, iv);
  const decoded = new TextDecoder().decode(plaintext);
  const result = v.safeParse(decryptedDownloadPayloadSchema, JSON.parse(decoded));
  if (!result.success) {
    throw new Error('Encrypted download payload is invalid.');
  }
  const parsed = result.output;

  return {
    data: fromBase64(parsed.data),
    mimeType: parsed.mimeType,
    sourceUrl: parsed.sourceUrl,
  };
}
