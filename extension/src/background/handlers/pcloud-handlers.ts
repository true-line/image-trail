import { defineMessage, type MessageDef } from '../message-dispatch.js';
import * as requestSchemas from '../message-schemas.js';
import {
  MessageType,
  createConnectPCloudProviderResultMessage,
  createDisconnectPCloudProviderResultMessage,
  createDownloadPCloudBackupResultMessage,
  createListPCloudBackupsResultMessage,
  createPCloudProviderStatusResultMessage,
  createUploadPCloudBackupResultMessage,
  type ConnectPCloudProviderMessage,
  type DisconnectPCloudProviderMessage,
  type DownloadPCloudBackupMessage,
  type ExtensionRequest,
  type ExtensionResponse,
  type ListPCloudBackupsMessage,
  type PCloudProviderStatusMessage,
  type UploadPCloudBackupMessage,
} from '../messages.js';
import {
  connectPCloudProvider,
  disconnectPCloudProvider,
  downloadPCloudBackup,
  listPCloudBackups,
  loadPCloudProviderStatus,
  uploadPCloudBackup,
} from '../pcloud-provider.js';
import { PCLOUD_BUILD_CONFIG } from '../pcloud-build-config.js';
import { PCLOUD_HOST_PERMISSION, requestHostPermission } from '../permissions.js';
import { createChromeInteropRuntime, preflightChromeInteropAction } from '../interop-runtime-chrome.js';
import type { LibraryChangeNotifier } from '../library-change-notifier.js';
import { finalizeInteropMoveSource } from '../../data/interop/move-source-finalizer.js';
import { createDisabledInteropRuntimeMessageRegistry, createInteropRuntimeMessageRegistry } from './interop-runtime-handlers.js';

declare const __IMAGE_TRAIL_INTEROP_ENABLED__: boolean | undefined;
const transferSyncEnabled = typeof __IMAGE_TRAIL_INTEROP_ENABLED__ === 'boolean' && __IMAGE_TRAIL_INTEROP_ENABLED__;

async function connectPCloudWithPermission(): ReturnType<typeof connectPCloudProvider> {
  if (!PCLOUD_BUILD_CONFIG.enabled) return connectPCloudProvider();
  const granted = await requestHostPermission(PCLOUD_HOST_PERMISSION);
  if (granted) return connectPCloudProvider();
  const message = 'pCloud access was not granted. Connect again to approve access only to pCloud hosts.';
  return { ok: false, status: { connected: false, message, messageIsError: true }, message };
}

async function openInteropPairingImport(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/interop-pairing/import.html') });
}

type PCloudRequestType =
  | typeof MessageType.PCloudProviderStatus
  | typeof MessageType.ConnectPCloudProvider
  | typeof MessageType.DisconnectPCloudProvider
  | typeof MessageType.UploadPCloudBackup
  | typeof MessageType.ListPCloudBackups
  | typeof MessageType.DownloadPCloudBackup;

export function createPCloudMessageRegistry(): Record<PCloudRequestType, MessageDef<ExtensionRequest, ExtensionResponse>> {
  return {
    [MessageType.PCloudProviderStatus]: defineMessage({
      requestSchema: requestSchemas.emptyPayloadSchema,
      handle: (_message: PCloudProviderStatusMessage) => loadPCloudProviderStatus(),
      respond: (result) => createPCloudProviderStatusResultMessage(result),
      fallback: () => createPCloudProviderStatusResultMessage({ connected: false, message: 'pCloud status could not be loaded.' }),
    }),
    [MessageType.ConnectPCloudProvider]: defineMessage({
      requestSchema: requestSchemas.emptyPayloadSchema,
      handle: (_message: ConnectPCloudProviderMessage) => connectPCloudWithPermission(),
      respond: (result) => createConnectPCloudProviderResultMessage(result),
      fallback: () =>
        createConnectPCloudProviderResultMessage({
          ok: false,
          status: { connected: false, message: 'pCloud connection failed.' },
          message: 'pCloud connection failed.',
        }),
    }),
    [MessageType.DisconnectPCloudProvider]: defineMessage({
      requestSchema: requestSchemas.emptyPayloadSchema,
      handle: (_message: DisconnectPCloudProviderMessage) => disconnectPCloudProvider(),
      respond: (result) => createDisconnectPCloudProviderResultMessage(result),
      fallback: () =>
        createDisconnectPCloudProviderResultMessage({
          ok: false,
          status: { connected: false, message: 'pCloud disconnect failed.' },
          message: 'pCloud disconnect failed.',
        }),
    }),
    [MessageType.UploadPCloudBackup]: defineMessage({
      requestSchema: requestSchemas.uploadPCloudBackupRequestSchema,
      handle: (message: UploadPCloudBackupMessage) => uploadPCloudBackup(message.payload),
      respond: (result) => createUploadPCloudBackupResultMessage(result),
      fallback: (message) => {
        const operationMessage = message.payload.operation === 'cleanup' ? 'pCloud backup cleanup failed.' : 'pCloud backup upload failed.';
        const base = {
          ok: false as const,
          status: { connected: false, message: operationMessage, messageIsError: true },
          reason: 'upload-failed',
          message: operationMessage,
        };
        return createUploadPCloudBackupResultMessage(
          message.payload.operation === 'cleanup' ? { ...base, deletedFileIds: [], failedFileIds: message.payload.fileIds } : base,
        );
      },
    }),
    [MessageType.ListPCloudBackups]: defineMessage({
      requestSchema: requestSchemas.emptyPayloadSchema,
      handle: (_message: ListPCloudBackupsMessage) => listPCloudBackups(),
      respond: (result) => createListPCloudBackupsResultMessage(result),
      fallback: () =>
        createListPCloudBackupsResultMessage({
          ok: false,
          status: { connected: false, message: 'pCloud backups could not be listed.', messageIsError: true },
          reason: 'list-failed',
          message: 'pCloud backups could not be listed.',
        }),
    }),
    [MessageType.DownloadPCloudBackup]: defineMessage({
      requestSchema: requestSchemas.downloadPCloudBackupRequestSchema,
      handle: (message: DownloadPCloudBackupMessage) => downloadPCloudBackup(message.payload),
      respond: (result) => createDownloadPCloudBackupResultMessage(result),
      fallback: () =>
        createDownloadPCloudBackupResultMessage({
          ok: false,
          status: { connected: false, message: 'pCloud backup could not be downloaded.', messageIsError: true },
          reason: 'download-failed',
          message: 'pCloud backup could not be downloaded.',
        }),
    }),
  };
}

export function createCloudMessageRegistry(
  getDb: () => Promise<IDBDatabase | null>,
  finalizeSourceRecord?: ((sourceLocalId: string, sourceUpdatedAt: string, sourceFingerprint?: string) => Promise<void>) | undefined,
): Record<PCloudRequestType | typeof MessageType.InteropRuntime, MessageDef<ExtensionRequest, ExtensionResponse>> {
  return {
    ...createPCloudMessageRegistry(),
    ...(transferSyncEnabled
      ? createInteropRuntimeMessageRegistry(
          createChromeInteropRuntime(getDb, finalizeSourceRecord),
          preflightChromeInteropAction,
          openInteropPairingImport,
        )
      : createDisabledInteropRuntimeMessageRegistry()),
  };
}

export function createInteropSourceFinalizer(
  getDb: () => Promise<IDBDatabase | null>,
  notifyLibraryChange: LibraryChangeNotifier,
): (sourceLocalId: string, sourceUpdatedAt: string, sourceFingerprint?: string) => Promise<void> {
  return async (sourceLocalId, sourceUpdatedAt, sourceFingerprint) => {
    const db = await getDb();
    if (!db) throw new Error('Move source storage is unavailable.');
    if (await finalizeInteropMoveSource(db, sourceLocalId, sourceUpdatedAt, sourceFingerprint)) {
      notifyLibraryChange({ topic: 'bookmarks', reason: 'bookmarks-removed', recordIds: [sourceLocalId] });
    }
  };
}
