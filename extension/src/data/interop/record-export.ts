import * as v from 'valibot';

import type { InteropReviewCategory, InteropRevisionVector } from '../../core/interop/contract.js';
import { interopMediaBlockForOriginal, withInteropMediaBlock } from '../../core/interop/media.js';
import { interopRecordSchema, type InteropBlobReference, type InteropRecord } from '../../core/interop/records.js';
import { sha256 } from '../../core/interop/transport.js';
import { openBlobPayload } from '../crypto/binary-envelope.js';
import { ensureDurableBookmarkKey } from '../durable-bookmark-key.js';
import type { ActiveBlobKey } from '../crypto/blob-keyring.js';
import { BookmarksRepository, type EncryptedBookmarkRecord } from '../repositories/bookmarks-repository.js';
import { EncryptedPinsRepository, type EncryptedPinRecord } from '../repositories/encrypted-pins-repository.js';
import { KeysRepository } from '../repositories/keys-repository.js';
import { BlobsRepository } from '../repositories/blobs-repository.js';
import { moveSourceFingerprint } from './move-source-fingerprint.js';
import type { DurableBookmarkPayloadV1, DurableEncryptedPinPayloadV1, DurableInteropRecordV1 } from '../types.js';

export interface CanonicalRecordExport {
  readonly localId: string;
  readonly sourceUpdatedAt: string;
  readonly sourceFingerprint: string;
  readonly record: InteropRecord;
  readonly albums: DurableInteropRecordV1['albums'];
  readonly reviewCategory: InteropReviewCategory;
  readonly original?: { readonly reference: AvailableInteropBlob; readonly bytes: Uint8Array } | undefined;
}

type AvailableInteropBlob = Extract<InteropBlobReference, { readonly state: 'available' }>;

export interface CanonicalRecordExportReview {
  readonly requested: number;
  readonly unsupported: number;
  readonly records: readonly CanonicalRecordExport[];
}

interface RecordExportOptions {
  readonly now?: (() => string) | undefined;
  readonly createId?: (() => string) | undefined;
}

export interface RecordExportReviewOptions {
  readonly includeOriginalBytes?: boolean | undefined;
}

const INITIAL_REVISION: InteropRevisionVector = { imageTrail: 1, overlook: 0 };
type ExportPayload = DurableBookmarkPayloadV1 | DurableEncryptedPinPayloadV1;

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function sourceUrl(value: string): string | null {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function timestamp(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function dimensions(payload: ExportPayload): InteropRecord['dimensions'] {
  return Number.isSafeInteger(payload.width) && Number.isSafeInteger(payload.height) && payload.width! > 0 && payload.height! > 0
    ? { width: payload.width!, height: payload.height! }
    : null;
}

function unavailableBlob(reason: 'not-captured' | 'provider-unavailable'): InteropBlobReference {
  return {
    state: reason === 'not-captured' ? 'unavailable' : 'metadata-only',
    blobId: null,
    mimeType: null,
    byteLength: null,
    contentHash: null,
    reason,
  };
}

function originalReference(payload: ExportPayload, original: AvailableInteropBlob | null): InteropBlobReference {
  if (original) return original;
  const stored = payload.storedOriginal;
  return stored
    ? {
        state: 'metadata-only',
        blobId: null,
        mimeType: stored.mimeType,
        byteLength: stored.byteLength,
        contentHash: null,
        reason: 'provider-unavailable',
      }
    : unavailableBlob('not-captured');
}

function thumbnailReference(payload: ExportPayload): InteropBlobReference {
  const thumbnail = 'thumbnail' in payload ? payload.thumbnail : 'thumbnailId' in payload ? payload.thumbnailId : undefined;
  if (!thumbnail) return unavailableBlob('not-captured');
  const mimeType = /^data:([^;,]+)[;,]/u.exec(thumbnail)?.[1] ?? null;
  return {
    state: 'metadata-only',
    blobId: null,
    mimeType,
    byteLength: null,
    contentHash: null,
    reason: 'provider-unavailable',
  };
}

function roundTripMetadata(payload: ExportPayload, existing?: InteropRecord['roundTripMetadata']): InteropRecord['roundTripMetadata'] {
  const base = existing ?? { imageTrail: {}, overlook: {} };
  const media = interopMediaBlockForOriginal(payload.storedOriginal);
  return media ? { ...base, overlook: withInteropMediaBlock(base.overlook, media) } : base;
}

function canonicalRecord(
  localId: string,
  payload: ExportPayload,
  interopId: string,
  original: AvailableInteropBlob | null,
): InteropRecord | null {
  const url = sourceUrl(payload.url);
  if (url === null) return null;
  const revision = INITIAL_REVISION;
  return v.parse(interopRecordSchema, {
    schemaVersion: 1,
    identity: { interopId, origin: { product: 'image-trail', localId }, contentHash: original?.contentHash ?? null },
    revision,
    fieldRevisions: {
      title: revision,
      label: revision,
      sourceUrl: revision,
      dimensions: revision,
      thumbnail: revision,
      timestamps: revision,
      original: revision,
      albums: revision,
      sourceCompatibility: revision,
      roundTripMetadata: revision,
    },
    recordKind: 'web-bookmark',
    title: nonEmpty(payload.title),
    label: nonEmpty(payload.label),
    sourceUrl: url,
    dimensions: dimensions(payload),
    timestamps: {
      bookmarkedAt: timestamp(payload.bookmarkedAt),
      capturedAt: timestamp(payload.capturedAt),
      downloadedAt: timestamp(payload.downloadedAt),
      takenAt: null,
      importedAt: null,
    },
    sourceCompatibility: payload.sourceCompatibility ?? null,
    original: originalReference(payload, original),
    thumbnail: thumbnailReference(payload),
    albumIds: [],
    roundTripMetadata: roundTripMetadata(payload),
    deletedAt: null,
  });
}

function custody(
  localId: string,
  payload: ExportPayload,
  original: AvailableInteropBlob | null,
  createId: () => string,
): DurableInteropRecordV1 | null {
  const existing = payload.interop;
  const record = existing
    ? {
        ...existing.record,
        identity: original ? { ...existing.record.identity, contentHash: original.contentHash } : existing.record.identity,
        original: originalReference(payload, original),
        roundTripMetadata: roundTripMetadata(payload, existing.record.roundTripMetadata),
      }
    : canonicalRecord(localId, payload, createId(), original);
  if (record === null) return null;
  return {
    schemaVersion: 1,
    record,
    albums: existing?.albums ?? [],
    reviewCategory: payload.storedOriginal ? (original ? 'eligible' : 'metadata-only') : (existing?.reviewCategory ?? 'eligible'),
  };
}

function sameCustody(left: DurableInteropRecordV1 | undefined, right: DurableInteropRecordV1): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export class InteropRecordExportStore {
  readonly #now: () => string;
  readonly #createId: () => string;

  constructor(
    private readonly db: IDBDatabase,
    options: RecordExportOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async review(
    recordIds: readonly string[],
    activeBlobKey: ActiveBlobKey | null = null,
    options: RecordExportReviewOptions = {},
  ): Promise<CanonicalRecordExportReview> {
    const uniqueIds = [...new Set(recordIds.map((id) => id.trim()).filter(Boolean))];
    const bookmarks = new BookmarksRepository(this.db);
    const encryptedPins = new EncryptedPinsRepository(this.db);
    const key = await ensureDurableBookmarkKey(new KeysRepository(this.db));
    const records: CanonicalRecordExport[] = [];
    let unsupported = 0;
    for (const localId of uniqueIds) {
      const encrypted = await bookmarks.getEncrypted(localId);
      const payload = await this.open(bookmarks, encrypted, key.key);
      const protectedPin = await this.openProtected(encryptedPins, payload, activeBlobKey);
      const exportPayload = protectedPin
        ? { ...protectedPin.payload, interop: protectedPin.payload.interop ?? payload?.interop }
        : payload?.protectedPin
          ? null
          : payload;
      const original =
        exportPayload && options.includeOriginalBytes !== false ? await this.openOriginal(exportPayload, activeBlobKey) : null;
      let retainedOriginal = false;
      try {
        const interop = exportPayload ? custody(localId, exportPayload, original?.reference ?? null, this.#createId) : null;
        if (!encrypted || !payload || !exportPayload || !interop) {
          unsupported += 1;
          continue;
        }
        if (protectedPin && activeBlobKey) {
          if (!sameCustody(protectedPin.payload.interop, interop) || payload.interop !== undefined) {
            await encryptedPins.sealAndPut({
              id: protectedPin.record.id,
              plainPinId: protectedPin.record.plainPinId,
              urlHash: protectedPin.record.urlHash,
              queueUpdatedAt: protectedPin.record.queueUpdatedAt,
              payload: { ...protectedPin.payload, interop },
              key: activeBlobKey.key,
              keyReference: activeBlobKey.reference,
              now: this.#now(),
            });
          }
          if (payload.interop) {
            await bookmarks.sealAndPut(
              encrypted.uuid,
              { ...payload, interop: undefined },
              key.key,
              key.reference,
              this.#now(),
              encrypted.url,
              encrypted.queueUpdatedAt,
            );
          }
        } else if (!sameCustody(payload.interop, interop)) {
          await bookmarks.sealAndPut(
            encrypted.uuid,
            { ...payload, interop },
            key.key,
            key.reference,
            this.#now(),
            encrypted.url,
            encrypted.queueUpdatedAt,
          );
        }
        const reviewedSource = await bookmarks.getEncrypted(localId);
        if (!reviewedSource) {
          unsupported += 1;
          continue;
        }
        records.push({
          localId,
          sourceUpdatedAt: reviewedSource.envelope.updatedAt,
          sourceFingerprint: await moveSourceFingerprint(
            reviewedSource,
            payload?.protectedPin?.encryptedPinId ? await encryptedPins.get(payload.protectedPin.encryptedPinId) : undefined,
          ),
          record: interop.record,
          albums: interop.albums,
          reviewCategory: interop.reviewCategory,
          ...(original ? { original } : {}),
        });
        retainedOriginal = true;
      } finally {
        if (!retainedOriginal) original?.bytes.fill(0);
      }
    }
    return { requested: uniqueIds.length, unsupported, records };
  }

  private async openOriginal(
    payload: ExportPayload,
    activeBlobKey: ActiveBlobKey | null,
  ): Promise<{ readonly reference: AvailableInteropBlob; readonly bytes: Uint8Array } | null> {
    if (!payload.storedOriginal || !activeBlobKey) return null;
    const record = await new BlobsRepository(this.db).get(payload.storedOriginal.blobId);
    if (!record || record.kind !== 'original' || record.key.reference !== activeBlobKey.reference.reference) return null;
    let bytes: Uint8Array | null = null;
    try {
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
      bytes = new Uint8Array(opened.bytes);
      if (
        opened.metadata.mimeType !== payload.storedOriginal.mimeType ||
        opened.metadata.byteLength !== payload.storedOriginal.byteLength ||
        bytes.byteLength !== payload.storedOriginal.byteLength
      ) {
        bytes.fill(0);
        return null;
      }
      return {
        reference: {
          state: 'available',
          blobId: payload.storedOriginal.blobId,
          mimeType: opened.metadata.mimeType,
          byteLength: bytes.byteLength,
          contentHash: await sha256(bytes),
        },
        bytes,
      };
    } catch {
      bytes?.fill(0);
      return null;
    }
  }

  private async open(
    bookmarks: BookmarksRepository,
    encrypted: EncryptedBookmarkRecord | undefined,
    key: CryptoKey,
  ): Promise<DurableBookmarkPayloadV1 | null> {
    if (!encrypted) return null;
    try {
      return await bookmarks.openRecord(encrypted, key);
    } catch {
      return null;
    }
  }

  private async openProtected(
    pins: EncryptedPinsRepository,
    relationship: DurableBookmarkPayloadV1 | null,
    activeBlobKey: ActiveBlobKey | null,
  ): Promise<{ readonly record: EncryptedPinRecord; readonly payload: DurableEncryptedPinPayloadV1 } | null> {
    const id = relationship?.protectedPin?.encryptedPinId;
    if (!id || !activeBlobKey) return null;
    const record = await pins.get(id);
    if (!record || record.plainPinId !== relationship.protectedPin?.plainPinId) return null;
    try {
      return { record, payload: await pins.openRecord(record, activeBlobKey.key) };
    } catch {
      return null;
    }
  }
}
