import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createBookmarkMessageRegistry } from '../extension/src/background/handlers/bookmark-message-handlers.js';
import { MessageType, createSaveBookmarkMessage } from '../extension/src/background/messages.js';
import { createDisplayRecord } from '../extension/src/core/display-records.js';
import { IndexedDbBookmarkStore } from '../extension/src/data/bookmarks-controller.js';
import { deleteImageTrailDb } from './indexeddb-test-helpers.js';

const record = createDisplayRecord({
  id: 'https://example.test/unavailable.jpg',
  url: 'https://example.test/unavailable.jpg',
  timestamp: '2026-07-01T00:00:00.000Z',
  source: 'bookmark',
});

/** Makes `indexedDB.open` fail the way a blocked or errored open does, until the returned restore runs. */
function breakIndexedDb(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  assert.ok(original);
  const broken = {
    open: () => {
      const request: { error: Error; onerror?: () => void } = { error: new Error('open failed') };
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { ...original, value: broken });
  return () => Object.defineProperty(globalThis, 'indexedDB', original);
}

test('save fails instead of returning the unsaved record when the database cannot be opened', async () => {
  await deleteImageTrailDb();
  const restore = breakIndexedDb();
  const store = new IndexedDbBookmarkStore();
  try {
    await assert.rejects(() => store.save(record), /unavailable/);
    assert.deepEqual(await store.saveResult(record), { ok: false, message: 'Bookmark storage is unavailable.' });
  } finally {
    restore();
    await store.close();
  }
});

test('a failed database open is retried on a later call instead of cached', async () => {
  await deleteImageTrailDb();
  const restore = breakIndexedDb();
  const store = new IndexedDbBookmarkStore();
  try {
    await assert.rejects(() => store.save(record), /unavailable/);
    restore();

    const saved = await store.save(record);
    assert.equal(saved.url, record.url);
    assert.equal((await store.loadPage({ offset: 0, limit: 10 })).total, 1);
  } finally {
    restore();
    await store.close();
  }
});

test('the save handler replies with a failure and publishes no library change when the store cannot save', async () => {
  const notifications: unknown[] = [];
  const registry = createBookmarkMessageRegistry({
    bookmarkStore: {
      loadPage: async () => ({ items: [], offset: 0, limit: 1, total: 0, hasOlder: false, hasNewer: false }),
      loadByIds: async () => [],
      findByUrl: async () => null,
      save: async () => {
        throw new Error('Bookmark storage is unavailable.');
      },
      remove: async () => undefined,
      removeMany: async () => ({ removedCount: 0 }),
      removeRecallPage: async () => ({ removedCount: 0 }),
    },
    notifyLibraryChange: (change) => notifications.push(change),
  });
  const entry = registry[MessageType.SaveBookmark];
  const message = createSaveBookmarkMessage(record);

  await assert.rejects(async () => entry.handle(message), /unavailable/);
  assert.deepEqual(entry.fallback(message).payload, { ok: false, message: 'Bookmark save failed.' });
  assert.deepEqual(notifications, []);
});
