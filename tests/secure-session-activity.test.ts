import assert from 'node:assert/strict';
import test from 'node:test';

import { SecureSessionActivityController } from '../extension/src/content/secure-session-activity.js';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('throttles pointer and keyboard activity through the extension-owned channel', async () => {
  const target = new EventTarget();
  let now = 1_000;
  let sent = 0;
  const controller = new SecureSessionActivityController({
    now: () => now,
    isTrustedActivity: () => true,
    sendActivity: async () => {
      sent += 1;
      return { unlocked: true };
    },
    onLocked: () => assert.fail('session should remain unlocked'),
  });
  controller.connect(target);

  target.dispatchEvent(new Event('pointermove'));
  target.dispatchEvent(new Event('pointerdown'));
  target.dispatchEvent(new Event('keydown'));
  await flush();
  assert.equal(sent, 1);

  now += 14_999;
  target.dispatchEvent(new Event('pointermove'));
  await flush();
  assert.equal(sent, 1);

  now += 1;
  target.dispatchEvent(new Event('keydown'));
  await flush();
  assert.equal(sent, 2);
});

test('refreshes locked UI status and disconnects all activity listeners', async () => {
  const target = new EventTarget();
  const lockedMessages: string[] = [];
  let sent = 0;
  const controller = new SecureSessionActivityController({
    isTrustedActivity: () => true,
    sendActivity: async () => {
      sent += 1;
      return { unlocked: false, message: 'Unlock to continue.' };
    },
    onLocked: (message) => lockedMessages.push(message),
  });
  controller.connect(target);
  target.dispatchEvent(new Event('pointerdown'));
  await flush();
  assert.deepEqual(lockedMessages, ['Unlock to continue.']);

  controller.disconnect();
  target.dispatchEvent(new Event('keydown'));
  await flush();
  assert.equal(sent, 1);
});

test('ignores synthetic host-page activity by default', async () => {
  const target = new EventTarget();
  let sent = 0;
  const controller = new SecureSessionActivityController({
    sendActivity: async () => {
      sent += 1;
      return { unlocked: true };
    },
    onLocked: () => assert.fail('synthetic activity must not reach the session'),
  });
  controller.connect(target);

  target.dispatchEvent(new Event('pointermove'));
  target.dispatchEvent(new Event('keydown'));
  await flush();

  assert.equal(sent, 0);
});

test('activity reported from the password frame shares the throttle with page activity', async () => {
  let now = 1_000;
  let sent = 0;
  const controller = new SecureSessionActivityController({
    now: () => now,
    sendActivity: async () => {
      sent += 1;
      return { unlocked: true };
    },
    onLocked: () => assert.fail('session should remain unlocked'),
  });

  controller.noteActivity();
  controller.noteActivity();
  await flush();
  assert.equal(sent, 1);
  now += 15_000;
  controller.noteActivity();
  await flush();
  assert.equal(sent, 2);
});
