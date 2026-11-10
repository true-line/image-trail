import type { InteropCounts } from '../../core/interop/messages.js';
import { parseInteropEnvelope } from '../../core/interop/messages.js';
import { INTEROP_CONTRACT_VERSION, INTEROP_MAGIC } from '../../core/interop/contract.js';
import { EncryptedInteropTransport, type InteropObjectStore } from '../../core/interop/transport.js';
import { InteropRecordExportStore } from './record-export.js';
import { sealInteropMessage } from './sealed-message.js';
import { sealInteropBlob } from './sealed-blob.js';
import { SecureMoveOutboxRepository, type SecureMoveQueueItem } from './secure-move-outbox-repository.js';
import type { ActiveBlobKey } from '../crypto/blob-keyring.js';
import type { StoredInteropKeyRecord } from '../repositories/interop-keys-repository.js';
import type { StoredMoveJournal } from './move-journal-types.js';

export interface MoveOutboxProgress {
  readonly transferId: string;
  readonly journal: StoredMoveJournal;
  readonly counts: InteropCounts;
  readonly delivered: number;
  readonly pending: number;
}

interface MoveOutboxPublisherOptions {
  readonly now?: (() => string) | undefined;
  readonly createId?: (() => string) | undefined;
  readonly seal?: typeof sealInteropMessage | undefined;
  readonly sealBlob?: typeof sealInteropBlob | undefined;
}

export class MoveOutboxPublishError extends Error {
  override readonly name = 'MoveOutboxPublishError';

  constructor(
    message: string,
    readonly progress: MoveOutboxProgress,
    readonly sourceError: unknown,
  ) {
    super(message);
  }
}

export async function readMoveOutboxProgress(db: IDBDatabase, transferId: string, total: number): Promise<MoveOutboxProgress | null> {
  const stored = await new SecureMoveOutboxRepository(db).progress(transferId);
  if (!stored) return null;
  return {
    transferId,
    journal: stored.journal,
    counts: withUnsupported(stored.journal.counts, total),
    delivered: Math.max(0, stored.journal.counts.total - stored.pending),
    pending: stored.pending,
  };
}

function withUnsupported(counts: InteropCounts, total: number): InteropCounts {
  const unsupported = Math.max(0, total - counts.total);
  return { ...counts, total, unsupported: counts.unsupported + unsupported };
}

function outboxPath(sequence: number, messageId: string): string {
  return `messages/outbox/${String(sequence).padStart(12, '0')}-${messageId}.json.aesgcm`;
}

function originalPath(interopId: string): string {
  return `blobs/${interopId}/original.bin.aesgcm`;
}

export class MoveOutboxPublisher {
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #seal: typeof sealInteropMessage;
  readonly #sealBlob: typeof sealInteropBlob;

  constructor(
    private readonly db: IDBDatabase,
    private readonly store: InteropObjectStore,
    options: MoveOutboxPublisherOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#seal = options.seal ?? sealInteropMessage;
    this.#sealBlob = options.sealBlob ?? sealInteropBlob;
  }

  async start(input: {
    readonly transferId: string;
    readonly recordIds: readonly string[];
    readonly pairing: StoredInteropKeyRecord;
    readonly activeBlobKey?: ActiveBlobKey | null | undefined;
  }): Promise<MoveOutboxProgress> {
    const reviewed = await new InteropRecordExportStore(this.db, {
      now: this.#now,
      createId: this.#createId,
    }).review(input.recordIds, input.activeBlobKey ?? null);
    if (reviewed.records.length === 0) throw new Error('No supported Image Trail records were available for Move.');
    const outbox = new SecureMoveOutboxRepository(this.db);
    const createdAt = this.#now();
    let sequence = 0;
    const queued: SecureMoveQueueItem[] = [];
    const sensitive: Uint8Array[] = [];
    try {
      for (const item of reviewed.records) {
        sequence += 1;
        const recordMessageId = this.#createId();
        const envelope = parseInteropEnvelope({
          header: {
            magic: INTEROP_MAGIC,
            contractVersion: INTEROP_CONTRACT_VERSION,
            messageId: recordMessageId,
            transferId: input.transferId,
            pairingId: input.pairing.pairingId,
            sourceProduct: 'image-trail',
            targetProduct: 'overlook',
            operation: 'move',
            kind: 'record',
            createdAt,
            sequence,
          },
          payload: {
            kind: 'record',
            schemaVersion: 1,
            record: item.record,
            albums: item.albums,
            reviewCategory: item.reviewCategory,
          },
        });
        const ciphertext = await this.#seal(envelope, input.pairing);
        sensitive.push(ciphertext);
        const attachments = [];
        if (item.original) {
          sequence += 1;
          const blobMessageId = this.#createId();
          const encryptedPath = originalPath(item.record.identity.interopId);
          const blobEnvelope = parseInteropEnvelope({
            header: {
              ...envelope.header,
              messageId: blobMessageId,
              kind: 'blob',
              sequence,
            },
            payload: {
              kind: 'blob',
              schemaVersion: 1,
              recordInteropId: item.record.identity.interopId,
              role: 'original',
              blob: item.original.reference,
              encryptedPath,
              chunkIndex: 0,
              chunkCount: 1,
            },
          });
          const blobMessage = await this.#seal(blobEnvelope, input.pairing);
          sensitive.push(blobMessage);
          const encryptedBlob = await this.#sealBlob({
            pairing: input.pairing,
            transferId: input.transferId,
            recordInteropId: item.record.identity.interopId,
            blob: item.original.reference,
            bytes: item.original.bytes,
          });
          sensitive.push(encryptedBlob);
          attachments.push(
            {
              messageId: blobMessageId,
              sequence,
              path: outboxPath(sequence, blobMessageId),
              ciphertext: blobMessage,
            },
            {
              messageId: this.#createId(),
              sequence,
              path: encryptedPath,
              ciphertext: encryptedBlob,
              acknowledgementRequired: false,
            },
          );
        }
        queued.push({
          messageId: envelope.header.messageId,
          sequence: envelope.header.sequence,
          interopId: item.record.identity.interopId,
          sourceLocalId: item.localId,
          sourceUpdatedAt: item.sourceUpdatedAt,
          sourceFingerprint: item.sourceFingerprint,
          reviewCategory: item.reviewCategory,
          path: outboxPath(envelope.header.sequence, envelope.header.messageId),
          ciphertext,
          attachments,
        });
      }
      await outbox.queueBatch({
        pairingId: input.pairing.pairingId,
        transferId: input.transferId,
        items: queued,
        at: createdAt,
      });
    } finally {
      for (const bytes of sensitive) bytes.fill(0);
      for (const item of reviewed.records) item.original?.bytes.fill(0);
    }
    return this.publish(input.transferId, input.pairing, reviewed.requested);
  }

  async resume(transferId: string, pairing: StoredInteropKeyRecord, total: number): Promise<MoveOutboxProgress> {
    return this.publish(transferId, pairing, total);
  }

  async status(transferId: string, total: number): Promise<MoveOutboxProgress | null> {
    return readMoveOutboxProgress(this.db, transferId, total);
  }

  private async publish(transferId: string, pairing: StoredInteropKeyRecord, total: number): Promise<MoveOutboxProgress> {
    const outbox = new SecureMoveOutboxRepository(this.db);
    const initial = await outbox.progress(transferId);
    if (!initial || initial.journal.pairingId !== pairing.pairingId) {
      throw new Error('Move outbox does not match the selected pairing custody.');
    }
    const transport = new EncryptedInteropTransport(this.store);
    const pending = await outbox.pending(transferId);
    for (const message of pending) {
      try {
        const ciphertext = new Uint8Array(message.ciphertext.slice(0));
        try {
          await transport.upload({ pairingId: pairing.pairingId, transferId }, message.path, ciphertext);
        } finally {
          ciphertext.fill(0);
        }
        await outbox.markDelivered(message.messageId, this.#now());
      } catch (error) {
        const progress = await this.status(transferId, total);
        if (!progress) throw error;
        throw new MoveOutboxPublishError('Move outbox upload is incomplete and can be resumed.', progress, error);
      }
    }
    const progress = await this.status(transferId, total);
    if (!progress) throw new Error('Move journal disappeared after outbox publication.');
    return progress;
  }
}
