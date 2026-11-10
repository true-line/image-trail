import { assertKeyReference } from '../crypto/key-reference.js';
import type { StoredKeyRecord } from '../crypto/types.js';
import { storedKeyRecordSchema } from '../crypto/types.schema.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { DataStore } from '../schema.js';
import { SchemaIndex } from '../schema.js';
import { hydrateRecord, hydrateRecords } from './hydration.js';

export class KeysRepository {
  constructor(private readonly db: IDBDatabase) {}

  async put(record: StoredKeyRecord): Promise<void> {
    assertKeyReference(record);
    const transaction = this.db.transaction(DataStore.Keys, 'readwrite');
    transaction.objectStore(DataStore.Keys).put(record);
    await transactionDone(transaction);
  }

  /**
   * Stores `record` unless a key of the same kind that `matches` already exists, checking and
   * writing in one transaction so concurrent creators converge on a single key. Returns the stored key.
   */
  async putUnlessKindExists<T extends StoredKeyRecord>(record: T, matches: (stored: StoredKeyRecord) => stored is T): Promise<T> {
    assertKeyReference(record);
    const transaction = this.db.transaction(DataStore.Keys, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(DataStore.Keys);
    const rows = await requestToPromise<unknown[]>(store.index(SchemaIndex.KeysByKind).getAll(record.kind));
    const existing = hydrateRecords(DataStore.Keys, storedKeyRecordSchema, rows).find(matches);
    if (!existing) store.put(record);
    await done;
    return existing ?? record;
  }

  async get(reference: string): Promise<StoredKeyRecord | undefined> {
    const transaction = this.db.transaction(DataStore.Keys, 'readonly');
    const result = await requestToPromise<unknown>(transaction.objectStore(DataStore.Keys).get(reference));
    await transactionDone(transaction);
    return hydrateRecord(DataStore.Keys, storedKeyRecordSchema, result);
  }

  async listByKind(kind: StoredKeyRecord['kind']): Promise<readonly StoredKeyRecord[]> {
    const transaction = this.db.transaction(DataStore.Keys, 'readonly');
    const result = await requestToPromise<unknown[]>(transaction.objectStore(DataStore.Keys).index(SchemaIndex.KeysByKind).getAll(kind));
    await transactionDone(transaction);
    return hydrateRecords(DataStore.Keys, storedKeyRecordSchema, result);
  }

  async remove(reference: string): Promise<void> {
    const transaction = this.db.transaction(DataStore.Keys, 'readwrite');
    transaction.objectStore(DataStore.Keys).delete(reference);
    await transactionDone(transaction);
  }
}
