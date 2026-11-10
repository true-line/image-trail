import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchLinkedPage } from '../extension/src/background/fetch-linked-page.js';
import { createFetchLinkedPageMessage } from '../extension/src/background/messages.js';

test('linked-page fetch checks target-origin permission before network I/O', async () => {
  const checkedOrigins: string[] = [];
  let fetched = false;
  const result = await fetchLinkedPage(
    createFetchLinkedPageMessage('https://target.example.test/page', 'https://source.example.test/gallery', 1024, 2000),
    {
      hasPermission: async (origin) => {
        checkedOrigins.push(origin);
        return false;
      },
      fetchImpl: async () => {
        fetched = true;
        throw new Error('fetch must not run without permission');
      },
    },
  );

  assert.deepEqual(checkedOrigins, ['https://target.example.test']);
  assert.equal(fetched, false);
  assert.deepEqual(result, {
    ok: false,
    reason: 'permission-needed',
    message: 'Permission needed for https://target.example.test.',
    origin: 'https://target.example.test',
  });
});

test('linked-page fetch omits credentials across origins without forwarding the page referrer', async () => {
  const calls: Array<{ readonly input: RequestInfo | URL; readonly init?: RequestInit | undefined }> = [];
  const result = await fetchLinkedPage(
    createFetchLinkedPageMessage('https://target.example.test/page', 'https://source.example.test/gallery', 1024, 2000),
    {
      hasPermission: async () => true,
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response('<meta property="og:image" content="/image.jpg">', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(calls[0]?.input, 'https://target.example.test/page');
  assert.equal(calls[0]?.init?.credentials, 'omit');
  assert.equal(calls[0]?.init?.redirect, 'manual');
  assert.equal('referrer' in calls[0]!.init!, false);
});

test('linked-page fetch includes credentials only for same-origin source pages', async () => {
  const credentials: RequestCredentials[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    credentials.push(init?.credentials ?? 'same-origin');
    return new Response('<html></html>', { status: 200 });
  };

  const sameOrigin = await fetchLinkedPage(
    createFetchLinkedPageMessage('https://secure.example.test/page', 'https://secure.example.test/gallery', 1024, 2000),
    { hasPermission: async () => true, fetchImpl },
  );
  const malformedReferrer = await fetchLinkedPage(
    createFetchLinkedPageMessage('https://secure.example.test/page', 'not a url', 1024, 2000),
    { hasPermission: async () => true, fetchImpl },
  );

  assert.equal(sameOrigin.ok, true);
  assert.equal(malformedReferrer.ok, true);
  assert.deepEqual(credentials, ['include', 'omit']);
});

test('linked-page redirects are followed manually and drop credentials before crossing origins', async () => {
  const calls: Array<{ readonly input: RequestInfo | URL; readonly credentials: RequestCredentials | undefined }> = [];
  const checkedOrigins: string[] = [];
  const result = await fetchLinkedPage(
    createFetchLinkedPageMessage('https://secure.example.test/page', 'https://secure.example.test/gallery', 1024, 2000),
    {
      hasPermission: async (origin) => {
        checkedOrigins.push(origin);
        return true;
      },
      fetchImpl: async (input, init) => {
        calls.push({ input, credentials: init?.credentials });
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example.test/landing' },
          });
        }
        return new Response('<html></html>', { status: 200 });
      },
    },
  );

  assert.equal(result.ok && result.finalUrl, 'https://cdn.example.test/landing');
  assert.deepEqual(checkedOrigins, ['https://secure.example.test', 'https://cdn.example.test']);
  assert.deepEqual(calls, [
    { input: 'https://secure.example.test/page', credentials: 'include' },
    { input: 'https://cdn.example.test/landing', credentials: 'omit' },
  ]);
});

test('linked-page redirects require target-origin permission before the redirected request', async () => {
  const calls: string[] = [];
  const result = await fetchLinkedPage(
    createFetchLinkedPageMessage('https://secure.example.test/page', 'https://secure.example.test/gallery', 1024, 2000),
    {
      hasPermission: async (origin) => origin === 'https://secure.example.test',
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: 'https://blocked.example.test/landing' },
        });
      },
    },
  );

  assert.deepEqual(result, {
    ok: false,
    reason: 'permission-needed',
    message: 'Permission needed for https://blocked.example.test.',
    origin: 'https://blocked.example.test',
  });
  assert.deepEqual(calls, ['https://secure.example.test/page']);
});

test('linked-page fetch rejects non-HTTP targets before permission or network access', async () => {
  let permissionChecked = false;
  let fetched = false;
  const result = await fetchLinkedPage(createFetchLinkedPageMessage('file:///private/data', 'https://example.test/', 1024, 2000), {
    hasPermission: async () => {
      permissionChecked = true;
      return true;
    },
    fetchImpl: async () => {
      fetched = true;
      throw new Error('unsupported targets must not be fetched');
    },
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'unsupported-url',
    message: 'Linked page URL must use HTTP or HTTPS.',
  });
  assert.equal(permissionChecked, false);
  assert.equal(fetched, false);
});

test('linked-page fetch stops a redirect from a public page into a private network', async () => {
  const fetched: string[] = [];
  const result = await fetchLinkedPage(
    createFetchLinkedPageMessage('https://target.example.test/page', 'https://source.example.test/gallery', 1024, 2000),
    {
      hasPermission: async () => true,
      fetchImpl: async (input) => {
        fetched.push(String(input));
        return new Response(null, { status: 302, headers: { location: 'http://192.168.1.10/admin' } });
      },
    },
  );

  assert.deepEqual(fetched, ['https://target.example.test/page']);
  assert.deepEqual(result, {
    ok: false,
    reason: 'network-error',
    message: 'Linked page redirect into a private network was blocked.',
  });
});
