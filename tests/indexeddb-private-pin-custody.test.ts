import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openImageTrailDb } from '../extension/src/data/db.js';
import { BookmarksRepository } from '../extension/src/data/repositories/bookmarks-repository.js';
import { createAndActivateWrappedBlobKey, lockBlobKey, type ActiveBlobKey } from '../extension/src/data/crypto/blob-keyring.js';
import { IndexedDbBookmarkStore } from '../extension/src/data/bookmarks-controller.js';
import { createDisplayRecord } from '../extension/src/core/display-records.js';
import { bookmarkRecordToExportEntry } from '../extension/src/ui/panel/record-export-helpers.js';
import { lockedPrivatePinsMessage, restoreBookmarkEntries } from '../extension/src/ui/panel/restore-import-preview.js';
import { deleteImageTrailDb } from './indexeddb-test-helpers.js';

const URL_A = 'https://secret.example.test/private-a.jpg';

function pin(url: string) {
  return createDisplayRecord({ id: url, url, label: 'private.jpg', timestamp: '2026-06-21T00:00:01.000Z', source: 'bookmark' });
}

async function storedRowCount(): Promise<number> {
  const opened = await openImageTrailDb();
  assert.ok(opened.db);
  try {
    return (await new BookmarksRepository(opened.db).listEncrypted()).length;
  } finally {
    opened.db.close();
  }
}

async function activeKey(uuid: string): Promise<ActiveBlobKey> {
  return (await createAndActivateWrappedBlobKey({ password: `${uuid}-password`, uuid, now: '2026-06-21T00:00:00.000Z' })).active;
}

test('pinning an existing private pin again while locked writes no plaintext copy', async () => {
  await deleteImageTrailDb();
  let key: ActiveBlobKey | null = await activeKey('custody-relock');
  const store = new IndexedDbBookmarkStore({ getActiveBlobKey: () => key, getPinSaveStoragePreference: () => 'encrypted' });
  try {
    const saved = await store.save(pin(URL_A));
    assert.ok(saved.protectedPin?.encryptedPinId);
    const rowsBefore = await storedRowCount();

    key = null;
    const resaved = await store.save(pin(URL_A));

    assert.equal(resaved.id, saved.id);
    assert.equal(resaved.privacyStatus, 'locked');
    assert.deepEqual(resaved.pinSaveStorage, { destination: 'encrypted' });
    assert.equal(await storedRowCount(), rowsBefore, 'no second row is created for the same image');
  } finally {
    await store.close();
    lockBlobKey();
  }
});

test('a save that must be encrypted fails while locked and stores nothing', async () => {
  await deleteImageTrailDb();
  const store = new IndexedDbBookmarkStore({ getActiveBlobKey: () => null, getPinSaveStoragePreference: () => 'encrypted' });
  try {
    const result = await store.saveResult(pin(URL_A), { requireEncrypted: true });
    assert.equal(result.ok, false);
    assert.equal(await storedRowCount(), 0);
  } finally {
    await store.close();
  }
});

test('a save that must be encrypted ignores the plaintext preference when unlocked', async () => {
  await deleteImageTrailDb();
  const key = await activeKey('custody-required');
  const store = new IndexedDbBookmarkStore({ getActiveBlobKey: () => key, getPinSaveStoragePreference: () => 'plaintext' });
  try {
    const result = await store.saveResult(pin(URL_A), { requireEncrypted: true });
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.record.protectedPin?.encryptedPinId);
    assert.deepEqual(result.ok && result.record.pinSaveStorage, { destination: 'encrypted' });
  } finally {
    await store.close();
    lockBlobKey();
  }
});

test('export marks private pins and restore refuses to save them without encryption', async () => {
  const privateRecord = {
    ...pin(URL_A),
    protectedPin: { plainPinId: 'plain-1', hasEncryptedMetadata: true, hasEncryptedThumbnail: false, hasStoredOriginal: false },
  };
  const privateEntry = bookmarkRecordToExportEntry(privateRecord);
  const plainEntry = bookmarkRecordToExportEntry(pin('https://example.test/plain.jpg'));
  assert.equal(privateEntry.payload.protectedPin?.plainPinId, 'plain-1');
  assert.equal(plainEntry.payload.protectedPin, undefined);

  const calls: { url: string; requireEncrypted: boolean }[] = [];
  const lockedStore = {
    save: async (record: ReturnType<typeof pin>) => {
      calls.push({ url: record.url, requireEncrypted: false });
      return { ...record, id: 'saved-plain' };
    },
    saveResult: async (record: ReturnType<typeof pin>, options?: { requireEncrypted?: boolean | undefined }) => {
      calls.push({ url: record.url, requireEncrypted: options?.requireEncrypted === true });
      return { ok: false as const, message: 'locked' };
    },
  };
  const ids = new Map<string, string>();
  const outcome = await restoreBookmarkEntries(lockedStore, [privateEntry, plainEntry], ids);

  assert.deepEqual(outcome, { importedCount: 1, lockedPrivateCount: 1 });
  assert.deepEqual(calls, [
    { url: URL_A, requireEncrypted: true },
    { url: 'https://example.test/plain.jpg', requireEncrypted: false },
  ]);
  assert.deepEqual([...ids.values()], ['saved-plain']);
  assert.equal(lockedPrivatePinsMessage(0), '');
  assert.match(lockedPrivatePinsMessage(1), /1 private pin was not restored/u);
  assert.match(lockedPrivatePinsMessage(2), /2 private pins were not restored/u);
});
