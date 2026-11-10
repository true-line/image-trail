import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';

import { createOriginalBlobMessageRegistry } from '../extension/src/background/handlers/original-blob-handlers.js';
import type { MessageDef } from '../extension/src/background/message-dispatch.js';
import {
  MessageType,
  createCheckOriginalBlobsMessage,
  createExportOriginalBlobsMessage,
  createImportOriginalBlobsMessage,
  type CheckOriginalBlobsResultMessage,
  type ExportOriginalBlobsResultMessage,
  type ExtensionRequest,
  type ExtensionResponse,
  type ImportOriginalBlobsResultMessage,
} from '../extension/src/background/messages.js';
import { createKeyReference } from '../extension/src/data/crypto/key-reference.js';
import { portableStoredBlobRecord } from '../extension/src/data/import-export/full-backup.js';
import { BlobsRepository } from '../extension/src/data/repositories/blobs-repository.js';
import type { StoredBlobRecord } from '../extension/src/data/types.js';
import { openFreshImageTrailDb } from './indexeddb-test-helpers.js';
import { DataStore } from '../extension/src/data/schema.js';

type AnyEntry = MessageDef<ExtensionRequest, ExtensionResponse>;

function record(id: string): StoredBlobRecord {
  return {
    id,
    kind: 'original',
    schemaVersion: 1,
    algorithm: 'AES-GCM',
    iv: 'AAAAAAAAAAAAAAAA',
    ciphertext: new ArrayBuffer(1_000_000),
    encryptedByteLength: 1_000_000,
    createdAt: '2026-07-13T00:00:00.000Z',
    key: createKeyReference('blob', 'blob-key-1'),
    referenceCount: 1,
  };
}

async function handleAndRespond<Res extends ExtensionResponse>(entry: AnyEntry, message: ExtensionRequest): Promise<Res> {
  return entry.respond(await entry.handle(message)) as Res;
}

test('original check returns only missing ids without hydrating ciphertext', async (t) => {
  const db = await openFreshImageTrailDb();
  t.after(() => db.close());
  await new BlobsRepository(db).put(record('present-original'));
  await new BlobsRepository(db).put({ ...record('present-thumbnail'), kind: 'thumbnail' });
  const corruptWrite = db.transaction(DataStore.Blobs, 'readwrite');
  corruptWrite.objectStore(DataStore.Blobs).put({ id: 'malformed-row', kind: 'not-a-kind', schemaVersion: 99 });
  await new Promise<void>((resolve, reject) => {
    corruptWrite.oncomplete = () => resolve();
    corruptWrite.onerror = () => reject(corruptWrite.error);
  });
  const registry = createOriginalBlobMessageRegistry({ getDb: async () => db });
  const originalGet = BlobsRepository.prototype.get;
  BlobsRepository.prototype.get = () => {
    throw new Error('original existence checks must not hydrate records');
  };
  t.after(() => {
    BlobsRepository.prototype.get = originalGet;
  });

  const result = await handleAndRespond<CheckOriginalBlobsResultMessage>(
    registry[MessageType.CheckOriginalBlobs],
    createCheckOriginalBlobsMessage(['missing-a', 'present-original', 'present-thumbnail', 'malformed-row', 'missing-a', 'missing-b']),
  );

  assert.equal(result.type, MessageType.CheckOriginalBlobsResult);
  assert.deepEqual(result.payload, {
    ok: true,
    missingBlobIds: ['missing-a', 'present-thumbnail', 'malformed-row', 'missing-b'],
  });
});

test('original check reports database and dispatch fallback failures', async () => {
  const registry = createOriginalBlobMessageRegistry({ getDb: async () => null });
  const message = createCheckOriginalBlobsMessage(['blob-1']);
  const result = await handleAndRespond<CheckOriginalBlobsResultMessage>(registry[MessageType.CheckOriginalBlobs], message);
  const fallback = registry[MessageType.CheckOriginalBlobs].fallback(message) as CheckOriginalBlobsResultMessage;

  assert.deepEqual(result.payload, { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' });
  assert.deepEqual(fallback.payload, { ok: false, reason: 'unknown', message: 'Encrypted original check failed.' });
});

test('extracted original export and import handlers preserve portable backup behavior', async (t) => {
  const db = await openFreshImageTrailDb();
  t.after(() => db.close());
  await new BlobsRepository(db).put(record('exported-original'));
  const registry = createOriginalBlobMessageRegistry({ getDb: async () => db });

  const exported = await handleAndRespond<ExportOriginalBlobsResultMessage>(
    registry[MessageType.ExportOriginalBlobs],
    createExportOriginalBlobsMessage(['exported-original', 'missing-original']),
  );
  assert.equal(exported.payload.ok, true);
  if (!exported.payload.ok) return;
  assert.equal(exported.payload.records.length, 1);
  assert.deepEqual(exported.payload.missingBlobIds, ['missing-original']);

  const imported = await handleAndRespond<ImportOriginalBlobsResultMessage>(
    registry[MessageType.ImportOriginalBlobs],
    createImportOriginalBlobsMessage(exported.payload.records),
  );
  assert.deepEqual(imported.payload, { ok: true, importedCount: 0, skippedCount: 1 }, 'the stored original already has that id');
});

test('original import keeps existing bytes on an id collision and reports the skip', async (t) => {
  const db = await openFreshImageTrailDb();
  t.after(() => db.close());
  const blobs = new BlobsRepository(db);
  await blobs.put(record('colliding-original'));
  const foreignBytes = new Uint8Array([7, 7, 7, 7]).buffer;
  const registry = createOriginalBlobMessageRegistry({ getDb: async () => db });

  const imported = await handleAndRespond<ImportOriginalBlobsResultMessage>(
    registry[MessageType.ImportOriginalBlobs],
    createImportOriginalBlobsMessage([
      portableStoredBlobRecord({ ...record('colliding-original'), ciphertext: foreignBytes, encryptedByteLength: 4 }),
      portableStoredBlobRecord(record('new-original')),
    ]),
  );

  assert.deepEqual(imported.payload, { ok: true, importedCount: 1, skippedCount: 1 });
  assert.equal((await blobs.get('colliding-original'))?.encryptedByteLength, 1_000_000, 'the existing original bytes are kept');
  assert.equal((await blobs.get('new-original'))?.encryptedByteLength, 1_000_000);
  assert.deepEqual(await blobs.findMissingOriginalIds(['colliding-original', 'new-original']), []);
});
