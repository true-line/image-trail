import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { createDisplayRecord, type ImageDisplayRecord } from '../extension/src/core/display-records.js';
import { IndexedDbBookmarkStore } from '../extension/src/data/bookmarks-controller.js';
import { createAndActivateWrappedBlobKey, lockBlobKey, type ActiveBlobKey } from '../extension/src/data/crypto/blob-keyring.js';
import { createKeyReference } from '../extension/src/data/crypto/key-reference.js';
import { openImageTrailDb } from '../extension/src/data/db.js';
import { BlobsRepository } from '../extension/src/data/repositories/blobs-repository.js';
import { BookmarksRepository } from '../extension/src/data/repositories/bookmarks-repository.js';
import { EncryptedPinsRepository } from '../extension/src/data/repositories/encrypted-pins-repository.js';
import { deleteImageTrailDb } from './indexeddb-test-helpers.js';

const ORIGINAL = {
  blobId: 'blob-serialized-original',
  mimeType: 'image/jpeg',
  byteLength: 4,
  capturedAt: '2026-07-18T00:00:00.000Z',
} as const;

type SealAndPutOwner = { sealAndPut(...args: never[]): Promise<unknown> };

/** Holds the next `sealAndPut` call on `prototype` after its caller has read the row, until `release()`. */
function holdNextSealAndPut(prototype: SealAndPutOwner) {
  const original = prototype.sealAndPut;
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  prototype.sealAndPut = async function (this: unknown, ...args: never[]) {
    if (armed) {
      armed = false;
      markEntered();
      await released;
    }
    return original.apply(this, args);
  };
  return { entered, release, restore: () => (prototype.sealAndPut = original) };
}

/** Gives an unserialised competing writer time to commit before the held save resumes. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function pin(url: string, timestamp: string, extra: Partial<ImageDisplayRecord> = {}): ImageDisplayRecord {
  return createDisplayRecord({ id: url, url, label: url.split('/').at(-1), timestamp, source: 'bookmark', ...extra });
}

async function recallDuringHeldSave(store: IndexedDbBookmarkStore, prototype: SealAndPutOwner, firstUrl: string): Promise<void> {
  const first = (await store.loadPage({ offset: 0, limit: 30 })).items.find((item) => item.url === firstUrl);
  assert.ok(first);
  const hold = holdNextSealAndPut(prototype);
  try {
    const saving = store.save(pin(firstUrl, '2026-07-18T00:00:01.000Z', { label: 'refreshed.jpg' }));
    await hold.entered;
    const moving = store.moveToFront([first.id]);
    await settle();
    hold.release();
    await Promise.all([saving, moving]);
  } finally {
    hold.restore();
  }
}

test('Recall during an in-flight plain save keeps the recalled record at the queue front (#946)', async () => {
  await deleteImageTrailDb();
  const store = new IndexedDbBookmarkStore();
  const first = 'https://example.test/serialized-first.jpg';
  try {
    await store.save(pin(first, '2026-07-18T00:00:01.000Z'));
    await store.save(pin('https://example.test/serialized-second.jpg', '2026-07-18T00:00:02.000Z'));

    await recallDuringHeldSave(store, BookmarksRepository.prototype, first);

    const page = await store.loadPage({ offset: 0, limit: 30 });
    assert.equal(page.items[0]?.url, first);
    assert.equal(page.items[0]?.label, 'refreshed.jpg');
  } finally {
    await store.close();
  }
});

test('Recall during an in-flight protected save keeps the recalled record at the queue front (#946)', async () => {
  await deleteImageTrailDb();
  let active: ActiveBlobKey | null = null;
  const store = new IndexedDbBookmarkStore({ getActiveBlobKey: () => active });
  const first = 'https://example.test/serialized-protected-first.jpg';
  try {
    active = (
      await createAndActivateWrappedBlobKey({
        password: 'serialized-protected-password',
        uuid: 'serialized-protected-key',
        now: '2026-07-18T00:00:00.000Z',
      })
    ).active;
    await store.save(pin(first, '2026-07-18T00:00:01.000Z'));
    await store.save(pin('https://example.test/serialized-protected-second.jpg', '2026-07-18T00:00:02.000Z'));

    await recallDuringHeldSave(store, EncryptedPinsRepository.prototype, first);

    const page = await store.loadPage({ offset: 0, limit: 30 });
    assert.equal(page.items[0]?.url, first);
    assert.equal(page.items[0]?.label, 'refreshed.jpg');
    const opened = await openImageTrailDb();
    assert.ok(opened.db);
    try {
      const [relationshipRow] = await new BookmarksRepository(opened.db).listEncryptedPage({ offset: 0, limit: 1 });
      assert.equal(relationshipRow?.uuid, page.items[0]?.id);
    } finally {
      opened.db.close();
    }
  } finally {
    await store.close();
    active = null;
    lockBlobKey();
  }
});

test('overlapping Recall moves of a protected pin keep its two rows at the same queue position (#946)', async () => {
  await deleteImageTrailDb();
  let active: ActiveBlobKey | null = null;
  const store = new IndexedDbBookmarkStore({ getActiveBlobKey: () => active });
  const url = 'https://example.test/serialized-protected-recall.jpg';
  const applied: Array<{ readonly row: 'relationship' | 'pin'; readonly queueUpdatedAt: string }> = [];
  const moveRelationships = BookmarksRepository.prototype.updateQueueUpdatedAt;
  const movePins = EncryptedPinsRepository.prototype.updateQueueUpdatedAt;
  const openRecord = BookmarksRepository.prototype.openRecord;
  let slowNextOpen = false;
  // The first move pauses between its relationship update and its pin update, where an unserialised second move would overtake it.
  BookmarksRepository.prototype.openRecord = async function (this: BookmarksRepository, ...args: Parameters<typeof openRecord>) {
    if (slowNextOpen) {
      slowNextOpen = false;
      await settle();
    }
    return openRecord.apply(this, args);
  } as typeof openRecord;
  BookmarksRepository.prototype.updateQueueUpdatedAt = async function (updates) {
    const updated = await moveRelationships.call(this, updates);
    for (const update of updates) applied.push({ row: 'relationship', queueUpdatedAt: update.queueUpdatedAt });
    return updated;
  };
  EncryptedPinsRepository.prototype.updateQueueUpdatedAt = async function (updates) {
    await movePins.call(this, updates);
    for (const update of updates) applied.push({ row: 'pin', queueUpdatedAt: update.queueUpdatedAt });
  };
  try {
    active = (
      await createAndActivateWrappedBlobKey({
        password: 'serialized-recall-password',
        uuid: 'serialized-recall-key',
        now: '2026-07-18T00:00:00.000Z',
      })
    ).active;
    const saved = await store.save(pin(url, '2026-07-18T00:00:01.000Z'));

    slowNextOpen = true;
    const firstMove = store.moveToFront([saved.id]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.all([firstMove, store.moveToFront([saved.id])]);

    assert.equal(applied.length, 4);
    const last = (row: 'relationship' | 'pin') => applied.filter((entry) => entry.row === row).at(-1)?.queueUpdatedAt;
    assert.equal(last('pin'), last('relationship'));
  } finally {
    BookmarksRepository.prototype.updateQueueUpdatedAt = moveRelationships;
    BookmarksRepository.prototype.openRecord = openRecord;
    EncryptedPinsRepository.prototype.updateQueueUpdatedAt = movePins;
    await store.close();
    active = null;
    lockBlobKey();
  }
});

test('overlapping saves for one record keep the captured original attached by either (#946)', async () => {
  await deleteImageTrailDb();
  const opened = await openImageTrailDb();
  assert.ok(opened.db);
  try {
    await new BlobsRepository(opened.db).put({
      id: ORIGINAL.blobId,
      kind: 'original',
      schemaVersion: 1,
      algorithm: 'AES-GCM',
      iv: 'iv',
      ciphertext: new ArrayBuffer(4),
      encryptedByteLength: 4,
      createdAt: ORIGINAL.capturedAt,
      key: createKeyReference('blob', 'serialized-original-key'),
      referenceCount: 1,
    });
  } finally {
    opened.db.close();
  }
  const store = new IndexedDbBookmarkStore();
  const url = 'https://example.test/serialized-original.jpg';
  try {
    await store.save(pin(url, '2026-07-18T00:00:01.000Z'));

    const hold = holdNextSealAndPut(BookmarksRepository.prototype);
    try {
      const refreshing = store.save(pin(url, '2026-07-18T00:00:01.000Z', { label: 'refreshed.jpg' }));
      await hold.entered;
      const attaching = store.save(pin(url, '2026-07-18T00:00:01.000Z', { storedOriginal: ORIGINAL }));
      await settle();
      hold.release();
      await Promise.all([refreshing, attaching]);
    } finally {
      hold.restore();
    }

    const saved = (await store.loadPage({ offset: 0, limit: 1 })).items[0];
    assert.deepEqual(saved?.storedOriginal, ORIGINAL);
    assert.equal((await store.loadOriginalBlobIds()).has(ORIGINAL.blobId), true);
  } finally {
    await store.close();
  }
});

test('a failed save does not block later bookmark writes (#946)', async () => {
  await deleteImageTrailDb();
  const store = new IndexedDbBookmarkStore();
  const url = 'https://example.test/serialized-after-failure.jpg';
  try {
    const saved = await store.save(pin(url, '2026-07-18T00:00:01.000Z'));
    await assert.rejects(store.save(pin('https://example.test/needs-unlock.jpg', '2026-07-18T00:00:02.000Z'), { requireEncrypted: true }));

    const moved = await store.moveToFront([saved.id]);
    assert.deepEqual(
      moved.map((record) => record.url),
      [url],
    );
    assert.equal((await store.removeMany([saved.id])).removedCount, 1);
  } finally {
    await store.close();
  }
});
