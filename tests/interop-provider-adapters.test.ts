import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  GoogleDriveInteropObjectStore,
  createChromeIdentityInteropDriveStore,
} from '../extension/src/background/interop-google-drive-store.js';
import { PCloudInteropAuth } from '../extension/src/background/interop-pcloud-auth.js';
import {
  PCLOUD_INTEROP_CONNECTION_KEY,
  PCloudInteropConnectionStore,
  type PCloudInteropConnectionRecord,
} from '../extension/src/background/interop-pcloud-connection-store.js';
import { PCloudInteropObjectStore } from '../extension/src/background/interop-pcloud-store.js';
import { INTEROP_PROVIDER_LOGICAL_ROOT } from '../extension/src/core/interop/provider-root.js';
import { InteropTransportError } from '../extension/src/core/interop/transport.js';

describe('pCloud interoperability namespace (#588)', () => {
  test('authorizes and stores only a dedicated interop credential', async () => {
    const values = new Map<string, unknown>();
    const restricted: string[] = [];
    let authFlows = 0;
    const store = new PCloudInteropConnectionStore(
      {
        get: async (key) => ({ [key]: values.get(key) }),
        set: async (items) => {
          for (const [key, value] of Object.entries(items)) values.set(key, value);
        },
        remove: async (key) => {
          values.delete(key);
        },
      },
      async () => {
        restricted.push('trusted');
      },
    );
    const auth = new PCloudInteropAuth({
      store,
      redirectUrl: 'https://extension.test/pcloud-interop',
      createState: () => 'interop-state',
      now: () => '2026-07-17T12:00:00.000Z',
      launchAuthFlow: async (input) => {
        authFlows += 1;
        const url = new URL(input);
        assert.equal(url.searchParams.get('redirect_uri'), 'https://extension.test/pcloud-interop');
        assert.equal(url.searchParams.get('state'), 'interop-state');
        return 'https://extension.test/pcloud-interop#access_token=interop-token&hostname=api.pcloud.com&state=interop-state';
      },
      fetchImpl: async (input, init) => {
        assert.equal(String(input), 'https://api.pcloud.com/userinfo');
        assert.equal((init?.body as URLSearchParams).get('access_token'), 'interop-token');
        return Response.json({ result: 0, usedquota: 12, quota: 100 });
      },
    });

    assert.equal(await auth.probe(false), false);
    assert.equal(await auth.probe(true), true);
    assert.equal(await auth.probe(true), true);
    assert.equal(authFlows, 1);
    assert.deepEqual(values.get(PCLOUD_INTEROP_CONNECTION_KEY), {
      schemaVersion: 1,
      provider: 'pcloud-interop',
      accessToken: 'interop-token',
      apiHost: 'api.pcloud.com',
      connectedAt: '2026-07-17T12:00:00.000Z',
    });
    assert.equal(values.has('imageTrail.pcloudConnection'), false);
    assert.equal((await auth.openProvider())?.provider, 'pcloud');
    await auth.disconnect();
    assert.equal(values.has(PCLOUD_INTEROP_CONNECTION_KEY), false);
    assert.ok(restricted.length >= 4);
  });

  test('treats pCloud access denied as a scope failure instead of expired authorization', async () => {
    const store = new PCloudInteropObjectStore({
      credential: () => ({ accessToken: 'interop-only-token', apiHost: 'api.pcloud.com' }),
      fetchImpl: async () => Response.json({ result: 2003, error: 'Access denied.' }),
    });

    await assert.rejects(
      store.quota(),
      (error: unknown) =>
        error instanceof InteropTransportError &&
        error.code === 'provider-unavailable' &&
        error.retryable &&
        /app-folder scope/u.test(error.message),
    );
  });

  test('interactive probe falls back to OAuth only when the saved interop credential expired', async () => {
    let stored: PCloudInteropConnectionRecord = {
      schemaVersion: 1 as const,
      provider: 'pcloud-interop' as const,
      accessToken: 'expired-token',
      apiHost: 'api.pcloud.com' as const,
      connectedAt: '2026-07-17T12:00:00.000Z',
    };
    const store = new PCloudInteropConnectionStore(
      {
        get: async (key) => ({ [key]: stored }),
        set: async (items) => {
          stored = items[PCLOUD_INTEROP_CONNECTION_KEY] as PCloudInteropConnectionRecord;
        },
        remove: async () => undefined,
      },
      async () => undefined,
    );
    let authFlows = 0;
    const auth = new PCloudInteropAuth({
      store,
      redirectUrl: 'https://extension.test/pcloud-interop',
      createState: () => 'fresh-state',
      launchAuthFlow: () => {
        authFlows += 1;
        return Promise.resolve('https://extension.test/pcloud-interop#access_token=fresh-token&hostname=api.pcloud.com&state=fresh-state');
      },
      fetchImpl: async (_input, init) =>
        Response.json(
          (init?.body as URLSearchParams).get('access_token') === 'expired-token'
            ? { result: 1000, error: 'Log in required.' }
            : { result: 0, usedquota: 12, quota: 100 },
        ),
    });

    assert.equal(await auth.probe(true), true);
    assert.equal(authFlows, 1);
    assert.equal(stored.accessToken, 'fresh-token');
  });

  test('writes and verifies only below the interop root with separate custody', async () => {
    let uploaded = new Uint8Array();
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const url = String(_input);
      const method = url.slice(url.lastIndexOf('/') + 1);
      const body = init?.body;
      if (body instanceof FormData) {
        const path = String(body.get('path'));
        paths.push(path);
        if (method === 'uploadfile') {
          const file = body.get('file');
          assert.ok(file instanceof Blob);
          uploaded = new Uint8Array(await file.arrayBuffer());
          return Response.json({ result: 0, metadata: [{ size: uploaded.byteLength }] });
        }
      }
      if (method === 'checksumfile')
        return Response.json({
          result: 0,
          sha256: createHash('sha256').update(uploaded).digest('hex'),
          metadata: { size: uploaded.byteLength },
        });
      return Response.json({ result: 0, metadata: { isfolder: true, folderid: 1 } });
    };
    const store = new PCloudInteropObjectStore({
      credential: () => ({ accessToken: 'interop-only-token', apiHost: 'api.pcloud.com' }),
      fetchImpl,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    assert.deepEqual(await store.put('pairings/a/object.bin', bytes), { bytes: 3 });
    assert.equal((await store.verify('pairings/a/object.bin')).sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.ok(paths.every((path) => path.startsWith(`/${INTEROP_PROVIDER_LOGICAL_ROOT}/`)));
    assert.ok(paths.every((path) => !path.includes('/Applications/Playbook-Eng-Trail-Overlook-1/backups')));

    const disconnected = new PCloudInteropObjectStore({ credential: () => null, fetchImpl });
    await assert.rejects(
      disconnected.put('pairings/a/object.bin', bytes),
      (error: unknown) => error instanceof InteropTransportError && error.code === 'auth-expired',
    );
  });

  test('shapes getfilelink and download requests with exact-lifetime DNR rules', async () => {
    const originalChrome = globalThis.chrome;
    const dnrCalls: Array<{
      readonly addRules?: readonly {
        readonly id: number;
        readonly condition: { readonly regexFilter?: string; readonly tabIds?: readonly number[] };
      }[];
      readonly removeRuleIds?: readonly number[];
    }> = [];
    globalThis.chrome = {
      declarativeNetRequest: {
        RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
        HeaderOperation: { SET: 'set' },
        ResourceType: { XMLHTTPREQUEST: 'xmlhttprequest' },
        updateSessionRules: async (input: (typeof dnrCalls)[number]) => {
          dnrCalls.push(input);
        },
      },
    } as unknown as typeof chrome;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      assert.equal(init?.referrer, 'https://my.pcloud.com/');
      if (url === 'https://api.pcloud.com/getfilelink') {
        assert.equal((init?.body as URLSearchParams).get('path'), `/${INTEROP_PROVIDER_LOGICAL_ROOT}/pairings/a/object.bin`);
        return Response.json({ result: 0, hosts: ['c123.pcloud.com'], path: '/download/object.bin' });
      }
      assert.equal(url, 'https://c123.pcloud.com/download/object.bin');
      return new Response(new Uint8Array([4, 5, 6]));
    };

    try {
      const store = new PCloudInteropObjectStore({
        credential: () => ({ accessToken: 'interop-only-token', apiHost: 'api.pcloud.com' }),
        fetchImpl,
      });
      assert.deepEqual(await store.get('pairings/a/object.bin'), new Uint8Array([4, 5, 6]));
      const added = dnrCalls.flatMap((call) => call.addRules ?? []);
      const removed = dnrCalls.flatMap((call) => call.removeRuleIds ?? []);
      assert.equal(added.length, 2);
      assert.deepEqual(
        added.map((rule) => rule.condition.regexFilter),
        ['^https://api\\.pcloud\\.com/getfilelink$', '^https://c123\\.pcloud\\.com/download/object\\.bin$'],
      );
      // Each id is cleared when its rule is installed (a rule left by a stopped worker must
      // not block the install) and removed again when the request ends.
      assert.deepEqual(
        removed,
        added.flatMap((rule) => [rule.id, rule.id]),
      );
      assert.deepEqual(
        added.map((rule) => rule.condition.tabIds),
        [[-1], [-1]],
        'only requests that do not come from a tab get the rewritten headers',
      );
    } finally {
      globalThis.chrome = originalChrome;
    }
  });

  test('rejects a provider-controlled download path that changes the vetted host', async () => {
    let requests = 0;
    const store = new PCloudInteropObjectStore({
      credential: () => ({ accessToken: 'interop-only-token', apiHost: 'api.pcloud.com' }),
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ result: 0, hosts: ['pcloud.com'], path: '@attacker.example/object.bin' });
      },
    });

    await assert.rejects(
      store.get('pairings/a/object.bin'),
      (error: unknown) => error instanceof InteropTransportError && error.code === 'corrupt',
    );
    assert.equal(requests, 1);
  });
});

describe('Google Drive drive.file interoperability adapter (#588)', () => {
  test('uses an app-owned root, resumable upload, checksum verification, and isolated listings', async () => {
    assert.equal(createChromeIdentityInteropDriveStore().provider, 'google-drive');
    let uploaded = new Uint8Array();
    let uploadedFile = false;
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      if (url.hostname === 'www.googleapis.com' && url.pathname === '/upload-session') {
        uploaded = new Uint8Array((init?.body as ArrayBuffer) ?? new ArrayBuffer(0));
        uploadedFile = true;
        return Response.json({ id: 'file-1', size: String(uploaded.byteLength) });
      }
      if (url.pathname.startsWith('/upload/drive/v3/files'))
        return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload-session' } });
      if (url.pathname === '/drive/v3/files/file-1')
        return Response.json({
          id: 'file-1',
          size: String(uploaded.byteLength),
          sha256Checksum: createHash('sha256').update(uploaded).digest('hex'),
          appProperties: { imageTrailInteropOwner: 'qwts-image-trail-interop-v1', imageTrailInteropPath: 'pairings/a/object.bin' },
        });
      if (url.pathname === '/drive/v3/files') {
        const query = url.searchParams.get('q') ?? '';
        if (query.includes("name = 'Image Trail Interop'"))
          return Response.json({ files: [{ id: 'root-1', name: 'Image Trail Interop', mimeType: 'application/vnd.google-apps.folder' }] });
        if (query.includes('imageTrailInteropPath'))
          return Response.json({
            files: uploadedFile
              ? [
                  {
                    id: 'file-1',
                    size: String(uploaded.byteLength),
                    appProperties: {
                      imageTrailInteropOwner: 'qwts-image-trail-interop-v1',
                      imageTrailInteropPath: 'pairings/a/object.bin',
                    },
                  },
                ]
              : [],
          });
        return Response.json({
          files: [
            {
              id: 'file-1',
              size: String(uploaded.byteLength),
              appProperties: { imageTrailInteropOwner: 'qwts-image-trail-interop-v1', imageTrailInteropPath: 'pairings/a/object.bin' },
            },
            { id: 'backup', size: '99', appProperties: { overlookOwner: 'qwts-photos' } },
          ],
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    };
    const store = new GoogleDriveInteropObjectStore({ accessToken: () => Promise.resolve('drive-file-token'), fetchImpl });
    const bytes = new Uint8Array([4, 5, 6]);
    assert.deepEqual(await store.put('pairings/a/object.bin', bytes), { bytes: 3 });
    assert.deepEqual(await store.verify('pairings/a/object.bin'), {
      bytes: 3,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    assert.deepEqual((await store.list('pairings/a', null)).entries, [{ path: 'pairings/a/object.bin', bytes: 3 }]);
    assert.ok(requests.some((request) => request.startsWith('PUT /upload-session')));
  });

  test('continues a partial resumable upload from the provider-acknowledged byte', async () => {
    const uploaded: number[] = [];
    let uploadRequest = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/drive/v3/files')
        return Response.json({
          files: url.searchParams.get('q')?.includes("name = 'Image Trail Interop'") ? [{ id: 'root-1' }] : [],
        });
      if (url.pathname.startsWith('/upload/drive/v3/files'))
        return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload-session' } });
      if (url.pathname === '/upload-session') {
        uploadRequest += 1;
        const body = new Uint8Array((init?.body as ArrayBuffer) ?? new ArrayBuffer(0));
        if (uploadRequest === 1) {
          uploaded.push(body[0] as number);
          return new Response(null, { status: 308, headers: { range: 'bytes=0-0' } });
        }
        uploaded.push(...body);
        return Response.json({ id: 'file-1', size: String(uploaded.length) });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    };
    const store = new GoogleDriveInteropObjectStore({ accessToken: () => Promise.resolve('drive-file-token'), fetchImpl });

    assert.deepEqual(await store.put('pairings/a/object.bin', new Uint8Array([4, 5, 6])), { bytes: 3 });
    assert.deepEqual(uploaded, [4, 5, 6]);
  });

  test('rejects a resumable upload location outside the exact HTTPS Drive origin', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/drive/v3/files')
        return Response.json({ files: url.searchParams.get('q')?.includes("name = 'Image Trail Interop'") ? [{ id: 'root-1' }] : [] });
      if (url.pathname.startsWith('/upload/drive/v3/files'))
        return new Response(null, { status: 200, headers: { location: 'http://www.googleapis.com/upload-session' } });
      throw new Error(`Unexpected request: ${String(input)}`);
    };
    const store = new GoogleDriveInteropObjectStore({ accessToken: () => Promise.resolve('drive-file-token'), fetchImpl });

    await assert.rejects(
      store.put('pairings/a/object.bin', new Uint8Array([1])),
      (error: unknown) => error instanceof InteropTransportError && error.code === 'corrupt',
    );
  });
});
