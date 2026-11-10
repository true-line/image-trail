import * as v from 'valibot';
import { type SearchableMetadataMode, type SearchableMetadataPolicy } from '../../core/metadata-policy.js';
import { DEFAULT_URL_REVIEW_STATUS_LIMIT } from '../../core/settings.js';
import type { UrlReviewStatusClearFilter, UrlReviewStatusRecord } from '../../core/types.js';
import { urlReviewStatusRecordSchema } from '../../core/types.schema.js';
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
import { hydrateRecords } from './hydration.js';
import { isMetadataRecordKind, metadataRecordKind, storedUpdatedAt, type MetadataKindRecord } from './metadata-record-helpers.js';

interface UrlReviewStatusMetadataRecord extends UrlReviewStatusRecord {
  readonly key: string;
  readonly kind: 'urlReviewStatus';
}

interface EncryptedUrlReviewStatusMetadataRecord {
  readonly key: string;
  readonly kind: 'urlReviewStatusEncrypted';
  readonly updatedAt: string;
  readonly envelope: EncryptedEnvelope<RecordEnvelopeMetadata<'urlReviewStatus'>>;
}

type StoredUrlReviewStatusRecord = UrlReviewStatusMetadataRecord | EncryptedUrlReviewStatusMetadataRecord;

const urlReviewStatusMetadataRecordSchema = v.object({
  ...urlReviewStatusRecordSchema.entries,
  key: v.string(),
  kind: v.literal('urlReviewStatus'),
}) as v.GenericSchema<unknown, UrlReviewStatusMetadataRecord>;

const encryptedUrlReviewStatusMetadataRecordSchema = v.object({
  key: v.string(),
  kind: v.literal('urlReviewStatusEncrypted'),
  updatedAt: v.string(),
  envelope: encryptedEnvelopeSchema('urlReviewStatus'),
}) as v.GenericSchema<unknown, EncryptedUrlReviewStatusMetadataRecord>;

const URL_REVIEW_STATUS_KEY_PREFIX = 'url-review-status:';

export class UrlReviewStatusRepository {
  private reconciledMode: SearchableMetadataMode | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: IDBDatabase,
    private readonly privacy: UrlMetadataPrivacyOptions = {},
  ) {}

  async listByHostname(hostname: string): Promise<readonly UrlReviewStatusRecord[]> {
    return this.withPolicy(async (mode) =>
      (await this.recordsForHost(mode, hostname)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  async listAll(): Promise<readonly UrlReviewStatusRecord[]> {
    return this.withPolicy(async (mode) => {
      if (mode === 'plaintext') {
        const stored = await storedRecordsForPrefix(this.db, 'plaintext', URL_REVIEW_STATUS_KEY_PREFIX);
        return stored.map(stripMetadataKey).sort(compareNewestFirst);
      }
      const stored = await storedRecordsForPrefix(this.db, 'encrypted', URL_REVIEW_STATUS_KEY_PREFIX);
      const records: UrlReviewStatusRecord[] = [];
      for (const record of stored) {
        const opened = await this.openEncrypted(record);
        if (opened) records.push(opened);
      }
      return records.sort(compareNewestFirst);
    });
  }

  async put(record: UrlReviewStatusRecord, options: { readonly maxRecordsPerHost?: number } = {}): Promise<void> {
    await this.withPolicy(async (mode) => {
      const stored = await this.storedRecord(mode, record);
      const hostPrefix = await urlReviewStatusHostPrefix(mode, record.hostname);
      const transaction = this.db.transaction(DataStore.Metadata, 'readwrite');
      const store = transaction.objectStore(DataStore.Metadata);
      const existing = await requestToPromise<unknown>(store.get(stored.key));
      if (storedUpdatedAt(existing, stored.kind) <= record.updatedAt) {
        store.put(stored);
        await trimHostRecords(store, mode, hostPrefix, normalizeLimit(options.maxRecordsPerHost));
      }
      await transactionDone(transaction);
    });
  }

  async putMany(records: readonly UrlReviewStatusRecord[], options: { readonly maxRecordsPerHost?: number } = {}): Promise<number> {
    if (records.length === 0) return 0;
    return this.withPolicy(async (mode) => {
      const prepared = await Promise.all(records.map(async (source) => ({ source, stored: await this.storedRecord(mode, source) })));
      const hostPrefixes = await Promise.all(
        [...new Set(records.map((record) => record.hostname))].map((hostname) => urlReviewStatusHostPrefix(mode, hostname)),
      );
      const transaction = this.db.transaction(DataStore.Metadata, 'readwrite');
      const store = transaction.objectStore(DataStore.Metadata);
      let imported = 0;
      for (const { source, stored } of prepared) {
        const existing = await requestToPromise<unknown>(store.get(stored.key));
        if (storedUpdatedAt(existing, stored.kind) > source.updatedAt) continue;
        store.put(stored);
        imported += 1;
      }
      for (const hostPrefix of hostPrefixes) {
        await trimHostRecords(store, mode, hostPrefix, normalizeLimit(options.maxRecordsPerHost));
      }
      await transactionDone(transaction);
      return imported;
    });
  }

  async clear(filter: UrlReviewStatusClearFilter): Promise<number> {
    return this.withPolicy(async (mode) => {
      const stored = await this.storedRecordsForFilter(mode, filter);
      if (stored.length === 0) return 0;
      const transaction = this.db.transaction(DataStore.Metadata, 'readwrite');
      const store = transaction.objectStore(DataStore.Metadata);
      for (const record of stored) store.delete(record.key);
      await transactionDone(transaction);
      return stored.length;
    });
  }

  async clearHostname(hostname: string): Promise<number> {
    return this.clear({ scope: 'hostname', hostname });
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

  private async storedRecord(mode: SearchableMetadataMode, record: UrlReviewStatusRecord): Promise<StoredUrlReviewStatusRecord> {
    const key = await urlReviewStatusKey(mode, record.hostname, record.sourceUrl);
    if (mode === 'plaintext') return { ...record, key, kind: 'urlReviewStatus' };
    const encryption = await requireUrlMetadataEncryptionKey(this.privacy);
    const envelope = await sealJsonEnvelope({
      payload: record,
      payloadVersion: 1,
      key: encryption.key,
      keyReference: encryption.reference,
      authenticatedMetadata: { recordType: 'urlReviewStatus' as const, recordId: key },
      now: record.updatedAt,
    });
    return { key, kind: 'urlReviewStatusEncrypted', updatedAt: record.updatedAt, envelope };
  }

  private async openEncrypted(record: EncryptedUrlReviewStatusMetadataRecord): Promise<UrlReviewStatusRecord | null> {
    try {
      const encryption = await requireUrlMetadataEncryptionKey(this.privacy);
      return await openValidatedJsonEnvelope(record.envelope, encryption.key, urlReviewStatusRecordSchema, record.key);
    } catch {
      return null;
    }
  }

  private async recordsForHost(mode: SearchableMetadataMode, hostname: string): Promise<UrlReviewStatusRecord[]> {
    if (mode === 'plaintext') {
      const stored = await storedRecordsForPrefix(this.db, mode, urlReviewStatusPlaintextHostPrefix(hostname));
      return stored.map(stripMetadataKey);
    }
    const prefix = await encryptedUrlMetadataPrefix(URL_REVIEW_STATUS_KEY_PREFIX, hostname.toLowerCase());
    const stored = await storedRecordsForPrefix(this.db, mode, prefix);
    const records: UrlReviewStatusRecord[] = [];
    for (const record of stored) {
      const opened = await this.openEncrypted(record);
      if (opened) records.push(opened);
    }
    return records;
  }

  private async storedRecordsForFilter(mode: SearchableMetadataMode, filter: UrlReviewStatusClearFilter): Promise<MetadataKindRecord[]> {
    if (mode === 'plaintext') {
      const prefix = filter.scope === 'all' ? URL_REVIEW_STATUS_KEY_PREFIX : urlReviewStatusPlaintextHostPrefix(filter.hostname);
      const candidates = (await metadataRowsForPrefix(this.db, prefix)).filter((record): record is MetadataKindRecord =>
        isMetadataRecordKind(record, 'urlReviewStatus'),
      );
      if (filter.scope === 'all' || filter.scope === 'hostname') return candidates;
      const stored = hydrateRecords(DataStore.Metadata, urlReviewStatusMetadataRecordSchema, candidates);
      return stored.filter((record) =>
        filter.scope === 'page' ? record.pageUrl === filter.pageUrl : record.sourceUrl === filter.sourceUrl,
      );
    }
    const prefix =
      filter.scope === 'all'
        ? URL_REVIEW_STATUS_KEY_PREFIX
        : await encryptedUrlMetadataPrefix(URL_REVIEW_STATUS_KEY_PREFIX, filter.hostname.toLowerCase());
    const candidates = (await metadataRowsForPrefix(this.db, prefix)).filter((record): record is MetadataKindRecord =>
      isMetadataRecordKind(record, 'urlReviewStatusEncrypted'),
    );
    if (filter.scope === 'all' || filter.scope === 'hostname') return candidates;
    const stored = hydrateRecords(DataStore.Metadata, encryptedUrlReviewStatusMetadataRecordSchema, candidates);
    const matches: EncryptedUrlReviewStatusMetadataRecord[] = [];
    for (const record of stored) {
      const opened = await this.openEncrypted(record);
      if (opened && (filter.scope === 'page' ? opened.pageUrl === filter.pageUrl : opened.sourceUrl === filter.sourceUrl)) {
        matches.push(record);
      }
    }
    return matches;
  }

  private async migratePlaintextRows(): Promise<void> {
    const raw = await metadataRowsForPrefix(this.db, URL_REVIEW_STATUS_KEY_PREFIX);
    for (const candidate of raw.filter((record): record is MetadataKindRecord => isMetadataRecordKind(record, 'urlReviewStatus'))) {
      const parsed = v.safeParse(urlReviewStatusMetadataRecordSchema, candidate);
      if (!parsed.success) {
        await deleteMetadataRow(this.db, candidate.key);
        continue;
      }
      const record = stripMetadataKey(parsed.output);
      await replaceMetadataRow(this.db, candidate.key, await this.storedRecord('encrypted', record));
    }
  }

  private async migrateEncryptedRows(): Promise<void> {
    const stored = await storedRecordsForPrefix(this.db, 'encrypted', URL_REVIEW_STATUS_KEY_PREFIX);
    for (const encrypted of stored) {
      const record = await this.openEncrypted(encrypted);
      if (record) await replaceMetadataRow(this.db, encrypted.key, await this.storedRecord('plaintext', record));
    }
  }
}

function stripMetadataKey(record: UrlReviewStatusMetadataRecord): UrlReviewStatusRecord {
  const { key: _key, kind: _kind, ...status } = record;
  return status;
}

function compareNewestFirst(left: UrlReviewStatusRecord, right: UrlReviewStatusRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function urlReviewStatusKey(mode: SearchableMetadataMode, hostname: string, sourceUrl: string): Promise<string> | string {
  return mode === 'plaintext'
    ? `${urlReviewStatusPlaintextHostPrefix(hostname)}${encodeURIComponent(sourceUrl)}`
    : encryptedUrlMetadataKey(URL_REVIEW_STATUS_KEY_PREFIX, hostname.toLowerCase(), sourceUrl);
}

function urlReviewStatusHostPrefix(mode: SearchableMetadataMode, hostname: string): Promise<string> | string {
  return mode === 'plaintext'
    ? urlReviewStatusPlaintextHostPrefix(hostname)
    : encryptedUrlMetadataPrefix(URL_REVIEW_STATUS_KEY_PREFIX, hostname.toLowerCase());
}

function urlReviewStatusPlaintextHostPrefix(hostname: string): string {
  return `${URL_REVIEW_STATUS_KEY_PREFIX}${hostname.toLowerCase()}:`;
}

async function trimHostRecords(
  store: IDBObjectStore,
  mode: SearchableMetadataMode,
  prefix: string,
  maxRecordsPerHost: number,
): Promise<void> {
  const records = await storedRecordsInStore(store, mode, prefix);
  if (records.length <= maxRecordsPerHost) return;
  const staleRecords = records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(maxRecordsPerHost);
  for (const record of staleRecords) store.delete(record.key);
}

function normalizeLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_URL_REVIEW_STATUS_LIMIT;
}

async function storedRecordsForPrefix(db: IDBDatabase, mode: 'plaintext', prefix: string): Promise<UrlReviewStatusMetadataRecord[]>;
async function storedRecordsForPrefix(
  db: IDBDatabase,
  mode: 'encrypted',
  prefix: string,
): Promise<EncryptedUrlReviewStatusMetadataRecord[]>;
async function storedRecordsForPrefix(
  db: IDBDatabase,
  mode: SearchableMetadataMode,
  prefix: string,
): Promise<StoredUrlReviewStatusRecord[]> {
  const raw = await metadataRowsForPrefix(db, prefix);
  return storedRecordsFromRaw(raw, mode);
}

async function storedRecordsInStore(
  store: IDBObjectStore,
  mode: SearchableMetadataMode,
  prefix: string,
): Promise<StoredUrlReviewStatusRecord[]> {
  const raw = await requestToPromise<unknown[]>(store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
  return storedRecordsFromRaw(raw, mode);
}

function storedRecordsFromRaw(raw: readonly unknown[], mode: SearchableMetadataMode): StoredUrlReviewStatusRecord[] {
  if (mode === 'plaintext') {
    return hydrateRecords(
      DataStore.Metadata,
      urlReviewStatusMetadataRecordSchema,
      raw.filter((record) => metadataRecordKind(record) === 'urlReviewStatus'),
    );
  }
  return hydrateRecords(
    DataStore.Metadata,
    encryptedUrlReviewStatusMetadataRecordSchema,
    raw.filter((record) => metadataRecordKind(record) === 'urlReviewStatusEncrypted'),
  );
}

async function metadataRowsForPrefix(db: IDBDatabase, prefix: string): Promise<unknown[]> {
  const transaction = db.transaction(DataStore.Metadata, 'readonly');
  const raw = await requestToPromise<unknown[]>(
    transaction.objectStore(DataStore.Metadata).getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)),
  );
  await transactionDone(transaction);
  return raw;
}

async function replaceMetadataRow(db: IDBDatabase, previousKey: string, replacement: StoredUrlReviewStatusRecord): Promise<void> {
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
