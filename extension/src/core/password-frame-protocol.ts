/**
 * Contract between the in-page panel and the extension-origin password frame.
 *
 * Keystrokes typed into a field that lives in a visited page are observable by that page, even
 * inside a closed shadow root. Password entry therefore happens in a frame served from the
 * extension's own origin; the frame hands the value to the panel over extension messaging.
 */

export const PASSWORD_FRAME_PATH = 'src/password-field/field.html';
export const PASSWORD_FRAME_MESSAGE = 'ImageTrailPasswordFrame';

export interface PasswordFrameConfig {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly autocomplete: string;
  readonly disabled: boolean;
  /** Incremented by the panel each time it wants the frame to forget the typed value. */
  readonly clear: number;
}

export interface PasswordFrameMessage {
  readonly type: typeof PASSWORD_FRAME_MESSAGE;
  readonly id: string;
  readonly kind: 'value' | 'submit';
  readonly value: string;
}

export function encodePasswordFrameConfig(config: PasswordFrameConfig): string {
  return encodeURIComponent(JSON.stringify(config));
}

export function decodePasswordFrameConfig(hash: string): PasswordFrameConfig | null {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(hash.replace(/^#/u, '')));
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value['id'] !== 'string' || value['id'] === '') return null;
    return {
      id: value['id'],
      label: typeof value['label'] === 'string' ? value['label'] : 'Password',
      placeholder: typeof value['placeholder'] === 'string' ? value['placeholder'] : '',
      autocomplete: typeof value['autocomplete'] === 'string' ? value['autocomplete'] : 'off',
      disabled: value['disabled'] === true,
      clear: typeof value['clear'] === 'number' ? value['clear'] : 0,
    };
  } catch {
    return null;
  }
}

export function isPasswordFrameMessage(message: unknown): message is PasswordFrameMessage {
  if (!message || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  return (
    value['type'] === PASSWORD_FRAME_MESSAGE &&
    typeof value['id'] === 'string' &&
    (value['kind'] === 'value' || value['kind'] === 'submit') &&
    typeof value['value'] === 'string'
  );
}

/**
 * True when a runtime message came from the password frame of this extension. Content scripts
 * report the visited page's URL, so an extension-scheme sender URL can only be the frame.
 */
export function isPasswordFrameSender(
  sender: { readonly id?: string | undefined; readonly url?: string | undefined },
  runtimeId: string,
): boolean {
  if (sender.id !== runtimeId || !sender.url) return false;
  try {
    const parsed = new URL(sender.url);
    return parsed.protocol === 'chrome-extension:' && parsed.pathname === `/${PASSWORD_FRAME_PATH}`;
  } catch {
    return false;
  }
}
