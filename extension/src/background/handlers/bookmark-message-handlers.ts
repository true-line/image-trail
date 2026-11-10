import type { ImageDisplayRecord } from '../../core/display-records.js';
import type { BookmarkStore } from '../../core/types.js';
import { noopLibraryChangeNotifier, type LibraryChangeNotifier } from '../library-change-notifier.js';
import { defineMessage, type MessageDef } from '../message-dispatch.js';
import * as requestSchemas from '../message-schemas.js';
import {
  MessageType,
  createFindBookmarkByUrlResultMessage,
  createLoadBookmarksByIdsResultMessage,
  createLoadBookmarksResultMessage,
  createRemoveBookmarkResultMessage,
  createRemoveBookmarksResultMessage,
  createRemoveRecallBookmarksResultMessage,
  createSaveBookmarkResultMessage,
  type ExtensionRequest,
  type ExtensionResponse,
  type FindBookmarkByUrlMessage,
  type LoadBookmarksByIdsMessage,
  type LoadBookmarksMessage,
  type RemoveBookmarkMessage,
  type RemoveBookmarksMessage,
  type RemoveRecallBookmarksMessage,
  type SaveBookmarkMessage,
} from '../messages.js';

type BookmarkRequestType =
  | typeof MessageType.LoadBookmarks
  | typeof MessageType.LoadBookmarksByIds
  | typeof MessageType.FindBookmarkByUrl
  | typeof MessageType.SaveBookmark
  | typeof MessageType.RemoveBookmark
  | typeof MessageType.RemoveBookmarks
  | typeof MessageType.RemoveRecallBookmarks;

export interface BookmarkMessageHandlerDeps {
  readonly bookmarkStore: Pick<
    BookmarkStore,
    'loadPage' | 'loadByIds' | 'findByUrl' | 'save' | 'remove' | 'removeMany' | 'removeRecallPage'
  >;
  readonly notifyLibraryChange?: LibraryChangeNotifier;
}

export function createBookmarkMessageRegistry({
  bookmarkStore,
  notifyLibraryChange = noopLibraryChangeNotifier,
}: BookmarkMessageHandlerDeps): Record<BookmarkRequestType, MessageDef<ExtensionRequest, ExtensionResponse>> {
  return {
    [MessageType.LoadBookmarks]: defineMessage({
      requestSchema: requestSchemas.loadBookmarksRequestSchema,
      handle: (message: LoadBookmarksMessage) => bookmarkStore.loadPage(message.payload),
      respond: (result) => createLoadBookmarksResultMessage(result),
      fallback: (message) =>
        createLoadBookmarksResultMessage({
          items: [],
          offset: message.payload.offset,
          limit: message.payload.limit,
          total: 0,
          hasOlder: false,
          hasNewer: false,
        }),
    }),
    [MessageType.LoadBookmarksByIds]: defineMessage({
      requestSchema: requestSchemas.loadBookmarksByIdsRequestSchema,
      handle: async (message: LoadBookmarksByIdsMessage) => ({ items: await bookmarkStore.loadByIds(message.payload.ids) }),
      respond: (result) => createLoadBookmarksByIdsResultMessage(result),
      fallback: () => createLoadBookmarksByIdsResultMessage({ items: [] }),
    }),
    [MessageType.FindBookmarkByUrl]: defineMessage({
      requestSchema: requestSchemas.findBookmarkByUrlRequestSchema,
      handle: async (message: FindBookmarkByUrlMessage) => ({ record: await bookmarkStore.findByUrl(message.payload.url) }),
      respond: (result) => createFindBookmarkByUrlResultMessage(result),
      fallback: () => createFindBookmarkByUrlResultMessage({ record: null }),
    }),
    [MessageType.SaveBookmark]: defineMessage({
      requestSchema: requestSchemas.saveBookmarkRequestSchema,
      handle: async (message: SaveBookmarkMessage) => {
        let record: ImageDisplayRecord;
        try {
          record = await bookmarkStore.save(message.payload.record, message.payload.options);
        } catch (error) {
          // A save that must be encrypted reports why it failed, so restore can tell a locked
          // key from a storage failure. Other saves keep the generic fallback reply.
          if (!message.payload.options?.requireEncrypted) throw error;
          return { ok: false as const, message: error instanceof Error ? error.message : 'Bookmark save failed.' };
        }
        notifyLibraryChange({ topic: 'bookmarks', reason: 'bookmark-saved', recordIds: [record.id] });
        return { ok: true as const, record };
      },
      respond: (result) => createSaveBookmarkResultMessage(result),
      fallback: () => createSaveBookmarkResultMessage({ ok: false, message: 'Bookmark save failed.' }),
    }),
    [MessageType.RemoveBookmark]: defineMessage({
      requestSchema: requestSchemas.removeBookmarkRequestSchema,
      handle: async (message: RemoveBookmarkMessage) => {
        await bookmarkStore.remove(message.payload.record);
        notifyLibraryChange({ topic: 'bookmarks', reason: 'bookmark-removed', recordIds: [message.payload.record.id] });
        return { ok: true as const };
      },
      respond: (result) => createRemoveBookmarkResultMessage(result),
      fallback: () => createRemoveBookmarkResultMessage({ ok: false }),
    }),
    [MessageType.RemoveBookmarks]: defineMessage({
      requestSchema: requestSchemas.removeBookmarksRequestSchema,
      handle: async (message: RemoveBookmarksMessage) => {
        const result = await bookmarkStore.removeMany(message.payload.ids);
        if (result.removedCount > 0) {
          notifyLibraryChange({ topic: 'bookmarks', reason: 'bookmarks-removed', recordIds: message.payload.ids });
        }
        return { ok: true as const, ...result };
      },
      respond: (result) => createRemoveBookmarksResultMessage(result),
      fallback: () => createRemoveBookmarksResultMessage({ ok: false, removedCount: 0 }),
    }),
    [MessageType.RemoveRecallBookmarks]: defineMessage({
      requestSchema: requestSchemas.removeRecallBookmarksRequestSchema,
      handle: async (message: RemoveRecallBookmarksMessage) => {
        const result = await bookmarkStore.removeRecallPage(message.payload);
        if (result.removedCount > 0) notifyLibraryChange({ topic: 'bookmarks', reason: 'recall-bookmarks-removed' });
        return { ok: true as const, ...result };
      },
      respond: (result) => createRemoveRecallBookmarksResultMessage(result),
      fallback: () => createRemoveRecallBookmarksResultMessage({ ok: false, removedCount: 0 }),
    }),
  };
}
