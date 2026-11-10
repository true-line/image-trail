import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { getActiveBlobKey, lockBlobKey } from '../extension/src/data/crypto/blob-keyring.js';
import { createBlobKeyMessageRegistry } from '../extension/src/background/handlers/blob-key-handlers.js';
import { KeysRepository } from '../extension/src/data/repositories/keys-repository.js';
import { MessageType, createSetupBlobKeyMessage, type BlobKeyResultMessage } from '../extension/src/background/messages.js';
import { openFreshImageTrailDb } from './indexeddb-test-helpers.js';

async function setup(registry: ReturnType<typeof createBlobKeyMessageRegistry>, password: string) {
  return (await registry[MessageType.SetupBlobKey].handle(createSetupBlobKeyMessage(password))) as BlobKeyResultMessage['payload'];
}

test('setup leaves encrypted storage locked when the new key cannot be persisted', async (t) => {
  await lockBlobKey();
  const db = await openFreshImageTrailDb();
  const originalPut = KeysRepository.prototype.putUnlessKindExists;
  KeysRepository.prototype.putUnlessKindExists = async () => {
    throw new Error('QuotaExceededError');
  };
  t.after(async () => {
    KeysRepository.prototype.putUnlessKindExists = originalPut;
    await lockBlobKey();
    db.close();
  });
  const registry = createBlobKeyMessageRegistry({ getDb: async () => db });

  await assert.rejects(setup(registry, 'correct horse'), /QuotaExceededError/u);

  assert.equal(getActiveBlobKey(), null, 'a key that was never saved must not unlock the session');
  assert.deepEqual(await new KeysRepository(db).listByKind('blob'), []);
});

test('setup refuses to create a second blob key, including a concurrent duplicate request', async (t) => {
  await lockBlobKey();
  const db = await openFreshImageTrailDb();
  t.after(async () => {
    await lockBlobKey();
    db.close();
  });
  const registry = createBlobKeyMessageRegistry({ getDb: async () => db });

  const results = await Promise.all([setup(registry, 'first password'), setup(registry, 'first password')]);
  const created = results.filter((result) => result.ok);
  assert.equal(created.length, 1, 'exactly one concurrent setup creates a key');
  assert.deepEqual(
    results.find((result) => !result.ok),
    { ok: false, reason: 'key-exists', message: 'Encrypted storage is already set up. Unlock it with its password.' },
  );
  const keyReference = created[0]!.ok ? created[0]!.keyReference : '';

  await lockBlobKey();
  const second = await setup(registry, 'second password');
  assert.equal(second.ok === false && second.reason, 'key-exists');
  assert.equal(getActiveBlobKey(), null, 'a refused setup does not unlock anything');
  assert.deepEqual(
    (await new KeysRepository(db).listByKind('blob')).map((key) => key.reference),
    [keyReference],
  );
});
