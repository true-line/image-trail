import { encryptedBlobIdForRecord, type ImageDisplayRecord } from '../../core/display-records.js';
import type { DurableBookmarkPayloadV1, DurableHistoryPayloadV1 } from '../../content/panel-services.js';

export function withoutRecentPinState(record: ImageDisplayRecord): ImageDisplayRecord {
  const copy = { ...record };
  delete copy.pinnedAt;
  delete copy.pinnedRecordId;
  return copy;
}

export function historyRecordToExportEntry(record: ImageDisplayRecord): {
  readonly uuid: string;
  readonly payload: DurableHistoryPayloadV1;
} {
  return {
    uuid: record.id,
    payload: {
      url: record.url,
      title: record.title,
      label: record.label,
      thumbnail: record.thumbnail,
      capturedAt: record.timestamp,
      captureStatus: record.storedOriginal ? 'downloaded' : 'remote-only',
      storedOriginal: record.storedOriginal,
    },
  };
}

export function bookmarkRecordToExportEntry(record: ImageDisplayRecord): {
  readonly uuid: string;
  readonly payload: DurableBookmarkPayloadV1;
} {
  return {
    uuid: record.id,
    payload: {
      url: record.url,
      title: record.title,
      label: record.label,
      thumbnail: record.thumbnail,
      width: record.width,
      height: record.height,
      bookmarkedAt: record.timestamp,
      downloadedAt: record.downloadedAt,
      capturedAt: record.capturedAt,
      sourceCompatibility: record.source === 'favorites' ? 'favorites' : undefined,
      storedOriginal: record.storedOriginal,
      // Carried so restore knows the pin was private and refuses to save it as plaintext.
      protectedPin: record.protectedPin
        ? { schemaVersion: 1, queueUpdatedAt: record.queueUpdatedAt ?? record.timestamp, ...record.protectedPin }
        : undefined,
    },
  };
}

export function selectedRecords(records: readonly ImageDisplayRecord[], selectedIds: readonly string[]): readonly ImageDisplayRecord[] {
  if (selectedIds.length === 0) return records;
  const selected = new Set(selectedIds);
  return records.filter((record) => selected.has(record.id));
}

export function originalBlobIdsForFullBackup(records: readonly ImageDisplayRecord[]): readonly string[] {
  const blobIds = new Set<string>();
  for (const record of records) {
    const capturedBlobId = encryptedBlobIdForRecord(record);
    if (capturedBlobId) blobIds.add(capturedBlobId);
    if (record.storedOriginal?.blobId) blobIds.add(record.storedOriginal.blobId);
    if (record.protectedPin?.storedOriginalBlobId) blobIds.add(record.protectedPin.storedOriginalBlobId);
  }
  return [...blobIds];
}

export function isLockedPrivatePin(record: ImageDisplayRecord): boolean {
  return record.privacyStatus === 'locked' || record.url.startsWith('image-trail-private:');
}

export function isEncryptedImageExportRecord(record: ImageDisplayRecord): boolean {
  return record.storedOriginal?.mimeType === undefined || record.storedOriginal.mimeType.startsWith('image/');
}

export function pcloudBackupFileName(isoTimestamp: string): string {
  const timestamp = isoTimestamp.replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z');
  return `image-trail-pcloud-backup-${timestamp}.image-trail-encrypted.json`;
}

export function pcloudBackupUploadMessage(
  uploadMessage: string,
  originalCount: number,
  originalBytes: number,
  missingOriginalCount: number,
): string {
  const originalSummary = `${originalCount} encrypted original${originalCount === 1 ? '' : 's'} (${formatCloudBackupBytes(originalBytes)})`;
  if (missingOriginalCount === 0) return `${uploadMessage} Included ${originalSummary}.`;
  return `${uploadMessage} Included ${originalSummary}; ${missingOriginalCount} referenced original${missingOriginalCount === 1 ? '' : 's'} missing.`;
}

export function formatCloudBackupBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function bookmarkSaveMessage(record: ImageDisplayRecord, label = record.url): string {
  if (record.pinSaveStorage?.destination !== 'plaintext') return `Added to Image Trail: ${label}`;
  switch (record.pinSaveStorage.reason) {
    case 'setting':
      return `Saved plaintext pin by current storage setting: ${label}`;
    case 'failed':
      return `Saved plaintext pin because encrypted storage failed: ${label}`;
    case 'unavailable':
      return `Saved plaintext pin because encrypted storage is not set up: ${label}`;
    case 'locked':
    default:
      return `Saved plaintext pin because encrypted storage is locked: ${label}`;
  }
}

export const PRIVATE_PIN_EXPORT_LOCKED_MESSAGE =
  'Unlock encrypted storage before exporting private pins so their image metadata and originals are available.';

export function recordHasBlobId(record: Pick<ImageDisplayRecord, 'blobId' | 'storedOriginal' | 'protectedPin'>, blobId: string): boolean {
  return record.blobId === blobId || record.storedOriginal?.blobId === blobId || record.protectedPin?.storedOriginalBlobId === blobId;
}

export function urlReviewStatusClearScopeLabel(scope: 'hostname' | 'page' | 'source' | 'all'): string {
  if (scope === 'all') return 'all sites';
  if (scope === 'page') return 'this page';
  if (scope === 'source') return 'the selected URL';
  return 'this site';
}
