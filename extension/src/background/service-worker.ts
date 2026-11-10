import type { StorageUsageSummary } from '../core/image/capture-result.js';
import { computeSha256 } from '../core/image/fingerprints.js';
import { isBuildIdentity } from '../core/build-info.js';
import { IndexedDbBookmarkStore } from '../data/bookmarks-controller.js';
import { IndexedDbAlbumStore } from '../data/albums-controller.js';
import { IndexedDbPanelPositionStore } from '../data/panel-position-controller.js';
import { IndexedDbWorkspaceLayoutStore } from '../data/workspace-layout-controller.js';
import { IndexedDbUrlTemplateStore } from '../data/url-template-controller.js';
import { createUrlMetadataStores, reconcilePersistedUrlMetadataPolicy } from '../data/url-metadata-stores.js';
import { RecentHistoryCache } from './recent-history-cache.js';
import { sessionStorageForContext } from './session-storage-context.js';
import { configureBlobKeySessionStorage, restoreActiveBlobKey } from '../data/crypto/blob-keyring.js';
import { openBlobPayload, sealBlobPayload } from '../data/crypto/binary-envelope.js';
import { createEncryptedImageFile } from '../data/import-export/encrypted-image.js';
import { openImageTrailDb } from '../data/db.js';
import { BlobsRepository } from '../data/repositories/blobs-repository.js';
import { EncryptedPinsRepository } from '../data/repositories/encrypted-pins-repository.js';
import { EncryptedPinThumbnailsRepository } from '../data/repositories/encrypted-pin-thumbnails-repository.js';
import type { StoredBlobRecord } from '../data/types.js';
import { BROWSER_COMMAND_SHORTCUTS } from '../core/keyboard-shortcuts.js';
import { fetchImageBytes, preferredCaptureFileName } from './fetch-image.js';
import { dataUrlToImageBytes, imageDataUrlFromBytes, isSupportedMediaDataUrl, openedImageDataFromPayload } from './data-url-image.js';
import { openPreviewPayload, takePreviewPayload } from './preview-payload-store.js';
import { fetchLinkedPage } from './fetch-linked-page.js';
import {
  MessageType,
  createCaptureImageMessage,
  createCaptureResultMessage,
  createCheckImageRequestPolicyResultMessage,
  createCleanupOrphanedBlobsResultMessage,
  createCreateBlobPreviewResultMessage,
  createDeleteBlobResultMessage,
  createDownloadImageResultMessage,
  createExportEncryptedImageResultMessage,
  createFetchLinkedPageResultMessage,
  createFetchThumbnailSourceResultMessage,
  createLoadParsedFieldStateBySourceResultMessage,
  createImportEncryptedImageResultMessage,
  createLoadBuildIdentityResultMessage,
  createLoadParsedFieldStateResultMessage,
  createSaveParsedFieldStateResultMessage,
  createFetchBufferedImageSourceResultMessage,
  createPingMessage,
  createProbeImageSourceResultMessage,
  createRetrieveBlobResultMessage,
  createStorageUsageResponseMessage,
  createToggleBuildIdentityOverlayMessage,
  createTogglePanelMessage,
  isExtensionRequest,
  isStatusMessage,
} from './messages.js';
import type {
  CaptureImageMessage,
  DeleteBlobMessage,
  DownloadImageMessage,
  ExportEncryptedImageMessage,
  RetrieveBlobMessage,
  GrantPermissionAndCaptureMessage,
} from './messages.js';
import type { LoadParsedFieldStateMessage, SaveParsedFieldStateMessage } from './messages.js';
import type {
  FetchBufferedImageSourceMessage,
  CheckImageRequestPolicyMessage,
  FetchLinkedPageMessage,
  FetchThumbnailSourceMessage,
  ProbeImageSourceMessage,
} from './messages.js';
import type { CreateBlobPreviewMessage } from './messages.js';
import type { ImportEncryptedImageMessage } from './messages.js';
import { ImageRequestManager } from './image-request-manager.js';
import { extractOrigin, hasOriginPermission, requestOriginPermission } from './permissions.js';
import { findDeletableOrphanBlobIds } from './orphaned-blobs.js';
import { defineMessage, dispatchRequest, type MessageDef } from './message-dispatch.js';
import * as requestSchemas from './message-schemas.js';
import type { ExtensionRequest, ExtensionResponse } from './messages.js';
import type {
  CleanupOrphanedBlobsMessage,
  CreateDataUrlPreviewMessage,
  LoadBuildIdentityMessage,
  LoadParsedFieldStateBySourceMessage,
  StorageUsageRequestMessage,
} from './messages.js';
import { createBookmarkMessageRegistry } from './handlers/bookmark-message-handlers.js';
import { createAlbumMessageRegistry } from './handlers/album-handlers.js';
import { createPanelPositionMessageRegistry } from './handlers/panel-position-handlers.js';
import { createRecentHistoryMessageRegistry } from './handlers/recent-history-handlers.js';
import { createRecallMessageRegistry } from './handlers/recall-handlers.js';
import { createBlobKeyMessageRegistry } from './handlers/blob-key-handlers.js';
import { createOriginalBlobMessageRegistry } from './handlers/original-blob-handlers.js';
import { createDestinationMessageRegistry } from './handlers/destination-page-handler.js';
import { createCloudMessageRegistry, createInteropSourceFinalizer } from './handlers/pcloud-handlers.js';
import { createUrlTemplateMessageRegistry } from './handlers/url-template-handlers.js';
import { createUrlReviewStatusMessageRegistry } from './handlers/url-review-status-handlers.js';
import { createLocalSettingsMessageRegistry, loadLocalSettings } from './handlers/local-settings-handlers.js';
import { normalizeHostname } from './handlers/hostname.js';
import { createChangeNotifiers } from './change-notifiers.js';
import type { ServiceWorkerContext } from './service-worker-context.js';
import { createShortcutActionMessage } from './shortcut-action-message.js';
import { createRetryingDbProvider } from './db-provider.js';
import { importEncryptedImageToDurableStorage } from './encrypted-image-import.js';
const CONTENT_SCRIPT_FILE = 'src/content/content-script.js';
const TOGGLE_BUILD_IDENTITY_COMMAND = 'toggle-build-info-overlay';
const BROWSER_COMMAND_ACTIONS = new Map(BROWSER_COMMAND_SHORTCUTS.map((shortcut) => [shortcut.command, shortcut.action]));
const SUPPORTED_PAGE_PATTERN = /^https?:\/\//u;
const imageRequests = new ImageRequestManager();
configureBlobKeySessionStorage(sessionStorageForContext());
const bookmarkStore = new IndexedDbBookmarkStore({
  getActiveBlobKey: restoreActiveBlobKey,
  getPinSaveStoragePreference: async () => (await loadLocalSettings()).pinSaveStoragePreference,
  getSearchableMetadataPolicy: async () => (await loadLocalSettings()).searchableMetadataPolicy,
});
const albumStore = new IndexedDbAlbumStore();
const getDb = createRetryingDbProvider(openImageTrailDb);
const { parsedFieldStateStore, urlReviewStatusStore, reconcileSearchableMetadataPolicy } = createUrlMetadataStores({
  getDb,
  getSearchableMetadataPolicy: async () => (await loadLocalSettings()).searchableMetadataPolicy,
});
const urlTemplateStore = new IndexedDbUrlTemplateStore();
const recentHistoryCache = new RecentHistoryCache(sessionStorageForContext());
const { notifyLibraryChange, notifySecureSessionChange } = createChangeNotifiers(chrome.runtime, chrome.tabs);
/** Composition-root context handed to extracted handler modules; see {@link ServiceWorkerContext}. */
const context: ServiceWorkerContext = {
  bookmarkStore,
  albumStore,
  panelPositionStore: new IndexedDbPanelPositionStore(),
  workspaceLayoutStore: new IndexedDbWorkspaceLayoutStore(),
  parsedFieldStateStore,
  urlReviewStatusStore,
  urlTemplateStore,
  recentHistoryCache,
  imageRequests,
  getDb,
  loadLocalSettings,
};
async function requestStatus(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, createPingMessage());
    return isStatusMessage(response);
  } catch {
    return false;
  }
}
async function ensureContentScript(tabId: number): Promise<void> {
  if (await requestStatus(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
  if (!(await requestStatus(tabId))) {
    throw new Error('Injected content script did not return a valid Image Trail status response.');
  }
}
async function sendToggle(tabId: number): Promise<void> {
  await ensureContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, createTogglePanelMessage());
  if (!isStatusMessage(response)) {
    console.warn('Image Trail received an unexpected toggle response.', response);
  }
}
async function sendToggleBuildIdentityOverlay(tabId: number): Promise<void> {
  await ensureContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, createToggleBuildIdentityOverlayMessage());
  if (!isStatusMessage(response)) {
    console.warn('Image Trail received an unexpected build-info toggle response.', response);
  }
}
async function sendShortcutAction(tabId: number, action: string): Promise<void> {
  await ensureContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, createShortcutActionMessage(action));
  if (!isStatusMessage(response)) {
    console.warn('Image Trail received an unexpected shortcut action response.', response);
  }
}
function supportedTabId(tab: chrome.tabs.Tab): number | null {
  if (typeof tab.id === 'number' && tab.url && SUPPORTED_PAGE_PATTERN.test(tab.url)) return tab.id;
  return null;
}
void reconcilePersistedUrlMetadataPolicy({
  loadPolicy: async () => (await loadLocalSettings()).searchableMetadataPolicy,
  reconcilePolicy: reconcileSearchableMetadataPolicy,
}).catch(() => {
  console.warn('Image Trail could not reconcile URL metadata privacy policy at startup.');
});
async function referencedBlobIds(): Promise<Set<string>> {
  const referenced = new Set(await bookmarkStore.loadOriginalBlobIds());
  await recentHistoryCache.ready();
  for (const history of recentHistoryCache.values()) {
    for (const item of history) {
      if (item.blobId) referenced.add(item.blobId);
    }
  }
  return referenced;
}
function createPreviewForDataUrl(dataUrl: string): Promise<import('./messages.js').CreateBlobPreviewResultMessage['payload']> {
  const parsed = dataUrlToImageBytes(dataUrl);
  if (!parsed.ok) return Promise.resolve({ ok: false, reason: 'invalid-data-url', message: parsed.message });
  return openPreviewPayload({
    dataUrl: imageDataUrlFromBytes(parsed.bytes, parsed.mimeType),
    byteLength: parsed.byteLength,
    mediaInfo: parsed.mediaInfo,
  });
}
async function handleCaptureImage(message: CaptureImageMessage): Promise<import('../core/image/capture-result.js').CaptureResult> {
  const url = message.payload.url;
  const activeBlobKey = await restoreActiveBlobKey();
  if (!activeBlobKey) {
    return {
      status: 'failed',
      reason: 'encryption-locked',
      message: 'Encrypted blob storage must be unlocked before original media capture.',
    };
  }
  const bytesResult = isSupportedMediaDataUrl(url)
    ? dataUrlToImageBytes(url, message.payload.fileName)
    : await (async () => {
        const origin = extractOrigin(url);
        if (origin && !(await hasOriginPermission(origin))) {
          return { ok: false as const, reason: 'permission-needed' as const, message: `Permission needed for ${origin}.`, origin };
        }
        return fetchImageBytes(url);
      })();
  if (!bytesResult.ok) {
    return 'reason' in bytesResult &&
      bytesResult.reason === 'permission-needed' &&
      'origin' in bytesResult &&
      typeof bytesResult.origin === 'string'
      ? { status: 'remote-only', reason: 'permission-needed', message: bytesResult.message, origin: bytesResult.origin }
      : { status: 'failed', reason: 'reason' in bytesResult ? bytesResult.reason : 'unknown', message: bytesResult.message };
  }
  const db = await getDb();
  if (!db) {
    return { status: 'failed', reason: 'unknown', message: 'Database unavailable.' };
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const sha256 = await computeSha256(bytesResult.bytes);
  const fileName = preferredCaptureFileName(bytesResult, message.payload.fileName);
  const aad = {
    id,
    kind: 'original' as const,
    schemaVersion: 1 as const,
    algorithm: 'AES-GCM' as const,
    createdAt: now,
    key: activeBlobKey.reference,
  };
  const sealed = await sealBlobPayload({
    key: activeBlobKey.key,
    aad,
    metadata: {
      mimeType: bytesResult.mimeType,
      byteLength: bytesResult.byteLength,
      sourceUrl: url.startsWith('data:') ? 'image-trail://local-import' : url,
      capturedAt: now,
      fileName,
      sha256,
      width: bytesResult.width,
      height: bytesResult.height,
      mediaInfo: bytesResult.mediaInfo,
    },
    bytes: bytesResult.bytes,
  });

  const record: StoredBlobRecord = {
    ...aad,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    encryptedByteLength: sealed.encryptedByteLength,
    referenceCount: 1,
  };
  await new BlobsRepository(db).put(record);
  return {
    status: 'captured',
    blobId: record.id,
    mimeType: bytesResult.mimeType,
    byteLength: bytesResult.byteLength,
    ...(fileName ? { fileName } : {}),
    sha256,
    ...(bytesResult.width ? { width: bytesResult.width } : {}),
    ...(bytesResult.height ? { height: bytesResult.height } : {}),
    ...(bytesResult.mediaInfo ? { mediaInfo: bytesResult.mediaInfo } : {}),
  };
}

async function handleDeleteBlob(message: DeleteBlobMessage): Promise<{ deleted: boolean; usage: StorageUsageSummary }> {
  const db = await getDb();
  if (!db) {
    return { deleted: false, usage: { totalBytes: 0, blobCount: 0 } };
  }
  const blobs = new BlobsRepository(db);
  await blobs.remove(message.payload.blobId);
  const usage = await handleStorageUsage();
  return { deleted: true, usage };
}

async function handleCleanupOrphanedBlobs(): Promise<import('./messages.js').CleanupOrphanedBlobsResultMessage['payload']> {
  const db = await getDb();
  if (!db) return { deletedCount: 0, usage: { totalBytes: 0, blobCount: 0 } };
  const referenced = await referencedBlobIds();
  const blobs = new BlobsRepository(db);
  const deletableOrphanBlobIds = findDeletableOrphanBlobIds(await blobs.listOriginalCleanupCandidates(), referenced);
  const deletedCount = await blobs.deleteMany(deletableOrphanBlobIds);
  return { deletedCount, usage: await handleStorageUsage() };
}

async function handleRetrieveBlob(message: RetrieveBlobMessage): Promise<import('./messages.js').RetrieveBlobResultMessage['payload']> {
  const activeBlobKey = await restoreActiveBlobKey();
  if (!activeBlobKey) {
    return { ok: false, reason: 'encryption-locked', message: 'Encrypted blob storage must be unlocked before retrieval.' };
  }
  const db = await getDb();
  if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
  const record = await new BlobsRepository(db).get(message.payload.blobId);
  if (!record) return { ok: false, reason: 'not-found', message: 'Encrypted blob was not found.' };
  if (record.key.reference !== activeBlobKey.reference.reference) {
    return { ok: false, reason: 'wrong-key', message: `Unlock ${record.key.reference} before retrieving this blob.` };
  }
  const opened = await openBlobPayload({
    key: activeBlobKey.key,
    iv: record.iv,
    ciphertext: record.ciphertext,
    aad: {
      id: record.id,
      kind: record.kind,
      schemaVersion: record.schemaVersion,
      algorithm: record.algorithm,
      createdAt: record.createdAt,
      key: record.key,
    },
  });
  const image = openedImageDataFromPayload(opened.bytes, opened.metadata);
  if (!image.ok) return image;
  return {
    ...image,
    blobId: record.id,
  };
}

async function handleCreateBlobPreview(
  message: CreateBlobPreviewMessage,
): Promise<import('./messages.js').CreateBlobPreviewResultMessage['payload']> {
  const retrieved = await handleRetrieveBlob({ type: MessageType.RetrieveBlob, version: 1, payload: { blobId: message.payload.blobId } });
  if (!retrieved.ok) return retrieved;
  return openPreviewPayload({
    dataUrl: retrieved.dataUrl,
    byteLength: retrieved.byteLength,
    mediaInfo: retrieved.mediaInfo,
  });
}

async function handleFetchThumbnailSource(
  message: FetchThumbnailSourceMessage,
): Promise<import('./messages.js').FetchThumbnailSourceResultMessage['payload']> {
  return imageRequests.fetchThumbnail(message.payload.url, {
    intent: message.payload.intent,
    referrer: message.payload.referrer,
    contextKey: message.payload.contextKey,
    sourceProfile: message.payload.sourceProfile,
  });
}

async function handleProbeImageSource(
  message: ProbeImageSourceMessage,
): Promise<import('./messages.js').ProbeImageSourceResultMessage['payload']> {
  return imageRequests.probeSpeculativeImage(message.payload.url, {
    referrer: message.payload.referrer,
    timeoutMs: message.payload.timeoutMs,
    contextKey: message.payload.contextKey,
    probeMethod: message.payload.probeMethod,
  });
}

async function handleFetchBufferedImageSource(
  message: FetchBufferedImageSourceMessage,
): Promise<import('./messages.js').FetchBufferedImageSourceResultMessage['payload']> {
  return imageRequests.fetchThumbnail(message.payload.url, {
    intent: message.payload.intent,
    referrer: message.payload.referrer,
    contextKey: message.payload.contextKey,
    sourceProfile: 'navigation',
  });
}
async function handleCheckImageRequestPolicy(
  message: CheckImageRequestPolicyMessage,
): Promise<import('./messages.js').CheckImageRequestPolicyResultMessage['payload']> {
  return imageRequests.checkRequestPolicy(message.payload.url, {
    intent: message.payload.intent,
    referrer: message.payload.referrer,
    contextKey: message.payload.contextKey,
  });
}

async function handleStorageUsage(): Promise<StorageUsageSummary> {
  const db = await getDb();
  if (!db) return { totalBytes: 0, blobCount: 0 };
  const blobs = new BlobsRepository(db);
  const pins = new EncryptedPinsRepository(db);
  const thumbnails = new EncryptedPinThumbnailsRepository(db);
  const [usage, bookmarkUsage, pinUsage, thumbnailUsage, referenced] = await Promise.all([
    blobs.getStorageUsage(),
    bookmarkStore.getStorageUsage(),
    pins.getStorageUsage(),
    thumbnails.getStorageUsage(),
    referencedBlobIds(),
  ]);
  const cleanupCandidates = await blobs.listOriginalCleanupCandidates();
  const inlineThumbnailUsage = bookmarkUsage.thumbnails ?? { count: 0, totalBytes: 0 };
  const combinedThumbnailUsage = {
    count: inlineThumbnailUsage.count + thumbnailUsage.blobCount,
    totalBytes: inlineThumbnailUsage.totalBytes + thumbnailUsage.totalBytes,
  };
  const queueMetadataBytes = Math.max(0, bookmarkUsage.totalBytes - inlineThumbnailUsage.totalBytes) + pinUsage.totalBytes;
  return {
    totalBytes: usage.totalBytes + bookmarkUsage.totalBytes + pinUsage.totalBytes + thumbnailUsage.totalBytes,
    blobCount: usage.blobCount,
    orphanedBlobCount: findDeletableOrphanBlobIds(cleanupCandidates, referenced).length,
    originals: { count: usage.blobCount, totalBytes: usage.totalBytes },
    queueRecords: { count: bookmarkUsage.blobCount + pinUsage.blobCount, totalBytes: queueMetadataBytes },
    thumbnails: combinedThumbnailUsage,
  };
}

async function handleLoadParsedFieldState(
  message: LoadParsedFieldStateMessage,
): Promise<import('./messages.js').LoadParsedFieldStateResultMessage['payload']> {
  const hostname = normalizeHostname(message.payload.hostname);
  if (!hostname) return { ok: true, record: null };
  return { ok: true, record: await parsedFieldStateStore.load(hostname, message.payload.pageUrl) };
}

async function handleLoadParsedFieldStateBySource(
  message: import('./messages.js').LoadParsedFieldStateBySourceMessage,
): Promise<import('./messages.js').LoadParsedFieldStateBySourceResultMessage['payload']> {
  const hostname = normalizeHostname(message.payload.hostname);
  if (!hostname) return { ok: true, record: null };
  return { ok: true, record: await parsedFieldStateStore.loadForSource(hostname, message.payload.sourceUrl) };
}

async function handleSaveParsedFieldState(
  message: SaveParsedFieldStateMessage,
): Promise<import('./messages.js').SaveParsedFieldStateResultMessage['payload']> {
  const hostname = normalizeHostname(message.payload.record.hostname);
  if (!hostname) return { ok: false };
  await parsedFieldStateStore.save({ ...message.payload.record, hostname });
  return { ok: true };
}

async function handleGrantPermissionAndCapture(
  message: GrantPermissionAndCaptureMessage,
): Promise<import('../core/image/capture-result.js').CaptureResult> {
  const { sourceType, sourceRecordId, fileName } = message.payload;
  const url = message.payload.url;
  const origin = extractOrigin(url);

  if (!origin) {
    return { status: 'failed', reason: 'unknown', message: 'Could not extract origin from URL.' };
  }

  const granted = await requestOriginPermission(origin);
  if (!granted) {
    return { status: 'failed', reason: 'permission-needed', message: `Permission was not granted for ${origin}.`, origin };
  }

  return handleCaptureImage(createCaptureImageMessage(url, sourceType, sourceRecordId, fileName));
}

async function handleDownloadImage(message: DownloadImageMessage): Promise<import('./messages.js').DownloadImageResultMessage['payload']> {
  try {
    const downloadId = await chrome.downloads.download({
      url: message.payload.url,
      filename: message.payload.fileName,
      saveAs: message.payload.saveAs,
      conflictAction: 'uniquify',
    });
    return { ok: true, downloadId };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Image download could not be started.',
    };
  }
}

async function handleExportEncryptedImage(
  message: ExportEncryptedImageMessage,
): Promise<import('./messages.js').ExportEncryptedImageResultMessage['payload']> {
  const activeBlobKey = await restoreActiveBlobKey();
  if (!activeBlobKey) {
    return { ok: false, reason: 'encryption-locked', message: 'Unlock encrypted originals before exporting encrypted images.' };
  }

  const bytesResult = message.payload.blobId
    ? await imageBytesFromStoredBlob(message.payload.blobId)
    : await imageBytesFromUrl(message.payload.url);
  if (!bytesResult.ok) return bytesResult;

  const result = await createEncryptedImageFile({
    bytes: bytesResult.bytes,
    mimeType: bytesResult.mimeType,
    sourceUrl: bytesResult.sourceUrl,
    fileName: message.payload.fileName,
    key: activeBlobKey.key,
    keyReference: activeBlobKey.reference,
  });
  return {
    ok: true,
    fileContent: result.fileContent,
    fileName: result.fileName,
    message: `Encrypted image export prepared for ${message.payload.fileName}.`,
  };
}

async function imageBytesFromStoredBlob(
  blobId: string,
): Promise<
  | { readonly ok: true; readonly bytes: ArrayBuffer; readonly mimeType: string; readonly sourceUrl: string }
  | { readonly ok: false; readonly reason: string; readonly message: string }
> {
  const activeBlobKey = await restoreActiveBlobKey();
  if (!activeBlobKey) {
    return { ok: false, reason: 'encryption-locked', message: 'Unlock encrypted originals before exporting encrypted images.' };
  }
  const db = await getDb();
  if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
  const record = await new BlobsRepository(db).get(blobId);
  if (!record) return { ok: false, reason: 'not-found', message: 'Encrypted blob was not found.' };
  if (record.key.reference !== activeBlobKey.reference.reference) {
    return { ok: false, reason: 'wrong-key', message: `Unlock ${record.key.reference} before exporting this encrypted image.` };
  }
  const opened = await openBlobPayload({
    key: activeBlobKey.key,
    iv: record.iv,
    ciphertext: record.ciphertext,
    aad: {
      id: record.id,
      kind: record.kind,
      schemaVersion: record.schemaVersion,
      algorithm: record.algorithm,
      createdAt: record.createdAt,
      key: record.key,
    },
  });
  return {
    ok: true,
    bytes: opened.bytes,
    mimeType: opened.metadata.mimeType,
    sourceUrl: opened.metadata.sourceUrl,
  };
}

async function imageBytesFromUrl(
  url: string,
): Promise<
  | { readonly ok: true; readonly bytes: ArrayBuffer; readonly mimeType: string; readonly sourceUrl: string }
  | { readonly ok: false; readonly reason: string; readonly message: string }
> {
  const parsed = url.startsWith('data:image/') ? dataUrlToImageBytes(url) : await imageRequests.fetchOriginalImage(url);
  if (!parsed.ok) {
    const reason = 'reason' in parsed && typeof parsed.reason === 'string' ? parsed.reason : 'invalid-data-url';
    return { ok: false, reason, message: parsed.message };
  }
  return { ok: true, bytes: parsed.bytes, mimeType: parsed.mimeType, sourceUrl: url };
}

async function handleImportEncryptedImage(
  message: ImportEncryptedImageMessage,
): Promise<import('./messages.js').ImportEncryptedImageResultMessage['payload']> {
  return importEncryptedImageToDurableStorage(message.payload.fileContent, {
    restoreActiveBlobKey,
    getDb,
    findBookmarkByUrl: (url) => bookmarkStore.findByUrl(url),
    saveBookmark: (record, activeBlobKey) => bookmarkStore.saveProtectedResult(record, activeBlobKey),
    notifyBookmarkSaved: (record) => notifyLibraryChange({ topic: 'bookmarks', reason: 'bookmark-saved', recordIds: [record.id] }),
  });
}

async function handleLoadBuildIdentity(): Promise<ReturnType<typeof createLoadBuildIdentityResultMessage>['payload']> {
  try {
    const response = await fetch(chrome.runtime.getURL('build-info.json'), { cache: 'no-store' });
    if (!response.ok) {
      return { ok: false, identity: null, message: 'Build identity could not be loaded.' };
    }
    const payload: unknown = await response.json();
    if (!isBuildIdentity(payload)) {
      return { ok: false, identity: null, message: 'Build identity payload was invalid.' };
    }
    return { ok: true, identity: payload };
  } catch {
    return { ok: false, identity: null, message: 'Build identity could not be loaded.' };
  }
}

type DispatchedRequestType = Exclude<
  ExtensionRequest['type'],
  typeof MessageType.TogglePanel | typeof MessageType.ToggleBuildIdentityOverlay | typeof MessageType.Ping
>;

/**
 * Message registry: the single source of truth for background request dispatch.
 * `satisfies Record<DispatchedRequestType, ...>` enforces completeness at compile
 * time -- every request type (except TogglePanel/Ping, handled by the content
 * script) must have exactly one entry, so adding a request without wiring it is a
 * type error. Each entry replaces one `case` of the former ~475-line switch:
 * `handle` runs the work, `respond` wraps the result into a response envelope, and
 * `fallback` supplies the reply used when the handler rejects. `requestSchema` is
 * reserved for schema validation (#271) and is not populated yet.
 */
const messageRegistry = {
  [MessageType.LoadBuildIdentity]: defineMessage({
    requestSchema: requestSchemas.loadBuildIdentityRequestSchema,
    handle: (_message: LoadBuildIdentityMessage) => handleLoadBuildIdentity(),
    respond: (result) => createLoadBuildIdentityResultMessage(result),
    fallback: () => createLoadBuildIdentityResultMessage({ ok: false, identity: null, message: 'Build identity could not be loaded.' }),
  }),
  ...createDestinationMessageRegistry(),
  ...createAlbumMessageRegistry({ albumStore, notifyLibraryChange }),
  [MessageType.CaptureImage]: defineMessage({
    requestSchema: requestSchemas.captureImageRequestSchema,
    handle: (message: CaptureImageMessage) => handleCaptureImage(message),
    respond: (result) => createCaptureResultMessage(result),
    fallback: () => createCaptureResultMessage({ status: 'failed', reason: 'unknown', message: 'Internal capture error.' }),
  }),
  [MessageType.DownloadImage]: defineMessage({
    requestSchema: requestSchemas.downloadImageRequestSchema,
    handle: (message: DownloadImageMessage) => handleDownloadImage(message),
    respond: (result) => createDownloadImageResultMessage(result),
    fallback: () => createDownloadImageResultMessage({ ok: false, message: 'Image download could not be started.' }),
  }),
  [MessageType.ExportEncryptedImage]: defineMessage({
    requestSchema: requestSchemas.exportEncryptedImageRequestSchema,
    handle: (message: ExportEncryptedImageMessage) => handleExportEncryptedImage(message),
    respond: (result) => createExportEncryptedImageResultMessage(result),
    fallback: () => createExportEncryptedImageResultMessage({ ok: false, reason: 'unknown', message: 'Encrypted image export failed.' }),
  }),
  [MessageType.ImportEncryptedImage]: defineMessage({
    requestSchema: requestSchemas.importEncryptedImageRequestSchema,
    handle: (message: ImportEncryptedImageMessage) => handleImportEncryptedImage(message),
    respond: (result) => createImportEncryptedImageResultMessage(result),
    fallback: () => createImportEncryptedImageResultMessage({ ok: false, reason: 'unknown', message: 'Encrypted image import failed.' }),
  }),
  [MessageType.StorageUsageRequest]: defineMessage({
    requestSchema: requestSchemas.emptyPayloadSchema,
    handle: (_message: StorageUsageRequestMessage) => handleStorageUsage(),
    respond: (result) => createStorageUsageResponseMessage(result),
    fallback: () => createStorageUsageResponseMessage({ totalBytes: 0, blobCount: 0 }),
  }),
  ...createBookmarkMessageRegistry({ bookmarkStore, notifyLibraryChange }),
  ...createRecentHistoryMessageRegistry({ ...context, notifyLibraryChange }),
  ...createRecallMessageRegistry(context),
  ...createPanelPositionMessageRegistry(context),
  [MessageType.LoadParsedFieldState]: defineMessage({
    requestSchema: requestSchemas.loadParsedFieldStateRequestSchema,
    handle: (message: LoadParsedFieldStateMessage) => handleLoadParsedFieldState(message),
    respond: (result) => createLoadParsedFieldStateResultMessage(result),
    fallback: () => createLoadParsedFieldStateResultMessage({ ok: false, message: 'Parsed field state could not be loaded.' }),
  }),
  [MessageType.LoadParsedFieldStateBySource]: defineMessage({
    requestSchema: requestSchemas.loadParsedFieldStateBySourceRequestSchema,
    handle: (message: LoadParsedFieldStateBySourceMessage) => handleLoadParsedFieldStateBySource(message),
    respond: (result) => createLoadParsedFieldStateBySourceResultMessage(result),
    fallback: () => createLoadParsedFieldStateBySourceResultMessage({ ok: false, message: 'Parsed field state could not be loaded.' }),
  }),
  [MessageType.SaveParsedFieldState]: defineMessage({
    requestSchema: requestSchemas.saveParsedFieldStateRequestSchema,
    handle: (message: SaveParsedFieldStateMessage) => handleSaveParsedFieldState(message),
    respond: (result) => createSaveParsedFieldStateResultMessage(result),
    fallback: () => createSaveParsedFieldStateResultMessage({ ok: false }),
  }),
  ...createUrlReviewStatusMessageRegistry(context),
  ...createUrlTemplateMessageRegistry(context),
  ...createLocalSettingsMessageRegistry({ recentHistoryCache, reconcileSearchableMetadataPolicy }),
  ...createCloudMessageRegistry(getDb, createInteropSourceFinalizer(getDb, notifyLibraryChange)),
  [MessageType.DeleteBlob]: defineMessage({
    requestSchema: requestSchemas.deleteBlobRequestSchema,
    handle: (message: DeleteBlobMessage) => handleDeleteBlob(message),
    respond: (result) => createDeleteBlobResultMessage(result.deleted, result.usage),
    fallback: () => createDeleteBlobResultMessage(false, { totalBytes: 0, blobCount: 0 }),
  }),
  [MessageType.CleanupOrphanedBlobs]: defineMessage({
    requestSchema: requestSchemas.emptyPayloadSchema,
    handle: (_message: CleanupOrphanedBlobsMessage) => handleCleanupOrphanedBlobs(),
    respond: (result) => createCleanupOrphanedBlobsResultMessage(result),
    fallback: () => createCleanupOrphanedBlobsResultMessage({ deletedCount: 0, usage: { totalBytes: 0, blobCount: 0 } }),
  }),
  [MessageType.RetrieveBlob]: defineMessage({
    requestSchema: requestSchemas.retrieveBlobRequestSchema,
    handle: (message: RetrieveBlobMessage) => handleRetrieveBlob(message),
    respond: (result) => createRetrieveBlobResultMessage(result),
    fallback: () => createRetrieveBlobResultMessage({ ok: false, reason: 'unknown', message: 'Blob retrieval failed.' }),
  }),
  ...createOriginalBlobMessageRegistry(context),
  [MessageType.CreateBlobPreview]: defineMessage({
    requestSchema: requestSchemas.createBlobPreviewRequestSchema,
    handle: (message: CreateBlobPreviewMessage) => handleCreateBlobPreview(message),
    respond: (result) => createCreateBlobPreviewResultMessage(result),
    fallback: () => createCreateBlobPreviewResultMessage({ ok: false, reason: 'unknown', message: 'Preview creation failed.' }),
  }),
  [MessageType.CreateDataUrlPreview]: defineMessage({
    requestSchema: requestSchemas.createDataUrlPreviewRequestSchema,
    handle: (message: CreateDataUrlPreviewMessage) => createPreviewForDataUrl(message.payload.dataUrl),
    respond: (result) => createCreateBlobPreviewResultMessage(result),
    fallback: () => createCreateBlobPreviewResultMessage({ ok: false, reason: 'unknown', message: 'Preview creation failed.' }),
  }),
  [MessageType.FetchThumbnailSource]: defineMessage({
    requestSchema: requestSchemas.fetchThumbnailSourceRequestSchema,
    handle: (message: FetchThumbnailSourceMessage) => handleFetchThumbnailSource(message),
    respond: (result) => createFetchThumbnailSourceResultMessage(result),
    fallback: () => createFetchThumbnailSourceResultMessage({ ok: false, reason: 'unknown', message: 'Thumbnail source fetch failed.' }),
  }),
  [MessageType.ProbeImageSource]: defineMessage({
    requestSchema: requestSchemas.probeImageSourceRequestSchema,
    handle: (message: ProbeImageSourceMessage) => handleProbeImageSource(message),
    respond: (result) => createProbeImageSourceResultMessage(result),
    fallback: () => createProbeImageSourceResultMessage({ ok: false, reason: 'unknown', message: 'Image probe failed.' }),
  }),
  [MessageType.FetchBufferedImageSource]: defineMessage({
    requestSchema: requestSchemas.fetchBufferedImageSourceRequestSchema,
    handle: (message: FetchBufferedImageSourceMessage) => handleFetchBufferedImageSource(message),
    respond: (result) => createFetchBufferedImageSourceResultMessage(result),
    fallback: () => createFetchBufferedImageSourceResultMessage({ ok: false, reason: 'unknown', message: 'Buffered image fetch failed.' }),
  }),
  [MessageType.CheckImageRequestPolicy]: defineMessage({
    requestSchema: requestSchemas.checkImageRequestPolicyRequestSchema,
    handle: (message: CheckImageRequestPolicyMessage) => handleCheckImageRequestPolicy(message),
    respond: (result) => createCheckImageRequestPolicyResultMessage(result),
    fallback: () => createCheckImageRequestPolicyResultMessage({ status: 'unknown' }),
  }),
  [MessageType.FetchLinkedPage]: defineMessage({
    requestSchema: requestSchemas.fetchLinkedPageRequestSchema,
    handle: (message: FetchLinkedPageMessage) => fetchLinkedPage(message),
    respond: (result) => createFetchLinkedPageResultMessage(result),
    fallback: () => createFetchLinkedPageResultMessage({ ok: false, reason: 'unknown', message: 'Linked page fetch failed.' }),
  }),
  ...createBlobKeyMessageRegistry({ ...context, notifySecureSessionChange }),
  [MessageType.GrantPermissionAndCapture]: defineMessage({
    requestSchema: requestSchemas.grantPermissionAndCaptureRequestSchema,
    handle: (message: GrantPermissionAndCaptureMessage) => handleGrantPermissionAndCapture(message),
    respond: (result) => createCaptureResultMessage(result),
    fallback: () => createCaptureResultMessage({ status: 'failed', reason: 'unknown', message: 'Internal permission/capture error.' }),
  }),
} satisfies Record<DispatchedRequestType, MessageDef<ExtensionRequest, ExtensionResponse>>;

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isExtensionRequest(message)) return false;
  return dispatchRequest(messageRegistry, message, sendResponse, { sender });
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return false;
  if ((message as { type?: unknown }).type !== 'imageTrail.consumePreview') return false;
  const token = (message as { token?: unknown }).token;
  if (typeof token !== 'string') {
    sendResponse({ ok: false, reason: 'missing-token', message: 'Preview token is missing.' });
    return false;
  }
  const payload = takePreviewPayload(token);
  if (!payload) {
    sendResponse({ ok: false, reason: 'not-found', message: 'Preview expired or was not found.' });
    return false;
  }
  sendResponse({ ok: true, dataUrl: payload.dataUrl, byteLength: payload.byteLength, mediaInfo: payload.mediaInfo });
  return false;
});

chrome.action.onClicked.addListener((tab) => {
  const tabId = supportedTabId(tab);
  if (tabId === null) {
    console.warn('Image Trail can only be injected into http(s) pages.');
    return;
  }

  sendToggle(tabId).catch((error: unknown) => {
    console.warn('Image Trail could not toggle the in-page panel.', error);
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  const shortcutAction = BROWSER_COMMAND_ACTIONS.get(command);
  if (!shortcutAction && command !== TOGGLE_BUILD_IDENTITY_COMMAND) return;
  if (!tab) {
    console.warn('Image Trail command did not include an active tab.');
    return;
  }
  const tabId = supportedTabId(tab);
  if (tabId === null) {
    console.warn('Image Trail commands can only run on http(s) pages.');
    return;
  }

  if (shortcutAction) {
    sendShortcutAction(tabId, shortcutAction).catch((error: unknown) => {
      console.warn('Image Trail could not run the browser shortcut action.', error);
    });
    return;
  }

  sendToggleBuildIdentityOverlay(tabId).catch((error: unknown) => {
    console.warn('Image Trail could not toggle the build-info overlay.', error);
  });
});
