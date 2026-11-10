import { createKeyReference } from './crypto/key-reference.js';
import type { KeyReference, StoredKeyRecord } from './crypto/types.js';
import { generateAesGcmKey } from './crypto/webcrypto.js';
import type { KeysRepository } from './repositories/keys-repository.js';

interface DurableBookmarkKeyRecord extends StoredKeyRecord<'bookmark'> {
  readonly key: CryptoKey;
}

export interface DurableBookmarkKeyContext {
  readonly reference: KeyReference<'bookmark'>;
  readonly key: CryptoKey;
}

export async function ensureDurableBookmarkKey(repository: KeysRepository): Promise<DurableBookmarkKeyContext> {
  const existing = (await repository.listByKind('bookmark')).find(isDurableBookmarkKeyRecord);
  if (existing) return { reference: existing, key: existing.key };

  const uuid = crypto.randomUUID();
  const reference = createKeyReference('bookmark', uuid);
  const now = new Date().toISOString();
  const record: DurableBookmarkKeyRecord = {
    ...reference,
    key: await generateAesGcmKey(false),
    createdAt: now,
    updatedAt: now,
    wrapping: { mode: 'indexeddb', algorithm: 'none' },
    extractable: false,
  };
  // Callers run independently on first use; whichever key lands first is the one every caller uses.
  const stored = await repository.putUnlessKindExists(record, isDurableBookmarkKeyRecord);
  return stored === record ? { reference, key: record.key } : { reference: stored, key: stored.key };
}

/** Ensures the key for a freshly opened database and closes that connection if it fails, so a retried open does not leak it. */
export async function ensureDurableBookmarkKeyOrClose(db: IDBDatabase, repository: KeysRepository): Promise<DurableBookmarkKeyContext> {
  try {
    return await ensureDurableBookmarkKey(repository);
  } catch (error) {
    db.close();
    throw error;
  }
}

function isDurableBookmarkKeyRecord(record: StoredKeyRecord): record is DurableBookmarkKeyRecord {
  return typeof CryptoKey !== 'undefined' && record.kind === 'bookmark' && record.key instanceof CryptoKey;
}
