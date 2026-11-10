import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  createAndActivateWrappedBlobKey,
  getActiveBlobKey,
  getBlobKeySessionSnapshot,
  lockBlobKey,
} from '../extension/src/data/crypto/blob-keyring.js';
import { orderBlobKeysForUnlock } from '../extension/src/data/crypto/blob-key-unlock.js';
import { openJsonEnvelope, sealJsonEnvelope } from '../extension/src/data/crypto/envelope.js';
import type { StoredKeyRecord } from '../extension/src/data/crypto/types.js';
import { exportStoredKeyBackupWithPassword, importStoredKeyBackupWithPassword } from '../extension/src/data/import-export/key-backup.js';
import { KeysRepository } from '../extension/src/data/repositories/keys-repository.js';
import { createBlobKeyMessageRegistry } from '../extension/src/background/handlers/blob-key-handlers.js';
import {
  MessageType,
  createExportBlobKeyBackupMessage,
  createImportBlobKeyBackupMessage,
  createSetupBlobKeyMessage,
  createUnlockBlobKeyMessage,
  type BlobKeyResultMessage,
  type ExportBlobKeyBackupResultMessage,
  type ImportBlobKeyBackupResultMessage,
} from '../extension/src/background/messages.js';
import { openFreshImageTrailDb } from './indexeddb-test-helpers.js';

// Issue #945: restoring another device's key backup must not lock this device out of its own data.
const localPassword = 'local device password';
const foreignPassword = 'other device password';
const backupPassword = 'backup file password';

let db: IDBDatabase;
let registry: ReturnType<typeof createBlobKeyMessageRegistry>;

beforeEach(async () => {
  await lockBlobKey();
  db = await openFreshImageTrailDb();
  registry = createBlobKeyMessageRegistry({ getDb: async () => db });
});

afterEach(async () => {
  await lockBlobKey();
  db.close();
});

async function unlock(password: string, keyReference?: string): Promise<BlobKeyResultMessage['payload']> {
  const entry = registry[MessageType.UnlockBlobKey];
  return ((await entry.respond(await entry.handle(createUnlockBlobKeyMessage(password, keyReference)))) as BlobKeyResultMessage).payload;
}

async function setUpLocalKey(password: string): Promise<string> {
  const entry = registry[MessageType.SetupBlobKey];
  const result = ((await entry.respond(await entry.handle(createSetupBlobKeyMessage(password)))) as BlobKeyResultMessage).payload;
  assert.ok(result.ok && result.keyReference);
  return result.keyReference;
}

/** Builds another device's blob key backup, newer than any key this test set up, and imports it. */
async function importForeignKey(password: string, createdAt = '2099-01-01T00:00:00.000Z'): Promise<string> {
  // `never` keeps a far-future `now` from arming an out-of-range inactivity timer.
  const foreign = await createAndActivateWrappedBlobKey({ password, uuid: 'foreign-device-key', now: createdAt, timeoutMinutes: 'never' });
  await lockBlobKey();
  const backup = await exportStoredKeyBackupWithPassword(foreign.metadata, backupPassword);
  assert.ok(backup.fileContent);
  const entry = registry[MessageType.ImportBlobKeyBackup];
  const message = createImportBlobKeyBackupMessage(backup.fileContent, backupPassword);
  const result = ((await entry.respond(await entry.handle(message))) as ImportBlobKeyBackupResultMessage).payload;
  assert.ok(result.ok && result.imported);
  return foreign.metadata.reference;
}

async function sealWithActiveKey(): Promise<Awaited<ReturnType<typeof sealJsonEnvelope>>> {
  const active = getActiveBlobKey();
  assert.ok(active);
  return sealJsonEnvelope({
    payload: { note: 'local private pin' },
    payloadVersion: 1,
    key: active.key,
    keyReference: active.reference,
    authenticatedMetadata: { recordType: 'encrypted-pin' },
  });
}

test('the local password still unlocks local data after a newer key with another password is imported', async () => {
  const localReference = await setUpLocalKey(localPassword);
  const localEnvelope = await sealWithActiveKey();
  await lockBlobKey();
  const foreignReference = await importForeignKey(foreignPassword);

  const local = await unlock(localPassword);
  assert.equal(local.ok, true);
  assert.equal(local.keyReference, localReference);
  assert.deepEqual(await openJsonEnvelope(localEnvelope, getActiveBlobKey()!.key), { note: 'local private pin' });

  await lockBlobKey();
  const foreign = await unlock(foreignPassword);
  assert.equal(foreign.ok, true);
  assert.equal(foreign.keyReference, foreignReference, 'the imported key stays reachable with its own password');
});

test('when both keys share a password, the local key stays the sealing key', async () => {
  const localReference = await setUpLocalKey(localPassword);
  const localEnvelope = await sealWithActiveKey();
  await lockBlobKey();
  await importForeignKey(localPassword);

  const result = await unlock(localPassword);
  assert.equal(result.ok, true);
  assert.equal(result.keyReference, localReference);
  assert.equal(getActiveBlobKey()?.reference.reference, localReference);
  assert.deepEqual(await openJsonEnvelope(localEnvelope, getActiveBlobKey()!.key), { note: 'local private pin' });
});

test('an imported key older than the local key does not become the sealing key either', async () => {
  const localReference = await setUpLocalKey(localPassword);
  await lockBlobKey();
  await importForeignKey(localPassword, '2000-01-01T00:00:00.000Z');

  const result = await unlock(localPassword);
  assert.equal(result.ok && result.keyReference, localReference);
});

test('a password that matches no stored key fails cleanly and leaves the session locked', async () => {
  await setUpLocalKey(localPassword);
  await lockBlobKey();
  await importForeignKey(foreignPassword);

  const result = await unlock('neither password');
  assert.deepEqual(result, { ok: false, reason: 'wrong-password', message: 'Password did not unlock encrypted storage.' });
  assert.equal(getActiveBlobKey(), null);
  assert.equal(getBlobKeySessionSnapshot().status, 'locked');
});

test('an explicit key reference unlocks only that key', async () => {
  const localReference = await setUpLocalKey(localPassword);
  await lockBlobKey();
  const foreignReference = await importForeignKey(localPassword);

  const foreign = await unlock(localPassword, foreignReference);
  assert.equal(foreign.ok && foreign.keyReference, foreignReference);

  await lockBlobKey();
  // The requested key is tried alone: a wrong password for it does not fall through to another key.
  const wrong = await unlock('neither password', localReference);
  assert.equal(wrong.ok === false && wrong.reason, 'wrong-password');
  assert.equal(getActiveBlobKey(), null);
});

test('import marks the key as imported, and its backup export leaves that marker out', async () => {
  const localReference = await setUpLocalKey(localPassword);
  await lockBlobKey();
  const foreignReference = await importForeignKey(foreignPassword);
  const keys = new KeysRepository(db);
  assert.equal((await keys.get(localReference))?.importedAt, undefined);
  assert.equal(typeof (await keys.get(foreignReference))?.importedAt, 'string');

  const entry = registry[MessageType.ExportBlobKeyBackup];
  const message = createExportBlobKeyBackupMessage(backupPassword, foreignReference);
  const exported = ((await entry.respond(await entry.handle(message))) as ExportBlobKeyBackupResultMessage).payload;
  assert.ok(exported.ok && exported.fileContent);
  const roundTrip = await importStoredKeyBackupWithPassword(exported.fileContent, backupPassword);
  assert.ok(roundTrip.record);
  assert.equal('importedAt' in roundTrip.record, false);
});

function keyRecord(uuid: string, createdAt: string, importedAt?: string): StoredKeyRecord<'blob'> {
  return {
    kind: 'blob',
    uuid,
    reference: `blob:${uuid}`,
    createdAt,
    updatedAt: createdAt,
    wrapping: { mode: 'password', algorithm: 'AES-GCM' },
    extractable: false,
    ...(importedAt ? { importedAt } : {}),
  };
}

test('unlock order puts local keys first, then oldest first, with the reference as tie-break', () => {
  const ordered = orderBlobKeysForUnlock([
    keyRecord('imported-old', '2000-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    keyRecord('local-new', '2026-02-01T00:00:00.000Z'),
    keyRecord('legacy-b', '2025-01-01T00:00:00.000Z'),
    keyRecord('legacy-a', '2025-01-01T00:00:00.000Z'),
  ]);
  assert.deepEqual(
    ordered.map((key) => key.uuid),
    ['legacy-a', 'legacy-b', 'local-new', 'imported-old'],
  );
});
