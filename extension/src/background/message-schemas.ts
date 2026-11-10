import * as v from 'valibot';
import { imageDisplayRecordSchema } from '../core/display-records.schema.js';
import {
  panelPositionSchema,
  parsedFieldStateRecordSchema,
  urlReviewStatusClearFilterSchema,
  urlReviewStatusRecordSchema,
} from '../core/types.schema.js';
import { grabSourcePatternSchema, urlTemplateRecordSchema } from '../core/url/templates.schema.js';
import { workspaceLayoutSchema } from '../core/workspace-layout.schema.js';
import { pcloudBackupDownloadInputSchema, pcloudBackupUploadInputSchema } from '../core/cloud/pcloud-provider.schema.js';
import { saveLocalSettingsPayloadSchema } from '../data/local-settings.schema.js';
import { portableStoredBlobRecordSchema } from '../data/import-export/full-backup.schema.js';
import { EXTENSION_DESTINATION_IDS } from '../core/destinations.js';

/**
 * Runtime schema for every dispatched request payload, reused by the message
 * registry (see service-worker.ts) as the single definition validated before a
 * handler runs. Objects are loose (`v.object`) so a peer running a newer protocol
 * version can add fields without every request degrading to a fallback; empty
 * payloads accept `{}` and tolerate extra keys the same way.
 */
export const emptyPayloadSchema = v.object({}) as v.GenericSchema<unknown, Record<string, never>>;
const interopRuntimeContextSchema = v.object({
  entry: v.picklist(['bookmark', 'selection', 'album', 'gallery', 'captured-original', 'settings']),
  total: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  recordIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.readonly()),
  locked: v.boolean(),
});
const interopRuntimeActionSchema = v.variant('name', [
  v.object({ name: v.literal('status') }),
  v.object({ name: v.literal('select-provider'), provider: v.picklist(['pcloud', 'google-drive', 'icloud-drive']) }),
  v.object({ name: v.literal('connect'), provider: v.picklist(['pcloud', 'google-drive', 'icloud-drive']) }),
  v.object({ name: v.literal('disconnect') }),
  v.object({ name: v.literal('open-pairing-import') }),
  v.object({ name: v.literal('import-pairing'), fileContent: v.string(), password: v.string() }),
  v.object({ name: v.literal('set-operation'), operation: v.picklist(['move', 'sync']) }),
  v.object({ name: v.literal('start') }),
  v.object({ name: v.literal('pause') }),
  v.object({ name: v.literal('resume') }),
  v.object({ name: v.literal('cancel') }),
  v.object({ name: v.literal('reconnect'), provider: v.picklist(['pcloud', 'google-drive', 'icloud-drive']) }),
  v.object({
    name: v.literal('resolve-conflict'),
    interopId: v.string(),
    action: v.picklist(['keep-image-trail', 'keep-overlook', 'keep-both']),
    applyToAll: v.boolean(),
  }),
]);
export const interopRuntimeRequestSchema = v.object({ context: interopRuntimeContextSchema, action: interopRuntimeActionSchema });
export const openDestinationRequestSchema = v.object({ destination: v.picklist(EXTENSION_DESTINATION_IDS) });
export const destinationSourceStatusRequestSchema = v.object({ sourceTabId: v.optional(v.number()) });
export const focusDestinationSourceRequestSchema = v.object({ sourceTabId: v.number() });

const captureSourceTypeSchema = v.picklist(['target', 'history', 'bookmark']);
const imageRequestIntentSchema = v.picklist([
  'field-speculative-probe',
  'field-active-navigation',
  'url-editor-apply',
  'recent-load',
  'bookmark-load',
  'pin-load',
  'thumbnail-refresh',
  'capture-original',
]);
const imageProbeMethodSchema = v.picklist(['get', 'head']);
const imageSourceProfileSchema = v.picklist(['thumbnail', 'navigation']);
const bookmarkScopeSchema = v.picklist(['global', 'site']);
const stringArraySchema = v.pipe(v.array(v.string()), v.readonly());

export const loadBuildIdentityRequestSchema = v.object({ requestedAt: v.number() });

export const captureImageRequestSchema = v.object({
  url: v.string(),
  sourceRecordId: v.optional(v.string()),
  sourceType: captureSourceTypeSchema,
  fileName: v.optional(v.string()),
});

export const downloadImageRequestSchema = v.object({
  url: v.string(),
  fileName: v.string(),
  saveAs: v.boolean(),
});

export const exportEncryptedImageRequestSchema = v.object({
  url: v.string(),
  fileName: v.string(),
  blobId: v.optional(v.string()),
});

export const importEncryptedImageRequestSchema = v.object({ fileContent: v.string() });

export const loadBookmarksRequestSchema = v.object({
  offset: v.number(),
  limit: v.number(),
  scope: v.optional(bookmarkScopeSchema),
  currentPageUrl: v.optional(v.string()),
  displayOrder: v.optional(v.picklist(['front-first', 'back-first'])),
});

export const loadRecentHistoryRequestSchema = v.object({
  pageUrl: v.string(),
  includeRetained: v.optional(v.boolean()),
  scope: v.optional(v.picklist(['page', 'site', 'all'])),
});

export const loadBookmarksByIdsRequestSchema = v.object({ ids: stringArraySchema });

export const findBookmarkByUrlRequestSchema = v.object({ url: v.string() });

export const addRecentHistoryRequestSchema = v.object({
  pageUrl: v.string(),
  item: imageDisplayRecordSchema,
  includeRetained: v.optional(v.boolean()),
  scope: v.optional(v.picklist(['page', 'site', 'all'])),
});

export const updateRecentHistoryRequestSchema = v.object({
  pageUrl: v.string(),
  item: imageDisplayRecordSchema,
  includeRetained: v.optional(v.boolean()),
  scope: v.optional(v.picklist(['page', 'site', 'all'])),
});

export const removeRecentHistoryRequestSchema = v.object({
  pageUrl: v.string(),
  id: v.string(),
  includeRetained: v.optional(v.boolean()),
  scope: v.optional(v.picklist(['page', 'site', 'all'])),
});

export const loadRecallCandidatesRequestSchema = v.object({
  offset: v.number(),
  limit: v.number(),
  scope: v.optional(bookmarkScopeSchema),
  currentPageUrl: v.optional(v.string()),
});

export const recallRecordsRequestSchema = v.object({ ids: stringArraySchema });

export const saveBookmarkRequestSchema = v.object({
  record: imageDisplayRecordSchema,
  options: v.optional(v.object({ clearStoredOriginal: v.optional(v.boolean()), requireEncrypted: v.optional(v.boolean()) })),
});

export const removeBookmarkRequestSchema = v.object({ record: imageDisplayRecordSchema });

export const removeBookmarksRequestSchema = v.object({ ids: stringArraySchema });

export const removeRecallBookmarksRequestSchema = v.object({
  offset: v.number(),
  scope: v.optional(bookmarkScopeSchema),
  currentPageUrl: v.optional(v.string()),
});

export const loadPanelPositionRequestSchema = v.object({ hostname: v.string() });

export const savePanelPositionRequestSchema = v.object({
  hostname: v.string(),
  position: panelPositionSchema,
});

export const deletePanelPositionRequestSchema = v.object({ hostname: v.string() });

export const loadWorkspaceLayoutRequestSchema = v.object({ hostname: v.string(), pageUrl: v.string() });

export const saveWorkspaceLayoutRequestSchema = v.object({
  hostname: v.string(),
  pageUrl: v.string(),
  layout: workspaceLayoutSchema,
});

export const deleteWorkspaceLayoutRequestSchema = v.object({ hostname: v.string(), pageUrl: v.string() });

export const loadParsedFieldStateRequestSchema = v.object({ hostname: v.string(), pageUrl: v.string() });

export const loadParsedFieldStateBySourceRequestSchema = v.object({ hostname: v.string(), sourceUrl: v.string() });

export const saveParsedFieldStateRequestSchema = v.object({ record: parsedFieldStateRecordSchema });

export const listUrlReviewStatusRequestSchema = v.object({ hostname: v.nullable(v.string()) });

export const saveUrlReviewStatusRequestSchema = v.object({ record: urlReviewStatusRecordSchema });

export const importUrlReviewStatusRequestSchema = v.object({
  records: v.pipe(v.array(urlReviewStatusRecordSchema), v.readonly()),
});

export const clearUrlReviewStatusRequestSchema = v.object({ filter: urlReviewStatusClearFilterSchema });

export const listUrlTemplatesRequestSchema = v.object({ hostname: v.string() });

export const saveUrlTemplateRequestSchema = v.object({ template: urlTemplateRecordSchema });

export const deleteUrlTemplateRequestSchema = v.object({ hostname: v.string(), id: v.string() });

export const listGrabSourcePatternsRequestSchema = v.object({ hostname: v.string() });

export const saveGrabSourcePatternRequestSchema = v.object({ pattern: grabSourcePatternSchema });

export const deleteGrabSourcePatternRequestSchema = v.object({ hostname: v.string(), id: v.string() });

export const loadLocalSettingsRequestSchema = v.object({ requestedAt: v.number() });

export const saveLocalSettingsRequestSchema = v.object({ settings: saveLocalSettingsPayloadSchema });

export const uploadPCloudBackupRequestSchema = pcloudBackupUploadInputSchema;

export const downloadPCloudBackupRequestSchema = pcloudBackupDownloadInputSchema;

export const deleteBlobRequestSchema = v.object({ blobId: v.string() });

export const retrieveBlobRequestSchema = v.object({ blobId: v.string() });

export const checkOriginalBlobsRequestSchema = v.object({ blobIds: stringArraySchema });

export const exportOriginalBlobsRequestSchema = v.object({ blobIds: stringArraySchema });

export const importOriginalBlobsRequestSchema = v.object({
  records: v.pipe(v.array(portableStoredBlobRecordSchema), v.readonly()),
});

export const createBlobPreviewRequestSchema = v.object({ blobId: v.string() });

export const createDataUrlPreviewRequestSchema = v.object({ dataUrl: v.string() });

export const fetchThumbnailSourceRequestSchema = v.object({
  url: v.string(),
  referrer: v.optional(v.string()),
  intent: v.optional(imageRequestIntentSchema),
  contextKey: v.optional(v.string()),
  sourceProfile: v.optional(imageSourceProfileSchema),
});

export const probeImageSourceRequestSchema = v.object({
  url: v.string(),
  referrer: v.optional(v.string()),
  timeoutMs: v.number(),
  contextKey: v.optional(v.string()),
  probeMethod: v.optional(imageProbeMethodSchema),
});

export const fetchBufferedImageSourceRequestSchema = v.object({
  url: v.string(),
  referrer: v.optional(v.string()),
  intent: v.optional(imageRequestIntentSchema),
  contextKey: v.optional(v.string()),
});

export const fetchBufferedImageSourceResultPayloadSchema = v.variant('ok', [
  v.object({
    ok: v.literal(true),
    dataUrl: v.pipe(v.string(), v.regex(/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]*={0,2}$/iu)),
    mimeType: v.pipe(v.string(), v.regex(/^image\/[a-z0-9.+-]+$/iu)),
    byteLength: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0)),
    sha256: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u))),
  }),
  v.object({ ok: v.literal(false), reason: v.string(), message: v.string() }),
]);

export const checkImageRequestPolicyRequestSchema = v.object({
  url: v.string(),
  referrer: v.optional(v.string()),
  intent: v.optional(imageRequestIntentSchema),
  contextKey: v.optional(v.string()),
});

export const fetchLinkedPageRequestSchema = v.object({
  url: v.string(),
  referrer: v.string(),
  maxBytes: v.number(),
  timeoutMs: v.number(),
});

export const setupBlobKeyRequestSchema = v.object({ password: v.string() });

export const unlockBlobKeyRequestSchema = v.object({
  password: v.string(),
  keyReference: v.optional(v.string()),
});

export const exportBlobKeyBackupRequestSchema = v.object({
  password: v.string(),
  keyReference: v.optional(v.string()),
});

export const importBlobKeyBackupRequestSchema = v.object({ fileContent: v.string(), password: v.string() });

export const grantPermissionAndCaptureRequestSchema = v.object({
  url: v.string(),
  sourceType: captureSourceTypeSchema,
  sourceRecordId: v.optional(v.string()),
  fileName: v.optional(v.string()),
});
