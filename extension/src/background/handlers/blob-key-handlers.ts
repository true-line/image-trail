import { activateFirstMatchingBlobKey, orderBlobKeysForUnlock } from '../../data/crypto/blob-key-unlock.js';
import {
  createAndActivateWrappedBlobKey,
  didBlobKeySessionRestoreFail,
  getActiveBlobKey,
  getBlobKeySessionSnapshot,
  lockBlobKey,
  recordBlobKeyActivity,
  restoreActiveBlobKey,
} from '../../data/crypto/blob-keyring.js';
import type { StoredKeyRecord } from '../../data/crypto/types.js';
import { DEFAULT_LOCAL_SETTINGS } from '../../data/local-settings.js';
import { exportStoredKeyBackupWithPassword, importStoredKeyBackupWithPassword } from '../../data/import-export/key-backup.js';
import { KeysRepository } from '../../data/repositories/keys-repository.js';
import { defineMessage, type MessageDef } from '../message-dispatch.js';
import * as requestSchemas from '../message-schemas.js';
import {
  MessageType,
  createBlobKeyResultMessage,
  createBlobKeyStatusResultMessage,
  createExportBlobKeyBackupResultMessage,
  createImportBlobKeyBackupResultMessage,
  type BlobKeyResultMessage,
  type BlobKeyActivityMessage,
  type BlobKeyStatusMessage,
  type BlobKeyStatusResultMessage,
  type ClearBlobKeyMessage,
  type ExportBlobKeyBackupMessage,
  type ExportBlobKeyBackupResultMessage,
  type ExtensionRequest,
  type ExtensionResponse,
  type ImportBlobKeyBackupMessage,
  type ImportBlobKeyBackupResultMessage,
  type LockBlobKeyMessage,
  type SetupBlobKeyMessage,
  type UnlockBlobKeyMessage,
} from '../messages.js';
import type { ServiceWorkerContext } from '../service-worker-context.js';
import { noopSecureSessionChangeNotifier, type SecureSessionChangeNotifier } from '../secure-session-change-notifier.js';

type BlobKeyRequestType =
  | typeof MessageType.BlobKeyStatus
  | typeof MessageType.SetupBlobKey
  | typeof MessageType.UnlockBlobKey
  | typeof MessageType.LockBlobKey
  | typeof MessageType.BlobKeyActivity
  | typeof MessageType.ClearBlobKey
  | typeof MessageType.ExportBlobKeyBackup
  | typeof MessageType.ImportBlobKeyBackup;

export type BlobKeyMessageHandlerDeps = Pick<ServiceWorkerContext, 'getDb'> & {
  readonly loadLocalSettings?: ServiceWorkerContext['loadLocalSettings'] | undefined;
  readonly notifySecureSessionChange?: SecureSessionChangeNotifier | undefined;
};

function isStoredBlobKey(record: StoredKeyRecord | undefined): record is StoredKeyRecord<'blob'> {
  return record?.kind === 'blob';
}

function latestKeyByCreatedAt(keys: readonly StoredKeyRecord[]): StoredKeyRecord | undefined {
  return keys.reduce<StoredKeyRecord | undefined>((latest, key) => (!latest || key.createdAt > latest.createdAt ? key : latest), undefined);
}

export function createBlobKeyMessageRegistry({
  getDb,
  loadLocalSettings,
  notifySecureSessionChange = noopSecureSessionChangeNotifier,
}: BlobKeyMessageHandlerDeps): Record<BlobKeyRequestType, MessageDef<ExtensionRequest, ExtensionResponse>> {
  const loadSettings = loadLocalSettings ?? (async () => DEFAULT_LOCAL_SETTINGS);

  async function handleBlobKeyStatus(): Promise<BlobKeyStatusResultMessage['payload']> {
    const activeBlobKey = await restoreActiveBlobKey();
    if (activeBlobKey) {
      return { unlocked: true, keyReference: activeBlobKey.reference.reference, hasKey: true };
    }
    const db = await getDb();
    if (!db) return { unlocked: false, keyReference: null, hasKey: false };
    const blobKeys = await new KeysRepository(db).listByKind('blob');
    const hasKey = blobKeys.length > 0;
    const snapshot = getBlobKeySessionSnapshot();
    const reason = hasKey
      ? snapshot.status === 'locked' && snapshot.reason
        ? snapshot.reason
        : didBlobKeySessionRestoreFail()
          ? 'worker-restart'
          : undefined
      : undefined;
    const message =
      reason === 'timeout'
        ? 'Encrypted storage locked after the configured inactivity period. Unlock to continue.'
        : reason === 'worker-restart'
          ? 'Encrypted storage locked because the extension worker restarted. Unlock to continue.'
          : reason === 'manual'
            ? 'Encrypted storage locked.'
            : undefined;
    const locked = { unlocked: false as const, keyReference: null, hasKey };
    return reason && message ? { ...locked, reason, message } : locked;
  }

  async function handleSetupBlobKey(message: SetupBlobKeyMessage): Promise<BlobKeyResultMessage['payload']> {
    const password = message.payload.password.trim();
    if (!password) return { ok: false, reason: 'empty-password', message: 'Enter a password to set up encrypted blob storage.' };
    const db = await getDb();
    if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
    const timeoutMinutes = (await loadSettings()).blobKeyInactivityTimeoutMinutes;
    const wrapped = await createAndActivateWrappedBlobKey({ password, timeoutMinutes });
    await new KeysRepository(db).put(wrapped.metadata);
    return {
      ok: true,
      keyReference: wrapped.metadata.reference,
      message: `Encrypted blob storage unlocked with ${wrapped.metadata.reference}.`,
    };
  }

  async function handleUnlockBlobKey(message: UnlockBlobKeyMessage): Promise<BlobKeyResultMessage['payload']> {
    const password = message.payload.password.trim();
    if (!password) return { ok: false, reason: 'empty-password', message: 'Enter a password to unlock encrypted blob storage.' };
    const db = await getDb();
    if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
    const keys = new KeysRepository(db);
    const requested = message.payload.keyReference ? await keys.get(message.payload.keyReference) : undefined;
    const candidates = isStoredBlobKey(requested)
      ? [requested]
      : orderBlobKeysForUnlock((await keys.listByKind('blob')).filter(isStoredBlobKey));
    if (candidates.length === 0) {
      return { ok: false, reason: 'missing-key', message: 'No encrypted blob key exists. Set up encrypted storage first.' };
    }
    const timeoutMinutes = (await loadSettings()).blobKeyInactivityTimeoutMinutes;
    const blobKey = await activateFirstMatchingBlobKey(candidates, password, timeoutMinutes);
    if (!blobKey) return { ok: false, reason: 'wrong-password', message: 'Password did not unlock encrypted storage.' };
    return { ok: true, keyReference: blobKey.reference, message: `Encrypted blob storage unlocked with ${blobKey.reference}.` };
  }

  async function handleLockBlobKey(): Promise<BlobKeyResultMessage['payload']> {
    await lockBlobKey('manual');
    return { ok: true, keyReference: '', message: 'Encrypted storage locked.' };
  }

  async function handleBlobKeyActivity(): Promise<BlobKeyStatusResultMessage['payload']> {
    if (await recordBlobKeyActivity()) {
      const active = getActiveBlobKey();
      if (active) return { unlocked: true, keyReference: active.reference.reference, hasKey: true };
    }
    return handleBlobKeyStatus();
  }

  async function handleClearBlobKey(): Promise<BlobKeyResultMessage['payload']> {
    await lockBlobKey();
    const db = await getDb();
    if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
    const keys = new KeysRepository(db);
    const blobKeys = await keys.listByKind('blob');
    for (const key of blobKeys) {
      await keys.remove(key.reference);
    }
    notifySecureSessionChange({ unlocked: false, keyReference: null, hasKey: false });
    return { ok: true, keyReference: '', message: 'Encrypted blob key cleared. Import a key backup to recover encrypted originals.' };
  }

  async function handleExportBlobKeyBackup(message: ExportBlobKeyBackupMessage): Promise<ExportBlobKeyBackupResultMessage['payload']> {
    const password = message.payload.password.trim();
    if (!password) return { ok: false, reason: 'empty-password', message: 'Enter a password to export a key backup.' };
    const db = await getDb();
    if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
    const keys = new KeysRepository(db);
    const blobKey = message.payload.keyReference
      ? await keys.get(message.payload.keyReference)
      : latestKeyByCreatedAt(await keys.listByKind('blob'));
    if (!isStoredBlobKey(blobKey)) {
      return { ok: false, reason: 'missing-key', message: 'No encrypted blob key exists to back up.' };
    }
    const result = await exportStoredKeyBackupWithPassword(blobKey, password);
    if (!result.status.ok || !result.fileContent || !result.fileName) {
      return { ok: false, reason: result.status.code, message: result.status.message };
    }
    return {
      ok: true,
      keyReference: blobKey.reference,
      fileContent: result.fileContent,
      fileName: result.fileName,
      message: result.status.message,
    };
  }

  async function handleImportBlobKeyBackup(message: ImportBlobKeyBackupMessage): Promise<ImportBlobKeyBackupResultMessage['payload']> {
    const password = message.payload.password.trim();
    if (!password) return { ok: false, reason: 'empty-password', message: 'Enter a password to import a key backup.' };
    const db = await getDb();
    if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
    const result = await importStoredKeyBackupWithPassword(message.payload.fileContent, password);
    if (!result.status.ok || !result.record) {
      return { ok: false, reason: result.status.code, message: result.status.message };
    }
    if (!isStoredBlobKey(result.record)) {
      return { ok: false, reason: 'unsupported-key', message: 'Only blob key backups can be imported here.' };
    }
    const keys = new KeysRepository(db);
    if (await keys.get(result.record.reference)) {
      return {
        ok: true,
        keyReference: result.record.reference,
        imported: false,
        message: `Key backup already exists for ${result.record.reference}.`,
      };
    }
    await keys.put({ ...result.record, importedAt: new Date().toISOString() });
    notifySecureSessionChange({ unlocked: false, keyReference: null, hasKey: true });
    return {
      ok: true,
      keyReference: result.record.reference,
      imported: true,
      message: `Imported key backup for ${result.record.reference}.`,
    };
  }

  return {
    [MessageType.BlobKeyStatus]: defineMessage({
      requestSchema: requestSchemas.emptyPayloadSchema,
      handle: (_message: BlobKeyStatusMessage) => handleBlobKeyStatus(),
      respond: (result) => createBlobKeyStatusResultMessage(result),
      fallback: () => createBlobKeyStatusResultMessage({ unlocked: false, keyReference: null, hasKey: false }),
    }),
    [MessageType.SetupBlobKey]: defineMessage({
      requestSchema: requestSchemas.setupBlobKeyRequestSchema,
      handle: (message: SetupBlobKeyMessage) => handleSetupBlobKey(message),
      respond: (result) => createBlobKeyResultMessage(result),
      fallback: () => createBlobKeyResultMessage({ ok: false, reason: 'unknown', message: 'Blob key setup failed.' }),
    }),
    [MessageType.UnlockBlobKey]: defineMessage({
      requestSchema: requestSchemas.unlockBlobKeyRequestSchema,
      handle: (message: UnlockBlobKeyMessage) => handleUnlockBlobKey(message),
      respond: (result) => createBlobKeyResultMessage(result),
      fallback: () => createBlobKeyResultMessage({ ok: false, reason: 'unknown', message: 'Blob key unlock failed.' }),
    }),
    [MessageType.LockBlobKey]: defineMessage({
      requestSchema: requestSchemas.emptyPayloadSchema,
      handle: (_message: LockBlobKeyMessage) => handleLockBlobKey(),
      respond: (result) => createBlobKeyResultMessage(result),
      fallback: () => createBlobKeyResultMessage({ ok: false, reason: 'unknown', message: 'Blob key lock failed.' }),
    }),
    [MessageType.BlobKeyActivity]: defineMessage({
      requestSchema: requestSchemas.emptyPayloadSchema,
      handle: (_message: BlobKeyActivityMessage) => handleBlobKeyActivity(),
      respond: (result) => createBlobKeyStatusResultMessage(result),
      fallback: () => createBlobKeyStatusResultMessage({ unlocked: false, keyReference: null, hasKey: false }),
    }),
    [MessageType.ClearBlobKey]: defineMessage({
      requestSchema: requestSchemas.emptyPayloadSchema,
      handle: (_message: ClearBlobKeyMessage) => handleClearBlobKey(),
      respond: (result) => createBlobKeyResultMessage(result),
      fallback: () => createBlobKeyResultMessage({ ok: false, reason: 'unknown', message: 'Blob key clear failed.' }),
    }),
    [MessageType.ExportBlobKeyBackup]: defineMessage({
      requestSchema: requestSchemas.exportBlobKeyBackupRequestSchema,
      handle: (message: ExportBlobKeyBackupMessage) => handleExportBlobKeyBackup(message),
      respond: (result) => createExportBlobKeyBackupResultMessage(result),
      fallback: () => createExportBlobKeyBackupResultMessage({ ok: false, reason: 'unknown', message: 'Key backup export failed.' }),
    }),
    [MessageType.ImportBlobKeyBackup]: defineMessage({
      requestSchema: requestSchemas.importBlobKeyBackupRequestSchema,
      handle: (message: ImportBlobKeyBackupMessage) => handleImportBlobKeyBackup(message),
      respond: (result) => createImportBlobKeyBackupResultMessage(result),
      fallback: () => createImportBlobKeyBackupResultMessage({ ok: false, reason: 'unknown', message: 'Key backup import failed.' }),
    }),
  };
}
