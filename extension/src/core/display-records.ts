import type { CaptureStatus, StoredOriginalReference } from './image/capture-result.js';

export interface ImageDisplayRecord {
  readonly id: string;
  readonly url: string;
  readonly title?: string | undefined;
  readonly label?: string | undefined;
  readonly thumbnail?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly timestamp: string;
  readonly queueUpdatedAt?: string | undefined;
  readonly pinnedAt?: string | undefined;
  readonly pinnedRecordId?: string | undefined;
  readonly downloadedAt?: string | undefined;
  readonly capturedAt?: string | undefined;
  readonly source?: 'history' | 'bookmark' | 'favorites' | undefined;
  readonly captureStatus?: CaptureStatus | undefined;
  readonly blobId?: string | undefined;
  readonly storedOriginal?: StoredOriginalReference | undefined;
  readonly pinSaveStorage?:
    | {
        readonly destination: 'encrypted' | 'plaintext';
        readonly reason?: 'setting' | 'locked' | 'unavailable' | 'failed' | undefined;
      }
    | undefined;
  readonly privacyStatus?: 'locked' | 'unlocked' | undefined;
  readonly protectedPin?:
    | {
        readonly plainPinId: string;
        readonly encryptedPinId?: string | undefined;
        readonly encryptedThumbnailId?: string | undefined;
        readonly storedOriginalBlobId?: string | undefined;
        readonly hasEncryptedMetadata: boolean;
        readonly hasEncryptedThumbnail: boolean;
        readonly hasStoredOriginal: boolean;
      }
    | undefined;
}

export const IMAGE_RECORD_EXTENSIONS = [
  'PNG',
  'JPG',
  'JPEG',
  'GIF',
  'WEBP',
  'TS',
  'MTS',
  'M2TS',
  'MP4',
  'M4V',
  'M4A',
  'MPEG4',
  'MOV',
  'QT',
  'WEBM',
  'WEBA',
  'MKV',
  'MKA',
  'AVI',
  'MPG',
  'MPEG',
  'MP2',
] as const;

export interface ImageRecordUrlValidation {
  readonly ok: boolean;
  readonly sourceUrl?: string;
  readonly message?: string;
}

export function normalizeDisplayLabel(record: Pick<ImageDisplayRecord, 'url' | 'title' | 'label'>): string {
  if (record.label?.trim()) {
    return record.label.trim();
  }
  if (record.title?.trim()) {
    return record.title.trim();
  }
  if (isDataMediaUrl(record.url)) {
    return dataMediaDisplayLabel(record.url);
  }

  try {
    const parsed = sourceImageUrlFrom(record.url);
    const filename = parsed.pathname.split('/').filter(Boolean).at(-1);
    return filename ? decodeURIComponent(filename) : parsed.hostname;
  } catch {
    return record.url;
  }
}

export function displayTitleForRecord(record: Pick<ImageDisplayRecord, 'url' | 'label' | 'title'>): string {
  return isDataMediaUrl(record.url) ? normalizeDisplayLabel(record) : record.url;
}

export function sourceImageUrlFrom(url: string): URL {
  const parsed = new URL(url);
  for (const key of ['u', 'url', 'imgurl', 'mediaurl']) {
    const sourceUrl = parsed.searchParams.get(key)?.trim();
    if (!sourceUrl) continue;
    try {
      return new URL(sourceUrl);
    } catch {
      // Fall back to the visible URL if the parameter is not itself a URL.
    }
  }
  return parsed;
}

export function isDurableImageSourceUrl(url: string): boolean {
  try {
    const sourceUrl = new URL(url);
    return sourceUrl.protocol === 'http:' || sourceUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

export function encryptedBlobIdForRecord(record: Pick<ImageDisplayRecord, 'captureStatus' | 'blobId'>): string | undefined {
  return record.captureStatus === 'captured' ? record.blobId : undefined;
}

export function recordHasStoredOriginal(record: Pick<ImageDisplayRecord, 'captureStatus' | 'storedOriginal' | 'protectedPin'>): boolean {
  return record.captureStatus === 'captured' || !!record.storedOriginal || record.protectedPin?.hasStoredOriginal === true;
}

export function withDurableQueueState(record: ImageDisplayRecord, durable: ImageDisplayRecord): ImageDisplayRecord {
  return {
    ...record,
    thumbnail: durable.thumbnail ?? record.thumbnail,
    width: durable.width ?? record.width,
    height: durable.height ?? record.height,
    pinnedAt: durable.queueUpdatedAt ?? durable.timestamp,
    pinnedRecordId: durable.id,
    captureStatus: durable.captureStatus,
    blobId: durable.blobId,
    capturedAt: durable.capturedAt,
    storedOriginal: durable.storedOriginal,
    protectedPin: durable.protectedPin,
  };
}

export function withoutStoredOriginal(record: ImageDisplayRecord): ImageDisplayRecord {
  const protectedPin = record.protectedPin
    ? { ...record.protectedPin, storedOriginalBlobId: undefined, hasStoredOriginal: false }
    : undefined;
  return {
    ...record,
    captureStatus: undefined,
    blobId: undefined,
    capturedAt: undefined,
    storedOriginal: undefined,
    protectedPin,
  };
}

export function validateImageRecordUrl(url: string): ImageRecordUrlValidation {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(url);
  } catch {
    return { ok: false, message: 'Image Trail could not save this URL because it is not a valid URL.' };
  }

  if (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') {
    return { ok: false, message: 'Only http(s) image URLs can be saved to Image Trail.' };
  }

  return { ok: true, sourceUrl: sourceUrl.href };
}

export function imageExtensionFromUrl(url: string): string | null {
  const dataImageType = imageExtensionFromDataImageUrl(url);
  if (dataImageType) return dataImageType;
  try {
    return imageExtensionFromParsedUrl(sourceImageUrlFrom(url));
  } catch {
    return imageExtensionFromValue(url);
  }
}

export function imageExtensionForRecord(
  record: Pick<ImageDisplayRecord, 'url' | 'title' | 'label' | 'thumbnail' | 'storedOriginal'>,
): string | null {
  return (
    imageExtensionFromValue(record.storedOriginal?.fileName) ??
    imageExtensionFromImageType(record.storedOriginal?.mimeType) ??
    imageExtensionFromValue(record.label) ??
    imageExtensionFromValue(record.title) ??
    imageExtensionFromUrl(record.url) ??
    imageExtensionFromUrl(record.thumbnail ?? '')
  );
}

export function imageExtensionFromValue(value: string | undefined): string | null {
  if (!value) return null;
  const cleanName = value.split(/[?#]/u)[0] ?? value;
  const extension = cleanName.match(/\.([a-z0-9]+)$/iu)?.[1]?.toUpperCase();
  if (extension && isImageRecordExtension(extension)) return extension;
  return /(?:^|[/.-])OIP[.-]/iu.test(cleanName) ? 'JPG' : null;
}

function imageExtensionFromParsedUrl(url: URL): string | null {
  return imageExtensionFromValue(url.pathname) ?? imageExtensionFromImageQuery(url);
}

function imageExtensionFromImageQuery(url: URL): string | null {
  for (const key of ['format', 'fm', 'ext', 'type', 'mime', 'mimeType']) {
    const extension = imageExtensionFromImageType(url.searchParams.get(key)?.trim());
    if (extension) return extension;
  }
  return null;
}

function imageExtensionFromImageType(value: string | null | undefined): string | null {
  if (!value) return null;
  const mediaExtension = (
    {
      'video/mp2t': 'TS',
      'video/mp4': 'MP4',
      'audio/mp4': 'M4A',
      'video/quicktime': 'MOV',
      'video/webm': 'WEBM',
      'audio/webm': 'WEBA',
      'video/x-matroska': 'MKV',
      'audio/x-matroska': 'MKA',
      'video/x-msvideo': 'AVI',
      'audio/x-msvideo': 'AVI',
      'video/mpeg': 'MPG',
      'audio/mpeg': 'MP2',
    } as Record<string, string>
  )[value.toLowerCase()];
  if (mediaExtension && isImageRecordExtension(mediaExtension)) return mediaExtension;
  const normalized = value
    .toUpperCase()
    .replace(/^IMAGE\//u, '')
    .replace(/^JPE?G$/u, (match) => (match === 'JPG' ? 'JPG' : 'JPEG'));
  return isImageRecordExtension(normalized) ? normalized : null;
}

function isImageRecordExtension(value: string): value is (typeof IMAGE_RECORD_EXTENSIONS)[number] {
  return (IMAGE_RECORD_EXTENSIONS as readonly string[]).includes(value);
}

export function createDisplayRecord(
  input: Omit<ImageDisplayRecord, 'id' | 'label' | 'timestamp'> & {
    readonly id?: string | undefined;
    readonly label?: string | undefined;
    readonly timestamp?: string | undefined;
  },
): ImageDisplayRecord {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const id = input.id ?? createDisplayRecordId(timestamp, input.url);
  const draft = { ...input, id, timestamp };
  return { ...draft, label: normalizeDisplayLabel(draft) };
}

function createDisplayRecordId(timestamp: string, url: string): string {
  if (!isDataMediaUrl(url)) return `${timestamp}:${url}`;
  const mimeType = dataMediaMimeType(url)?.replace(/[^a-z0-9.+-]/giu, '-') ?? 'media';
  return `${timestamp}:data:${mimeType}:${url.length}`;
}

function isDataMediaUrl(url: string): boolean {
  return /^data:(?:image|video|audio)\//iu.test(url);
}

function dataMediaDisplayLabel(url: string): string {
  const extension = imageExtensionFromDataImageUrl(url);
  if (/^data:(?:video|audio)\//iu.test(url)) return extension ? `Data URL media (${extension})` : 'Data URL media';
  return extension ? `Data URL image (${extension})` : 'Data URL image';
}

function dataMediaMimeType(url: string): string | null {
  return /^data:((?:image|video|audio)\/[a-z0-9.+-]+)[;,]/iu.exec(url)?.[1]?.toLowerCase() ?? null;
}

function imageExtensionFromDataImageUrl(url: string): string | null {
  return imageExtensionFromImageType(dataMediaMimeType(url));
}

/**
 * Thumbnails the extension generates are always inline `data:image/` URLs. Anything else comes
 * from a file the user imported, and rendering it would make an extension page request a
 * remote URL chosen by whoever wrote that file.
 */
export function inlineImageThumbnail(thumbnail: string | undefined): string | undefined {
  return thumbnail !== undefined && /^data:image\//iu.test(thumbnail) ? thumbnail : undefined;
}
