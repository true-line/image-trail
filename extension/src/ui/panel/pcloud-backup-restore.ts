import { reducePanelAction } from '../../core/actions.js';
import type { PCloudBackupDownloadResult, PCloudProviderStatus } from '../../core/cloud/pcloud-provider.js';
import type { PanelState } from '../../core/types.js';
import type { CaptureStore } from '../../content/capture-controller.js';
import type { downloadPCloudBackup, listPCloudBackups } from '../../content/pcloud-provider-client.js';
import type { OriginalRestoreOutcome } from './full-backup-original-restore.js';
import {
  createFullBackupImportResult,
  decryptCloudBackupManifest,
  decryptCloudBackupPart,
  isChunkedCloudBackupManifest,
  type BookmarksImportResult,
  type CloudBackupCryptoSession,
  type CloudBackupManifestV1,
  type CloudBackupMetadataPartV1,
  type CloudBackupPartReference,
} from '../../content/panel-services.js';

export interface ChunkedCloudRestoreContext {
  readonly manifest: CloudBackupManifestV1;
  readonly session: CloudBackupCryptoSession;
}

export interface PCloudBackupRestoreDeps {
  getState(): PanelState;
  setState(state: PanelState): void;
  render(): void;
  captureStore(): CaptureStore | null;
  listPCloudBackups: typeof listPCloudBackups;
  downloadPCloudBackup: typeof downloadPCloudBackup;
  refreshBlobKeyStatus(): Promise<void>;
  refreshStorageUsage(options?: { readonly render?: boolean }): Promise<void>;
}

interface ActiveRestore {
  cancelled: boolean;
  lastStatus?: PCloudProviderStatus;
}

class CloudRestoreFlowError extends Error {
  constructor(
    message: string,
    readonly status?: PCloudProviderStatus,
  ) {
    super(message);
  }
}

class CloudRestoreCancelledError extends Error {}

type ChunkedPreviewCallback = (
  result: BookmarksImportResult,
  context: ChunkedCloudRestoreContext,
  password: string,
  fileName: string,
) => Promise<void>;

export class PCloudBackupRestoreCoordinator {
  private active: ActiveRestore | null = null;

  constructor(private readonly deps: PCloudBackupRestoreDeps) {}

  cancel(): void {
    if (!this.active) return;
    this.active.cancelled = true;
    this.progress('Cancel requested. Finishing the current provider request before stopping...');
  }

  async chooseRestoreFile(): Promise<void> {
    if (this.deps.getState().pcloudBackup.connectionState === 'busy') return;
    const active: ActiveRestore = { cancelled: false };
    this.active = active;
    this.busy('Checking pCloud backups...');
    try {
      const result = await this.deps.listPCloudBackups();
      active.lastStatus = result.status;
      if (!result.ok) throw new CloudRestoreFlowError(result.message, result.status);
      this.assertNotCancelled(active);
      this.deps.setState(
        reducePanelAction(this.deps.getState(), {
          name: 'pcloud-backup/restore-candidates-loaded',
          candidates: result.candidates,
          folderPath: result.folderPath,
          apiHost: result.apiHost,
          message: result.message,
        }),
      );
      this.deps.render();
    } catch (error) {
      this.finishError(error, active);
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  async previewRestoreFile(
    fileId: number,
    fileName: string,
    password: string,
    onLegacy: (fileContent: string, password: string, fileName: string) => Promise<void>,
    onChunked: ChunkedPreviewCallback,
  ): Promise<void> {
    if (this.deps.getState().pcloudBackup.connectionState === 'busy') return;
    if (password.length < 4) {
      this.restoreError('Enter the cloud backup password before previewing this restore file.');
      return;
    }

    const active: ActiveRestore = { cancelled: false };
    this.active = active;
    this.busy('Downloading encrypted pCloud backup manifest...');
    try {
      const result = await this.download({ fileId, fileName }, active);
      if (!isChunkedCloudBackupManifest(result.fileContent)) {
        this.restoreDownloaded(result);
        await onLegacy(result.fileContent, password, result.fileName);
        return;
      }
      const context = await this.decryptManifest(result.fileContent, password);
      const imported = await this.loadPreviewParts(context, active);
      this.restoreDownloaded(result);
      await onChunked(imported, context, password, result.fileName);
    } catch (error) {
      this.finishError(error, active);
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  async restoreOriginals(context: ChunkedCloudRestoreContext, password: string): Promise<OriginalRestoreOutcome> {
    const captureStore = this.deps.captureStore();
    if (!captureStore) return { ok: false, message: 'Encrypted original storage is unavailable; no bookmarks were imported.' };
    const active: ActiveRestore = { cancelled: false };
    this.active = active;
    this.busy('Restoring encrypted original parts...');
    try {
      const metadata = await this.loadMetadataPart(context, active);
      await this.importBlobKeys(captureStore, metadata, password, active);
      const { importedOriginalCount, skippedOriginalCount } = await this.importOriginalParts(captureStore, context, active);
      await this.deps.refreshBlobKeyStatus();
      await this.deps.refreshStorageUsage();
      this.connected(active, `Restored ${importedOriginalCount} encrypted original part(s).`);
      return { ok: true, importedOriginalCount, skippedOriginalCount };
    } catch (error) {
      const message = this.finishError(error, active);
      return { ok: false, message };
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  private async loadPreviewParts(context: ChunkedCloudRestoreContext, active: ActiveRestore): Promise<BookmarksImportResult> {
    const bookmarks: unknown[] = [];
    let metadata: CloudBackupMetadataPartV1 | null = null;
    const previewParts = orderedParts(context.manifest).filter((part) => part.kind !== 'original');
    for (const [index, reference] of previewParts.entries()) {
      this.assertNotCancelled(active);
      this.progress(`Validating restore part ${index + 1} of ${previewParts.length}...`);
      const payload = await this.downloadPart(reference, context.session, active);
      if (payload.kind === 'metadata') metadata = payload;
      if (payload.kind === 'records') bookmarks.push(...payload.bookmarks);
    }
    if (!metadata) throw new CloudRestoreFlowError('Cloud backup metadata part was missing.');
    this.validatePreviewCounts(context.manifest, metadata, bookmarks.length);
    const backedOriginalBlobIds = orderedParts(context.manifest)
      .filter((part) => part.kind === 'original')
      .map((part) => part.originalBlobId!);
    return createFullBackupImportResult({
      bookmarks,
      backedOriginalBlobIds,
      blobKeyBackups: metadata.blobKeyBackups,
      missingOriginalBlobIds: metadata.missingOriginalBlobIds,
      albums: metadata.albums,
    });
  }

  private async loadMetadataPart(context: ChunkedCloudRestoreContext, active: ActiveRestore): Promise<CloudBackupMetadataPartV1> {
    const reference = context.manifest.parts.find((part) => part.kind === 'metadata');
    if (!reference) throw new CloudRestoreFlowError('Cloud backup metadata part was missing.');
    const payload = await this.downloadPart(reference, context.session, active);
    if (payload.kind !== 'metadata') throw new CloudRestoreFlowError('Cloud backup metadata part had the wrong type.');
    return payload;
  }

  private async importBlobKeys(
    captureStore: CaptureStore,
    metadata: CloudBackupMetadataPartV1,
    password: string,
    active: ActiveRestore,
  ): Promise<void> {
    for (const backup of metadata.blobKeyBackups) {
      this.assertNotCancelled(active);
      const imported = await captureStore.importBlobKeyBackup(backup.fileContent, password);
      if (!imported.ok) throw new CloudRestoreFlowError(imported.message);
    }
  }

  private async importOriginalParts(
    captureStore: CaptureStore,
    context: ChunkedCloudRestoreContext,
    active: ActiveRestore,
  ): Promise<{ readonly importedOriginalCount: number; readonly skippedOriginalCount: number }> {
    const references = orderedParts(context.manifest).filter((part) => part.kind === 'original');
    let importedCount = 0;
    let skippedCount = 0;
    let originalBytes = 0;
    for (const [index, reference] of references.entries()) {
      this.assertNotCancelled(active);
      this.progress(`Restoring encrypted original ${index + 1} of ${references.length}...`);
      const payload = await this.downloadPart(reference, context.session, active);
      if (payload.kind !== 'original' || payload.originalBlob.id !== reference.originalBlobId) {
        throw new CloudRestoreFlowError('Cloud backup original part did not match its manifest blob id.');
      }
      const imported = await captureStore.importOriginalBlobRecords([payload.originalBlob]);
      if (!imported.ok) throw new CloudRestoreFlowError(imported.message);
      importedCount += imported.importedCount;
      skippedCount += imported.skippedCount;
      originalBytes += payload.originalBlob.encryptedByteLength;
    }
    if (originalBytes !== context.manifest.originalBytes) {
      throw new CloudRestoreFlowError('Cloud backup original byte count did not match its manifest.');
    }
    return { importedOriginalCount: importedCount, skippedOriginalCount: skippedCount };
  }

  private async downloadPart(reference: CloudBackupPartReference, session: CloudBackupCryptoSession, active: ActiveRestore) {
    const downloaded = await this.download({ fileId: reference.fileId, fileName: reference.fileName, kind: 'part' }, active);
    if (
      downloaded.fileName !== reference.fileName ||
      downloaded.sizeBytes !== reference.sizeBytes ||
      downloaded.sha256.toLowerCase() !== reference.sha256.toLowerCase()
    ) {
      throw new CloudRestoreFlowError(`Cloud backup part ${reference.restoreOrder + 1} failed size or SHA-256 verification.`);
    }
    try {
      return await decryptCloudBackupPart(downloaded.fileContent, session, reference);
    } catch {
      throw new CloudRestoreFlowError(`Cloud backup part ${reference.restoreOrder + 1} failed identity or decryption validation.`);
    }
  }

  private async download(
    input: Parameters<typeof downloadPCloudBackup>[0],
    active: ActiveRestore,
  ): Promise<Extract<PCloudBackupDownloadResult, { readonly ok: true }>> {
    this.assertNotCancelled(active);
    const result = await this.deps.downloadPCloudBackup(input);
    active.lastStatus = result.status;
    if (!result.ok) throw new CloudRestoreFlowError(result.message, result.status);
    this.assertNotCancelled(active);
    return result;
  }

  private async decryptManifest(fileContent: string, password: string): Promise<ChunkedCloudRestoreContext> {
    try {
      return await decryptCloudBackupManifest(fileContent, password);
    } catch {
      throw new CloudRestoreFlowError('Chunked cloud backup manifest could not be decrypted. Wrong password or corrupted file.');
    }
  }

  private validatePreviewCounts(manifest: CloudBackupManifestV1, metadata: CloudBackupMetadataPartV1, bookmarkCount: number): void {
    if (
      bookmarkCount !== manifest.recordCount ||
      metadata.albums.length !== manifest.albumCount ||
      metadata.missingOriginalBlobIds.length !== manifest.missingOriginalCount
    ) {
      throw new CloudRestoreFlowError('Cloud backup manifest counts did not match its decrypted parts.');
    }
  }

  private finishError(error: unknown, active: ActiveRestore): string {
    const message = error instanceof Error ? error.message : 'Cloud restore failed.';
    if (error instanceof CloudRestoreCancelledError && active.lastStatus) {
      this.connected(active, 'Cloud restore canceled. No bookmark records were changed.');
      return message;
    }
    this.restoreError(message, error instanceof CloudRestoreFlowError ? (error.status ?? active.lastStatus) : active.lastStatus);
    return message;
  }

  private restoreDownloaded(result: Extract<PCloudBackupDownloadResult, { readonly ok: true }>): void {
    this.deps.setState(
      reducePanelAction(this.deps.getState(), {
        name: 'pcloud-backup/restore-downloaded',
        fileName: result.fileName,
        folderPath: result.folderPath,
        apiHost: result.apiHost,
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        downloadedAt: result.downloadedAt,
        message: result.message,
      }),
    );
  }

  private assertNotCancelled(active: ActiveRestore): void {
    if (active.cancelled) throw new CloudRestoreCancelledError('Cloud restore canceled.');
  }

  private busy(message: string): void {
    this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'pcloud-backup/busy', pendingOperation: 'restoring', message }));
    this.deps.render();
  }

  private progress(message: string): void {
    this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'pcloud-backup/message', message }));
    this.deps.render();
  }

  private connected(active: ActiveRestore, message: string): void {
    const status = active.lastStatus ?? { connected: true };
    this.deps.setState(reducePanelAction(this.deps.getState(), { name: 'pcloud-backup/status', status: { ...status, message } }));
    this.deps.render();
  }

  private restoreError(message: string, status?: PCloudProviderStatus): void {
    const action =
      status === undefined
        ? ({ name: 'pcloud-backup/restore-error', message } as const)
        : ({ name: 'pcloud-backup/restore-error', message, status } as const);
    this.deps.setState(reducePanelAction(this.deps.getState(), action));
    this.deps.render();
  }
}

function orderedParts(manifest: CloudBackupManifestV1): readonly CloudBackupPartReference[] {
  return [...manifest.parts].sort((left, right) => left.restoreOrder - right.restoreOrder);
}
