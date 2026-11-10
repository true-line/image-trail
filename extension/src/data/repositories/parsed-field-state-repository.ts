import * as v from 'valibot';
import { type SearchableMetadataMode, type SearchableMetadataPolicy } from '../../core/metadata-policy.js';
import type { ParsedFieldStateRecord } from '../../core/types.js';
import { parsedFieldStateRecordSchema } from '../../core/types.schema.js';
import { openValidatedJsonEnvelope, sealJsonEnvelope } from '../crypto/envelope.js';
import type { EncryptedEnvelope, RecordEnvelopeMetadata } from '../crypto/types.js';
import { encryptedEnvelopeSchema } from '../crypto/types.schema.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { DataStore } from '../schema.js';
import {
  encryptedUrlMetadataKey,
  encryptedUrlMetadataPrefix,
  requireUrlMetadataEncryptionKey,
  urlMetadataMode,
  type UrlMetadataPrivacyOptions,
} from '../url-metadata-privacy.js';
import { hydrateRecord, hydrateRecords } from './hydration.js';
import { isMetadataRecordKind, metadataRecordKind, storedUpdatedAt, type MetadataKindRecord } from './metadata-record-helpers.js';

interface ParsedFieldStateMetadataRecord extends ParsedFieldStateRecord {
  readonly key: string;
  readonly kind: 'parsedFieldState';
}

interface EncryptedParsedFieldStateMetadataRecord {
  readonly key: string;
  readonly kind: 'parsedFieldStateEncrypted';
  readonly updatedAt: string;
  readonly envelope: EncryptedEnvelope<RecordEnvelopeMetadata<'parsedFieldState'>>;
}

const parsedFieldStateMetadataRecordSchema = v.object({
  ...parsedFieldStateRecordSchema.entries,
  key: v.string(),
  kind: v.literal('parsedFieldState'),
}) as v.GenericSchema<unknown, ParsedFieldStateMetadataRecord>;

const encryptedParsedFieldStateMetadataRecordSchema = v.object({
  key: v.string(),
  kind: v.literal('parsedFieldStateEncrypted'),
  updatedAt: v.string(),
  envelope: encryptedEnvelopeSchema('parsedFieldState'),
}) as v.GenericSchema<unknown, EncryptedParsedFieldStateMetadataRecord>;

const PARSED_FIELD_STATE_KEY_PREFIX = 'parsed-field-state:';

export class ParsedFieldStateRepository {
  private reconciledMode: SearchableMetadataMode | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: IDBDatabase,
    private readonly privacy: UrlMetadataPrivacyOptions = {},
  ) {}

  async get(hostname: string, pageUrl: string): Promise<ParsedFieldStateRecord | null> {
    return this.withPolicy(async (mode) => {
      const key = await parsedFieldStateKey(mode, hostname, pageUrl);
      const transaction = this.db.transaction(DataStore.Metadata, 'readonly');
      const raw = await requestToPromise<unknown>(transaction.objectStore(DataStore.Metadata).get(key));
      await transactionDone(transaction);
      if (mode === 'plaintext') {
        const record = hydrateRecord(DataStore.Metadata, parsedFieldStateMetadataRecordSchema, raw);
        return record ? stripMetadataKey(record) : null;
      }
      const record = hydrateRecord(DataStore.Metadata, encryptedParsedFieldStateMetadataRecordSchema, raw);
      return record ? this.openEncrypted(record) : null;
    });
  }

  async getForSource(hostname: string, sourceUrl: string): Promise<ParsedFieldStateRecord | null> {
    return this.withPolicy(async (mode) => {
      const prefix =
        mode === 'plaintext'
          ? parsedFieldStateHostPrefix(hostname)
          : await encryptedUrlMetadataPrefix(PARSED_FIELD_STATE_KEY_PREFIX, hostname);
      const raw = await metadataRowsForPrefix(this.db, prefix);
      const records =
        mode === 'plaintext'
          ? hydrateRecords(
              DataStore.Metadata,
              parsedFieldStateMetadataRecordSchema,
              raw.filter((record) => metadataRecordKind(record) === 'parsedFieldState'),
            ).map(stripMetadataKey)
          : await this.openEncryptedRows(raw);
      return (
        records
          .filter((record) => record.sourceUrl === sourceUrl || record.selectedUrl === sourceUrl || record.pageUrl === sourceUrl)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
      );
    });
  }

  async put(record: ParsedFieldStateRecord): Promise<void> {
    await this.withPolicy(async (mode) => {
      const stored = await this.storedRecord(mode, record);
      const transaction = this.db.transaction(DataStore.Metadata, 'readwrite');
      const store = transaction.objectStore(DataStore.Metadata);
      const existing = await requestToPromise<unknown>(store.get(stored.key));
      if (storedUpdatedAt(existing, stored.kind) <= record.updatedAt) store.put(stored);
      await transactionDone(transaction);
    });
  }

  async reconcilePolicy(policy?: SearchableMetadataPolicy): Promise<SearchableMetadataMode> {
    return this.withPolicy((mode) => Promise.resolve(mode), policy);
  }

  private async reconcilePolicyNow(policy?: SearchableMetadataPolicy): Promise<SearchableMetadataMode> {
    const mode = await urlMetadataMode(this.privacy, policy);
    if (this.reconciledMode === mode) return mode;
    if (mode === 'encrypted') await this.migratePlaintextRows();
    else await this.migrateEncryptedRows();
    this.reconciledMode = mode;
    return mode;
  }

  private withPolicy<T>(operation: (mode: SearchableMetadataMode) => Promise<T>, policy?: SearchableMetadataPolicy): Promise<T> {
    const previous = this.operationQueue.catch(() => undefined);
    const result = previous.then(async () => operation(await this.reconcilePolicyNow(policy)));
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async storedRecord(
    mode: SearchableMetadataMode,
    record: ParsedFieldStateRecord,
  ): Promise<ParsedFieldStateMetadataRecord | EncryptedParsedFieldStateMetadataRecord> {
    const key = await parsedFieldStateKey(mode, record.hostname, record.pageUrl);
    if (mode === 'plaintext') return { ...record, key, kind: 'parsedFieldState' };
    const encryption = await requireUrlMetadataEncryptionKey(this.privacy);
    const envelope = await sealJsonEnvelope({
      payload: record,
      payloadVersion: 1,
      key: encryption.key,
      keyReference: encryption.reference,
      authenticatedMetadata: { recordType: 'parsedFieldState' as const, recordId: key },
      now: record.updatedAt,
    });
    return { key, kind: 'parsedFieldStateEncrypted', updatedAt: record.updatedAt, envelope };
  }

  private async openEncrypted(record: EncryptedParsedFieldStateMetadataRecord): Promise<ParsedFieldStateRecord | null> {
    try {
      const encryption = await requireUrlMetadataEncryptionKey(this.privacy);
      return await openValidatedJsonEnvelope(record.envelope, encryption.key, parsedFieldStateRecordSchema, record.key);
    } catch {
      return null;
    }
  }

  private async openEncryptedRows(raw: readonly unknown[]): Promise<ParsedFieldStateRecord[]> {
    const stored = hydrateRecords(
      DataStore.Metadata,
      encryptedParsedFieldStateMetadataRecordSchema,
      raw.filter((record) => metadataRecordKind(record) === 'parsedFieldStateEncrypted'),
    );
    const records: ParsedFieldStateRecord[] = [];
    for (const record of stored) {
      const opened = await this.openEncrypted(record);
      if (opened) records.push(opened);
    }
    return records;
  }

  private async migratePlaintextRows(): Promise<void> {
    const raw = await metadataRowsForPrefix(this.db, PARSED_FIELD_STATE_KEY_PREFIX);
    for (const candidate of raw.filter((record): record is MetadataKindRecord => isMetadataRecordKind(record, 'parsedFieldState'))) {
      const parsed = v.safeParse(parsedFieldStateMetadataRecordSchema, candidate);
      if (!parsed.success) {
        await deleteMetadataRow(this.db, candidate.key);
        continue;
      }
      const record = stripMetadataKey(parsed.output);
      await replaceMetadataRow(this.db, candidate.key, await this.storedRecord('encrypted', record));
    }
  }

  private async migrateEncryptedRows(): Promise<void> {
    const raw = await metadataRowsForPrefix(this.db, PARSED_FIELD_STATE_KEY_PREFIX);
    const stored = hydrateRecords(
      DataStore.Metadata,
      encryptedParsedFieldStateMetadataRecordSchema,
      raw.filter((record) => metadataRecordKind(record) === 'parsedFieldStateEncrypted'),
    );
    for (const encrypted of stored) {
      const record = await this.openEncrypted(encrypted);
      if (record) await replaceMetadataRow(this.db, encrypted.key, await this.storedRecord('plaintext', record));
    }
  }
}

function stripMetadataKey(record: ParsedFieldStateMetadataRecord): ParsedFieldStateRecord {
  const { key: _key, kind: _kind, ...state } = record;
  return state;
}

function parsedFieldStateKey(mode: SearchableMetadataMode, hostname: string, pageUrl: string): Promise<string> | string {
  return mode === 'plaintext'
    ? `${parsedFieldStateHostPrefix(hostname)}${encodeURIComponent(pageUrl)}`
    : encryptedUrlMetadataKey(PARSED_FIELD_STATE_KEY_PREFIX, hostname.toLowerCase(), pageUrl);
}

function parsedFieldStateHostPrefix(hostname: string): string {
  return `${PARSED_FIELD_STATE_KEY_PREFIX}${hostname.toLowerCase()}:`;
}

async function metadataRowsForPrefix(db: IDBDatabase, prefix: string): Promise<unknown[]> {
  const transaction = db.transaction(DataStore.Metadata, 'readonly');
  const raw = await requestToPromise<unknown[]>(
    transaction.objectStore(DataStore.Metadata).getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)),
  );
  await transactionDone(transaction);
  return raw;
}

async function replaceMetadataRow(
  db: IDBDatabase,
  previousKey: string,
  replacement: ParsedFieldStateMetadataRecord | EncryptedParsedFieldStateMetadataRecord,
): Promise<void> {
  const transaction = db.transaction(DataStore.Metadata, 'readwrite');
  const store = transaction.objectStore(DataStore.Metadata);
  const existing = await requestToPromise<unknown>(store.get(replacement.key));
  if (storedUpdatedAt(existing, replacement.kind) <= replacement.updatedAt) store.put(replacement);
  if (previousKey !== replacement.key) store.delete(previousKey);
  await transactionDone(transaction);
}

async function deleteMetadataRow(db: IDBDatabase, key: string): Promise<void> {
  const transaction = db.transaction(DataStore.Metadata, 'readwrite');
  transaction.objectStore(DataStore.Metadata).delete(key);
  await transactionDone(transaction);
}
