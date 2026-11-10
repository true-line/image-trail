import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IndexedDbBookmarkStore } from '../extension/src/data/bookmarks-controller.js';
import { createDisplayRecord } from '../extension/src/core/display-records.js';
import { openImageTrailDb } from '../extension/src/data/db.js';
import { BookmarksRepository } from '../extension/src/data/repositories/bookmarks-repository.js';
import { DataStore } from '../extension/src/data/schema.js';
import {
  ORPHANED_BLOB_GRACE_PERIOD_MS,
  cleanupReferencedBlobIds,
  findDeletableOrphanBlobIds,
} from '../extension/src/background/orphaned-blobs.js';
import { deleteImageTrailDb } from './indexeddb-test-helpers.js';

const now = Date.parse('2026-07-18T16:00:00.000Z');
const oldCreatedAt = new Date(now - ORPHANED_BLOB_GRACE_PERIOD_MS - 1).toISOString();

async function saveBookmarkWithOriginal(store: IndexedDbBookmarkStore, name: string, blobId: string): Promise<void> {
  await store.save(
    createDisplayRecord({
      id: `https://example.test/${name}.jpg`,
      url: `https://example.test/${name}.jpg`,
      timestamp: '2026-07-18T00:00:00.000Z',
      source: 'bookmark',
      storedOriginal: { blobId, mimeType: 'image/jpeg', byteLength: 4, capturedAt: '2026-07-18T00:00:00.000Z' },
    }),
  );
}

async function withRawDb(write: (db: IDBDatabase) => Promise<void>): Promise<void> {
  const opened = await openImageTrailDb();
  assert.ok(opened.db);
  try {
    await write(opened.db);
  } finally {
    opened.db.close();
  }
}

test('an undecryptable bookmark row blocks orphan cleanup instead of exposing its original', async () => {
  await deleteImageTrailDb();
  const store = new IndexedDbBookmarkStore();
  try {
    await saveBookmarkWithOriginal(store, 'readable', 'blob-readable');
    await saveBookmarkWithOriginal(store, 'sealed', 'blob-behind-unreadable-row');
    await withRawDb(async (db) => {
      const repository = new BookmarksRepository(db);
      const sealed = (await repository.listEncrypted()).find((record) => record.url.endsWith('sealed.jpg'));
      assert.ok(sealed);
      const ciphertext = sealed.envelope.ciphertext;
      const tampered = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;
      await repository.putEncrypted({ ...sealed, envelope: { ...sealed.envelope, ciphertext: tampered } });
    });

    const references = await store.loadOriginalBlobReferences();
    assert.deepEqual([...references.ids], ['blob-readable']);
    assert.equal(references.unreadableCount, 1);

    const referenced = cleanupReferencedBlobIds(references, []);
    assert.equal(referenced, null);
    const candidates = [
      { id: 'blob-behind-unreadable-row', createdAt: oldCreatedAt },
      { id: 'true-orphan', createdAt: oldCreatedAt },
    ];
    assert.deepEqual(findDeletableOrphanBlobIds(candidates, referenced, now), [], 'nothing is deletable while a row is unreadable');
  } finally {
    await store.close();
  }
});

test('a bookmark row quarantined by schema validation also counts as unreadable', async () => {
  await deleteImageTrailDb();
  const store = new IndexedDbBookmarkStore();
  try {
    await saveBookmarkWithOriginal(store, 'readable', 'blob-readable');
    await withRawDb(async (db) => {
      const transaction = db.transaction(DataStore.Bookmarks, 'readwrite');
      transaction
        .objectStore(DataStore.Bookmarks)
        .put({ uuid: 'corrupt-row', url: 'https://example.test/corrupt.jpg', queueUpdatedAt: 'x' });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    });

    assert.equal((await store.loadOriginalBlobReferences()).unreadableCount, 1);
  } finally {
    await store.close();
  }
});

test('with every row readable, cleanup references merge bookmarks and Recent history', () => {
  const referenced = cleanupReferencedBlobIds({ ids: new Set(['blob-pinned']), unreadableCount: 0 }, [[{ blobId: 'blob-recent' }, {}]]);
  assert.deepEqual([...(referenced ?? [])], ['blob-pinned', 'blob-recent']);
  const candidates = ['blob-pinned', 'blob-recent', 'true-orphan'].map((id) => ({ id, createdAt: oldCreatedAt }));
  assert.deepEqual(findDeletableOrphanBlobIds(candidates, referenced, now), ['true-orphan']);
});
