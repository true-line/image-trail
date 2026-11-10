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
