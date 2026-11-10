import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';

import { parseInteropEnvelope } from '../extension/src/core/interop/messages.js';
import {
  EncryptedInteropTransport,
  InteropTransportError,
  sha256,
  type InteropObjectPage,
  type InteropObjectStore,
} from '../extension/src/core/interop/transport.js';
import { openImageTrailDb } from '../extension/src/data/db.js';
import { transactionDone } from '../extension/src/data/idb-helpers.js';
import { DataStore } from '../extension/src/data/schema.js';
import type { DurableBookmarkPayloadV1 } from '../extension/src/data/types.js';
import { sealBlobPayload } from '../extension/src/data/crypto/binary-envelope.js';
import type { ActiveBlobKey } from '../extension/src/data/crypto/blob-keyring.js';
import { createKeyReference } from '../extension/src/data/crypto/key-reference.js';
import { generateAesGcmKey } from '../extension/src/data/crypto/webcrypto.js';
import { ensureDurableBookmarkKey } from '../extension/src/data/durable-bookmark-key.js';
import { MoveAcknowledgementReconciler, moveAcknowledgementPath } from '../extension/src/data/interop/move-acknowledgement-reconciler.js';
import { isMoveRecordEnvelope, type MoveRecordEnvelope } from '../extension/src/data/interop/move-journal-records.js';
import { MoveOutboxPublisher } from '../extension/src/data/interop/move-outbox-publisher.js';
import { finalizeInteropMoveSource } from '../extension/src/data/interop/move-source-finalizer.js';
import { importInteropPairingBundle } from '../extension/src/data/interop/pairing-import.js';
import { openInteropMessage, sealInteropMessage } from '../extension/src/data/interop/sealed-message.js';
import { SecureMoveOutboxRepository } from '../extension/src/data/interop/secure-move-outbox-repository.js';
import { BookmarksRepository } from '../extension/src/data/repositories/bookmarks-repository.js';
import { BlobsRepository } from '../extension/src/data/repositories/blobs-repository.js';
import { InteropKeysRepository, type StoredInteropKeyRecord } from '../extension/src/data/repositories/interop-keys-repository.js';
import { KeysRepository } from '../extension/src/data/repositories/keys-repository.js';

const INTEROP_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const ACKNOWLEDGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const TRANSFER_ID = '44444444-4444-4444-8444-444444444444';
const BLOB_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const BLOB_STORAGE_ID = '66666666-6666-4666-8666-666666666666';
const BLOB_KEY_ID = '77777777-7777-4777-8777-777777777777';

class MemoryStore implements InteropObjectStore {
  readonly provider = 'pcloud' as const;
  readonly objects = new Map<string, Uint8Array>();

  authState(): Promise<'connected'> {
    return Promise.resolve('connected');
  }
  put(path: string, bytes: Uint8Array): Promise<{ readonly bytes: number }> {
    this.objects.set(path, bytes.slice());
    return Promise.resolve({ bytes: bytes.byteLength });
  }
  get(path: string): Promise<Uint8Array> {
    const value = this.objects.get(path);
    return value ? Promise.resolve(value.slice()) : Promise.reject(new InteropTransportError('missing', 'not-found', false));
  }
  list(prefix: string, cursor: string | null): Promise<InteropObjectPage> {
    const values = [...this.objects.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, bytes]) => ({ path, bytes: bytes.byteLength }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const offset = cursor === null ? 0 : Number(cursor);
    const entries = values.slice(offset, offset + 2);
    return Promise.resolve({ entries, nextCursor: offset + entries.length < values.length ? String(offset + entries.length) : null });
  }
  delete(path: string): Promise<void> {
    this.objects.delete(path);
    return Promise.resolve();
  }
  quota(): Promise<{ readonly usedBytes: number; readonly totalBytes: number }> {
    return Promise.resolve({ usedBytes: 0, totalBytes: 1_000_000 });
  }
  async verify(path: string): Promise<{ readonly sha256: string; readonly bytes: number }> {
    const value = await this.get(path);
    return { sha256: await sha256(value), bytes: value.byteLength };
  }
}

async function setup(captured: boolean, availableOriginal = false) {
  const opened = await openImageTrailDb(new IDBFactory());
  assert.ok(opened.db);
  const key = await ensureDurableBookmarkKey(new KeysRepository(opened.db));
  await new BookmarksRepository(opened.db).sealAndPut(
    'bookmark-1',
    {
      url: 'https://example.test/image.jpg',
      title: 'Source record',
      bookmarkedAt: '2026-07-17T12:00:00.000Z',
      ...(captured
        ? {
            storedOriginal: {
              blobId: 'blob-1',
              mimeType: 'image/jpeg',
              byteLength: 42,
              capturedAt: '2026-07-17T12:01:00.000Z',
            },
          }
        : {}),
    },
    key.key,
    key.reference,
    '2026-07-17T12:02:00.000Z',
  );
  await importInteropPairingBundle({
    db: opened.db,
    bundle: JSON.parse(readFileSync('contracts/interop/v1/fixtures/valid-pairing-bundle.json', 'utf8')) as unknown,
    password: 'fixture-password',
  });
  const pairing = (await new InteropKeysRepository(opened.db).list())[0];
  assert.ok(pairing);
  const store = new MemoryStore();
  let activeBlobKey: ActiveBlobKey | null = null;
  if (availableOriginal) {
    const reference = createKeyReference('blob', BLOB_KEY_ID);
    const key = await generateAesGcmKey(false);
    const bytes = Uint8Array.from({ length: 42 }, (_value, index) => index);
    const createdAt = '2026-07-17T12:01:00.000Z';
    const aad = {
      id: 'blob-1',
      kind: 'original' as const,
      schemaVersion: 1 as const,
      algorithm: 'AES-GCM' as const,
      createdAt,
      key: reference,
    };
    const sealed = await sealBlobPayload({
      key,
      aad,
      metadata: {
        mimeType: 'image/jpeg',
        byteLength: bytes.byteLength,
        sourceUrl: 'https://example.test/image.jpg',
        capturedAt: createdAt,
      },
      bytes: bytes.buffer,
    });
    await new BlobsRepository(opened.db).put({ ...aad, ...sealed, referenceCount: 1 });
    activeBlobKey = { reference, key };
  }
  const ids = [INTEROP_ID, SOURCE_MESSAGE_ID, BLOB_MESSAGE_ID, BLOB_STORAGE_ID];
  await new MoveOutboxPublisher(opened.db, store, {
    now: () => '2026-07-17T12:03:00.000Z',
    createId: () => ids.shift() ?? crypto.randomUUID(),
  }).start({ transferId: TRANSFER_ID, recordIds: ['bookmark-1'], pairing, activeBlobKey });
  return { db: opened.db, pairing, store };
}

async function sourceEnvelope(db: IDBDatabase, pairing: StoredInteropKeyRecord): Promise<MoveRecordEnvelope> {
  const outbox = (await new SecureMoveOutboxRepository(db).outbox(TRANSFER_ID))[0];
  assert.ok(outbox);
  const envelope = await openInteropMessage(new Uint8Array(outbox.ciphertext.slice(0)), pairing);
  assert.equal(isMoveRecordEnvelope(envelope), true);
  return envelope as MoveRecordEnvelope;
}

async function uploadAcknowledgement(
  db: IDBDatabase,
  pairing: StoredInteropKeyRecord,
  store: MemoryStore,
  input: { readonly acknowledgedMessageIds?: readonly string[]; readonly status?: 'accepted' | 'rejected' } = {},
): Promise<void> {
  const source = await sourceEnvelope(db, pairing);
  const status = input.status ?? 'accepted';
  const acknowledgement = parseInteropEnvelope({
    header: {
      ...source.header,
      messageId: ACKNOWLEDGEMENT_ID,
      sourceProduct: 'overlook',
      targetProduct: 'image-trail',
      kind: 'acknowledgement',
      createdAt: '2026-07-17T12:04:00.000Z',
    },
    payload: {
      kind: 'acknowledgement',
      schemaVersion: 1,
      status,
      recordInteropId: source.payload.record.identity.interopId,
      targetLocalId: status === 'accepted' ? 'overlook-1' : null,
      metadataPersisted: status === 'accepted',
      originalVerification: source.payload.record.original.state === 'available' ? 'verified' : source.payload.record.original.state,
      acknowledgedMessageIds: input.acknowledgedMessageIds ?? [source.header.messageId],
      errors:
        status === 'accepted'
          ? []
          : [{ code: 'unsupported-record', message: 'Rejected by target.', retryable: false, recordInteropId: INTEROP_ID }],
    },
  });
  const sealed = await sealInteropMessage(acknowledgement, pairing);
  await new EncryptedInteropTransport(store).upload(
    { pairingId: pairing.pairingId, transferId: TRANSFER_ID },
    moveAcknowledgementPath(acknowledgement.header.sequence, acknowledgement.header.messageId),
    sealed,
  );
  sealed.fill(0);
}

test('accepted sealed acknowledgement finalizes an eligible source exactly once', async (t) => {
  const { db, pairing, store } = await setup(false);
  t.after(() => db.close());
  await uploadAcknowledgement(db, pairing, store);
  const finalized: string[] = [];
  const reconciler = new MoveAcknowledgementReconciler(db, store, {
    finalize: async (sourceLocalId, sourceUpdatedAt, sourceFingerprint) => {
      finalized.push(sourceLocalId);
      assert.equal(await finalizeInteropMoveSource(db, sourceLocalId, sourceUpdatedAt, sourceFingerprint), true);
    },
  });
  const locked = await reconciler.reconcile({ transferId: TRANSFER_ID, total: 1, pairing, allowFinalization: false });
  assert.equal(locked.journal.phase, 'acknowledged');
  assert.equal(locked.counts.acknowledged, 1);
  assert.equal(locked.counts.finalized, 0);
  assert.deepEqual(finalized, []);
  const completed = await reconciler.reconcile({ transferId: TRANSFER_ID, total: 1, pairing, allowFinalization: true });
  assert.equal(completed.journal.phase, 'completed');
  assert.equal(completed.counts.finalized, 1);
  assert.deepEqual(finalized, ['bookmark-1']);
  assert.equal(await new BookmarksRepository(db).getEncrypted('bookmark-1'), undefined);
  await reconciler.reconcile({ transferId: TRANSFER_ID, total: 1, pairing, allowFinalization: true });
  assert.deepEqual(finalized, ['bookmark-1']);
});

test('metadata-only original acknowledgement never authorizes source deletion', async (t) => {
  const { db, pairing, store } = await setup(true);
  t.after(() => db.close());
  await uploadAcknowledgement(db, pairing, store);
  let finalizations = 0;
  const progress = await new MoveAcknowledgementReconciler(db, store, {
    finalize: async () => {
      finalizations += 1;
    },
  }).reconcile({ transferId: TRANSFER_ID, total: 1, pairing, allowFinalization: true });
  assert.equal(progress.journal.phase, 'acknowledged');
  assert.equal(progress.counts.acknowledged, 1);
  assert.equal(progress.counts.finalized, 0);
  assert.equal(finalizations, 0);
});

test('source edits made after review stop finalization', async (t) => {
  const { db, pairing, store } = await setup(false);
  t.after(() => db.close());
  await uploadAcknowledgement(db, pairing, store);
  const bookmarks = new BookmarksRepository(db);
  const key = await ensureDurableBookmarkKey(new KeysRepository(db));
  const encrypted = await bookmarks.getEncrypted('bookmark-1');
  assert.ok(encrypted);
  const payload = await bookmarks.openRecord(encrypted, key.key);
  await bookmarks.sealAndPut(
    encrypted.uuid,
    { ...payload, title: 'Edited after review' },
    key.key,
    key.reference,
    '2026-07-17T12:05:00.000Z',
    encrypted.url,
    encrypted.queueUpdatedAt,
  );
  const progress = await new MoveAcknowledgementReconciler(db, store, {
    finalize: finalizeThrough(db),
  }).reconcile({ transferId: TRANSFER_ID, total: 1, pairing, allowFinalization: true });
  assert.equal(progress.journal.phase, 'failed');
  assert.equal(progress.counts.finalized, 0);
  assert.equal((await bookmarks.getEncrypted('bookmark-1'))?.envelope.updatedAt, '2026-07-17T12:05:00.000Z');
});

function finalizeThrough(db: IDBDatabase) {
  return (sourceLocalId: string, sourceUpdatedAt: string, sourceFingerprint?: string) =>
    finalizeInteropMoveSource(db, sourceLocalId, sourceUpdatedAt, sourceFingerprint).then(() => undefined);
}

// Normal re-seals reuse the existing envelope timestamp (queue order must not follow it), so these
// edits keep `updatedAt` identical to the reviewed value, exactly as the product does.
async function resealKeepingTimestamp(db: IDBDatabase, change: Partial<DurableBookmarkPayloadV1>): Promise<void> {
  const bookmarks = new BookmarksRepository(db);
  const key = await ensureDurableBookmarkKey(new KeysRepository(db));
  const encrypted = await bookmarks.getEncrypted('bookmark-1');
  assert.ok(encrypted);
  const payload = await bookmarks.openRecord(encrypted, key.key);
  await bookmarks.sealAndPut(
    encrypted.uuid,
    { ...payload, ...change },
    key.key,
    key.reference,
    encrypted.envelope.updatedAt,
    encrypted.url,
    encrypted.queueUpdatedAt,
  );
}

test('a same-timestamp edit after review stops finalization and keeps the record', async (t) => {
  const { db, pairing, store } = await setup(false);
  t.after(() => db.close());
  await uploadAcknowledgement(db, pairing, store);
  const reviewed = await new BookmarksRepository(db).getEncrypted('bookmark-1');
  await resealKeepingTimestamp(db, { title: 'Edited after review' });
  const edited = await new BookmarksRepository(db).getEncrypted('bookmark-1');
  assert.equal(edited?.envelope.updatedAt, reviewed?.envelope.updatedAt);
  const progress = await new MoveAcknowledgementReconciler(db, store, { finalize: finalizeThrough(db) }).reconcile({
    transferId: TRANSFER_ID,
    total: 1,
    pairing,
    allowFinalization: true,
  });
  assert.equal(progress.journal.phase, 'failed');
  assert.equal(progress.counts.finalized, 0);
  assert.ok(await new BookmarksRepository(db).getEncrypted('bookmark-1'));
});

test('an original captured after review stops finalization and the original survives', async (t) => {
  const { db, pairing, store } = await setup(false);
  t.after(() => db.close());
  await uploadAcknowledgement(db, pairing, store);
  const createdAt = '2026-07-17T12:04:30.000Z';
  const reference = createKeyReference('blob', BLOB_KEY_ID);
  const aad = {
    id: 'late-blob',
    kind: 'original' as const,
    schemaVersion: 1 as const,
    algorithm: 'AES-GCM' as const,
    createdAt,
    key: reference,
  };
  const bytes = Uint8Array.from({ length: 8 }, (_value, index) => index);
  const sealed = await sealBlobPayload({
    key: await generateAesGcmKey(false),
    aad,
    metadata: { mimeType: 'image/jpeg', byteLength: 8, sourceUrl: 'https://example.test/image.jpg', capturedAt: createdAt },
    bytes: bytes.buffer,
  });
  await new BlobsRepository(db).put({ ...aad, ...sealed, referenceCount: 1 });
  await resealKeepingTimestamp(db, {
    storedOriginal: { blobId: 'late-blob', mimeType: 'image/jpeg', byteLength: 8, capturedAt: createdAt },
  });
  const progress = await new MoveAcknowledgementReconciler(db, store, { finalize: finalizeThrough(db) }).reconcile({
    transferId: TRANSFER_ID,
    total: 1,
    pairing,
    allowFinalization: true,
  });
  assert.equal(progress.journal.phase, 'failed');
  assert.equal(progress.counts.finalized, 0);
  assert.ok(await new BookmarksRepository(db).getEncrypted('bookmark-1'));
  assert.ok(await new BlobsRepository(db).get('late-blob'));
});

test('a review recorded without a fingerprint never deletes the source', async (t) => {
  const { db, pairing, store } = await setup(false);
  t.after(() => db.close());
  await uploadAcknowledgement(db, pairing, store);
  const outbox = new SecureMoveOutboxRepository(db);
  const item = await outbox.item(TRANSFER_ID, INTEROP_ID);
  assert.ok(item?.sourceFingerprint);
  const { sourceFingerprint: _legacy, ...legacy } = item;
  const transaction = db.transaction(DataStore.MoveItems, 'readwrite');
  transaction.objectStore(DataStore.MoveItems).put(legacy);
  await transactionDone(transaction);
  assert.equal((await outbox.item(TRANSFER_ID, INTEROP_ID))?.sourceFingerprint, undefined);
  const progress = await new MoveAcknowledgementReconciler(db, store, { finalize: finalizeThrough(db) }).reconcile({
    transferId: TRANSFER_ID,
    total: 1,
    pairing,
    allowFinalization: true,
  });
  assert.equal(progress.journal.phase, 'failed');
  assert.equal(progress.counts.finalized, 0);
  assert.ok(await new BookmarksRepository(db).getEncrypted('bookmark-1'));
});

test('acknowledgement that does not cover the sealed source message fails closed', async (t) => {
  const { db, pairing, store } = await setup(false);
  t.after(() => db.close());
  await uploadAcknowledgement(db, pairing, store, { acknowledgedMessageIds: [ACKNOWLEDGEMENT_ID] });
  await assert.rejects(
    new MoveAcknowledgementReconciler(db, store, { finalize: async () => undefined }).reconcile({
      transferId: TRANSFER_ID,
      total: 1,
      pairing,
      allowFinalization: true,
    }),
    (error: unknown) => error instanceof InteropTransportError && error.code === 'corrupt',
  );
  const progress = await new SecureMoveOutboxRepository(db).progress(TRANSFER_ID);
  assert.equal(progress?.journal.phase, 'awaiting-acknowledgement');
  assert.equal(progress?.journal.counts.acknowledged, 0);
});

test('verified original acknowledgement must cover the blob message', async (t) => {
  const { db, pairing, store } = await setup(true, true);
  t.after(() => db.close());
  await uploadAcknowledgement(db, pairing, store);
  await assert.rejects(
    new MoveAcknowledgementReconciler(db, store, { finalize: async () => undefined }).reconcile({
      transferId: TRANSFER_ID,
      total: 1,
      pairing,
      allowFinalization: true,
    }),
    (error: unknown) => error instanceof InteropTransportError && error.code === 'corrupt',
  );
  const item = await new SecureMoveOutboxRepository(db).item(TRANSFER_ID, INTEROP_ID);
  assert.deepEqual(item?.sourceMessageIds, [SOURCE_MESSAGE_ID, BLOB_MESSAGE_ID]);
  assert.equal(item?.acknowledgedAt, null);
});
