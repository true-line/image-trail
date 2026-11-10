import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { ensureDurableBookmarkKey } from '../extension/src/data/durable-bookmark-key.js';
import { KeysRepository } from '../extension/src/data/repositories/keys-repository.js';
import { openFreshImageTrailDb } from './indexeddb-test-helpers.js';

test('concurrent first-use callers share one durable bookmark key', async (t) => {
  const db = await openFreshImageTrailDb();
  t.after(() => db.close());
  const keys = new KeysRepository(db);
  assert.deepEqual(await keys.listByKind('bookmark'), []);

  const [first, second] = await Promise.all([
    ensureDurableBookmarkKey(new KeysRepository(db)),
    ensureDurableBookmarkKey(new KeysRepository(db)),
  ]);

  assert.equal(first.reference.reference, second.reference.reference);
  assert.deepEqual(
    (await keys.listByKind('bookmark')).map((key) => key.reference),
    [first.reference.reference],
  );
  const iv = new Uint8Array(12);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, first.key, new TextEncoder().encode('row'));
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, second.key, sealed);
  assert.equal(new TextDecoder().decode(opened), 'row', 'both callers seal and open rows with the same key material');
  assert.equal((await ensureDurableBookmarkKey(keys)).reference.reference, first.reference.reference);
});
