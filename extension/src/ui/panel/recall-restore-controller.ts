import { reducePanelAction } from '../../core/actions.js';
import type { BookmarkStore, ImportedEncryptedImageFile, ImportedImageFile, PanelState, UrlReviewStatusStore } from '../../core/types.js';
import type { CaptureStore } from '../../content/capture-controller.js';
import type { RecentHistoryStore } from '../../content/recent-history-store.js';
import type { ImageDisplayRecord } from '../../core/display-records.js';
import type { CapturedImportedMedia } from './imported-media-record.js';
import { importMediaFiles } from './imported-media-batch.js';
import { importEncryptedImageFiles } from './encrypted-image-restore.js';
import type { RecordLibraryImportInput } from './record-library-controller.js';
import type { downloadPCloudBackup, listPCloudBackups } from '../../content/pcloud-provider-client.js';
import {
  importBookmarks as importBookmarkRecords,
  importEncryptedHistory,
  importUrlReviewStatus as importUrlReviewStatusFile,
  type AlbumBackupEntry,
  type PlaintextLocalSettings,
} from '../../content/panel-services.js';
import {
  bookmarkEntriesOriginalReferenceCount,
  privatePinsNotRestoredMessage,
  restoreBookmarkEntries,
  createBookmarksRestorePreview,
  createHistoryRestorePreview,
  createRestoreDuplicateSummary,
  createUrlReviewStatusRestorePreview,
  fullBackupRestoreDetail,
  historyPayloadToDisplayRecord,
  restoreImportCompleteMessage,
  type BookmarkImportResult,
  type HistoryImportResult,
  type UrlReviewStatusImportResult,
} from './restore-import-preview.js';
import { PCloudBackupRestoreCoordinator, type ChunkedCloudRestoreContext } from './pcloud-backup-restore.js';

/**
 * Tagged union of a decrypted, deduped import awaiting user confirmation. Owned by
 * {@link RecallRestoreController} as the backing value for the preview → confirm → import state machine.
 */
export type PendingRestoreImport =
  | { readonly kind: 'history'; readonly result: HistoryImportResult; readonly duplicateCount: number }
  | {
      readonly kind: 'bookmarks';
      readonly result: BookmarkImportResult;
      readonly duplicateCount: number;
      readonly duplicateRecordIdsByUuid: ReadonlyMap<string, string>;
      readonly password: string;
      readonly chunkedCloudRestore?: ChunkedCloudRestoreContext | undefined;
    }
  | { readonly kind: 'url-review-status'; readonly result: UrlReviewStatusImportResult };

/**
 * Owns file and pCloud restore previews, confirmation, imports, and sibling
 * export-controller callbacks injected as lazy closures.
 */
export interface RecallRestoreControllerDeps {
  getState(): PanelState;
  setState(state: PanelState): void;
  render(): void;
  renderPanelAndRefreshRecall(): void;
  loadBookmarkPage(offset: number, options?: { readonly render?: boolean }): Promise<void>;
  loadRecentHistory(options?: { readonly render?: boolean; readonly includeRetained?: boolean }): Promise<void>;
  refreshStorageUsage(options?: { readonly render?: boolean }): Promise<void>;
  addImportedImage(file: RecordLibraryImportInput, captured?: CapturedImportedMedia): Promise<boolean>;
  getLocalSettings(): PlaintextLocalSettings;
  bookmarkStore(): BookmarkStore | null;
  albumStore(): {
    readonly importBackupEntries: (
      albums: readonly AlbumBackupEntry[],
      recordIdMap: ReadonlyMap<string, string>,
    ) => Promise<{
      readonly importedAlbumCount: number;
      readonly importedMembershipCount: number;
      readonly skippedMembershipCount: number;
    }>;
  } | null;
  captureStore(): CaptureStore | null;
  recentHistoryStore(): RecentHistoryStore | null;
  urlReviewStatusStore(): UrlReviewStatusStore | null;
  listPCloudBackups: typeof listPCloudBackups;
  downloadPCloudBackup: typeof downloadPCloudBackup;
  loadAllBookmarks(): Promise<readonly ImageDisplayRecord[]>;
  refreshBlobKeyStatus(): Promise<void>;
}

export class RecallRestoreController {
  private pendingRestoreImport: PendingRestoreImport | null = null;
  private readonly pcloudRestore: PCloudBackupRestoreCoordinator;

  constructor(private readonly deps: RecallRestoreControllerDeps) {
    this.pcloudRestore = new PCloudBackupRestoreCoordinator(deps);
  }

  async choosePCloudRestoreFile(): Promise<void> {
    return this.pcloudRestore.chooseRestoreFile();
  }

  async previewPCloudRestoreFile(fileId: number, fileName: string, password: string): Promise<void> {
    return this.pcloudRestore.previewRestoreFile(
      fileId,
      fileName,
      password,
      (fileContent, legacyPassword, legacyFileName) => this.previewBookmarksImport(fileContent, legacyPassword, legacyFileName),
      (result, context, chunkedPassword, chunkedFileName) =>
        this.prepareBookmarksPreview(result, chunkedPassword, chunkedFileName, context),
    );
  }

  cancelPCloudRestore(): void {
    this.pcloudRestore.cancel();
  }

  async importImages(files: readonly ImportedImageFile[]): Promise<void> {
    if (files.length === 0) {
      this.deps.setState(
        reducePanelAction(this.deps.getState(), { name: 'import-export/error', message: 'Choose one or more image files to import.' }),
      );
      this.deps.render();
      return;
    }

    this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'import-export/start' }));
    this.deps.render();
    const { imported, failed, firstFailureMessage } = await importMediaFiles(files, this.deps);

    if (imported === 0) {
      this.deps.setState(
        reducePanelAction(this.deps.getState(), {
          name: 'import-export/error',
          message: firstFailureMessage ?? 'No selected media could be imported.',
        }),
      );
    } else {
      this.deps.setState(
        reducePanelAction(this.deps.getState(), {
          name: 'import-export/complete',
          message: `Imported ${imported} media item${imported === 1 ? '' : 's'} into bookmarks and recent history.${failed > 0 ? ` ${failed} failed.` : ''}`,
        }),
      );
    }
    this.deps.render();
  }

  async importEncryptedImages(files: readonly ImportedEncryptedImageFile[]): Promise<void> {
    return importEncryptedImageFiles(files, this.deps);
  }

  async previewHistoryImport(fileContent: string, password: string, fileName?: string): Promise<void> {
    this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'import-export/start' }));
    this.deps.render();
    const result = await importEncryptedHistory(fileContent, password);
    if (!result.status.ok) {
      this.pendingRestoreImport = null;
      this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'import-export/error', message: result.status.message }));
      this.deps.render();
      return;
    }
    const duplicateSummary = createRestoreDuplicateSummary(result.entries, await this.loadRetainedRecentHistoryForRestoreDuplicateCheck());
    this.pendingRestoreImport = {
      kind: 'history',
      result: { ...result, entries: duplicateSummary.uniqueEntries },
      duplicateCount: duplicateSummary.duplicateCount,
    };
    this.deps.setState(
      reducePanelAction(this.deps.getState(), {
        name: 'import/restore-preview-ready',
        preview: createHistoryRestorePreview(result, fileName, duplicateSummary),
      }),
    );
    this.deps.render();
  }

  private async importHistory(result: HistoryImportResult, duplicateCount: number): Promise<void> {
    const recentHistoryStore = this.deps.recentHistoryStore();
    if (!recentHistoryStore) {
      this.deps.setState(
        reducePanelAction(this.deps.getState(), {
          name: 'import-export/error',
          message: 'Recent history storage is unavailable; no records were imported.',
        }),
      );
      this.deps.render();
      return;
    }
    let importedCount = 0;
    for (const entry of result.entries) {
      const record = historyPayloadToDisplayRecord(entry.uuid, entry.payload);
      await recentHistoryStore.add(record, window.location.href);
      importedCount += 1;
    }
    await this.deps.loadRecentHistory();
    this.deps.setState(
      reducePanelAction(this.deps.getState(), {
        name: 'import-export/complete',
        message: restoreImportCompleteMessage(
          'record',
          importedCount,
          duplicateCount,
          result.skipped.length,
          result.plaintext,
          'reloaded into extension state',
        ),
      }),
    );
    this.deps.render();
  }

  async previewBookmarksImport(fileContent: string, password: string, fileName?: string): Promise<void> {
    this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'import-export/start' }));
    this.deps.render();
    const result = await importBookmarkRecords(fileContent, password);
    await this.prepareBookmarksPreview(result, password, fileName);
  }

  private async prepareBookmarksPreview(
    result: BookmarkImportResult,
    password: string,
    fileName?: string,
    chunkedCloudRestore?: ChunkedCloudRestoreContext,
  ): Promise<void> {
    if (!result.status.ok) {
      this.pendingRestoreImport = null;
      this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'import-export/error', message: result.status.message }));
      this.deps.render();
      return;
    }
    const duplicateSummary = createRestoreDuplicateSummary(result.entries, await this.deps.loadAllBookmarks());
    this.pendingRestoreImport = {
      kind: 'bookmarks',
      result: {
        ...result,
        entries: duplicateSummary.uniqueEntries,
        externalOriginalCount: bookmarkEntriesOriginalReferenceCount(duplicateSummary.uniqueEntries),
      },
      duplicateCount: duplicateSummary.duplicateCount,
      duplicateRecordIdsByUuid: duplicateSummary.duplicateRecordIdsByUuid,
      password,
      ...(chunkedCloudRestore ? { chunkedCloudRestore } : {}),
    };
    this.deps.setState(
      reducePanelAction(this.deps.getState(), {
        name: 'import/restore-preview-ready',
        preview: createBookmarksRestorePreview(result, fileName, duplicateSummary),
      }),
    );
    this.deps.render();
  }

  private async importBookmarks(
    result: BookmarkImportResult,
    duplicateCount: number,
    password: string,
    duplicateRecordIdsByUuid: ReadonlyMap<string, string>,
    chunkedCloudRestore?: ChunkedCloudRestoreContext,
  ): Promise<boolean> {
    const bookmarkStore = this.deps.bookmarkStore();
    if (!bookmarkStore) {
      this.deps.setState(
        reducePanelAction(this.deps.getState(), {
          name: 'import-export/error',
          message: 'Bookmark storage is unavailable; no bookmarks were imported.',
        }),
      );
      this.deps.render();
      return false;
    }
    const fullBackupOriginalRestore = await this.restoreFullBackupOriginals(result, password, chunkedCloudRestore);
    if (!fullBackupOriginalRestore.ok) {
      this.deps.setState(
        reducePanelAction(this.deps.getState(), { name: 'import-export/error', message: fullBackupOriginalRestore.message }),
      );
      this.deps.render();
      return false;
    }
    const recordIdMap = new Map(duplicateRecordIdsByUuid);
    const { importedCount, ...privateCounts } = await restoreBookmarkEntries(bookmarkStore, result.entries, recordIdMap);
    const albumRestore = await this.restoreFullBackupAlbums(result, recordIdMap);
    await this.deps.loadBookmarkPage(0, { render: false });
    this.deps.setState(
      reducePanelAction(this.deps.getState(), {
        name: 'import-export/complete',
        message:
          restoreImportCompleteMessage(
            'bookmark',
            importedCount,
            duplicateCount,
            result.skipped.length,
            result.plaintext,
            result.fullBackup
              ? fullBackupRestoreDetail(fullBackupOriginalRestore.importedOriginalCount)
              : 'encrypted into bookmark storage',
          ) +
          privatePinsNotRestoredMessage(privateCounts) +
          albumRestoreCompleteMessage(albumRestore),
      }),
    );
    this.deps.renderPanelAndRefreshRecall();
    return true;
  }

  private async restoreFullBackupAlbums(
    result: BookmarkImportResult,
    recordIdMap: ReadonlyMap<string, string>,
  ): Promise<{
    readonly importedAlbumCount: number;
    readonly importedMembershipCount: number;
    readonly skippedMembershipCount: number;
    readonly unavailable?: boolean;
  } | null> {
    if (!result.fullBackup || result.albums.length === 0) return null;
    const albumStore = this.deps.albumStore();
    if (!albumStore) {
      return {
        importedAlbumCount: 0,
        importedMembershipCount: 0,
        skippedMembershipCount: result.albums.reduce((sum, album) => sum + album.recordIds.length, 0),
        unavailable: true,
      };
    }
    return albumStore.importBackupEntries(result.albums, recordIdMap);
  }

  private async restoreFullBackupOriginals(
    result: BookmarkImportResult,
    password: string,
    chunkedCloudRestore?: ChunkedCloudRestoreContext,
  ): Promise<{ readonly ok: true; readonly importedOriginalCount: number } | { readonly ok: false; readonly message: string }> {
    if (!result.fullBackup) return { ok: true, importedOriginalCount: 0 };
    if (chunkedCloudRestore && chunkedCloudRestore.manifest.originalCount > 0) {
      return this.pcloudRestore.restoreOriginals(chunkedCloudRestore, password);
    }
    if (result.externalOriginalCount === 0) return { ok: true, importedOriginalCount: 0 };
    const captureStore = this.deps.captureStore();
    if (!captureStore) {
      return { ok: false, message: 'Encrypted original storage is unavailable; no bookmarks were imported.' };
    }
    for (const backup of result.blobKeyBackups) {
      const imported = await captureStore.importBlobKeyBackup(backup.fileContent, password);
      if (!imported.ok) return { ok: false, message: imported.message };
    }
    const blobImport = await captureStore.importOriginalBlobRecords(result.originalBlobs);
    if (!blobImport.ok) return { ok: false, message: blobImport.message };
    await this.deps.refreshBlobKeyStatus();
    await this.deps.refreshStorageUsage();
    return { ok: true, importedOriginalCount: blobImport.importedCount };
  }

  previewUrlReviewStatusImport(fileContent: string, fileName?: string): void {
    const result = importUrlReviewStatusFile(fileContent);
    if (!result.status.ok) {
      this.pendingRestoreImport = null;
      this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'import-export/error', message: result.status.message }));
      this.deps.render();
      return;
    }
    this.pendingRestoreImport = { kind: 'url-review-status', result };
    this.deps.setState(
      reducePanelAction(this.deps.getState(), {
        name: 'import/restore-preview-ready',
        preview: createUrlReviewStatusRestorePreview(result, fileName),
      }),
    );
    this.deps.render();
  }

  private async importUrlReviewStatus(result: UrlReviewStatusImportResult): Promise<void> {
    const importedCount = await this.deps.urlReviewStatusStore()?.importMany(result.records, {
      maxRecordsPerHost: this.deps.getLocalSettings().urlReviewStatusLimit,
    });
    this.deps.setState(
      reducePanelAction(this.deps.getState(), {
        name: 'import-export/complete',
        message: `${result.status.message} ${importedCount ?? 0} saved to extension state.`,
      }),
    );
    this.deps.render();
  }

  async confirmRestorePreview(): Promise<void> {
    const pending = this.pendingRestoreImport;
    if (!pending) {
      this.deps.setState(
        reducePanelAction(this.deps.getState(), {
          name: 'import-export/error',
          message: 'Choose an import file before confirming restore.',
        }),
      );
      this.deps.render();
      return;
    }

    this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'import-export/start' }));
    this.deps.render();

    let completed = true;
    switch (pending.kind) {
      case 'history':
        await this.importHistory(pending.result, pending.duplicateCount);
        break;
      case 'bookmarks':
        completed = await this.importBookmarks(
          pending.result,
          pending.duplicateCount,
          pending.password,
          pending.duplicateRecordIdsByUuid,
          pending.chunkedCloudRestore,
        );
        break;
      case 'url-review-status':
        await this.importUrlReviewStatus(pending.result);
        break;
    }
    if (completed) this.pendingRestoreImport = null;
  }

  cancelRestorePreview(): void {
    this.pendingRestoreImport = null;
    this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'import/cancel-restore-preview' }));
    this.deps.render();
  }

  private async loadRetainedRecentHistoryForRestoreDuplicateCheck(): Promise<readonly ImageDisplayRecord[]> {
    const recentHistoryStore = this.deps.recentHistoryStore();
    if (!recentHistoryStore) return this.deps.getState().history;
    return recentHistoryStore.load(window.location.href, { includeRetained: true });
  }
}

function albumRestoreCompleteMessage(
  summary: {
    readonly importedAlbumCount: number;
    readonly importedMembershipCount: number;
    readonly skippedMembershipCount: number;
    readonly unavailable?: boolean;
  } | null,
): string {
  if (!summary) return '';
  if (summary.unavailable) return ' Albums were not restored because album storage is unavailable.';
  const restored = ` Restored ${summary.importedAlbumCount} album${summary.importedAlbumCount === 1 ? '' : 's'} with ${summary.importedMembershipCount} membership${summary.importedMembershipCount === 1 ? '' : 's'}.`;
  const skipped =
    summary.skippedMembershipCount > 0
      ? ` Skipped ${summary.skippedMembershipCount} album membership${summary.skippedMembershipCount === 1 ? '' : 's'} without a local record.`
      : '';
  return `${restored}${skipped}`;
}
