import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureStore } from '../extension/src/content/capture-controller.js';
import {
  batchOriginalRecords,
  restoreFullBackupOriginalFiles,
  type OriginalRestoreBatchLimits,
} from '../extension/src/ui/panel/full-backup-original-restore.js';
import { fullBackupRestoreDetail, type BookmarkImportResult } from '../extension/src/ui/panel/restore-import-preview.js';

type Original = BookmarkImportResult['originalBlobs'][number];

function original(id: string, ciphertextChars: number): Original {
  return {
    id,
    kind: 'original',
    schemaVersion: 1,
    algorithm: 'AES-GCM',
    iv: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'A'.repeat(ciphertextChars),
    encryptedByteLength: ciphertextChars,
    createdAt: '2026-07-18T00:00:00.000Z',
    key: { kind: 'blob', uuid: 'key-1', reference: 'blob:key-1' },
    referenceCount: 1,
  };
}

const limits: OriginalRestoreBatchLimits = { maxRecords: 3, maxCiphertextChars: 100 };

function backup(originalBlobs: readonly Original[]): BookmarkImportResult {
  return { externalOriginalCount: originalBlobs.length, blobKeyBackups: [], originalBlobs } as unknown as BookmarkImportResult;
}

function harness(respond: (batch: readonly Original[], index: number) => unknown) {
  const batches: string[][] = [];
  let refreshed = 0;
  const captureStore = {
    importBlobKeyBackup: async () => ({ ok: true as const, keyReference: 'blob:key-1', imported: false, message: 'Exists.' }),
    importOriginalBlobRecords: async (batch: readonly Original[]) => {
      batches.push(batch.map((record) => record.id));
      return respond(batch, batches.length - 1);
    },
  } as unknown as CaptureStore;
  const deps = {
    captureStore: () => captureStore,
    refreshBlobKeyStatus: async () => {
      refreshed += 1;
    },
    refreshStorageUsage: async () => {},
  };
  return {
    deps,
    batches,
    get refreshed() {
      return refreshed;
    },
  };
}

test('originals are batched by record count and by ciphertext size, with an oversized original alone', () => {
  const records = [
    original('a', 10),
    original('b', 10),
    original('c', 10),
    original('d', 10),
    original('e', 90),
    original('f', 150),
    original('g', 5),
  ];
  assert.deepEqual(
    batchOriginalRecords(records, limits).map((batch) => batch.map((record) => record.id)),
    [['a', 'b', 'c'], ['d', 'e'], ['f'], ['g']],
  );
  assert.deepEqual(batchOriginalRecords([], limits), []);
});

test('restore sends bounded batches and totals imported and skipped originals', async () => {
  const run = harness((batch) => ({ ok: true, importedCount: batch.length - 1, skippedCount: 1 }));
  const records = ['a', 'b', 'c', 'd', 'e'].map((id) => original(id, 10));

  const outcome = await restoreFullBackupOriginalFiles(run.deps, backup(records), 'pw', limits);

  assert.deepEqual(run.batches, [
    ['a', 'b', 'c'],
    ['d', 'e'],
  ]);
  assert.deepEqual(outcome, { ok: true, importedOriginalCount: 3, skippedOriginalCount: 2 });
  assert.equal(run.refreshed, 1);
});

test('a failing middle batch stops the restore and reports what was already restored', async () => {
  const run = harness((batch, index) =>
    index === 1
      ? { ok: false, reason: 'invalid-original', message: 'Encrypted original backup payload was invalid.' }
      : { ok: true, importedCount: batch.length, skippedCount: 0 },
  );
  const records = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => original(id, 10));

  const outcome = await restoreFullBackupOriginalFiles(run.deps, backup(records), 'pw', limits);

  assert.deepEqual(
    run.batches,
    [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ],
    'no batch is sent after the failure',
  );
  assert.deepEqual(outcome, {
    ok: false,
    message:
      'Encrypted original backup payload was invalid. 3 encrypted originals were restored before the failure. No bookmarks were imported.',
  });
  assert.equal(run.refreshed, 0);
});

test('a batch whose runtime message rejects is reported as a failure, not thrown', async () => {
  const run = harness(() => {
    throw new Error('Message length exceeded maximum allowed length.');
  });

  const outcome = await restoreFullBackupOriginalFiles(run.deps, backup([original('a', 10)]), 'pw', limits);

  assert.deepEqual(outcome, { ok: false, message: 'Encrypted originals import failed. No bookmarks were imported.' });
});

test('the restore summary says when existing originals were kept', () => {
  assert.equal(fullBackupRestoreDetail(2, 0), 'encrypted into bookmark storage with 2 encrypted originals restored');
  assert.equal(
    fullBackupRestoreDetail(1, 1),
    'encrypted into bookmark storage with 1 encrypted original restored; 1 original was already stored and kept unchanged',
  );
  assert.equal(
    fullBackupRestoreDetail(0, 3),
    'encrypted into bookmark storage with 0 encrypted originals restored; 3 originals were already stored and kept unchanged',
  );
});
