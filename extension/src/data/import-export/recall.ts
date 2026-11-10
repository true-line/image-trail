import { assertEnvelopeBoundTo, openJsonEnvelope } from '../crypto/envelope.js';
import type { EncryptedEnvelope, RecordEnvelopeMetadata } from '../crypto/types.js';
import type { DurableBookmarkPayloadV1, DurableHistoryPayloadV1, RecoverableDataStatus } from '../types.js';

export type RecallRecordType = 'history' | 'bookmark';

export interface RecallInput<T extends RecallRecordType> {
  readonly uuid: string;
  readonly recordType: T;
  readonly envelope: EncryptedEnvelope<RecordEnvelopeMetadata<T>>;
  readonly key: CryptoKey;
}

export interface RecalledHistoryEntry {
  readonly uuid: string;
  readonly recordType: 'history';
  readonly payload: DurableHistoryPayloadV1;
}

export interface RecalledBookmarkEntry {
  readonly uuid: string;
  readonly recordType: 'bookmark';
  readonly payload: DurableBookmarkPayloadV1;
}

export type RecalledEntry = RecalledHistoryEntry | RecalledBookmarkEntry;

export interface RecallResult {
  readonly status: RecoverableDataStatus;
  readonly entry?: RecalledEntry;
}

export async function recallEncryptedRecord<T extends RecallRecordType>(input: RecallInput<T>): Promise<RecallResult> {
  try {
    assertEnvelopeBoundTo(input.envelope, input.uuid);
    if (input.recordType === 'history') {
      const payload = await openJsonEnvelope<DurableHistoryPayloadV1>(input.envelope, input.key);
      return {
        status: { ok: true, code: 'ok', message: 'Record recalled successfully.' },
        entry: { uuid: input.uuid, recordType: 'history', payload },
      };
    }

    const payload = await openJsonEnvelope<DurableBookmarkPayloadV1>(input.envelope, input.key);
    return {
      status: { ok: true, code: 'ok', message: 'Record recalled successfully.' },
      entry: { uuid: input.uuid, recordType: 'bookmark', payload },
    };
  } catch (cause) {
    return {
      status: { ok: false, code: 'decryption-failed', message: 'Failed to decrypt record.', cause },
    };
  }
}

export interface BatchRecallResult {
  readonly status: RecoverableDataStatus;
  readonly entries: readonly RecalledEntry[];
  readonly failed: readonly string[];
}

export async function recallSelectedRecords(inputs: readonly RecallInput<RecallRecordType>[]): Promise<BatchRecallResult> {
  const entries: RecalledEntry[] = [];
  const failed: string[] = [];

  for (const input of inputs) {
    const result = await recallEncryptedRecord(input);
    if (result.status.ok && result.entry) {
      entries.push(result.entry);
    } else {
      failed.push(input.uuid);
    }
  }

  return {
    status: {
      ok: failed.length === 0,
      code: failed.length === 0 ? 'ok' : 'decryption-failed',
      message: `Recalled ${entries.length} record(s)${failed.length ? `, ${failed.length} failed` : ''}.`,
    },
    entries,
    failed,
  };
}
