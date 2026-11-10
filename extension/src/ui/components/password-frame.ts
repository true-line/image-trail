import {
  encodePasswordFrameConfig,
  isPasswordFrameMessage,
  PASSWORD_FRAME_PATH,
  type PasswordFrameConfig,
} from '../../core/password-frame-protocol.js';
import { isTrustedPanelEvent } from './trusted-events.js';

/** Fired on the field's input (not composed, so it never leaves the panel) when Enter is pressed in the frame. */
export const PASSWORD_SUBMIT_EVENT = 'image-trail-password-submit';

/** Runs `submit` for Enter typed in a plain password input or in the frame that stands in for it. */
export function onPasswordSubmit(input: HTMLInputElement, submit: () => void): void {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !isTrustedPanelEvent(event)) return;
    event.preventDefault();
    submit();
  });
  input.addEventListener(PASSWORD_SUBMIT_EVENT, submit);
}

interface FrameRuntime {
  readonly id: string;
  getURL(path: string): string;
  readonly onMessage: {
    addListener(listener: (message: unknown, sender: { readonly id?: string; readonly url?: string }) => void): void;
  };
}

const receivers = new Map<string, WeakRef<HTMLInputElement>>();
let listening = false;

/**
 * The extension runtime, when this UI is hosted inside a visited page. Extension pages, unit
 * tests and Storybook get `null` and keep an ordinary password input: nothing hostile shares
 * their document.
 */
export function passwordFrameRuntime(): FrameRuntime | null {
  if (typeof chrome === 'undefined' || typeof location === 'undefined') return null;
  const runtime = chrome.runtime as Partial<FrameRuntime> | undefined;
  if (!runtime?.id || typeof runtime.getURL !== 'function' || !runtime.onMessage) return null;
  if (location.protocol === 'chrome-extension:') return null;
  return runtime as FrameRuntime;
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
}

/** Content scripts report the visited page's URL, so an extension-scheme sender URL can only be the frame. */
function isPasswordFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome-extension:' && parsed.pathname === `/${PASSWORD_FRAME_PATH}`;
  } catch {
    return false;
  }
}

function listen(runtime: FrameRuntime): void {
  if (listening) return;
  listening = true;
  runtime.onMessage.addListener((message, sender) => {
    if (!isPasswordFrameMessage(message)) return;
    if (sender.id !== runtime.id || !isPasswordFrameUrl(sender.url)) return;
    const input = receivers.get(message.id)?.deref();
    if (!input) {
      receivers.delete(message.id);
      return;
    }
    setNativeValue(input, message.value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (message.kind === 'submit') input.dispatchEvent(new Event(PASSWORD_SUBMIT_EVENT, { bubbles: true }));
  });
}

/**
 * Replaces the visible control of a password input with an extension-origin frame. `input`
 * stays in the panel, hidden and never focused, as the place the views read the value from;
 * it is only ever written by script, which the host page cannot observe.
 */
export function attachPasswordFrame(
  runtime: FrameRuntime,
  input: HTMLInputElement,
  options: Pick<PasswordFrameConfig, 'label' | 'placeholder' | 'autocomplete'>,
): HTMLIFrameElement {
  listen(runtime);
  const id = crypto.randomUUID();
  receivers.set(id, new WeakRef(input));
  let clear = 0;

  const frame = document.createElement('iframe');
  frame.className = 'image-trail-panel__password-frame';
  frame.title = options.label;
  frame.setAttribute('scrolling', 'no');
  const sync = (): void => {
    frame.src = `${runtime.getURL(PASSWORD_FRAME_PATH)}#${encodePasswordFrameConfig({ ...options, id, disabled: input.disabled, clear })}`;
  };

  const disabled = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'disabled');
  Object.defineProperty(input, 'disabled', {
    configurable: true,
    get: () => disabled?.get?.call(input) === true,
    set: (value: boolean) => {
      disabled?.set?.call(input, value);
      sync();
    },
  });
  const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => String(value?.get?.call(input) ?? ''),
    set: (next: string) => {
      setNativeValue(input, next);
      if (next !== '') return;
      clear += 1;
      sync();
    },
  });
  input.focus = () => frame.focus();
  input.hidden = true;
  input.tabIndex = -1;
  input.required = false;
  sync();
  return frame;
}
