/**
 * Sender checks applied to every runtime message before dispatch.
 *
 * Content scripts run inside the visited page's renderer, so anything they put in a payload is
 * only as trustworthy as that page. The browser, not the payload, tells us who is asking.
 */

export interface MessageSenderLike {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
  readonly tab?: { readonly url?: string | undefined } | undefined;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True when the message was sent by this extension (a content script or one of its pages). */
export function isOwnExtensionSender(sender: MessageSenderLike, runtimeId: string): boolean {
  return sender.id === runtimeId;
}

/** True when the sender is one of this extension's own pages rather than a content script. */
export function isExtensionPageSender(sender: MessageSenderLike, runtimeId: string): boolean {
  return isOwnExtensionSender(sender, runtimeId) && sender.url?.startsWith(`chrome-extension://${runtimeId}/`) === true;
}

/**
 * The referrer decides whether cookies accompany an image request, so a content script may only
 * claim the origin the browser reports for it. A mismatched referrer is dropped, which makes the
 * request go out without credentials. Extension pages are trusted to name a record's source page.
 */
export function withSenderCheckedReferrer<T extends { readonly payload?: unknown }>(
  message: T,
  sender: MessageSenderLike,
  runtimeId: string,
): T {
  const payload = message.payload;
  if (!payload || typeof payload !== 'object' || !('referrer' in payload)) return message;
  const claimed = (payload as { readonly referrer?: unknown }).referrer;
  if (typeof claimed !== 'string') return message;
  if (isExtensionPageSender(sender, runtimeId)) return message;
  const senderOrigin = sender.origin ?? originOf(sender.url) ?? originOf(sender.tab?.url);
  if (senderOrigin !== null && senderOrigin !== 'null' && originOf(claimed) === senderOrigin) return message;
  return { ...message, payload: { ...payload, referrer: undefined } };
}

const PRIVATE_IPV4 = [/^127\./u, /^10\./u, /^192\.168\./u, /^169\.254\./u, /^172\.(1[6-9]|2\d|3[01])\./u, /^0\./u];

/** Loopback, link-local, and private-range hosts, plus the names that conventionally resolve to them. */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host)) return PRIVATE_IPV4.some((range) => range.test(host));
  if (!host.includes(':')) return false;
  if (host === '::1' || host === '::') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(host);
  if (mapped?.[1]) return PRIVATE_IPV4.some((range) => range.test(mapped[1] ?? ''));
  return /^f[cd]/u.test(host) || /^fe[89ab]/u.test(host);
}

function privateHttpTarget(url: unknown): URL | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isPrivateNetworkHost(parsed.hostname) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A page on the public internet must not be able to point the extension's privileged fetch at
 * a device on the user's own network, even when the user granted that host earlier. Pages that
 * are themselves on a private network, and the extension's own pages, are unaffected.
 */
export function publicPageTargetsPrivateNetwork(
  message: { readonly payload?: unknown },
  sender: MessageSenderLike,
  runtimeId: string,
): boolean {
  const payload = message.payload;
  if (!payload || typeof payload !== 'object' || !('url' in payload)) return false;
  const target = privateHttpTarget((payload as { readonly url?: unknown }).url);
  if (!target) return false;
  if (isExtensionPageSender(sender, runtimeId)) return false;
  const senderUrl = sender.url ?? sender.tab?.url ?? sender.origin;
  if (!senderUrl) return true;
  try {
    return !isPrivateNetworkHost(new URL(senderUrl).hostname);
  } catch {
    return true;
  }
}
