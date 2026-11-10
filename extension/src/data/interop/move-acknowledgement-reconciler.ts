import * as v from 'valibot';

import { interopUuidSchema } from '../../core/interop/contract.js';
import { parseInteropEnvelope } from '../../core/interop/messages.js';
import { EncryptedInteropTransport, InteropTransportError, type InteropObjectStore } from '../../core/interop/transport.js';
import type { StoredInteropKeyRecord } from '../repositories/interop-keys-repository.js';
import {
  isMoveAcknowledgementEnvelope,
  isMoveRecordEnvelope,
  type MoveAcknowledgementEnvelope,
  type MoveRecordEnvelope,
} from './move-journal-records.js';
import { readMoveOutboxProgress, type MoveOutboxProgress } from './move-outbox-publisher.js';
import { openInteropMessage } from './sealed-message.js';
import { SecureMoveAcknowledgementRepository } from './secure-move-acknowledgement-repository.js';
import { SecureMoveOutboxRepository, type SecureMoveItem } from './secure-move-outbox-repository.js';

export const MOVE_ACKNOWLEDGEMENT_PREFIX = 'messages/acknowledgements';

export function moveAcknowledgementPath(sequence: number, messageId: string): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Move acknowledgement sequence is invalid.');
  return `${MOVE_ACKNOWLEDGEMENT_PREFIX}/${String(sequence).padStart(12, '0')}-${v.parse(interopUuidSchema, messageId)}.json.aesgcm`;
}

export interface MoveSourceRecordFinalizer {
  finalize(sourceLocalId: string, sourceUpdatedAt: string, sourceFingerprint?: string): Promise<void>;
}

interface ReconcilerOptions {
  readonly now?: (() => string) | undefined;
  readonly open?: typeof openInteropMessage | undefined;
}

function corrupt(message: string): InteropTransportError {
  return new InteropTransportError(message, 'corrupt', false);
}

function expectedOriginalVerification(state: 'available' | 'metadata-only' | 'unavailable'): 'verified' | 'metadata-only' | 'unavailable' {
  return state === 'available' ? 'verified' : state;
}

export class MoveAcknowledgementReconciler {
  readonly #now: () => string;
  readonly #open: typeof openInteropMessage;

  constructor(
    private readonly db: IDBDatabase,
    private readonly store: InteropObjectStore,
    private readonly finalizer: MoveSourceRecordFinalizer,
    options: ReconcilerOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#open = options.open ?? openInteropMessage;
  }

  async reconcile(input: {
    readonly transferId: string;
    readonly total: number;
    readonly pairing: StoredInteropKeyRecord;
    readonly allowFinalization: boolean;
  }): Promise<MoveOutboxProgress> {
    const repository = new SecureMoveOutboxRepository(this.db);
    const acknowledgements = new SecureMoveAcknowledgementRepository(this.db);
    const initial = await repository.progress(input.transferId);
    if (!initial || initial.journal.pairingId !== input.pairing.pairingId) {
      throw new InteropTransportError('Move acknowledgement custody does not match the durable source journal.', 'corrupt', false);
    }
    const scope = { pairingId: input.pairing.pairingId, transferId: input.transferId };
    const transport = new EncryptedInteropTransport(this.store);
    for (const path of await transport.listPaths(scope, MOVE_ACKNOWLEDGEMENT_PREFIX)) {
      const sealed = await transport.download(scope, path);
      let acknowledgement;
      try {
        acknowledgement = await this.#open(sealed, input.pairing);
      } catch (error) {
        throw corrupt(error instanceof Error ? error.message : 'Encrypted Move acknowledgement could not be opened.');
      } finally {
        sealed.fill(0);
      }
      const verified = await this.verify(path, acknowledgement, input.transferId, input.pairing, repository);
      await acknowledgements.apply({
        acknowledgement: verified.acknowledgement,
        canFinalize: verified.canFinalize,
        at: this.#now(),
      });
    }
    if (input.allowFinalization) await this.finalizePending(input.transferId, acknowledgements);
    const progress = await readMoveOutboxProgress(this.db, input.transferId, input.total);
    if (!progress) throw new InteropTransportError('Move journal disappeared during acknowledgement recovery.', 'corrupt', false);
    return progress;
  }

  private async verify(
    path: string,
    envelopeInput: unknown,
    transferId: string,
    pairing: StoredInteropKeyRecord,
    repository: SecureMoveOutboxRepository,
  ): Promise<{ readonly acknowledgement: MoveAcknowledgementEnvelope; readonly canFinalize: boolean }> {
    const acknowledgement = parseInteropEnvelope(envelopeInput);
    if (acknowledgement.header.operation !== 'move' || !isMoveAcknowledgementEnvelope(acknowledgement)) {
      throw corrupt('Provider acknowledgement object is not a canonical Move acknowledgement.');
    }
    if (
      acknowledgement.header.pairingId !== pairing.pairingId ||
      acknowledgement.header.transferId !== transferId ||
      acknowledgement.header.sourceProduct !== 'overlook' ||
      acknowledgement.header.targetProduct !== 'image-trail' ||
      path !== moveAcknowledgementPath(acknowledgement.header.sequence, acknowledgement.header.messageId)
    ) {
      throw corrupt('Move acknowledgement crossed its authenticated provider scope.');
    }
    const item = await repository.item(acknowledgement.header.transferId, acknowledgement.payload.recordInteropId);
    if (!item) throw corrupt('Move acknowledgement does not match a reviewed source item.');
    const source = await this.openSource(item, pairing, repository);
    if (
      source.header.transferId !== acknowledgement.header.transferId ||
      source.header.pairingId !== acknowledgement.header.pairingId ||
      source.header.sequence !== acknowledgement.header.sequence ||
      source.payload.record.identity.interopId !== acknowledgement.payload.recordInteropId ||
      !(item.sourceMessageIds ?? [source.header.messageId]).every((messageId) =>
        acknowledgement.payload.acknowledgedMessageIds.includes(messageId),
      )
    ) {
      throw corrupt('Move acknowledgement does not cover the reviewed source message.');
    }
    if (acknowledgement.payload.status === 'accepted') {
      if (
        !acknowledgement.payload.metadataPersisted ||
        acknowledgement.payload.targetLocalId === null ||
        acknowledgement.payload.errors.length > 0 ||
        acknowledgement.payload.originalVerification !== expectedOriginalVerification(source.payload.record.original.state)
      ) {
        throw corrupt('Accepted Move acknowledgement did not prove durable target custody.');
      }
    }
    return {
      acknowledgement,
      canFinalize: acknowledgement.payload.status === 'accepted' && acknowledgement.payload.originalVerification !== 'metadata-only',
    };
  }

  private async openSource(
    item: SecureMoveItem,
    pairing: StoredInteropKeyRecord,
    repository: SecureMoveOutboxRepository,
  ): Promise<MoveRecordEnvelope> {
    const outbox = await repository.outboxMessage(item.sourceMessageId);
    if (!outbox || outbox.transferId !== item.transferId)
      throw corrupt('Move source ciphertext is unavailable for acknowledgement validation.');
    const sealed = new Uint8Array(outbox.ciphertext.slice(0));
    try {
      return this.requireRecordEnvelope(await this.#open(sealed, pairing));
    } catch (error) {
      if (error instanceof InteropTransportError) throw error;
      throw corrupt(error instanceof Error ? error.message : 'Move source ciphertext could not be opened.');
    } finally {
      sealed.fill(0);
    }
  }

  private requireRecordEnvelope(envelopeInput: unknown) {
    const envelope = parseInteropEnvelope(envelopeInput);
    if (envelope.header.operation !== 'move' || !isMoveRecordEnvelope(envelope)) {
      throw corrupt('Move source ciphertext is not a canonical record request.');
    }
    return envelope;
  }

  private async finalizePending(transferId: string, repository: SecureMoveAcknowledgementRepository): Promise<void> {
    for (const item of await repository.pendingFinalization(transferId)) {
      const at = this.#now();
      await repository.markFinalizing(transferId, item.interopId, at);
      try {
        await this.finalizer.finalize(item.sourceLocalId, item.sourceUpdatedAt, item.sourceFingerprint);
        await repository.markFinalized(transferId, item.interopId, this.#now());
      } catch (error) {
        await repository.markFinalizationFailed(
          transferId,
          item.interopId,
          { message: error instanceof Error ? error.message : 'Move source finalization failed.' },
          this.#now(),
        );
      }
    }
  }
}
