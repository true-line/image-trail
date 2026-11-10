import { decodePasswordFrameConfig, PASSWORD_FRAME_MESSAGE } from '../core/password-frame-protocol.js';
import type { PasswordFrameMessage } from '../core/password-frame-protocol.js';

/**
 * Runs inside the extension-origin frame the panel embeds for password entry. The visited page
 * cannot observe keyboard or input events here. Values go to the panel's content script with
 * `chrome.tabs.sendMessage`, never `postMessage`, so the page never receives them.
 */

const input = document.getElementById('password') as HTMLInputElement | null;
let tabId: number | undefined;
let cleared = 0;

function send(kind: PasswordFrameMessage['kind']): void {
  const config = decodePasswordFrameConfig(location.hash);
  if (!input || !config || tabId === undefined) return;
  const message: PasswordFrameMessage = { type: PASSWORD_FRAME_MESSAGE, id: config.id, kind, value: input.value };
  void chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

function applyConfig(): void {
  const config = decodePasswordFrameConfig(location.hash);
  if (!input || !config) return;
  input.placeholder = config.placeholder;
  input.setAttribute('aria-label', config.label);
  input.setAttribute('autocomplete', config.autocomplete);
  input.disabled = config.disabled;
  if (config.clear !== cleared) {
    cleared = config.clear;
    input.value = '';
  }
}

if (input) {
  applyConfig();
  cleared = decodePasswordFrameConfig(location.hash)?.clear ?? 0;
  window.addEventListener('hashchange', applyConfig);
  window.addEventListener('focus', () => input.focus());
  input.addEventListener('input', () => send('value'));
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.isTrusted) return;
    event.preventDefault();
    send('submit');
  });
  void chrome.tabs.getCurrent().then((tab) => {
    tabId = tab?.id;
    if (input.value !== '') send('value');
  });
}
