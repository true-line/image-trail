import * as v from 'valibot';

import type { InteropReviewCategory } from '../../core/interop/contract.js';
import type { InteropCounts } from '../../core/interop/messages.js';
import { requestToPromise, transactionDone } from '../idb-helpers.js';
import { DataStore, SchemaIndex } from '../schema.js';
import { hydrateRecord, hydrateRecords } from '../repositories/hydration.js';
import { moveItemId, moveJournalRecordSchema, type MoveJournalRecord, type StoredMoveJournal } from './move-journal-types.js';

const timestampSchema = v.pipe(v.string(), v.isoTimestamp());

export const secureMoveItemSchema = v.object({
  id: v.string(),
  transferId: v.string(),
  interopId: v.string(),
  sourceMessageId: v.string(),
  sourceMessageIds: v.optional(v.array(v.string())),
  sourceLocalId: v.string(),
  sourceUpdatedAt: v.optional(timestampSchema),
  sourceFingerprint: v.optional(v.string()),
  reviewCategory: v.picklist(['eligible', 'duplicate', 'conflict', 'metadata-only', 'unsupported', 'skipped']),
  state: v.picklist(['queued', 'acknowledged', 'finalizing', 'finalized', 'rejected', 'failed']),
  targetLocalId: v.optional(v.nullable(v.string())),
  metadataPersisted: v.optional(v.boolean()),
  originalVerification: v.optional(v.picklist(['pending', 'verified', 'metadata-only', 'unavailable'])),
  acknowledgementMessageId: v.optional(v.nullable(v.string())),
  acknowledgedMessageIds: v.optional(v.array(v.string())),
  error: v.optional(v.unknown()),
  acknowledgedAt: v.nullable(timestampSchema),
  finalizedAt: v.nullable(timestampSchema),
});

const secureMoveOutboxSchema = v.object({
  messageId: v.string(),
  transferId: v.string(),
  interopId: v.optional(v.string()),
  sequence: v.number(),
  path: v.string(),
  ciphertext: v.instance(ArrayBuffer),
  createdAt: timestampSchema,
  deliveredAt: v.nullable(timestampSchema),
});

export type SecureMoveItem = v.InferOutput<typeof secureMoveItemSchema>;
export type SecureMoveOutboxRecord = v.InferOutput<typeof secureMoveOutboxSchema>;

export interface SecureMoveQueueItem {
  readonly messageId: string;
  readonly sequence: number;
  readonly interopId: string;
  readonly sourceLocalId: string;
  readonly sourceUpdatedAt: string;
  readonly sourceFingerprint: string;
  readonly reviewCategory: InteropReviewCategory;
  readonly path: string;
  readonly ciphertext: Uint8Array;
  readonly attachments?: readonly SecureMoveQueueMessage[] | undefined;
}

export interface SecureMoveQueueMessage {
  readonly messageId: string;
  readonly sequence: number;
  readonly path: string;
  readonly ciphertext: Uint8Array;
  readonly acknowledgementRequired?: boolean | undefined;
}

const STORES = [DataStore.MoveJournals, DataStore.MoveItems, DataStore.MoveOutbox, DataStore.MoveAudit];

export function acknowledged(item: SecureMoveItem): boolean {
  return item.acknowledgedAt !== null;
}

export function finalizable(item: SecureMoveItem): item is SecureMoveItem & { readonly sourceUpdatedAt: string } {
  return (
    acknowledged(item) && item.sourceUpdatedAt !== undefined && item.originalVerification !== 'metadata-only' && item.finalizedAt === null
  );
}

export function phaseFor(items: readonly SecureMoveItem[]): MoveJournalRecord['phase'] {
  if (items.some((item) => item.state === 'failed' || item.state === 'rejected')) return 'failed';
  if (items.some((item) => item.state === 'finalizing')) return 'finalizing';
  if (items.some((item) => item.state === 'queued')) return 'awaiting-acknowledgement';
  if (items.length > 0 && items.every((item) => item.state === 'finalized')) return 'completed';
  return 'acknowledged';
}

function countsFor(items: readonly SecureMoveItem[]): InteropCounts {
  const counts: InteropCounts = {
    total: items.length,
    eligible: 0,
    duplicate: 0,
    conflict: 0,
    metadataOnly: 0,
    unsupported: 0,
    skipped: 0,
    failed: 0,
    acknowledged: 0,
    finalized: 0,
  };
  for (const item of items) counts[item.reviewCategory === 'metadata-only' ? 'metadataOnly' : item.reviewCategory] += 1;
  for (const item of items) {
    if (item.state === 'failed' || item.state === 'rejected') counts.failed += 1;
    if (acknowledged(item)) counts.acknowledged += 1;
    if (item.finalizedAt !== null) counts.finalized += 1;
  }
  return counts;
}

export async function secureMoveItemsIn(transaction: IDBTransaction, transferId: string): Promise<readonly SecureMoveItem[]> {
  const values = await requestToPromise<unknown[]>(
    transaction.objectStore(DataStore.MoveItems).index(SchemaIndex.MoveItemsByTransferId).getAll(transferId),
  );
  return hydrateRecords(DataStore.MoveItems, secureMoveItemSchema, values).sort((left, right) =>
    left.interopId.localeCompare(right.interopId),
  );
}

export class SecureMoveOutboxRepository {
  constructor(private readonly db: IDBDatabase) {}

  async queueBatch(input: {
    readonly pairingId: string;
    readonly transferId: string;
    readonly items: readonly SecureMoveQueueItem[];
    readonly at: string;
  }): Promise<void> {
    if (input.items.length === 0) throw new Error('Secure Move outbox batch cannot be empty.');
    const messageIds = input.items.flatMap((item) => [item.messageId, ...(item.attachments ?? []).map((row) => row.messageId)]);
    if (new Set(messageIds).size !== messageIds.length) {
      throw new Error('Secure Move outbox batch contains duplicate message identities.');
    }
    const transaction = this.db.transaction(STORES, 'readwrite');
    const journals = transaction.objectStore(DataStore.MoveJournals);
    const existingJournal = hydrateRecord(
      DataStore.MoveJournals,
      moveJournalRecordSchema,
      await requestToPromise<unknown>(journals.get(input.transferId)),
    );
    if (
      existingJournal &&
      (existingJournal.pairingId !== input.pairingId ||
        existingJournal.sourceProduct !== 'image-trail' ||
        existingJournal.targetProduct !== 'overlook')
    ) {
      transaction.abort();
      throw new Error('Secure Move journal identity was reused across participants.');
    }
    const items = transaction.objectStore(DataStore.MoveItems);
    const outbox = transaction.objectStore(DataStore.MoveOutbox);
    const audit = transaction.objectStore(DataStore.MoveAudit);
    let lastSequence = existingJournal?.lastSequence ?? 0;
    for (const queued of input.items) {
      const item: SecureMoveItem = {
        id: moveItemId(input.transferId, queued.interopId),
        transferId: input.transferId,
        interopId: queued.interopId,
        sourceMessageId: queued.messageId,
        sourceMessageIds: [
          queued.messageId,
          ...(queued.attachments ?? []).filter((row) => row.acknowledgementRequired !== false).map((row) => row.messageId),
        ],
        sourceLocalId: queued.sourceLocalId,
        sourceUpdatedAt: queued.sourceUpdatedAt,
        sourceFingerprint: queued.sourceFingerprint,
        reviewCategory: queued.reviewCategory,
        state: 'queued',
        targetLocalId: null,
        metadataPersisted: false,
        originalVerification: 'pending',
        acknowledgementMessageId: null,
        acknowledgedMessageIds: [],
        error: null,
        acknowledgedAt: null,
        finalizedAt: null,
      };
      const existingItem = hydrateRecord(DataStore.MoveItems, secureMoveItemSchema, await requestToPromise<unknown>(items.get(item.id)));
      if (
        existingItem &&
        (existingItem.sourceMessageId !== item.sourceMessageId ||
          JSON.stringify(existingItem.sourceMessageIds ?? [existingItem.sourceMessageId]) !== JSON.stringify(item.sourceMessageIds) ||
          existingItem.sourceLocalId !== item.sourceLocalId ||
          existingItem.sourceUpdatedAt !== item.sourceUpdatedAt ||
          existingItem.reviewCategory !== item.reviewCategory)
      ) {
        transaction.abort();
        throw new Error('Secure Move item identity was replayed with different metadata.');
      }
      items.put(existingItem ?? item);
      for (const message of [queued, ...(queued.attachments ?? [])]) {
        const existingOutbox = hydrateRecord(
          DataStore.MoveOutbox,
          secureMoveOutboxSchema,
          await requestToPromise<unknown>(outbox.get(message.messageId)),
        );
        if (
          existingOutbox &&
          (existingOutbox.transferId !== input.transferId ||
            existingOutbox.interopId !== queued.interopId ||
            existingOutbox.sequence !== message.sequence ||
            existingOutbox.path !== message.path)
        ) {
          transaction.abort();
          throw new Error('Secure Move message identity was replayed across outbox objects.');
        }
        if (!existingOutbox) {
          const ciphertext = message.ciphertext.buffer.slice(
            message.ciphertext.byteOffset,
            message.ciphertext.byteOffset + message.ciphertext.byteLength,
          ) as ArrayBuffer;
          outbox.put({
            messageId: message.messageId,
            transferId: input.transferId,
            interopId: queued.interopId,
            sequence: message.sequence,
            path: message.path,
            ciphertext,
            createdAt: input.at,
            deliveredAt: null,
          } satisfies SecureMoveOutboxRecord);
        }
        lastSequence = Math.max(lastSequence, message.sequence);
      }
      const eventKey = `${queued.messageId}:queued`;
      if ((await requestToPromise<IDBValidKey | undefined>(audit.getKey(eventKey))) === undefined) {
        audit.put({
          eventKey,
          transferId: input.transferId,
          interopId: queued.interopId,
          event: 'queued',
          details: { sourceMessageIds: item.sourceMessageIds },
          createdAt: input.at,
        });
      }
    }
    const journal: MoveJournalRecord = existingJournal ?? {
      transferId: input.transferId,
      pairingId: input.pairingId,
      sourceProduct: 'image-trail',
      targetProduct: 'overlook',
      phase: 'awaiting-acknowledgement',
      lastSequence,
      createdAt: input.at,
      updatedAt: input.at,
    };
    journals.put({ ...journal, lastSequence, updatedAt: input.at });
    await transactionDone(transaction);
  }

  async progress(transferId: string): Promise<{ readonly journal: StoredMoveJournal; readonly pending: number } | null> {
    const transaction = this.db.transaction([DataStore.MoveJournals, DataStore.MoveItems, DataStore.MoveOutbox], 'readonly');
    const journal = hydrateRecord(
      DataStore.MoveJournals,
      moveJournalRecordSchema,
      await requestToPromise<unknown>(transaction.objectStore(DataStore.MoveJournals).get(transferId)),
    );
    const items = await secureMoveItemsIn(transaction, transferId);
    const outbox = await this.outboxIn(transaction, transferId);
    await transactionDone(transaction);
    const pendingIds = new Set(
      outbox
        .filter((row) => !row.deliveredAt)
        .map((row) => row.interopId)
        .filter((id): id is string => !!id),
    );
    const legacyPending = outbox.filter((row) => !row.deliveredAt && !row.interopId).length;
    return journal
      ? { journal: { ...journal, counts: countsFor(items) }, pending: Math.min(items.length, pendingIds.size + legacyPending) }
      : null;
  }

  async pending(transferId: string): Promise<readonly SecureMoveOutboxRecord[]> {
    const transaction = this.db.transaction(DataStore.MoveOutbox, 'readonly');
    const rows = await this.outboxIn(transaction, transferId);
    await transactionDone(transaction);
    return rows.filter((row) => !row.deliveredAt);
  }

  async outbox(transferId: string): Promise<readonly SecureMoveOutboxRecord[]> {
    const transaction = this.db.transaction(DataStore.MoveOutbox, 'readonly');
    const rows = await this.outboxIn(transaction, transferId);
    await transactionDone(transaction);
    return rows;
  }

  async item(transferId: string, interopId: string): Promise<SecureMoveItem | undefined> {
    const transaction = this.db.transaction(DataStore.MoveItems, 'readonly');
    const item = hydrateRecord(
      DataStore.MoveItems,
      secureMoveItemSchema,
      await requestToPromise<unknown>(transaction.objectStore(DataStore.MoveItems).get(moveItemId(transferId, interopId))),
    );
    await transactionDone(transaction);
    return item;
  }

  async outboxMessage(messageId: string): Promise<SecureMoveOutboxRecord | undefined> {
    const transaction = this.db.transaction(DataStore.MoveOutbox, 'readonly');
    const row = hydrateRecord(
      DataStore.MoveOutbox,
      secureMoveOutboxSchema,
      await requestToPromise<unknown>(transaction.objectStore(DataStore.MoveOutbox).get(messageId)),
    );
    await transactionDone(transaction);
    return row;
  }

  async markDelivered(messageId: string, at: string): Promise<void> {
    const transaction = this.db.transaction(DataStore.MoveOutbox, 'readwrite');
    const store = transaction.objectStore(DataStore.MoveOutbox);
    const row = hydrateRecord(DataStore.MoveOutbox, secureMoveOutboxSchema, await requestToPromise<unknown>(store.get(messageId)));
    if (row && !row.deliveredAt) store.put({ ...row, deliveredAt: at });
    await transactionDone(transaction);
  }

  private async outboxIn(transaction: IDBTransaction, transferId: string): Promise<readonly SecureMoveOutboxRecord[]> {
    const values = await requestToPromise<unknown[]>(
      transaction.objectStore(DataStore.MoveOutbox).index(SchemaIndex.MoveOutboxByTransferId).getAll(transferId),
    );
    return hydrateRecords(DataStore.MoveOutbox, secureMoveOutboxSchema, values).sort(
      (left, right) => left.sequence - right.sequence || left.messageId.localeCompare(right.messageId),
    );
  }
}
