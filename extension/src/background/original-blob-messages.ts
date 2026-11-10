import type { PortableStoredBlobRecord } from '../data/import-export/full-backup.js';
import { MESSAGE_PROTOCOL_VERSION, MessageType, hasVersionedObjectShape } from './message-protocol.js';

export interface CheckOriginalBlobsMessage {
  readonly type: typeof MessageType.CheckOriginalBlobs;
  readonly version: typeof MESSAGE_PROTOCOL_VERSION;
  readonly payload: { readonly blobIds: readonly string[] };
}

export interface CheckOriginalBlobsResultMessage {
  readonly type: typeof MessageType.CheckOriginalBlobsResult;
  readonly version: typeof MESSAGE_PROTOCOL_VERSION;
  readonly payload:
    | { readonly ok: true; readonly missingBlobIds: readonly string[] }
    | { readonly ok: false; readonly reason: string; readonly message: string };
}

export interface ExportOriginalBlobsMessage {
  readonly type: typeof MessageType.ExportOriginalBlobs;
  readonly version: typeof MESSAGE_PROTOCOL_VERSION;
  readonly payload: { readonly blobIds: readonly string[] };
}

export interface ExportOriginalBlobsResultMessage {
  readonly type: typeof MessageType.ExportOriginalBlobsResult;
  readonly version: typeof MESSAGE_PROTOCOL_VERSION;
  readonly payload:
    | {
        readonly ok: true;
        readonly records: readonly PortableStoredBlobRecord[];
        readonly missingBlobIds: readonly string[];
      }
    | { readonly ok: false; readonly reason: string; readonly message: string };
}

export interface ImportOriginalBlobsMessage {
  readonly type: typeof MessageType.ImportOriginalBlobs;
  readonly version: typeof MESSAGE_PROTOCOL_VERSION;
  readonly payload: { readonly records: readonly PortableStoredBlobRecord[] };
}

export interface ImportOriginalBlobsResultMessage {
  readonly type: typeof MessageType.ImportOriginalBlobsResult;
  readonly version: typeof MESSAGE_PROTOCOL_VERSION;
  readonly payload:
    | { readonly ok: true; readonly importedCount: number; readonly skippedCount: number }
    | { readonly ok: false; readonly reason: string; readonly message: string };
}

export type OriginalBlobRequest = CheckOriginalBlobsMessage | ExportOriginalBlobsMessage | ImportOriginalBlobsMessage;
export type OriginalBlobResponse = CheckOriginalBlobsResultMessage | ExportOriginalBlobsResultMessage | ImportOriginalBlobsResultMessage;

export function createCheckOriginalBlobsMessage(blobIds: readonly string[]): CheckOriginalBlobsMessage {
  return { type: MessageType.CheckOriginalBlobs, version: MESSAGE_PROTOCOL_VERSION, payload: { blobIds } };
}

export function createCheckOriginalBlobsResultMessage(
  payload: CheckOriginalBlobsResultMessage['payload'],
): CheckOriginalBlobsResultMessage {
  return { type: MessageType.CheckOriginalBlobsResult, version: MESSAGE_PROTOCOL_VERSION, payload };
}

export function createExportOriginalBlobsMessage(blobIds: readonly string[]): ExportOriginalBlobsMessage {
  return { type: MessageType.ExportOriginalBlobs, version: MESSAGE_PROTOCOL_VERSION, payload: { blobIds } };
}

export function createExportOriginalBlobsResultMessage(
  payload: ExportOriginalBlobsResultMessage['payload'],
): ExportOriginalBlobsResultMessage {
  return { type: MessageType.ExportOriginalBlobsResult, version: MESSAGE_PROTOCOL_VERSION, payload };
}

export function createImportOriginalBlobsMessage(records: readonly PortableStoredBlobRecord[]): ImportOriginalBlobsMessage {
  return { type: MessageType.ImportOriginalBlobs, version: MESSAGE_PROTOCOL_VERSION, payload: { records } };
}

export function createImportOriginalBlobsResultMessage(
  payload: ImportOriginalBlobsResultMessage['payload'],
): ImportOriginalBlobsResultMessage {
  return { type: MessageType.ImportOriginalBlobsResult, version: MESSAGE_PROTOCOL_VERSION, payload };
}

export function isCheckOriginalBlobsResultMessage(value: unknown): value is CheckOriginalBlobsResultMessage {
  return hasVersionedObjectShape(value) && value.type === MessageType.CheckOriginalBlobsResult;
}

export function isExportOriginalBlobsResultMessage(value: unknown): value is ExportOriginalBlobsResultMessage {
  return hasVersionedObjectShape(value) && value.type === MessageType.ExportOriginalBlobsResult;
}

export function isImportOriginalBlobsResultMessage(value: unknown): value is ImportOriginalBlobsResultMessage {
  return hasVersionedObjectShape(value) && value.type === MessageType.ImportOriginalBlobsResult;
}
