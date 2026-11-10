import type { CaptureStore } from '../../content/capture-controller.js';
import type { BookmarkImportResult } from './restore-import-preview.js';

type PortableOriginal = BookmarkImportResult['originalBlobs'][number];

export type OriginalRestoreOutcome =
  | { readonly ok: true; readonly importedOriginalCount: number; readonly skippedOriginalCount: number }
  | { readonly ok: false; readonly message: string };

export interface OriginalRestoreBatchLimits {
  readonly maxRecords: number;
  /** Base64 ciphertext characters per runtime message, well under Chrome's 64 MiB message cap. */
  readonly maxCiphertextChars: number;
}

export const ORIGINAL_RESTORE_BATCH_LIMITS: OriginalRestoreBatchLimits = { maxRecords: 16, maxCiphertextChars: 8 * 1024 * 1024 };

/** Splits originals into runtime-message batches bounded by count and size; an oversized original travels alone. */
export function batchOriginalRecords(
  records: readonly PortableOriginal[],
  limits: OriginalRestoreBatchLimits = ORIGINAL_RESTORE_BATCH_LIMITS,
): PortableOriginal[][] {
  const batches: PortableOriginal[][] = [];
  let current: PortableOriginal[] = [];
  let currentChars = 0;
  for (const record of records) {
    const chars = record.ciphertext.length;
    if (current.length > 0 && (current.length >= limits.maxRecords || currentChars + chars > limits.maxCiphertextChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(record);
    currentChars += chars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function importOriginalBatches(
  captureStore: CaptureStore,
  records: readonly PortableOriginal[],
  limits: OriginalRestoreBatchLimits,
): Promise<OriginalRestoreOutcome> {
  let importedOriginalCount = 0;
  let skippedOriginalCount = 0;
  for (const batch of batchOriginalRecords(records, limits)) {
    const result = await captureStore
      .importOriginalBlobRecords(batch)
      .catch(() => ({ ok: false as const, message: 'Encrypted originals import failed.' }));
    if (!result.ok) {
      const partial =
        importedOriginalCount > 0
          ? ` ${importedOriginalCount} encrypted original${importedOriginalCount === 1 ? ' was' : 's were'} restored before the failure.`
          : '';
      return { ok: false, message: `${result.message}${partial} No bookmarks were imported.` };
    }
    importedOriginalCount += result.importedCount;
    skippedOriginalCount += result.skippedCount;
  }
  return { ok: true, importedOriginalCount, skippedOriginalCount };
}

/** Restores a local full backup's key backups and encrypted originals ahead of its bookmark records. */
export async function restoreFullBackupOriginalFiles(
  deps: {
    captureStore(): CaptureStore | null;
    refreshBlobKeyStatus(): Promise<void>;
    refreshStorageUsage(): Promise<void>;
  },
  result: BookmarkImportResult,
  password: string,
  limits: OriginalRestoreBatchLimits = ORIGINAL_RESTORE_BATCH_LIMITS,
): Promise<OriginalRestoreOutcome> {
  if (result.externalOriginalCount === 0) return { ok: true, importedOriginalCount: 0, skippedOriginalCount: 0 };
  const captureStore = deps.captureStore();
  if (!captureStore) {
    return { ok: false, message: 'Encrypted original storage is unavailable; no bookmarks were imported.' };
  }
  for (const backup of result.blobKeyBackups) {
    const imported = await captureStore.importBlobKeyBackup(backup.fileContent, password);
    if (!imported.ok) return { ok: false, message: imported.message };
  }
  const blobImport = await importOriginalBatches(captureStore, result.originalBlobs, limits);
  if (!blobImport.ok) return blobImport;
  await deps.refreshBlobKeyStatus();
  await deps.refreshStorageUsage();
  return blobImport;
}
