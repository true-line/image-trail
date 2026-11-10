import type { ImageDisplayRecord } from '../core/display-records.js';
import { createDisplayRecord } from '../core/display-records.js';
import { PRIVATE_PIN_NEEDS_UNLOCK_MESSAGE, type BookmarkSaveOptions } from '../core/bookmark-save-options.js';
import type { StorageUsageSummary } from '../core/image/capture-result.js';
import {
  bookmarkSearchIndexKey,
  DEFAULT_SEARCHABLE_METADATA_POLICY,
  hashSearchableUrl,
  type SearchableMetadataPolicy,
} from '../core/metadata-policy.js';
import type { BookmarkStore, PinSaveStoragePreference } from '../core/types.js';
import { loadPlainBookmarkRecords, type MergedBookmarkRecordsCache } from './bookmark-record-loader.js';
import { findStoredBookmarkByUrl } from './bookmark-record-lookup.js';
import {
  privatePinUrl,
  protectedRelationship,
  toBookmarkPayload,
  toDisplayRecord,
  toProtectedPayload,
  toRelationshipPayload,
} from './bookmark-record-mappers.js';
import type { ActiveBlobKey } from './crypto/blob-keyring.js';
import { moveBookmarkRowsToFront, removeBookmarkRows, withBookmarkRowWriteLock } from './bookmark-row-writes.js';
import { openImageTrailDb } from './db.js';
import { ensureDurableBookmarkKey, type DurableBookmarkKeyContext } from './durable-bookmark-key.js';
import { DEFAULT_LOCAL_SETTINGS } from './local-settings.js';
import { DEFAULT_QUEUE_DISPLAY_ORDER, sortQueueRecords, type QueueDisplayOrder } from '../core/display-order.js';
import { BlobsRepository } from './repositories/blobs-repository.js';
import { BookmarksRepository } from './repositories/bookmarks-repository.js';
import { EncryptedPinsRepository, type EncryptedPinRecord } from './repositories/encrypted-pins-repository.js';
import { EncryptedPinThumbnailsRepository } from './repositories/encrypted-pin-thumbnails-repository.js';
import { KeysRepository } from './repositories/keys-repository.js';
import {
  BookmarkPersistenceError,
  type BookmarkPersistenceOptions,
  clampPageOffset,
  filterByVisibilityScope,
  isVisibleInScope,
  preserveImportedBookmarkMetadata,
  protectedImportOptions,
  removeReplacedOriginal,
  saveProtectedThumbnail,
  withProtectedPinSaveLock,
} from './bookmark-controller-helpers.js';
export { recordQueueTime } from './bookmark-controller-helpers.js';

interface ProtectedBookmarkOptions {
  readonly getActiveBlobKey?: () => ActiveBlobKey | null | Promise<ActiveBlobKey | null>;
  readonly getPinSaveStoragePreference?: () => PinSaveStoragePreference | Promise<PinSaveStoragePreference>;
  readonly getSearchableMetadataPolicy?: () => SearchableMetadataPolicy | Promise<SearchableMetadataPolicy>;
}

type BookmarkContext = {
  readonly db: IDBDatabase;
  readonly repository: BookmarksRepository;
  readonly bookmarkKey: DurableBookmarkKeyContext;
  readonly encryptedPins: EncryptedPinsRepository;
  readonly encryptedThumbnails: EncryptedPinThumbnailsRepository;
  readonly blobs: BlobsRepository;
};

export interface BookmarkPage {
  readonly items: readonly ImageDisplayRecord[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

export interface BookmarkRecallPage {
  readonly items: readonly ImageDisplayRecord[];
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset: number;
  readonly hasMore: boolean;
  readonly total: number;
  readonly failedCount: number;
}

export class IndexedDbBookmarkStore implements BookmarkStore {
  private ready: Promise<BookmarkContext | null> | null = null;
  private mergedRecordsCache: MergedBookmarkRecordsCache | null = null;
  private mergedRecordsCacheGeneration = 0;

  constructor(private readonly options: ProtectedBookmarkOptions = {}) {}

  async load(): Promise<readonly ImageDisplayRecord[]> {
    return (await this.loadPage({ offset: 0, limit: DEFAULT_LOCAL_SETTINGS.visibleBookmarkSoftMax })).items;
  }

  async getStorageUsage(): Promise<StorageUsageSummary> {
    const context = await this.openContext();
    if (!context) return { totalBytes: 0, blobCount: 0, thumbnails: { count: 0, totalBytes: 0 } };
    return context.repository.getStorageUsage(context.bookmarkKey.key);
  }

  async loadOriginalBlobIds(): Promise<ReadonlySet<string>> {
    const context = await this.openContext();
    const ids = new Set<string>();
    if (!context) return ids;
    for (const record of await context.repository.listEncryptedNewestFirst()) {
      try {
        const payload = await context.repository.openRecord(record, context.bookmarkKey.key);
        if (payload.storedOriginal?.blobId) ids.add(payload.storedOriginal.blobId);
        if (payload.protectedPin?.storedOriginalBlobId) ids.add(payload.protectedPin.storedOriginalBlobId);
      } catch {
        // Unreadable legacy rows cannot safely identify linked originals.
      }
    }
    return ids;
  }

  async loadPage(input: {
    readonly offset: number;
    readonly limit: number;
    readonly scope?: 'global' | 'site' | undefined;
    readonly currentPageUrl?: string | undefined;
    readonly displayOrder?: QueueDisplayOrder | undefined;
  }): Promise<BookmarkPage> {
    const context = await this.openContext();
    const offset = Math.max(0, input.offset);
    const limit = Math.max(1, input.limit);
    if (!context) return { items: [], offset, limit, total: 0, hasOlder: false, hasNewer: false };

    const loaded = this.options.getActiveBlobKey
      ? await this.loadMergedRecords(context)
      : await loadPlainBookmarkRecords(context.repository, context.bookmarkKey.key);
    const visible = sortQueueRecords(
      filterByVisibilityScope(loaded, input.scope ?? 'global', input.currentPageUrl),
      input.displayOrder ?? DEFAULT_QUEUE_DISPLAY_ORDER,
    );
    const total = visible.length;
    const clampedOffset = clampPageOffset(offset, limit, total);
    const pageItems = visible.slice(clampedOffset, clampedOffset + limit);
    const items = this.options.getActiveBlobKey ? await this.loadProtectedThumbnailsForRecords(context, pageItems) : pageItems;
    return {
      items,
      offset: clampedOffset,
      limit,
      total,
      hasOlder: clampedOffset + limit < total,
      hasNewer: clampedOffset > 0,
    };
  }

  async save(record: ImageDisplayRecord, options: BookmarkSaveOptions = {}): Promise<ImageDisplayRecord> {
    const context = await this.openContext();
    const importedDataUrl = record.url.startsWith('data:image/');
    const bookmark = createDisplayRecord({ ...record, id: importedDataUrl ? record.id : record.url, source: 'bookmark' });
    if (!context) return bookmark;

    return withBookmarkRowWriteLock(() => this.saveWithContext(context, bookmark, options));
  }

  private async saveWithContext(
    context: BookmarkContext,
    bookmark: ImageDisplayRecord,
    options: BookmarkPersistenceOptions,
  ): Promise<ImageDisplayRecord> {
    if (options.requiredActiveBlobKey) {
      return {
        ...(await this.saveProtected(context, bookmark, options.requiredActiveBlobKey, options)),
        pinSaveStorage: { destination: 'encrypted' },
      };
    }
    const activeBlobKey = (await this.options.getActiveBlobKey?.()) ?? null;
    const preference = (await this.options.getPinSaveStoragePreference?.()) ?? DEFAULT_LOCAL_SETTINGS.pinSaveStoragePreference;
    const protectedPin = await context.encryptedPins.getByUrlHash(await hashSearchableUrl(bookmark.url));
    const keepPrivate = options.requireEncrypted === true || !!protectedPin;
    if (keepPrivate && !activeBlobKey) {
      // A pin that is, or must be, private never gets a plaintext copy while the key is away.
      if (!protectedPin) throw new BookmarkPersistenceError(PRIVATE_PIN_NEEDS_UNLOCK_MESSAGE, false);
      return this.lockedPrivatePin(context, protectedPin.plainPinId, bookmark);
    }
    if (activeBlobKey && (keepPrivate || preference !== 'plaintext')) {
      try {
        return { ...(await this.saveProtected(context, bookmark, activeBlobKey, options)), pinSaveStorage: { destination: 'encrypted' } };
      } catch (error) {
        if (keepPrivate) throw error;
        return this.savePlain(context, bookmark, { destination: 'plaintext', reason: 'failed' }, options);
      }
    }
    const reason = preference === 'plaintext' ? 'setting' : this.options.getActiveBlobKey ? 'locked' : 'unavailable';
    return this.savePlain(context, bookmark, { destination: 'plaintext', reason }, options);
  }

  private async lockedPrivatePin(context: BookmarkContext, plainPinId: string, bookmark: ImageDisplayRecord): Promise<ImageDisplayRecord> {
    const stub = await context.repository.getEncrypted(plainPinId);
    const payload = stub ? await context.repository.openRecord(stub, context.bookmarkKey.key).catch(() => null) : null;
    const stored = stub && payload ? toDisplayRecord(stub.uuid, payload, stub.queueUpdatedAt) : { ...bookmark, id: plainPinId };
    return { ...stored, pinSaveStorage: { destination: 'encrypted' }, privacyStatus: 'locked' };
  }

  async saveResult(record: ImageDisplayRecord, options?: BookmarkSaveOptions) {
    const context = await this.openContext();
    if (!context) return { ok: false as const, message: 'Bookmark storage is unavailable.' };
    const importedDataUrl = record.url.startsWith('data:image/');
    const bookmark = createDisplayRecord({ ...record, id: importedDataUrl ? record.id : record.url, source: 'bookmark' });
    try {
      return { ok: true as const, record: await withBookmarkRowWriteLock(() => this.saveWithContext(context, bookmark, options ?? {})) };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : 'Bookmark save failed.' };
    }
  }

  async saveProtectedResult(record: ImageDisplayRecord, activeBlobKey: ActiveBlobKey) {
    const context = await this.openContext();
    const current = (await this.options.getActiveBlobKey?.()) ?? null;
    if (!context || current?.reference.reference !== activeBlobKey.reference.reference) {
      return { ok: false as const, message: 'Encrypted original key changed during import.' };
    }
    const bookmark = createDisplayRecord({ ...record, id: record.url, source: 'bookmark' });
    try {
      return {
        ok: true as const,
        record: await withBookmarkRowWriteLock(() => this.saveWithContext(context, bookmark, protectedImportOptions(activeBlobKey))),
      };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : 'Bookmark save failed.',
        durableMetadataCommitted: error instanceof BookmarkPersistenceError && error.durableMetadataCommitted,
      };
    }
  }

  private async savePlain(
    context: BookmarkContext,
    bookmark: ImageDisplayRecord,
    pinSaveStorage?: ImageDisplayRecord['pinSaveStorage'],
    options: BookmarkPersistenceOptions = {},
  ): Promise<ImageDisplayRecord> {
    const importedDataUrl = bookmark.url.startsWith('data:image/');

    const policy = await this.searchableMetadataPolicy();
    const proposedIndexUrl = importedDataUrl ? `image-trail-import:${bookmark.id}` : await bookmarkSearchIndexKey(bookmark.url, policy);
    const existing = importedDataUrl
      ? await context.repository.getEncrypted(bookmark.id)
      : await findStoredBookmarkByUrl(context.repository, context.bookmarkKey.key, bookmark.url, policy);
    const existingPayload = existing ? await context.repository.openRecord(existing, context.bookmarkKey.key).catch(() => null) : null;
    if (existing && existingPayload?.protectedPin) {
      return { ...toDisplayRecord(existing.uuid, existingPayload, existing.queueUpdatedAt), pinSaveStorage };
    }
    const indexUrl = existingPayload?.interop ? existing!.url : proposedIndexUrl;
    const uuid = existing?.uuid ?? crypto.randomUUID();
    const payload = toBookmarkPayload(bookmark, existingPayload, {
      preserveExistingOriginal: !options.clearStoredOriginal,
      ...(options.preserveExistingThumbnail === undefined ? {} : { preserveExistingThumbnail: options.preserveExistingThumbnail }),
    });
    await context.repository.sealAndPut(
      uuid,
      payload,
      context.bookmarkKey.key,
      context.bookmarkKey.reference,
      existing?.envelope.updatedAt,
      indexUrl,
      existing?.queueUpdatedAt ?? bookmark.timestamp,
    );
    await removeReplacedOriginal(context, existingPayload, payload.storedOriginal?.blobId ?? bookmark.blobId);
    this.invalidateMergedRecordsCache();
    return { ...bookmark, id: uuid, pinSaveStorage };
  }

  private async hasProtectedPinForUrlInContext(context: BookmarkContext, url: string): Promise<boolean> {
    return !!(await context.encryptedPins.getByUrlHash(await hashSearchableUrl(url)));
  }

  private async searchableMetadataPolicy(): Promise<SearchableMetadataPolicy> {
    return (await this.options.getSearchableMetadataPolicy?.()) ?? DEFAULT_SEARCHABLE_METADATA_POLICY;
  }

  async loadRecallPage(input: {
    readonly offset: number;
    readonly limit: number;
    readonly scope?: 'global' | 'site' | undefined;
    readonly currentPageUrl?: string | undefined;
  }): Promise<BookmarkRecallPage> {
    const context = await this.openContext();
    const offset = Math.max(0, input.offset);
    const limit = Math.max(1, input.limit);
    if (!context) return { items: [], offset, limit, nextOffset: offset, hasMore: false, total: 0, failedCount: 0 };

    if (this.options.getActiveBlobKey) {
      const loaded = await this.loadMergedRecords(context);
      const visible = filterByVisibilityScope(loaded, input.scope ?? 'global', input.currentPageUrl);
      const items = [...(await this.loadProtectedThumbnailsForRecords(context, visible.slice(offset, offset + limit + 1)))];
      const hasMore = items.length > limit;
      if (hasMore) items.length = limit;
      return {
        items,
        offset,
        limit,
        nextOffset: offset + items.length,
        hasMore,
        total: visible.length,
        failedCount: 0,
      };
    }

    if ((input.scope ?? 'global') === 'site') {
      return this.loadRecallPageByScanning(context, input, offset, limit);
    }

    const items: ImageDisplayRecord[] = [];
    let failedCount = 0;
    let pageOffset = offset;
    let hasMore = false;
    const chunkLimit = limit + 1;
    while (items.length <= limit) {
      const records = await context.repository.listEncryptedPage({ offset: pageOffset, limit: chunkLimit });
      if (records.length === 0) break;
      pageOffset += records.length;
      for (const record of records) {
        try {
          const payload = await context.repository.openRecord(record, context.bookmarkKey.key);
          if (payload) items.push(toDisplayRecord(record.uuid, payload, record.queueUpdatedAt));
        } catch {
          failedCount += 1;
        }
      }
      if (records.length < chunkLimit) break;
    }
    if (items.length > limit) {
      hasMore = true;
      items.length = limit;
    }
    const total = await context.repository.countEncrypted();
    return { items, offset, limit, nextOffset: offset + items.length, hasMore, total: Math.max(0, total - offset), failedCount };
  }

  async moveToFront(ids: readonly string[]): Promise<readonly ImageDisplayRecord[]> {
    const context = await this.openContext();
    if (!context) return [];
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    const baseTime = Date.now();
    // Queue pages read queueUpdatedAt newest-first, so earlier selected IDs get later timestamps.
    const moves = uniqueIds.map((uuid, index) => ({ uuid, queueUpdatedAt: new Date(baseTime + uniqueIds.length - index).toISOString() }));
    const updated = await moveBookmarkRowsToFront(context, moves, Boolean(this.options.getActiveBlobKey));
    this.invalidateMergedRecordsCache();
    if (this.options.getActiveBlobKey) return this.loadRecordsByIds(context, uniqueIds);
    const records: ImageDisplayRecord[] = [];
    for (const record of updated) {
      try {
        const payload = await context.repository.openRecord(record, context.bookmarkKey.key);
        records.push(toDisplayRecord(record.uuid, payload, record.queueUpdatedAt));
      } catch {
        // If a record cannot be decrypted, it was not successfully recalled.
      }
    }
    return records;
  }

  async loadByIds(ids: readonly string[]): Promise<readonly ImageDisplayRecord[]> {
    const context = await this.openContext();
    if (!context) return [];
    return this.loadRecordsByIds(context, [...new Set(ids)].filter(Boolean));
  }

  async findByUrl(url: string): Promise<ImageDisplayRecord | null> {
    const context = await this.openContext();
    if (!context) return null;
    const activeBlobKey = (await this.options.getActiveBlobKey?.()) ?? null;
    if (activeBlobKey) {
      const protectedRecord = await context.encryptedPins.getByUrlHash(await hashSearchableUrl(url));
      if (protectedRecord) {
        try {
          return await this.openProtectedDisplayRecord(context, protectedRecord, activeBlobKey);
        } catch {
          // Fall through to the relationship/plain lookup below.
        }
      }
    }

    const plain = await findStoredBookmarkByUrl(context.repository, context.bookmarkKey.key, url, await this.searchableMetadataPolicy());
    if (!plain) return null;
    try {
      const payload = await context.repository.openRecord(plain, context.bookmarkKey.key);
      if (payload.protectedPin?.encryptedPinId && activeBlobKey) {
        const protectedRecord = await context.encryptedPins.get(payload.protectedPin.encryptedPinId);
        if (protectedRecord) return await this.openProtectedDisplayRecord(context, protectedRecord, activeBlobKey);
      }
      return toDisplayRecord(plain.uuid, payload, plain.queueUpdatedAt);
    } catch {
      return null;
    }
  }

  async hasProtectedPinForUrl(url: string): Promise<boolean> {
    const context = await this.openContext();
    return context ? this.hasProtectedPinForUrlInContext(context, url) : false;
  }

  async remove(record: ImageDisplayRecord): Promise<void> {
    await this.removeMany([record.id]);
  }

  async removeMany(ids: readonly string[]): Promise<{ readonly removedCount: number }> {
    const context = await this.openContext();
    if (!context) return { removedCount: 0 };
    const removedCount = await removeBookmarkRows(context, ids);
    if (removedCount > 0) this.invalidateMergedRecordsCache();
    return { removedCount };
  }

  async removeRecallPage(input: {
    readonly offset: number;
    readonly scope?: 'global' | 'site' | undefined;
    readonly currentPageUrl?: string | undefined;
  }): Promise<{ readonly removedCount: number }> {
    const context = await this.openContext();
    if (!context) return { removedCount: 0 };
    const records = this.options.getActiveBlobKey
      ? await this.loadMergedRecords(context)
      : await loadPlainBookmarkRecords(context.repository, context.bookmarkKey.key);
    const visible = filterByVisibilityScope(records, input.scope ?? 'global', input.currentPageUrl);
    const ids = visible.slice(Math.max(0, input.offset)).map((record) => record.id);
    return this.removeMany(ids);
  }

  async close(): Promise<void> {
    const context = await this.ready;
    context?.db.close();
    this.ready = null;
  }

  private openContext(): Promise<BookmarkContext | null> {
    this.ready ??= this.createContext();
    return this.ready;
  }

  private async createContext(): Promise<BookmarkContext | null> {
    const result = await openImageTrailDb();
    if (!result.db) return null;
    const bookmarkKey = await ensureDurableBookmarkKey(new KeysRepository(result.db));
    return {
      db: result.db,
      repository: new BookmarksRepository(result.db),
      bookmarkKey,
      encryptedPins: new EncryptedPinsRepository(result.db),
      encryptedThumbnails: new EncryptedPinThumbnailsRepository(result.db),
      blobs: new BlobsRepository(result.db),
    };
  }

  private async loadMergedRecords(context: BookmarkContext): Promise<readonly ImageDisplayRecord[]> {
    const activeBlobKey = (await this.options.getActiveBlobKey?.()) ?? null;
    const keyReference = activeBlobKey?.reference.reference ?? null;
    if (this.mergedRecordsCache?.keyReference === keyReference) return this.mergedRecordsCache.records;
    const cacheGeneration = this.mergedRecordsCacheGeneration;
    const plain = [...(await loadPlainBookmarkRecords(context.repository, context.bookmarkKey.key))];
    if (!activeBlobKey) {
      if (this.mergedRecordsCacheGeneration === cacheGeneration) {
        this.mergedRecordsCache = { keyReference, records: plain };
      }
      return plain;
    }

    const byId = new Map(plain.map((record) => [record.id, record]));
    const urlToId = new Map(plain.filter((record) => record.privacyStatus !== 'locked').map((record) => [record.url, record.id]));
    for (const encrypted of await context.encryptedPins.listNewestFirst()) {
      try {
        const display = await this.openProtectedDisplayRecord(context, encrypted, activeBlobKey, { includeThumbnail: false });
        const duplicateId = urlToId.get(display.url);
        if (duplicateId) byId.delete(duplicateId);
        byId.set(display.id, display);
      } catch {
        // Keep the relationship row placeholder if protected metadata cannot be decrypted.
      }
    }
    const records = sortQueueRecords([...byId.values()], DEFAULT_QUEUE_DISPLAY_ORDER);
    if (this.mergedRecordsCacheGeneration === cacheGeneration) {
      this.mergedRecordsCache = { keyReference, records };
    }
    return records;
  }

  private async loadRecordsByIds(context: BookmarkContext, ids: readonly string[]): Promise<readonly ImageDisplayRecord[]> {
    const activeBlobKey = (await this.options.getActiveBlobKey?.()) ?? null;
    const records: ImageDisplayRecord[] = [];
    for (const id of ids) {
      const relationship = await context.repository.getEncrypted(id);
      if (!relationship) continue;
      try {
        const payload = await context.repository.openRecord(relationship, context.bookmarkKey.key);
        if (payload.protectedPin?.encryptedPinId && activeBlobKey) {
          const encrypted = await context.encryptedPins.get(payload.protectedPin.encryptedPinId);
          if (encrypted) {
            records.push(await this.openProtectedDisplayRecord(context, encrypted, activeBlobKey));
            continue;
          }
        }
        records.push(toDisplayRecord(relationship.uuid, payload, relationship.queueUpdatedAt));
      } catch {
        // If a targeted row cannot be opened, it was not successfully recalled.
      }
    }
    return records;
  }

  private async saveProtected(
    context: BookmarkContext,
    bookmark: ImageDisplayRecord,
    activeBlobKey: ActiveBlobKey,
    options: BookmarkPersistenceOptions,
  ): Promise<ImageDisplayRecord> {
    const urlHash = await hashSearchableUrl(bookmark.url);
    return withProtectedPinSaveLock(urlHash, () => this.saveProtectedForHash(context, bookmark, activeBlobKey, urlHash, options));
  }
  private async saveProtectedForHash(
    context: BookmarkContext,
    bookmark: ImageDisplayRecord,
    activeBlobKey: ActiveBlobKey,
    urlHash: string,
    options: BookmarkPersistenceOptions,
  ): Promise<ImageDisplayRecord> {
    const existingProtected = await context.encryptedPins.getByUrlHash(urlHash);
    const existingBookmark = existingProtected
      ? undefined
      : await findStoredBookmarkByUrl(context.repository, context.bookmarkKey.key, bookmark.url, await this.searchableMetadataPolicy());
    const plainPinId = existingProtected?.plainPinId ?? existingBookmark?.uuid ?? crypto.randomUUID();
    const existingPlain = await context.repository.getEncrypted(plainPinId);
    const encryptedPinId = existingProtected?.id ?? crypto.randomUUID();
    const existingPlainPayload = existingPlain
      ? await context.repository.openRecord(existingPlain, context.bookmarkKey.key).catch(() => null)
      : null;
    if (existingPlainPayload?.interop) await context.repository.setInteropCustodyPresence(true);
    const existingProtectedPayload = existingProtected
      ? await context.encryptedPins.openRecord(existingProtected, activeBlobKey.key).catch(() => null)
      : null;
    const savedBookmark = options.preserveExistingMetadata
      ? preserveImportedBookmarkMetadata(bookmark, existingProtectedPayload ?? existingPlainPayload)
      : bookmark;
    const queueUpdatedAt = existingPlain?.queueUpdatedAt ?? existingProtected?.queueUpdatedAt ?? bookmark.timestamp;
    let thumbnail: { readonly id: string } | null = null;
    let protectedRecordCommitted = false;
    let relationshipCommitted = false;
    try {
      const bookmarkWithThumbnail =
        options.preserveExistingThumbnail && !savedBookmark.thumbnail && existingPlainPayload?.thumbnail
          ? { ...savedBookmark, thumbnail: existingPlainPayload.thumbnail }
          : savedBookmark;
      thumbnail = await saveProtectedThumbnail(
        context,
        bookmarkWithThumbnail,
        activeBlobKey,
        plainPinId,
        existingPlainPayload?.protectedPin,
      );
      const thumbnailId =
        thumbnail?.id ??
        (options.preserveExistingThumbnail
          ? (existingProtectedPayload?.thumbnailId ?? existingPlainPayload?.protectedPin?.encryptedThumbnailId)
          : undefined);
      const protectedPayload = toProtectedPayload(
        savedBookmark,
        thumbnailId,
        existingProtectedPayload?.interop ?? existingPlainPayload?.interop,
        options.clearStoredOriginal ? undefined : (existingProtectedPayload?.storedOriginal ?? existingPlainPayload?.storedOriginal),
      );
      const protectedRecord = await context.encryptedPins.sealAndPut({
        id: encryptedPinId,
        plainPinId,
        urlHash,
        queueUpdatedAt,
        payload: protectedPayload,
        key: activeBlobKey.key,
        keyReference: activeBlobKey.reference,
        now: existingProtected?.envelope.updatedAt,
      });
      protectedRecordCommitted = true;
      const relationship = protectedRelationship({
        plainPinId,
        encryptedPinId,
        encryptedThumbnailId: thumbnailId,
        storedOriginalBlobId:
          protectedPayload.storedOriginal?.blobId ??
          savedBookmark.blobId ??
          (options.clearStoredOriginal ? undefined : existingPlainPayload?.protectedPin?.storedOriginalBlobId),
        queueUpdatedAt,
      });
      await context.repository.sealAndPut(
        plainPinId,
        toRelationshipPayload(relationship),
        context.bookmarkKey.key,
        context.bookmarkKey.reference,
        existingPlain?.envelope.updatedAt,
        privatePinUrl(plainPinId),
        queueUpdatedAt,
      );
      relationshipCommitted = true;
      await removeReplacedOriginal(context, existingPlainPayload, relationship.storedOriginalBlobId);
      this.invalidateMergedRecordsCache();
      return this.openProtectedDisplayRecord(context, protectedRecord, activeBlobKey);
    } catch (error) {
      let durableMetadataCommitted = relationshipCommitted || (!!existingProtected && protectedRecordCommitted);
      const existingThumbnailId = existingPlainPayload?.protectedPin?.encryptedThumbnailId;
      if (!durableMetadataCommitted && thumbnail?.id && thumbnail.id !== existingThumbnailId) {
        await context.encryptedThumbnails.remove(thumbnail.id).catch(() => undefined);
      }
      if (!durableMetadataCommitted && !existingProtected && protectedRecordCommitted) {
        try {
          await context.encryptedPins.remove(encryptedPinId);
        } catch {
          durableMetadataCommitted = true;
        }
      }
      this.invalidateMergedRecordsCache();
      throw new BookmarkPersistenceError(error instanceof Error ? error.message : 'Bookmark save failed.', durableMetadataCommitted);
    }
  }

  private async openProtectedDisplayRecord(
    context: BookmarkContext,
    record: EncryptedPinRecord,
    activeBlobKey: ActiveBlobKey,
    options: { readonly includeThumbnail?: boolean } = {},
  ): Promise<ImageDisplayRecord> {
    const payload = await context.encryptedPins.openRecord(record, activeBlobKey.key);
    const thumbnail =
      options.includeThumbnail !== false && payload.thumbnailId
        ? await this.openProtectedThumbnail(context, payload.thumbnailId, activeBlobKey)
        : undefined;
    const storedOriginal = payload.storedOriginal;
    return createDisplayRecord({
      id: record.plainPinId,
      url: payload.url,
      title: payload.title,
      label: payload.label,
      thumbnail,
      width: payload.width,
      height: payload.height,
      timestamp: payload.bookmarkedAt,
      queueUpdatedAt: record.queueUpdatedAt,
      downloadedAt: payload.downloadedAt,
      capturedAt: payload.capturedAt ?? storedOriginal?.capturedAt,
      captureStatus: storedOriginal ? 'captured' : undefined,
      blobId: storedOriginal?.blobId,
      storedOriginal,
      source: payload.sourceCompatibility ?? 'bookmark',
      privacyStatus: 'unlocked',
      protectedPin: protectedRelationship({
        plainPinId: record.plainPinId,
        encryptedPinId: record.id,
        encryptedThumbnailId: payload.thumbnailId,
        storedOriginalBlobId: payload.storedOriginal?.blobId,
        queueUpdatedAt: record.queueUpdatedAt,
      }),
    });
  }

  private async loadProtectedThumbnailsForRecords(
    context: BookmarkContext,
    records: readonly ImageDisplayRecord[],
  ): Promise<readonly ImageDisplayRecord[]> {
    const activeBlobKey = (await this.options.getActiveBlobKey?.()) ?? null;
    if (!activeBlobKey) return records;
    const loaded: ImageDisplayRecord[] = [];
    for (const record of records) {
      const thumbnailId = record.protectedPin?.encryptedThumbnailId;
      if (!thumbnailId || record.thumbnail) {
        loaded.push(record);
        continue;
      }
      const thumbnail = await this.openProtectedThumbnail(context, thumbnailId, activeBlobKey).catch(() => undefined);
      loaded.push(thumbnail ? createDisplayRecord({ ...record, thumbnail }) : record);
    }
    return loaded;
  }

  private invalidateMergedRecordsCache(): void {
    this.mergedRecordsCacheGeneration += 1;
    this.mergedRecordsCache = null;
  }

  private async openProtectedThumbnail(
    context: BookmarkContext,
    thumbnailId: string,
    activeBlobKey: ActiveBlobKey,
  ): Promise<string | undefined> {
    const record = await context.encryptedThumbnails.get(thumbnailId);
    if (!record || record.key.reference !== activeBlobKey.reference.reference) return undefined;
    return (await context.encryptedThumbnails.openRecord(record, activeBlobKey.key)).dataUrl;
  }

  private async loadRecallPageByScanning(
    context: {
      readonly repository: BookmarksRepository;
      readonly bookmarkKey: DurableBookmarkKeyContext;
    },
    input: {
      readonly scope?: 'global' | 'site' | undefined;
      readonly currentPageUrl?: string | undefined;
    },
    offset: number,
    limit: number,
  ): Promise<BookmarkRecallPage> {
    const items: ImageDisplayRecord[] = [];
    let failedCount = 0;
    let scannedOffset = 0;
    let matchingSkipped = 0;
    let hasMore = false;
    const chunkLimit = Math.max(limit * 4, DEFAULT_LOCAL_SETTINGS.visibleBookmarkSoftMax, 30);

    while (items.length <= limit) {
      const records = await context.repository.listEncryptedPage({ offset: scannedOffset, limit: chunkLimit });
      if (records.length === 0) break;
      scannedOffset += records.length;

      for (const record of records) {
        try {
          const payload = await context.repository.openRecord(record, context.bookmarkKey.key);
          const displayRecord = payload ? toDisplayRecord(record.uuid, payload, record.queueUpdatedAt) : null;
          if (!displayRecord || !isVisibleInScope(displayRecord, input.scope ?? 'global', input.currentPageUrl)) continue;
          if (matchingSkipped < offset) {
            matchingSkipped += 1;
            continue;
          }
          if (items.length >= limit) {
            hasMore = true;
            break;
          }
          items.push(displayRecord);
        } catch {
          failedCount += 1;
        }
      }
      if (hasMore || records.length < chunkLimit) break;
    }

    return {
      items,
      offset,
      limit,
      nextOffset: offset + items.length,
      hasMore,
      total: offset + items.length + (hasMore ? 1 : 0),
      failedCount,
    };
  }
}
