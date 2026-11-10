import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePasswordFrameConfig,
  isPasswordFrameSender,
  PASSWORD_FRAME_MESSAGE,
} from '../../extension/src/core/password-frame-protocol.js';
import { attachPasswordFrame, PASSWORD_SUBMIT_EVENT, passwordFrameRuntime } from '../../extension/src/ui/components/password-frame.js';

type Listener = (message: unknown, sender: { readonly id?: string; readonly url?: string }) => void;

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const FRAME_URL = `chrome-extension://${ID}/src/password-field/field.html`;
const listeners: Listener[] = [];
const runtime = {
  id: ID,
  getURL: (path: string) => `chrome-extension://${ID}/${path}`,
  onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
};

function mount(): {
  readonly input: HTMLInputElement;
  readonly frame: HTMLIFrameElement;
  readonly config: () => ReturnType<typeof decodePasswordFrameConfig>;
} {
  const input = document.createElement('input');
  input.type = 'password';
  const frame = attachPasswordFrame(runtime, input, { label: 'Backup password', placeholder: 'Backup', autocomplete: 'new-password' });
  document.body.append(frame, input);
  return { input, frame, config: () => decodePasswordFrameConfig(new URL(frame.src).hash) };
}

function deliver(message: unknown, sender: { readonly id?: string; readonly url?: string }): void {
  for (const listener of listeners) listener(message, sender);
}

test.afterEach(() => {
  document.body.replaceChildren();
});

test('unit and extension-page hosts keep an ordinary password input', () => {
  assert.equal(passwordFrameRuntime(), null);
});

test('the frame carries the visible control and the panel input is hidden and unfocusable', () => {
  const { input, frame, config } = mount();
  assert.equal(input.hidden, true);
  assert.equal(input.tabIndex, -1);
  assert.equal(frame.title, 'Backup password');
  assert.ok(frame.src.startsWith(`${FRAME_URL}#`));
  assert.deepEqual(
    { ...config(), id: '' },
    { id: '', label: 'Backup password', placeholder: 'Backup', autocomplete: 'new-password', disabled: false, clear: 0 },
  );
});

test('a value from the frame reaches the panel input without leaving the panel', () => {
  const { input, config } = mount();
  const id = config()?.id ?? '';
  const events: Event[] = [];
  input.addEventListener('input', (event) => events.push(event));
  deliver({ type: PASSWORD_FRAME_MESSAGE, id, kind: 'value', value: 'hunter2' }, { id: ID, url: `${FRAME_URL}#x` });
  assert.equal(input.value, 'hunter2');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.composed, false, 'the event must not cross the shadow boundary into the page');
});

test('Enter in the frame raises a panel-only submit event', () => {
  const { input, config } = mount();
  let submitted = 0;
  input.addEventListener(PASSWORD_SUBMIT_EVENT, (event) => {
    submitted += 1;
    assert.equal(event.composed, false);
  });
  deliver({ type: PASSWORD_FRAME_MESSAGE, id: config()?.id, kind: 'submit', value: 'pw' }, { id: ID, url: FRAME_URL });
  assert.equal(submitted, 1);
  assert.equal(input.value, 'pw');
});

test('messages from a page content script, another extension, or an unknown field are ignored', () => {
  const { input, config } = mount();
  const id = config()?.id ?? '';
  const message = { type: PASSWORD_FRAME_MESSAGE, id, kind: 'value', value: 'spoofed' };
  deliver(message, { id: ID, url: 'https://evil.test/page' });
  deliver(message, { id: 'someotherextensionidsomeotherext', url: FRAME_URL });
  deliver(message, { id: ID, url: `chrome-extension://${ID}/src/gallery/gallery.html` });
  deliver({ ...message, id: 'not-this-field' }, { id: ID, url: FRAME_URL });
  deliver({ ...message, kind: 'other' }, { id: ID, url: FRAME_URL });
  assert.equal(input.value, '');
});

test('clearing or disabling the panel input is mirrored into the frame', () => {
  const { input, config } = mount();
  deliver({ type: PASSWORD_FRAME_MESSAGE, id: config()?.id, kind: 'value', value: 'secret' }, { id: ID, url: FRAME_URL });
  input.value = '';
  assert.equal(input.value, '');
  assert.equal(config()?.clear, 1);
  input.disabled = true;
  assert.equal(input.disabled, true);
  assert.equal(config()?.disabled, true);
});

test('frame configuration rejects malformed input', () => {
  assert.equal(decodePasswordFrameConfig('#not-json'), null);
  assert.equal(decodePasswordFrameConfig('#%7B%7D'), null);
});

test('only the password frame of this extension is accepted as a frame sender', () => {
  assert.equal(isPasswordFrameSender({ id: ID, url: `${FRAME_URL}#config` }, ID), true);
  assert.equal(isPasswordFrameSender({ id: ID, url: 'https://evil.test/src/password-field/field.html' }, ID), false);
  assert.equal(isPasswordFrameSender({ id: 'other', url: FRAME_URL }, ID), false);
  assert.equal(isPasswordFrameSender({ id: ID }, ID), false);
});
