import { redirectEntersPrivateNetwork } from './message-sender.js';
import { credentialsForImageRequest } from './fetch-image.js';
import type { FetchLinkedPageMessage, FetchLinkedPageResultMessage } from './messages.js';
import { hasOriginPermission } from './permissions.js';

const MAX_LINKED_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_LINKED_PAGE_TIMEOUT_MS = 15_000;
const MAX_LINKED_PAGE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface FetchLinkedPageDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly hasPermission?: (origin: string) => Promise<boolean>;
}

export async function fetchLinkedPage(
  message: FetchLinkedPageMessage,
  dependencies: FetchLinkedPageDependencies = {},
): Promise<FetchLinkedPageResultMessage['payload']> {
  const url = toHttpUrl(message.payload.url);
  if (!url) {
    return { ok: false, reason: 'unsupported-url', message: 'Linked page URL must use HTTP or HTTPS.' };
  }

  const maxBytes = Math.min(MAX_LINKED_PAGE_BYTES, Math.max(32_768, message.payload.maxBytes));
  const timeoutMs = Math.min(MAX_LINKED_PAGE_TIMEOUT_MS, Math.max(1000, message.payload.timeoutMs));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetched = await fetchWithPrivateRedirects({
      url,
      referrer: message.payload.referrer,
      signal: controller.signal,
      fetchImpl: dependencies.fetchImpl ?? fetch,
      hasPermission: dependencies.hasPermission ?? hasOriginPermission,
    });
    if (!fetched.ok) return fetched.result;
    const { response, finalUrl } = fetched;
    if (!response.ok) return { ok: false, reason: 'http-error', message: `Linked page returned ${response.status}.` };
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > maxBytes) {
      return { ok: false, reason: 'too-large', message: 'Linked page is larger than the strategy limit.' };
    }

    const result = await readLimitedText(response, maxBytes);
    return { ok: true, text: result.text, byteLength: result.byteLength, finalUrl };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { ok: false, reason: 'timeout', message: 'Linked page fetch timed out.' };
    }
    if (error instanceof Error && error.message === 'too-large') {
      return { ok: false, reason: 'too-large', message: 'Linked page is larger than the strategy limit.' };
    }
    return { ok: false, reason: 'network-error', message: 'Linked page fetch failed.' };
  } finally {
    clearTimeout(timeout);
  }
}

const PRIVATE_REDIRECT_BLOCKED: FetchLinkedPageResultMessage['payload'] = {
  ok: false,
  reason: 'network-error',
  message: 'Linked page redirect into a private network was blocked.',
};

async function fetchWithPrivateRedirects(input: {
  readonly url: URL;
  readonly referrer: string;
  readonly signal: AbortSignal;
  readonly fetchImpl: typeof fetch;
  readonly hasPermission: (origin: string) => Promise<boolean>;
}): Promise<
  | { readonly ok: true; readonly response: Response; readonly finalUrl: string }
  | { readonly ok: false; readonly result: FetchLinkedPageResultMessage['payload'] }
> {
  let current = input.url;
  for (let redirectCount = 0; redirectCount <= MAX_LINKED_PAGE_REDIRECTS; redirectCount += 1) {
    if (!(await input.hasPermission(current.origin))) {
      return {
        ok: false,
        result: {
          ok: false,
          reason: 'permission-needed',
          message: `Permission needed for ${current.origin}.`,
          origin: current.origin,
        },
      };
    }
    const response = await input.fetchImpl(current.href, {
      credentials: credentialsForImageRequest(current.href, input.referrer),
      redirect: 'manual',
      signal: input.signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.type === 'opaqueredirect') {
        return {
          ok: false,
          result: { ok: false, reason: 'network-error', message: 'Linked page redirect could not be inspected safely.' },
        };
      }
      const finalUrl = response.url || current.href;
      if (redirectEntersPrivateNetwork(input.url.href, finalUrl)) return { ok: false, result: PRIVATE_REDIRECT_BLOCKED };
      return { ok: true, response, finalUrl };
    }
    if (redirectCount === MAX_LINKED_PAGE_REDIRECTS) {
      return {
        ok: false,
        result: { ok: false, reason: 'network-error', message: 'Linked page redirected too many times.' },
      };
    }
    const next = redirectTarget(response, current);
    if (!next) {
      return {
        ok: false,
        result: { ok: false, reason: 'unsupported-url', message: 'Linked page redirect must use HTTP or HTTPS.' },
      };
    }
    if (redirectEntersPrivateNetwork(input.url.href, next.href)) return { ok: false, result: PRIVATE_REDIRECT_BLOCKED };
    current = next;
  }
  return { ok: false, result: { ok: false, reason: 'network-error', message: 'Linked page fetch failed.' } };
}

function redirectTarget(response: Response, current: URL): URL | null {
  const location = response.headers.get('location');
  if (!location) return null;
  try {
    return toHttpUrl(new URL(location, current).href);
  } catch {
    return null;
  }
}

function toHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<{ readonly text: string; readonly byteLength: number }> {
  if (!response.body) {
    const text = await response.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) throw new Error('too-large');
    return { text, byteLength };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new Error('too-large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), byteLength };
}
