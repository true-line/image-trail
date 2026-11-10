import { createDisplayRecord, inlineImageThumbnail, type ImageDisplayRecord } from '../../core/display-records.js';
import { PRIVATE_PIN_NEEDS_UNLOCK_MESSAGE } from '../../core/bookmark-save-options.js';
import type { BookmarkStore } from '../../core/bookmark-store.js';
import type { ImportRestorePreviewState } from '../../core/types.js';
import {
  classifyRestoreDuplicates,
  type RestoreDuplicateCandidate,
  type RestoreDuplicateMatch,
  type RestoreDuplicateRecord,
} from '../../core/import/restore-duplicates.js';
import { filenameFromUrl } from '../../core/image/downloads.js';
import type {
  importBookmarks,
  importEncryptedHistory,
  importUrlReviewStatus,
  DurableBookmarkPayloadV1,
  DurableHistoryPayloadV1,
} from '../../content/panel-services.js';

export type HistoryImportResult = Awaited<ReturnType<typeof importEncryptedHistory>>;
export type BookmarkImportResult = Awaited<ReturnType<typeof importBookmarks>>;
export type UrlReviewStatusImportResult = ReturnType<typeof importUrlReviewStatus>;
export type RestoreImageImportEntry = HistoryImportResult['entries'][number] | BookmarkImportResult['entries'][number];

export interface RestoreDuplicateSummary<TEntry extends RestoreImageImportEntry> {
  readonly uniqueEntries: readonly TEntry[];
  readonly duplicateCount: number;
  readonly matchesByUuid: ReadonlyMap<string, RestoreDuplicateMatch>;
  readonly duplicateRecordIdsByUuid: ReadonlyMap<string, string>;
}

export function createRestoreDuplicateSummary<TEntry extends RestoreImageImportEntry>(
  entries: readonly TEntry[],
  existingRecords: readonly ImageDisplayRecord[],
): RestoreDuplicateSummary<TEntry> {
  const candidates = entries.map((entry): RestoreDuplicateCandidate & { readonly entry: TEntry } => ({
    id: entry.uuid,
    url: entry.payload.url,
    sha256: restoreSha256FromUnknown(entry.payload),
    entry,
  }));
  const existing = existingRecords.map((record): RestoreDuplicateRecord => ({
    id: record.id,
    url: record.url,
    sha256: restoreSha256FromUnknown(record),
  }));
  const classifications = classifyRestoreDuplicates(candidates, existing);
  const privateExistingIds = new Set(existingRecords.filter((record) => record.protectedPin).map((record) => record.id));
  const matchesByUuid = new Map<string, RestoreDuplicateMatch>();
  const duplicateRecordIdsByUuid = new Map<string, string>();
  const uniqueEntries: TEntry[] = [];

  for (const classification of classifications) {
    // A pin that was private in the backup is not a duplicate of an unencrypted local copy:
    // it goes through the encrypted save, which converts that copy instead of leaving it.
    const upgradesPlaintextCopy =
      !!classification.duplicate &&
      'protectedPin' in classification.candidate.entry.payload &&
      !!classification.candidate.entry.payload.protectedPin &&
      !privateExistingIds.has(classification.duplicate.existingId);
    if (classification.duplicate && !upgradesPlaintextCopy) {
      matchesByUuid.set(classification.candidate.entry.uuid, classification.duplicate.matchedBy);
      duplicateRecordIdsByUuid.set(classification.candidate.entry.uuid, classification.duplicate.existingId);
    } else {
      uniqueEntries.push(classification.candidate.entry);
    }
  }

  return {
    uniqueEntries,
    duplicateCount: matchesByUuid.size,
    matchesByUuid,
    duplicateRecordIdsByUuid,
  };
}

export function emptyRestoreDuplicateSummary<TEntry extends RestoreImageImportEntry>(): RestoreDuplicateSummary<TEntry> {
  return {
    uniqueEntries: [],
    duplicateCount: 0,
    matchesByUuid: new Map<string, RestoreDuplicateMatch>(),
    duplicateRecordIdsByUuid: new Map<string, string>(),
  };
}

function restorePreviewMessage(duplicateCount: number, skippedCount: number, extra?: string): string {
  const duplicateMessage =
    duplicateCount > 0 ? `${duplicateCount} duplicate record${duplicateCount === 1 ? '' : 's'} will be skipped on confirm.` : undefined;
  const skippedMessage =
    skippedCount > 0
      ? `${skippedCount} rejected record${skippedCount === 1 ? '' : 's'} summarized by reason; sensitive URLs are not shown.`
      : undefined;
  return ['Preview loaded. Import has not changed local records yet.', duplicateMessage, skippedMessage, extra].filter(Boolean).join(' ');
}

function restorePreviewSampleDetail(detail: string | undefined, duplicateMatch: RestoreDuplicateMatch | undefined): string | undefined {
  if (!duplicateMatch) return detail;
  const duplicateDetail = duplicateMatch === 'sha256' ? 'Duplicate SHA-256, skipped on confirm' : 'Duplicate URL, skipped on confirm';
  return [detail, duplicateDetail].filter((part): part is string => !!part).join('; ');
}

export function restoreImportCompleteMessage(
  noun: string,
  importedCount: number,
  duplicateCount: number,
  skippedCount: number,
  plaintext: boolean,
  plaintextDetail: string,
): string {
  const imported = `Imported ${importedCount} ${noun}${importedCount === 1 ? '' : 's'}.`;
  const skipped = skippedCount > 0 ? `Skipped ${skippedCount} invalid ${noun}${skippedCount === 1 ? '' : 's'}.` : undefined;
  const duplicates = duplicateCount > 0 ? `Skipped ${duplicateCount} duplicate ${noun}${duplicateCount === 1 ? '' : 's'}.` : undefined;
  const plaintextMessage = plaintext ? `Plaintext import was ${plaintextDetail}.` : undefined;
  return [imported, skipped, duplicates, plaintextMessage].filter(Boolean).join(' ');
}

export function fullBackupRestoreDetail(importedOriginalCount: number): string {
  return `encrypted into bookmark storage with ${importedOriginalCount} encrypted original${importedOriginalCount === 1 ? '' : 's'} restored`;
}

function restoreSha256FromUnknown(value: unknown): string | undefined {
  const object = recordObject(value);
  if (!object) return undefined;
  const direct = stringField(object, 'sha256') ?? stringField(object, 'fingerprint');
  if (direct) return direct;
  return restoreSha256FromUnknown(object['storedOriginal']);
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

export function createHistoryRestorePreview(
  result: HistoryImportResult,
  fileName = 'Selected JSON file',
  duplicateSummary: RestoreDuplicateSummary<HistoryImportResult['entries'][number]> = emptyRestoreDuplicateSummary(),
): ImportRestorePreviewState {
  const originalReferenceCount = result.entries.filter((entry) => entry.payload.storedOriginal).length;
  return {
    fileName,
    payloadLabel: 'History',
    recordCount: result.entries.length,
    capturedOriginalCount: originalReferenceCount,
    duplicateCount: duplicateSummary.duplicateCount,
    skippedCount: result.skipped.length,
    unsupportedCount: originalReferenceCount > 0 ? 1 : 0,
    plaintext: result.plaintext,
    message: restorePreviewMessage(
      duplicateSummary.duplicateCount,
      result.validationReport.rejectedCount,
      result.plaintext ? 'Plaintext history will be reloaded into extension state after confirmation.' : undefined,
    ),
    samples: result.entries.slice(0, 3).map((entry) =>
      imagePayloadPreviewSample(entry.payload.url, {
        label: entry.payload.label,
        title: entry.payload.title,
        detail: restorePreviewSampleDetail(
          entry.payload.storedOriginal ? `${entry.payload.captureStatus}, original metadata reference` : entry.payload.captureStatus,
          duplicateSummary.matchesByUuid.get(entry.uuid),
        ),
      }),
    ),
    validationIssues: result.validationReport.reasons,
    unsupportedSections:
      originalReferenceCount > 0
        ? [
            {
              label: 'Captured original bytes',
              detail: 'Record imports restore metadata; original bytes must already exist or be restored by an encrypted-original flow.',
            },
          ]
        : undefined,
  };
}

export function createBookmarksRestorePreview(
  result: BookmarkImportResult,
  fileName = 'Selected JSON file',
  duplicateSummary: RestoreDuplicateSummary<BookmarkImportResult['entries'][number]> = emptyRestoreDuplicateSummary(),
): ImportRestorePreviewState {
  const missingOriginalBackupCount = fullBackupMissingOriginalReferenceCount(result);
  const unsupportedOriginalCount = result.fullBackup ? missingOriginalBackupCount : result.externalOriginalCount;
  return {
    fileName,
    payloadLabel: 'Bookmarks',
    recordCount: result.entries.length,
    capturedOriginalCount: result.externalOriginalCount,
    duplicateCount: duplicateSummary.duplicateCount,
    skippedCount: result.skipped.length,
    unsupportedCount: unsupportedOriginalCount > 0 ? 1 : 0,
    plaintext: result.plaintext,
    message: restorePreviewMessage(
      duplicateSummary.duplicateCount,
      result.validationReport.rejectedCount,
      result.plaintext ? 'Plaintext bookmarks will be encrypted into bookmark storage after confirmation.' : undefined,
    ),
    samples: result.entries.slice(0, 3).map((entry) =>
      imagePayloadPreviewSample(entry.payload.url, {
        label: entry.payload.label,
        title: entry.payload.title,
        detail: restorePreviewSampleDetail(bookmarkPayloadPreviewDetail(entry.payload), duplicateSummary.matchesByUuid.get(entry.uuid)),
      }),
    ),
    validationIssues: result.validationReport.reasons,
    unsupportedSections:
      unsupportedOriginalCount > 0
        ? [
            {
              label: result.fullBackup ? 'Missing original backups' : 'External original references',
              detail: result.fullBackup
                ? `${missingOriginalBackupCount} original reference${missingOriginalBackupCount === 1 ? '' : 's'} did not have matching encrypted bytes in the backup.`
                : 'Bookmark imports strip external blob references; original bytes are not imported from record JSON.',
            },
          ]
        : undefined,
  };
}

function fullBackupMissingOriginalReferenceCount(result: BookmarkImportResult): number {
  if (!result.fullBackup) return result.externalOriginalCount;
  const backedBlobIds = new Set(result.backedOriginalBlobIds);
  const missingBlobIds = new Set(result.missingOriginalBlobIds.filter((blobId) => !backedBlobIds.has(blobId)));
  for (const entry of result.entries) {
    const blobId = entry.payload.storedOriginal?.blobId ?? entry.payload.protectedPin?.storedOriginalBlobId;
    if (blobId && !backedBlobIds.has(blobId)) missingBlobIds.add(blobId);
  }
  return missingBlobIds.size;
}

export function bookmarkEntriesOriginalReferenceCount(entries: readonly BookmarkImportResult['entries'][number][]): number {
  return entries.filter((entry) => entry.payload.storedOriginal || entry.payload.protectedPin?.storedOriginalBlobId).length;
}

export function createUrlReviewStatusRestorePreview(
  result: UrlReviewStatusImportResult,
  fileName = 'Selected JSON file',
): ImportRestorePreviewState {
  return {
    fileName,
    payloadLabel: 'URL review status',
    recordCount: result.records.length,
    skippedCount: result.skipped.length,
    unsupportedCount: 0,
    plaintext: true,
    message: restorePreviewMessage(0, result.validationReport.rejectedCount),
    samples: result.records.slice(0, 3).map((record) => ({
      label: `${record.status} · ${record.hostname}`,
      url: record.sourceUrl,
      detail: `${record.fieldIds.length} field${record.fieldIds.length === 1 ? '' : 's'}, updated ${record.updatedAt}`,
    })),
    validationIssues: result.validationReport.reasons,
  };
}

function imagePayloadPreviewSample(
  url: string,
  options: { readonly label?: string | undefined; readonly title?: string | undefined; readonly detail?: string | undefined } = {},
): NonNullable<ImportRestorePreviewState['samples']>[number] {
  return {
    label: options.label ?? options.title ?? filenameFromUrl(url),
    url,
    detail: options.detail,
  };
}

function bookmarkPayloadPreviewDetail(payload: DurableBookmarkPayloadV1): string | undefined {
  const dimensions = payload.width && payload.height ? `${payload.width} x ${payload.height}` : undefined;
  const source = payload.sourceCompatibility === 'favorites' ? 'Legacy favorite' : undefined;
  return [dimensions, source].filter((part): part is string => !!part).join(', ') || undefined;
}

export function historyPayloadToDisplayRecord(uuid: string, payload: DurableHistoryPayloadV1): ImageDisplayRecord {
  return createDisplayRecord({
    id: uuid,
    url: payload.url,
    title: payload.title,
    label: payload.label,
    thumbnail: inlineImageThumbnail(payload.thumbnail),
    timestamp: payload.capturedAt,
    captureStatus: payload.storedOriginal ? 'captured' : undefined,
    blobId: payload.storedOriginal?.blobId,
    storedOriginal: payload.storedOriginal,
    source: 'history',
  });
}

export function bookmarkPayloadToDisplayRecord(uuid: string, payload: DurableBookmarkPayloadV1): ImageDisplayRecord {
  return createDisplayRecord({
    id: uuid,
    url: payload.url,
    title: payload.title,
    label: payload.label,
    thumbnail: inlineImageThumbnail(payload.thumbnail),
    width: payload.width,
    height: payload.height,
    timestamp: payload.bookmarkedAt,
    downloadedAt: payload.downloadedAt,
    capturedAt: payload.capturedAt ?? payload.storedOriginal?.capturedAt,
    captureStatus: payload.storedOriginal ? 'captured' : undefined,
    blobId: payload.storedOriginal?.blobId,
    storedOriginal: payload.storedOriginal,
    source: payload.sourceCompatibility ?? 'bookmark',
  });
}

type PrivateRestoreOutcome = ImageDisplayRecord | 'locked' | 'failed';

/**
 * Saves one restored bookmark. A pin that was private in the backup is saved encrypted or not
 * at all, and the reason is kept so the caller can report a locked key and a storage failure
 * differently instead of leaving a plaintext copy behind.
 */
async function restoreBookmarkEntry(
  store: Pick<BookmarkStore, 'save' | 'saveResult'>,
  entry: { readonly uuid: string; readonly payload: DurableBookmarkPayloadV1 },
): Promise<PrivateRestoreOutcome> {
  const record = bookmarkPayloadToDisplayRecord(entry.uuid, entry.payload);
  if (!entry.payload.protectedPin) return store.save(record);
  if (!store.saveResult) return 'failed';
  const result = await store.saveResult(record, { requireEncrypted: true });
  if (result.ok) return result.record;
  return result.message === PRIVATE_PIN_NEEDS_UNLOCK_MESSAGE ? 'locked' : 'failed';
}

export interface PrivateRestoreCounts {
  readonly lockedPrivateCount: number;
  readonly failedPrivateCount: number;
}

export function privatePinsNotRestoredMessage(counts: PrivateRestoreCounts): string {
  const pins = (count: number): string => `${count} private pin${count === 1 ? ' was' : 's were'} not restored`;
  const locked =
    counts.lockedPrivateCount > 0
      ? ` ${pins(counts.lockedPrivateCount)} because encryption is locked. Unlock and restore the file again.`
      : '';
  const failed =
    counts.failedPrivateCount > 0
      ? ` ${pins(counts.failedPrivateCount)} because encrypted storage failed. Nothing was saved unencrypted; restore the file again.`
      : '';
  return locked + failed;
}

/** Restores every entry, recording new ids in `recordIdMap` and counting private pins left out. */
export async function restoreBookmarkEntries(
  store: Pick<BookmarkStore, 'save' | 'saveResult'>,
  entries: readonly { readonly uuid: string; readonly payload: DurableBookmarkPayloadV1 }[],
  recordIdMap: Map<string, string>,
): Promise<PrivateRestoreCounts & { readonly importedCount: number }> {
  let importedCount = 0;
  let lockedPrivateCount = 0;
  let failedPrivateCount = 0;
  for (const entry of entries) {
    const saved = await restoreBookmarkEntry(store, entry);
    if (saved === 'locked') lockedPrivateCount += 1;
    else if (saved === 'failed') failedPrivateCount += 1;
    else {
      recordIdMap.set(entry.uuid, saved.id);
      importedCount += 1;
    }
  }
  return { importedCount, lockedPrivateCount, failedPrivateCount };
}
