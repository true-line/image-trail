import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';

import { assertEnvelopeBoundTo, openValidatedJsonEnvelope, sealJsonEnvelope } from '../extension/src/data/crypto/envelope.js';
import { recallEncryptedRecord } from '../extension/src/data/import-export/recall.js';
import { encryptedEnvelopeSchema } from '../extension/src/data/crypto/types.schema.js';

const payloadSchema = v.object({ url: v.string() });
const keyReference = { kind: 'bookmark', uuid: 'key-1', reference: 'bookmark:key-1' } as const;

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(key: CryptoKey, recordId?: string) {
  return sealJsonEnvelope({
    payload: { url: 'https://example.test/a.jpg' },
    payloadVersion: 1,
    key,
    keyReference,
    authenticatedMetadata: recordId === undefined ? { recordType: 'bookmark' as const } : { recordType: 'bookmark' as const, recordId },
  });
}

test('an envelope opens for the row it was sealed for and not for another row', async () => {
  const key = await aesKey();
  const envelope = await seal(key, 'row-a');
  assert.deepEqual(await openValidatedJsonEnvelope(envelope, key, payloadSchema, 'row-a'), { url: 'https://example.test/a.jpg' });
  await assert.rejects(openValidatedJsonEnvelope(envelope, key, payloadSchema, 'row-b'), /different record/u);
});

test('the bound record id cannot be rewritten or removed', async () => {
  const key = await aesKey();
  const envelope = await seal(key, 'row-a');
  const rewritten = { ...envelope, authenticatedMetadata: { recordType: 'bookmark', recordId: 'row-b' } };
  const stripped = { ...envelope, authenticatedMetadata: { recordType: 'bookmark' } };
  await assert.rejects(openValidatedJsonEnvelope(rewritten, key, payloadSchema, 'row-b'));
  await assert.rejects(openValidatedJsonEnvelope(stripped, key, payloadSchema, 'row-b'));
});

test('envelopes sealed before the binding existed still open', async () => {
  const key = await aesKey();
  const legacy = await seal(key);
  assert.doesNotThrow(() => assertEnvelopeBoundTo(legacy, 'any-row'));
  assert.deepEqual(await openValidatedJsonEnvelope(legacy, key, payloadSchema, 'any-row'), { url: 'https://example.test/a.jpg' });
});

test('schema hydration keeps the bound id and the authenticated byte order', async () => {
  const key = await aesKey();
  const schema = encryptedEnvelopeSchema('bookmark');
  for (const envelope of [await seal(key, 'row-a'), await seal(key)]) {
    const hydrated = v.parse(schema, JSON.parse(JSON.stringify(envelope)));
    assert.deepEqual(hydrated.authenticatedMetadata, envelope.authenticatedMetadata);
    assert.deepEqual(await openValidatedJsonEnvelope(hydrated, key, payloadSchema, 'row-a'), { url: 'https://example.test/a.jpg' });
  }
});

test('recall refuses an envelope presented under a different record id', async () => {
  const key = await aesKey();
  const envelope = await seal(key, 'row-a');
  const own = await recallEncryptedRecord({ uuid: 'row-a', recordType: 'bookmark', envelope, key });
  const other = await recallEncryptedRecord({ uuid: 'row-b', recordType: 'bookmark', envelope, key });
  assert.equal(own.status.ok, true);
  assert.equal(other.status.ok, false);
  assert.equal(other.entry, undefined);
});
