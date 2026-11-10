import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyboardRouter } from '../../extension/src/content/keyboard.js';
import { dispatchTrustedKeydown, dispatchTrustedKeyup } from './trusted-events.js';

function dispatchSyntheticKey(target: EventTarget, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

const dispatchKey = dispatchTrustedKeydown;

function dispatchKeyUp(target: EventTarget, key: string, options: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...options }));
}

test('router handles approved bare keys case-insensitively and leaves modifiers to the browser', () => {
  const actions: string[] = [];
  const router = new KeyboardRouter((action) => {
    actions.push(action);
    return true;
  });
  router.enable();
  try {
    assert.equal(dispatchTrustedKeydown(document, 'C', { shiftKey: true }).defaultPrevented, true);
    assert.equal(dispatchKey(document, '?', { shiftKey: true }).defaultPrevented, true);
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      assert.equal(dispatchKey(document, 'c', modifiers).defaultPrevented, false);
    }
    assert.deepEqual(actions, ['capture-current', 'help-toggle']);
  } finally {
    router.disable();
  }
});

test('router preserves typing controls and native record-row behavior', () => {
  const actions: string[] = [];
  const router = new KeyboardRouter((action) => {
    actions.push(action);
    return true;
  });
  const input = document.createElement('input');
  const row = document.createElement('div');
  row.dataset['imageTrailRowId'] = 'record-1';
  const rowButton = document.createElement('button');
  row.append(rowButton);
  document.body.append(input, row);
  router.enable();
  try {
    assert.equal(dispatchKey(input, 'c').defaultPrevented, false);
    assert.equal(dispatchKey(rowButton, 'ArrowDown').defaultPrevented, false);
    assert.equal(dispatchKey(rowButton, 'p').defaultPrevented, false);
    assert.deepEqual(actions, []);
  } finally {
    router.disable();
    input.remove();
    row.remove();
  }
});

test('Shift modifier state follows trusted page keys, ignores synthetic keys, and clears on blur and disable', () => {
  const changes: boolean[] = [];
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const router = new KeyboardRouter(
    () => false,
    undefined,
    (active) => changes.push(active),
  );
  const input = document.createElement('input');
  document.body.append(input);
  router.enable();
  try {
    dispatchSyntheticKey(input, 'Shift', { shiftKey: true });
    assert.deepEqual(changes, [], 'typing modifiers remain native');
    dispatchSyntheticKey(document, 'Shift', { shiftKey: true });
    dispatchKeyUp(document, 'Shift');
    assert.deepEqual(changes, [], 'host-page synthetic key transitions cannot select the Pin modifier');
    dispatchTrustedKeydown(document, 'Shift', { shiftKey: true });
    dispatchTrustedKeydown(document, 'Shift', { shiftKey: true });
    assert.deepEqual(changes, [true], 'repeated keydown does not duplicate state');
    dispatchKeyUp(document, 'Shift');
    assert.deepEqual(changes, [true], 'a synthetic keyup cannot mutate a trusted active modifier');
    dispatchTrustedKeyup(document, 'Shift');
    assert.deepEqual(changes, [true, false]);
    dispatchTrustedKeydown(document, 'Shift', { shiftKey: true });
    window.dispatchEvent(new Event('blur'));
    assert.deepEqual(changes, [true, false, true], 'synthetic blur must not clear trusted modifier');
    {
      const event = new FocusEvent('blur');
      Object.defineProperty(event, 'isTrusted', { value: true });
      window.dispatchEvent(event);
    }
    assert.deepEqual(changes, [true, false, true, false]);
    dispatchTrustedKeydown(document, 'Shift', { shiftKey: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    assert.deepEqual(changes, [true, false, true, false, true, false]);
    dispatchTrustedKeydown(document, 'Shift', { shiftKey: true });
  } finally {
    if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    else Reflect.deleteProperty(document, 'visibilityState');
    router.disable();
    input.remove();
  }
  assert.deepEqual(changes, [true, false, true, false, true, false, true, false]);
});

test('an unassigned Down action remains native because the handler declines it', () => {
  const actions: string[] = [];
  const router = new KeyboardRouter((action) => {
    actions.push(action);
    return false;
  });
  router.enable();
  try {
    assert.equal(dispatchTrustedKeydown(document, 'ArrowDown').defaultPrevented, false);
    assert.deepEqual(actions, ['down-arrow']);
  } finally {
    router.disable();
  }
});

test('router rejects every synthetic shortcut and routes the same keys when trusted', () => {
  const actions: string[] = [];
  const router = new KeyboardRouter((action) => {
    actions.push(action);
    return true;
  });
  router.enable();
  try {
    for (const key of ['c', 'p', 'b', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Escape']) {
      assert.equal(dispatchSyntheticKey(document, key).defaultPrevented, false, `synthetic ${key} is ignored`);
    }
    assert.equal(dispatchSyntheticKey(document, '?', { shiftKey: true }).defaultPrevented, false);
    assert.deepEqual(actions, []);

    assert.equal(dispatchTrustedKeydown(document, 'ArrowRight').defaultPrevented, true);
    assert.equal(dispatchTrustedKeydown(document, '?', { shiftKey: true }).defaultPrevented, true);
    assert.equal(dispatchTrustedKeydown(document, 'c').defaultPrevented, true);
    assert.equal(dispatchTrustedKeydown(document, 'p').defaultPrevented, true);
    assert.equal(dispatchTrustedKeydown(document, 'b').defaultPrevented, true);
    assert.equal(dispatchTrustedKeydown(document, 'ArrowDown').defaultPrevented, true);
    assert.deepEqual(actions, ['next', 'help-toggle', 'capture-current', 'pin-current', 'capture-and-bookmark', 'down-arrow']);
  } finally {
    router.disable();
  }
});

test('Escape inside a detached window remains owned by its local restore handler', () => {
  const actions: string[] = [];
  const router = new KeyboardRouter((action) => {
    actions.push(action);
    return true;
  });
  const detachedWindow = document.createElement('aside');
  detachedWindow.dataset['imageTrailDetachedWindow'] = 'history';
  const restore = document.createElement('button');
  detachedWindow.append(restore);
  document.body.append(detachedWindow);
  router.enable();
  try {
    assert.equal(dispatchKey(restore, 'Escape').defaultPrevented, false);
    assert.deepEqual(actions, []);
    assert.equal(dispatchKey(restore, 'g').defaultPrevented, true);
    assert.deepEqual(actions, ['grab-mode-toggle']);
  } finally {
    router.disable();
    detachedWindow.remove();
  }
});
