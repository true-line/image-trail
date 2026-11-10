import { redirectEntersPrivateNetwork } from './message-sender.js';
import type { CaptureFailureReason } from '../core/image/capture-result.js';
import { DEFAULT_MAX_ORIGINAL_BYTES } from '../core/image/capture-result.js';
import { alignFilenameWithVerifiedExtension, sanitizeFilename } from '../core/image/downloads.js';
import { commonMediaHint } from '../core/media/common-media.js';
import { inspectSpecializedMedia } from '../core/media/inspect-media.js';
import { hasMpegTsHint } from '../core/media/mpeg-ts-hints.js';
import type { StoredMediaInfo } from '../core/media/media-info.js';

const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'video/mp2t',
  'video/mp4',
  'audio/mp4',
  'video/quicktime',
  'video/webm',
  'audio/webm',
  'video/x-matroska',
  'audio/x-matroska',
  'video/x-msvideo',
  'audio/x-msvideo',
  'video/mpeg',
  'audio/mpeg',
]);

export interface FetchImageSuccess {
  readonly ok: true;
  readonly bytes: ArrayBuffer;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly fileName?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly mediaInfo?: StoredMediaInfo | undefined;
}

export interface FetchImageFailure {
  readonly ok: false;
  readonly reason: CaptureFailureReason;
  readonly message: string;
}

export type FetchImageResult = FetchImageSuccess | FetchImageFailure;

export interface FetchImageOptions {
  readonly referrer?: string | undefined;
}

type BoundedBodyResult = { readonly ok: true; readonly bytes: ArrayBuffer } | FetchImageFailure;

export function preferredCaptureFileName(result: Pick<FetchImageSuccess, 'fileName'>, requestedFileName?: string): string | undefined {
  return result.fileName ?? requestedFileName;
}

export async function fetchImageBytes(
  url: string,
  maxBytes: number = DEFAULT_MAX_ORIGINAL_BYTES,
  options: FetchImageOptions = {},
): Promise<FetchImageResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: credentialsForImageRequest(url, options.referrer),
    });
  } catch {
    return { ok: false, reason: 'network-error', message: 'Network request failed.' };
  }

  if (response.url && redirectEntersPrivateNetwork(url, response.url)) {
    return { ok: false, reason: 'fetch-forbidden', message: 'Redirect into a private network was blocked.' };
  }
  const statusFailure = responseStatusFailure(response);
  if (statusFailure) return statusFailure;

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const responseUrl = response.url || url;
  const specializedHint = hasMpegTsHint(contentType, responseUrl) || commonMediaHint(contentType, responseUrl);
  if (!ALLOWED_MEDIA_TYPES.has(contentType) && !specializedHint) {
    return { ok: false, reason: 'not-image', message: `Response content-type "${contentType}" is not supported media.` };
  }

  const declaredLength = response.headers.get('content-length');
  if (declaredLength && parseInt(declaredLength, 10) > maxBytes) {
    return { ok: false, reason: 'too-large', message: `Declared size ${declaredLength} bytes exceeds limit.` };
  }

  const body = await readBoundedResponseBody(response, maxBytes);
  if (!body.ok) return body;
  return classifyFetchedMedia(response, responseUrl, body.bytes, contentType, specializedHint);
}

function responseStatusFailure(response: Response): FetchImageFailure | null {
  if (response.status === 401) return { ok: false, reason: 'auth-required', message: 'Authentication required.' };
  if (response.status === 403) return { ok: false, reason: 'fetch-forbidden', message: 'Access forbidden by server.' };
  return response.ok ? null : { ok: false, reason: 'network-error', message: `HTTP ${response.status} ${response.statusText}` };
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<BoundedBodyResult> {
  try {
    if (!response.body) {
      // Fallback for environments where ReadableStream is unavailable.
      const bytes = await response.arrayBuffer();
      return bytes.byteLength > maxBytes
        ? { ok: false, reason: 'too-large', message: `Actual size ${bytes.byteLength} bytes exceeds limit.` }
        : { ok: true, bytes };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: 'too-large', message: `Actual size exceeds limit of ${maxBytes} bytes.` };
      }
      chunks.push(value);
    }
    return { ok: true, bytes: mergeChunks(chunks, totalBytes) };
  } catch {
    return { ok: false, reason: 'network-error', message: 'Failed to read response body.' };
  }
}

function mergeChunks(chunks: readonly Uint8Array[], totalBytes: number): ArrayBuffer {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function classifyFetchedMedia(
  response: Response,
  responseUrl: string,
  bytes: ArrayBuffer,
  contentType: string,
  specializedHint: boolean,
): FetchImageResult {
  const media = inspectSpecializedMedia(bytes, contentType, responseUrl);
  if (media.status === 'invalid') {
    return {
      ok: false,
      reason: media.reason === 'probe-limit' ? 'too-large' : specializedHint ? 'not-media' : 'not-image',
      message: media.message,
    };
  }
  if (media.status === 'supported') {
    const fallbackExtension =
      media.mediaInfo.kind === 'common-media'
        ? (media.extension ?? 'bin')
        : media.mediaInfo.kind === 'mpeg-ts'
          ? (media.extension ?? 'ts')
          : media.mediaInfo.kind;
    const fallbackBase = media.mediaInfo.kind === 'gif' || media.mediaInfo.kind === 'webp' ? 'image' : 'media';
    return {
      ok: true,
      bytes,
      mimeType: media.mimeType,
      byteLength: bytes.byteLength,
      fileName: originalMediaFileName(response.headers.get('content-disposition'), responseUrl, fallbackExtension, fallbackBase),
      width: media.width,
      height: media.height,
      mediaInfo: media.mediaInfo,
    };
  }
  return { ok: true, bytes, mimeType: contentType, byteLength: bytes.byteLength };
}

export function credentialsForImageRequest(url: string, referrer: string | undefined): RequestCredentials {
  if (!referrer) return 'omit';
  try {
    return new URL(url).origin === new URL(referrer).origin ? 'include' : 'omit';
  } catch {
    return 'omit';
  }
}

function originalMediaFileName(
  contentDisposition: string | null,
  url: string,
  fallbackExtension: string,
  fallbackBase: 'image' | 'media',
): string {
  const dispositionName = fileNameFromContentDisposition(contentDisposition);
  const urlName = fileNameFromUrlPath(url);
  const sanitized = sanitizeOriginalFileName(dispositionName ?? urlName ?? fallbackBase, fallbackBase);
  return alignFilenameWithVerifiedExtension(sanitized, fallbackExtension, fallbackBase);
}

function fileNameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(value)?.[1]?.trim();
  if (encoded) {
    try {
      return decodeURIComponent(stripHeaderQuotes(encoded));
    } catch {
      // Fall back to the plain filename parameter or URL path.
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/iu.exec(value);
  return plain ? (plain[1] ?? plain[2] ?? '').trim() || null : null;
}

function fileNameFromUrlPath(value: string): string | null {
  try {
    const segment = new URL(value).pathname.split('/').filter(Boolean).at(-1);
    if (!segment) return null;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  } catch {
    return null;
  }
}

function sanitizeOriginalFileName(value: string, fallback: string): string {
  const leaf = value.split(/[\\/]/u).at(-1) ?? fallback;
  return sanitizeFilename(leaf, fallback, 240);
}

function stripHeaderQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
