import {
  portableStoredBlobRecord,
  storedBlobRecordFromPortable,
  type PortableStoredBlobRecord,
} from '../../data/import-export/full-backup.js';
import { BlobsRepository } from '../../data/repositories/blobs-repository.js';
import { defineMessage, type MessageDef } from '../message-dispatch.js';
import * as requestSchemas from '../message-schemas.js';
import {
  MessageType,
  createCheckOriginalBlobsResultMessage,
  createExportOriginalBlobsResultMessage,
  createImportOriginalBlobsResultMessage,
  type CheckOriginalBlobsMessage,
  type CheckOriginalBlobsResultMessage,
  type ExportOriginalBlobsMessage,
  type ExportOriginalBlobsResultMessage,
  type ExtensionRequest,
  type ExtensionResponse,
  type ImportOriginalBlobsMessage,
  type ImportOriginalBlobsResultMessage,
} from '../messages.js';
import type { ServiceWorkerContext } from '../service-worker-context.js';

type OriginalBlobRequestType =
  typeof MessageType.CheckOriginalBlobs | typeof MessageType.ExportOriginalBlobs | typeof MessageType.ImportOriginalBlobs;

export type OriginalBlobMessageHandlerDeps = Pick<ServiceWorkerContext, 'getDb'>;

export function createOriginalBlobMessageRegistry({
  getDb,
}: OriginalBlobMessageHandlerDeps): Record<OriginalBlobRequestType, MessageDef<ExtensionRequest, ExtensionResponse>> {
  async function handleCheckOriginalBlobs(message: CheckOriginalBlobsMessage): Promise<CheckOriginalBlobsResultMessage['payload']> {
    const db = await getDb();
    if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
    return { ok: true, missingBlobIds: await new BlobsRepository(db).findMissingOriginalIds(message.payload.blobIds) };
  }

  async function handleExportOriginalBlobs(message: ExportOriginalBlobsMessage): Promise<ExportOriginalBlobsResultMessage['payload']> {
    const db = await getDb();
    if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
    const blobs = new BlobsRepository(db);
    const records: PortableStoredBlobRecord[] = [];
    const missingBlobIds: string[] = [];
    for (const blobId of [...new Set(message.payload.blobIds)]) {
      const record = await blobs.get(blobId);
      if (record?.kind === 'original') records.push(portableStoredBlobRecord(record));
      else missingBlobIds.push(blobId);
    }
    return { ok: true, records, missingBlobIds };
  }

  async function handleImportOriginalBlobs(message: ImportOriginalBlobsMessage): Promise<ImportOriginalBlobsResultMessage['payload']> {
    const db = await getDb();
    if (!db) return { ok: false, reason: 'db-unavailable', message: 'Database unavailable.' };
    const blobs = new BlobsRepository(db);
    try {
      // Convert first and store in one transaction: a bad or unstorable record leaves nothing behind,
      // so a failed batch never has originals the caller was not told about.
      const records = message.payload.records.filter((record) => record.kind === 'original').map(storedBlobRecordFromPortable);
      // An id that is already stored keeps its bytes: a stale or foreign backup never replaces them.
      const { stored, kept } = await blobs.restoreKeepingExisting(records);
      return { ok: true, importedCount: stored, skippedCount: kept };
    } catch {
      return { ok: false, reason: 'invalid-original', message: 'Encrypted original backup payload was invalid.' };
    }
  }

  return {
    [MessageType.CheckOriginalBlobs]: defineMessage({
      requestSchema: requestSchemas.checkOriginalBlobsRequestSchema,
      handle: (message: CheckOriginalBlobsMessage) => handleCheckOriginalBlobs(message),
      respond: (result) => createCheckOriginalBlobsResultMessage(result),
      fallback: () => createCheckOriginalBlobsResultMessage({ ok: false, reason: 'unknown', message: 'Encrypted original check failed.' }),
    }),
    [MessageType.ExportOriginalBlobs]: defineMessage({
      requestSchema: requestSchemas.exportOriginalBlobsRequestSchema,
      handle: (message: ExportOriginalBlobsMessage) => handleExportOriginalBlobs(message),
      respond: (result) => createExportOriginalBlobsResultMessage(result),
      fallback: () =>
        createExportOriginalBlobsResultMessage({ ok: false, reason: 'unknown', message: 'Encrypted originals export failed.' }),
    }),
    [MessageType.ImportOriginalBlobs]: defineMessage({
      requestSchema: requestSchemas.importOriginalBlobsRequestSchema,
      handle: (message: ImportOriginalBlobsMessage) => handleImportOriginalBlobs(message),
      respond: (result) => createImportOriginalBlobsResultMessage(result),
      fallback: () =>
        createImportOriginalBlobsResultMessage({ ok: false, reason: 'unknown', message: 'Encrypted originals import failed.' }),
    }),
  };
}
