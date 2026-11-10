import test from 'node:test';
import assert from 'node:assert/strict';

import { createDisplayRecord } from '../extension/src/core/display-records.js';
import {
  bookmarkEntriesOriginalReferenceCount,
  bookmarkPayloadToDisplayRecord,
  createBookmarksRestorePreview,
  createHistoryRestorePreview,
  createRestoreDuplicateSummary,
  createUrlReviewStatusRestorePreview,
  emptyRestoreDuplicateSummary,
  fullBackupRestoreDetail,
  historyPayloadToDisplayRecord,
  restoreImportCompleteMessage,
  type BookmarkImportResult,
  type HistoryImportResult,
  type UrlReviewStatusImportResult,
} from '../extension/src/ui/panel/restore-import-preview.js';

const MATCH_SHA256 = 'a'.repeat(64);

const STORED_ORIGINAL = {
  blobId: 'blob-1',
  mimeType: 'image/jpeg',
  byteLength: 2048,
  capturedAt: '2026-06-20T00:00:00.000Z',
} as const;

function historyEntry(
  uuid: string,
  url: string,
  overrides: Partial<HistoryImportResult['entries'][number]['payload']> = {},
): HistoryImportResult['entries'][number] {
  return {
    uuid,
    payload: {
      url,
      capturedAt: '2026-06-21T00:00:00.000Z',
      captureStatus: 'remote-only',
      ...overrides,
    },
  };
}

function historyResult(overrides: Partial<HistoryImportResult> = {}): HistoryImportResult {
  return {
    status: { ok: true, code: 'ok', message: 'ok' },
    entries: [historyEntry('uuid-1', 'https://example.test/one.jpg')],
    skipped: [],
    validationReport: { rejectedCount: 0, reasons: [] },
    plaintext: false,
    ...overrides,
  };
}

function bookmarkEntry(
  uuid: string,
  url: string,
  overrides: Partial<BookmarkImportResult['entries'][number]['payload']> = {},
): BookmarkImportResult['entries'][number] {
  return {
    uuid,
    payload: {
      url,
      bookmarkedAt: '2026-06-21T00:00:00.000Z',
      ...overrides,
    },
  };
}

function bookmarkResult(overrides: Partial<BookmarkImportResult> = {}): BookmarkImportResult {
  return {
    status: { ok: true, code: 'ok', message: 'ok' },
    entries: [bookmarkEntry('uuid-1', 'https://example.test/one.jpg')],
    skipped: [],
    validationReport: { rejectedCount: 0, reasons: [] },
    plaintext: false,
    externalOriginalCount: 0,
    fullBackup: false,
    originalBlobs: [],
    backedOriginalBlobIds: [],
    blobKeyBackups: [],
    missingOriginalBlobIds: [],
    albums: [],
    ...overrides,
  };
}

function existingRecord(id: string, url: string, sha256?: string) {
  return createDisplayRecord({
    id,
    url,
    timestamp: '2026-06-21T00:00:00.000Z',
    source: 'history',
    ...(sha256 ? { storedOriginal: { ...STORED_ORIGINAL, sha256 } as never } : {}),
  });
}

test('createRestoreDuplicateSummary splits unique entries from URL duplicates', () => {
  const entries = [historyEntry('uuid-1', 'https://example.test/dup.jpg'), historyEntry('uuid-2', 'https://example.test/new.jpg')];
  const summary = createRestoreDuplicateSummary(entries, [existingRecord('existing-1', 'https://example.test/dup.jpg')]);

  assert.deepEqual(
    summary.uniqueEntries.map((entry) => entry.uuid),
    ['uuid-2'],
  );
  assert.equal(summary.duplicateCount, 1);
  assert.equal(summary.matchesByUuid.get('uuid-1'), 'url');
  assert.equal(summary.duplicateRecordIdsByUuid.get('uuid-1'), 'existing-1');
});

test('createRestoreDuplicateSummary matches sha256 fingerprints nested in storedOriginal', () => {
  const entries = [
    historyEntry('uuid-1', 'https://example.test/renamed.jpg', {
      storedOriginal: { ...STORED_ORIGINAL, sha256: MATCH_SHA256 } as never,
    }),
  ];
  const summary = createRestoreDuplicateSummary(entries, [existingRecord('existing-1', 'https://example.test/other.jpg', MATCH_SHA256)]);

  assert.equal(summary.duplicateCount, 1);
  assert.equal(summary.matchesByUuid.get('uuid-1'), 'sha256');
});

test('emptyRestoreDuplicateSummary reports nothing skipped', () => {
  const summary = emptyRestoreDuplicateSummary();
  assert.deepEqual(summary.uniqueEntries, []);
  assert.equal(summary.duplicateCount, 0);
  assert.equal(summary.matchesByUuid.size, 0);
});

test('createHistoryRestorePreview counts originals and surfaces duplicate sample detail', () => {
  const result = historyResult({
    entries: [
      historyEntry('uuid-1', 'https://example.test/one.jpg', { captureStatus: 'downloaded', storedOriginal: STORED_ORIGINAL }),
      historyEntry('uuid-2', 'https://example.test/two.jpg'),
    ],
    plaintext: true,
  });
  const summary = createRestoreDuplicateSummary(result.entries, [existingRecord('existing-1', 'https://example.test/two.jpg')]);

  const preview = createHistoryRestorePreview(result, 'history.json', summary);

  assert.equal(preview.payloadLabel, 'History');
  assert.equal(preview.fileName, 'history.json');
  assert.equal(preview.recordCount, 2);
  assert.equal(preview.capturedOriginalCount, 1);
  assert.equal(preview.duplicateCount, 1);
  assert.equal(preview.unsupportedCount, 1);
  assert.equal(preview.plaintext, true);
  assert.match(preview.message ?? '', /1 duplicate record will be skipped on confirm\./u);
  assert.match(preview.message ?? '', /Plaintext history will be reloaded/u);
  assert.equal(preview.samples?.length, 2);
  assert.match(preview.samples?.[0]?.detail ?? '', /original metadata reference/u);
  assert.match(preview.samples?.[1]?.detail ?? '', /Duplicate URL, skipped on confirm/u);
  assert.equal(preview.unsupportedSections?.[0]?.label, 'Captured original bytes');
});

test('createHistoryRestorePreview defaults to an empty duplicate summary', () => {
  const preview = createHistoryRestorePreview(historyResult());
  assert.equal(preview.fileName, 'Selected JSON file');
  assert.equal(preview.duplicateCount, 0);
  assert.equal(preview.unsupportedSections, undefined);
});

test('createBookmarksRestorePreview reports missing original backups for full backups', () => {
  const result = bookmarkResult({
    entries: [
      bookmarkEntry('uuid-1', 'https://example.test/one.jpg', { storedOriginal: STORED_ORIGINAL }),
      bookmarkEntry('uuid-2', 'https://example.test/two.jpg', { storedOriginal: { ...STORED_ORIGINAL, blobId: 'blob-2' } }),
    ],
    fullBackup: true,
    originalBlobs: [{ id: 'blob-1' } as never],
    backedOriginalBlobIds: ['blob-1'],
    externalOriginalCount: 2,
  });

  const preview = createBookmarksRestorePreview(result, 'bookmarks.json');

  assert.equal(preview.payloadLabel, 'Bookmarks');
  assert.equal(preview.unsupportedCount, 1);
  assert.equal(preview.unsupportedSections?.[0]?.label, 'Missing original backups');
  assert.match(preview.unsupportedSections?.[0]?.detail ?? '', /1 original reference did not have matching encrypted bytes/u);
});

test('createBookmarksRestorePreview treats external original references as unsupported outside full backups', () => {
  const preview = createBookmarksRestorePreview(bookmarkResult({ externalOriginalCount: 2 }));

  assert.equal(preview.capturedOriginalCount, 2);
  assert.equal(preview.unsupportedSections?.[0]?.label, 'External original references');
});

test('createUrlReviewStatusRestorePreview lists record samples with field counts', () => {
  const result: UrlReviewStatusImportResult = {
    status: { ok: true, code: 'ok', message: 'ok' },
    records: [
      {
        schemaVersion: 1,
        hostname: 'example.test',
        pageUrl: 'https://example.test/page',
        sourceUrl: 'https://example.test/one.jpg',
        status: 'passed',
        fieldIds: ['field-1', 'field-2'],
        activeFieldId: 'field-1',
        updatedAt: '2026-06-21T00:00:00.000Z',
      },
    ],
    skipped: ['bad-record'],
    validationReport: { rejectedCount: 1, reasons: [{ reason: 'invalid', count: 1 }] },
  };

  const preview = createUrlReviewStatusRestorePreview(result, 'status.json');

  assert.equal(preview.payloadLabel, 'URL review status');
  assert.equal(preview.recordCount, 1);
  assert.equal(preview.skippedCount, 1);
  assert.equal(preview.plaintext, true);
  assert.equal(preview.samples?.[0]?.label, 'passed · example.test');
  assert.match(preview.samples?.[0]?.detail ?? '', /2 fields, updated 2026-06-21/u);
});

test('restoreImportCompleteMessage assembles the imported, skipped, duplicate, and plaintext parts', () => {
  assert.equal(restoreImportCompleteMessage('bookmark', 1, 0, 0, false, ''), 'Imported 1 bookmark.');
  assert.equal(
    restoreImportCompleteMessage('bookmark', 2, 3, 1, true, 'encrypted into bookmark storage'),
    'Imported 2 bookmarks. Skipped 1 invalid bookmark. Skipped 3 duplicate bookmarks. Plaintext import was encrypted into bookmark storage.',
  );
});

test('fullBackupRestoreDetail pluralizes restored original counts', () => {
  assert.equal(fullBackupRestoreDetail(1), 'encrypted into bookmark storage with 1 encrypted original restored');
  assert.equal(fullBackupRestoreDetail(2), 'encrypted into bookmark storage with 2 encrypted originals restored');
});

test('bookmarkEntriesOriginalReferenceCount counts stored originals and protected-pin references', () => {
  const entries = [
    bookmarkEntry('uuid-1', 'https://example.test/one.jpg', { storedOriginal: STORED_ORIGINAL }),
    bookmarkEntry('uuid-2', 'https://example.test/two.jpg'),
    bookmarkEntry('uuid-3', 'https://example.test/three.jpg', {
      protectedPin: { schemaVersion: 1, plainPinId: 'pin-1', storedOriginalBlobId: 'blob-3' } as never,
    }),
  ];

  assert.equal(bookmarkEntriesOriginalReferenceCount(entries), 2);
});

test('historyPayloadToDisplayRecord restores capture state from the payload', () => {
  const record = historyPayloadToDisplayRecord('uuid-1', {
    url: 'https://example.test/one.jpg',
    title: 'One',
    capturedAt: '2026-06-21T00:00:00.000Z',
    captureStatus: 'downloaded',
    storedOriginal: STORED_ORIGINAL,
  });

  assert.equal(record.id, 'uuid-1');
  assert.equal(record.timestamp, '2026-06-21T00:00:00.000Z');
  assert.equal(record.captureStatus, 'captured');
  assert.equal(record.blobId, 'blob-1');
  assert.equal(record.source, 'history');
});

test('bookmarkPayloadToDisplayRecord falls back to the stored original capture time and bookmark source', () => {
  const record = bookmarkPayloadToDisplayRecord('uuid-1', {
    url: 'https://example.test/one.jpg',
    width: 800,
    height: 600,
    bookmarkedAt: '2026-06-21T00:00:00.000Z',
    storedOriginal: STORED_ORIGINAL,
  });

  assert.equal(record.capturedAt, STORED_ORIGINAL.capturedAt);
  assert.equal(record.captureStatus, 'captured');
  assert.equal(record.source, 'bookmark');

  const favorite = bookmarkPayloadToDisplayRecord('uuid-2', {
    url: 'https://example.test/two.jpg',
    bookmarkedAt: '2026-06-21T00:00:00.000Z',
    sourceCompatibility: 'favorites',
  });
  assert.equal(favorite.source, 'favorites');
  assert.equal(favorite.captureStatus, undefined);
});

test('imported payloads keep inline thumbnails and drop any other thumbnail URL', () => {
  const inline = 'data:image/png;base64,AAAA';
  const base = { url: 'https://example.test/a.jpg', capturedAt: '2026-06-20T00:00:00.000Z', captureStatus: 'remote-only' as const };
  assert.equal(historyPayloadToDisplayRecord('h1', { ...base, thumbnail: inline }).thumbnail, inline);
  assert.equal(historyPayloadToDisplayRecord('h2', { ...base, thumbnail: 'https://tracker.test/pixel.gif' }).thumbnail, undefined);
  const bookmark = { url: base.url, bookmarkedAt: base.capturedAt };
  assert.equal(bookmarkPayloadToDisplayRecord('b1', { ...bookmark, thumbnail: inline }).thumbnail, inline);
  assert.equal(bookmarkPayloadToDisplayRecord('b2', { ...bookmark, thumbnail: 'data:text/html,<p>x</p>' }).thumbnail, undefined);
});
