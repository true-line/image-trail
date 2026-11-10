// Executable checks for the highest-stakes product invariants (issue #275). These encode, as
// tests, the rules that otherwise live only as prose in AGENTS.md / .github/copilot-instructions.md:
//   1. Recents are transient — session storage is allowed, but durable storage is not.
//   2. Queue ordering is `queueUpdatedAt`, never the encrypted envelope's `updatedAt`.
//   3. Recall pages the queue producer, never the encrypted blob store.
// A fourth check proves the companion ESLint rule (envelope.updatedAt sort ban) actually fires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { ESLint } from 'eslint';
import { openImageTrailDb } from '../extension/src/data/db.js';
import { IMAGE_TRAIL_DB_NAME } from '../extension/src/data/schema.js';
import { BookmarksRepository, type EncryptedBookmarkRecord } from '../extension/src/data/repositories/bookmarks-repository.js';
import { BlobsRepository } from '../extension/src/data/repositories/blobs-repository.js';
import { IndexedDbBookmarkStore, recordQueueTime } from '../extension/src/data/bookmarks-controller.js';
import { createDisplayRecord } from '../extension/src/core/display-records.js';

async function deleteImageTrailDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(IMAGE_TRAIL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Timed out deleting test IndexedDB database.'));
  });
}

async function openFreshImageTrailDb(): Promise<IDBDatabase> {
  await deleteImageTrailDb();
  const result = await openImageTrailDb();
  assert.equal(result.status.ok, true, result.status.message);
  assert.ok(result.db);
  return result.db;
}

/**
 * A schema-valid encrypted bookmark row with the `queueUpdatedAt` sort column and the envelope's
 * own `updatedAt` set independently, so a test can make the two disagree. The ciphertext is a
 * placeholder — these rows are only ever paged/hydrated, never decrypted, in this file.
 */
function encryptedBookmarkRecord(input: {
  readonly uuid: string;
  readonly url: string;
  readonly queueUpdatedAt: string;
  readonly envelopeUpdatedAt: string;
}): EncryptedBookmarkRecord {
  return {
    uuid: input.uuid,
    url: input.url,
    queueUpdatedAt: input.queueUpdatedAt,
    envelope: {
      schemaVersion: 1,
      payloadVersion: 1,
      algorithm: 'AES-GCM',
      iv: 'test-iv',
      ciphertext: 'test-ciphertext',
      key: { kind: 'bookmark', uuid: 'key-001', reference: 'bookmark:key-001' },
      createdAt: '2026-06-17T00:00:00.000Z',
      updatedAt: input.envelopeUpdatedAt,
      authenticatedMetadata: { recordType: 'bookmark' },
    },
  };
}

// ---------------------------------------------------------------------------
// Invariant 1 — recents are transient: no durable-storage write path
// ---------------------------------------------------------------------------

test('invariant: the recents layer exposes no durable browser-storage write path', () => {
  // The recents store (content proxy), the runtime-history reducer, and the background cache that
  // actually owns and mutates the retained rows must never reach durable storage — recents are
  // transient browser-session state (AGENTS.md "Product Model"). Scanning only the proxy/reducer would miss
  // a regression at the real write owner, extension/src/background/recent-history-cache.ts.
  const recentsModules = [
    'extension/src/content/recent-history-store.ts',
    'extension/src/data/runtime/runtime-history.ts',
    'extension/src/background/recent-history-cache.ts',
  ];
  const durableChromeStoragePattern = /chrome\.storage(?:\?\.|\.)(?:local|sync|managed)/;
  const forbidden: readonly (readonly [RegExp, string])[] = [
    [/\bindexedDB\b/, 'indexedDB'],
    [durableChromeStoragePattern, 'durable chrome.storage'],
    [/openImageTrailDb/, 'openImageTrailDb'],
    [/from ['"][^'"]*\/repositories\//, 'a data repository import'],
    [/from ['"][^'"]*\/data\/db(\.js)?['"]/, 'the IndexedDB module'],
  ];

  for (const durableAccess of ['chrome.storage.local', 'chrome.storage?.local']) {
    assert.match(durableAccess, durableChromeStoragePattern);
  }

  for (const relativePath of recentsModules) {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
    for (const [pattern, label] of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${relativePath} must not reference ${label} — recents are transient and must not be persisted.`,
      );
    }
  }

  const compositionRoot = readFileSync(resolve(process.cwd(), 'extension/src/background/service-worker.ts'), 'utf8');
  assert.match(
    compositionRoot,
    /new\s+RecentHistoryCache\s*\(\s*sessionStorageForContext\(\)\s*\)/,
    'the production recents cache must take its storage from sessionStorageForContext()',
  );
  const sessionContext = readFileSync(resolve(process.cwd(), 'extension/src/background/session-storage-context.ts'), 'utf8');
  assert.match(
    sessionContext,
    /return chrome\.storage\?\.session;/,
    'the regular instance must use browser-session storage so MV3 worker suspension does not clear recents',
  );
  assert.equal(
    durableChromeStoragePattern.test(sessionContext),
    false,
    'the session storage selector must never reach durable chrome.storage',
  );
});

// ---------------------------------------------------------------------------
// Invariant 2 — queue ordering is queueUpdatedAt, not envelope.updatedAt
// ---------------------------------------------------------------------------

test('invariant: recordQueueTime is the queue sort key (queueUpdatedAt), not envelope.updatedAt', () => {
  const withQueue = createDisplayRecord({
    url: 'https://example.test/a.jpg',
    timestamp: '2026-01-01T00:00:00.000Z',
    queueUpdatedAt: '2026-02-02T00:00:00.000Z',
    source: 'bookmark',
  });
  assert.equal(recordQueueTime(withQueue), '2026-02-02T00:00:00.000Z');

  // Falls back to the capture timestamp only when queueUpdatedAt is absent.
  const withoutQueue = createDisplayRecord({
    url: 'https://example.test/b.jpg',
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'bookmark',
  });
  assert.equal(recordQueueTime(withoutQueue), '2026-01-01T00:00:00.000Z');

  // The comparator orders by queueUpdatedAt newest-first, independent of the capture timestamp:
  // `older` has the newer capture time but the older queue time, so it must sort last.
  const older = createDisplayRecord({
    url: 'https://example.test/older.jpg',
    timestamp: '2030-01-01T00:00:00.000Z',
    queueUpdatedAt: '2026-01-01T00:00:00.000Z',
    source: 'bookmark',
  });
  const newer = createDisplayRecord({
    url: 'https://example.test/newer.jpg',
    timestamp: '2020-01-01T00:00:00.000Z',
    queueUpdatedAt: '2026-12-31T00:00:00.000Z',
    source: 'bookmark',
  });
  const ordered = [older, newer].sort((left, right) => recordQueueTime(right).localeCompare(recordQueueTime(left)));
  assert.deepEqual(
    ordered.map((record) => record.url),
    ['https://example.test/newer.jpg', 'https://example.test/older.jpg'],
  );
});

test('invariant: BookmarksRepository pages newest-first by queueUpdatedAt even when envelope.updatedAt disagrees', async (t) => {
  const db = await openFreshImageTrailDb();
  t.after(() => db.close());
  const repository = new BookmarksRepository(db);

  // queueUpdatedAt order (a < b < c) is deliberately the REVERSE of envelope.updatedAt order
  // (a > b > c), so paging by the wrong key would visibly flip the result.
  await repository.putEncrypted(
    encryptedBookmarkRecord({
      uuid: 'a',
      url: 'https://example.test/a.jpg',
      queueUpdatedAt: '2026-01-01T00:00:00.000Z',
      envelopeUpdatedAt: '2026-12-31T00:00:00.000Z',
    }),
  );
  await repository.putEncrypted(
    encryptedBookmarkRecord({
      uuid: 'b',
      url: 'https://example.test/b.jpg',
      queueUpdatedAt: '2026-06-01T00:00:00.000Z',
      envelopeUpdatedAt: '2026-06-01T00:00:00.000Z',
    }),
  );
  await repository.putEncrypted(
    encryptedBookmarkRecord({
      uuid: 'c',
      url: 'https://example.test/c.jpg',
      queueUpdatedAt: '2026-12-31T00:00:00.000Z',
      envelopeUpdatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );

  const newestFirst = (await repository.listEncryptedNewestFirst()).map((record) => record.uuid);
  assert.deepEqual(newestFirst, ['c', 'b', 'a'], 'queue paging must follow queueUpdatedAt newest-first');
  // If it had ordered by envelope.updatedAt, the result would be the reverse (['a', 'b', 'c']).
  assert.notDeepEqual(newestFirst, ['a', 'b', 'c'], 'queue paging must not follow envelope.updatedAt');

  const page = (await repository.listEncryptedPage({ offset: 0, limit: 2 })).map((record) => record.uuid);
  assert.deepEqual(page, ['c', 'b'], 'paged queue reads must also follow queueUpdatedAt newest-first');
});

// ---------------------------------------------------------------------------
// Invariant 3 — Recall pages the queue producer, never the blob store
// ---------------------------------------------------------------------------

test('invariant: Recall paging reads the queue producer, never the blob store', async (t) => {
  await deleteImageTrailDb();

  // Instrument the blob store's read methods so we can prove Recall never touches them.
  const blobReads = { get: 0, list: 0 };
  const originalGet = BlobsRepository.prototype.get;
  const originalList = BlobsRepository.prototype.list;
  BlobsRepository.prototype.get = function (this: BlobsRepository, id: string) {
    blobReads.get += 1;
    return originalGet.call(this, id);
  };
  BlobsRepository.prototype.list = function (this: BlobsRepository) {
    blobReads.list += 1;
    return originalList.call(this);
  };
  t.after(() => {
    BlobsRepository.prototype.get = originalGet;
    BlobsRepository.prototype.list = originalList;
  });

  const store = new IndexedDbBookmarkStore();
  try {
    await store.save(
      createDisplayRecord({
        url: 'https://example.test/recall.jpg',
        timestamp: '2026-06-19T00:00:00.000Z',
        source: 'bookmark',
      }),
    );

    // Only the Recall read path is under test; ignore any blob access from the save path above.
    blobReads.get = 0;
    blobReads.list = 0;

    const page = await store.loadRecallPage({ offset: 0, limit: 10 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.url, 'https://example.test/recall.jpg');
    assert.equal(blobReads.get, 0, 'Recall must not read individual blobs from the blob store');
    assert.equal(blobReads.list, 0, 'Recall must not list the blob store');
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// Invariant 4 — the companion ESLint rule actually blocks the sort footgun
// ---------------------------------------------------------------------------

test('invariant: the ESLint rule blocks sorting a queue by envelope.updatedAt', async () => {
  const eslint = new ESLint();
  // A filePath under extension/src so the fixture matches the config's source globs. The file need
  // not exist on disk — lintText only uses the path for config resolution. The fixtures live as
  // strings so the real `eslint .` run over this test file never sees a genuine violating sort.
  const filePath = resolve(process.cwd(), 'extension/src/data/__invariant_fixture__.ts');

  const violating = `export function bad(records: ReadonlyArray<{ readonly envelope: { readonly updatedAt: string } }>) {
  return [...records].sort((a, b) => a.envelope.updatedAt.localeCompare(b.envelope.updatedAt));
}
`;
  const [violatingResult] = await eslint.lintText(violating, { filePath });
  assert.ok(violatingResult, 'lintText must return a result for the violating fixture');
  const flagged = violatingResult.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
  assert.ok(
    flagged.some((message) => message.message.includes('queueUpdatedAt')),
    'sorting a queue by envelope.updatedAt must be flagged by no-restricted-syntax',
  );

  const clean = `export function good(records: ReadonlyArray<{ readonly queueUpdatedAt: string }>) {
  return [...records].sort((a, b) => a.queueUpdatedAt.localeCompare(b.queueUpdatedAt));
}
`;
  const [cleanResult] = await eslint.lintText(clean, { filePath });
  assert.ok(cleanResult, 'lintText must return a result for the clean fixture');
  assert.equal(
    cleanResult.messages.filter((message) => message.ruleId === 'no-restricted-syntax').length,
    0,
    'sorting a queue by queueUpdatedAt must not be flagged',
  );
});

test('invariant: interoperability custody never reaches host-page, provider, log, or extension storage APIs', () => {
  const interopCustodyModules = [
    'extension/src/data/interop/pairing-bundle.ts',
    'extension/src/data/interop/pairing-import.ts',
    'extension/src/data/interop/record-translation.ts',
    'extension/src/data/repositories/interop-keys-repository.ts',
  ];
  const forbidden: readonly (readonly [RegExp, string])[] = [
    [/\blocalStorage\b/u, 'host-page localStorage'],
    [/\bsessionStorage\b/u, 'host-page sessionStorage'],
    [/chrome\.storage/u, 'extension storage containing serializable plaintext'],
    [/\bconsole\.(?:debug|info|log|warn|error)\b/u, 'logging'],
    [/pcloud|google\s*drive|icloud|storageprovider/iu, 'provider access'],
  ];

  for (const relativePath of interopCustodyModules) {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
    for (const [pattern, label] of forbidden) {
      assert.equal(pattern.test(source), false, `${relativePath} must not use ${label}.`);
    }
  }
});
