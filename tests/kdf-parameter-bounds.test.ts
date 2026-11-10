import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  deriveEncryptionKey,
  deriveWrappingKey,
} from '../extension/src/data/crypto/password-wrap.js';

const salt = new Uint8Array(16);

test('key derivation refuses iteration counts outside the supported range', async () => {
  for (const iterations of [0, 1, MIN_PBKDF2_ITERATIONS - 1, MAX_PBKDF2_ITERATIONS + 1, 1e12, 600_000.5, Number.NaN, -600_000]) {
    await assert.rejects(deriveEncryptionKey('password', { salt, iterations }), RangeError, `encryption key, ${iterations}`);
    await assert.rejects(deriveWrappingKey('password', { salt, iterations }), RangeError, `wrapping key, ${iterations}`);
  }
});

test('key derivation accepts the lowest supported and the current iteration counts', async () => {
  assert.equal((await deriveEncryptionKey('password', { salt, iterations: MIN_PBKDF2_ITERATIONS })).type, 'secret');
  assert.equal((await deriveWrappingKey('password', { salt, iterations: 600_000 })).type, 'secret');
});
