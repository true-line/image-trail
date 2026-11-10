import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionStorageForContext } from '../extension/src/background/session-storage-context.js';

function withChrome<T>(value: unknown, run: () => T): T {
  const original = globalThis.chrome;
  globalThis.chrome = value as typeof chrome;
  try {
    return run();
  } finally {
    globalThis.chrome = original;
  }
}

test('the regular instance uses chrome.storage.session', () => {
  const session = { marker: 'shared-session-area' };
  const storage = withChrome({ extension: { inIncognitoContext: false }, storage: { session } }, () => sessionStorageForContext());
  assert.equal(storage, session);
});

test('the incognito instance gets a private in-memory area and never touches chrome.storage.session', async () => {
  const touched: string[] = [];
  const session = new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.push(String(property));
        return async () => ({});
      },
    },
  );
  const storage = withChrome({ extension: { inIncognitoContext: true }, storage: { session } }, () => sessionStorageForContext());
  assert.ok(storage);
  assert.notEqual(storage, session);

  await storage.set({ recents: ['a'], key: 'k' });
  assert.deepEqual(await storage.get('recents'), { recents: ['a'] });
  assert.deepEqual(await storage.get('missing'), {});
  await storage.remove('recents');
  assert.deepEqual(await storage.get('recents'), {});
  await storage.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  assert.deepEqual(touched, []);

  const second = withChrome({ extension: { inIncognitoContext: true }, storage: { session } }, () => sessionStorageForContext());
  assert.deepEqual(await second?.get('key'), {}, 'each worker start gets an empty area');
});
