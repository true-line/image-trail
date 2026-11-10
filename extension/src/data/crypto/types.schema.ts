import * as v from 'valibot';
import type { Assert, MutuallyAssignable } from '../../core/schema-assert.js';
import type {
  EncryptedEnvelope,
  RecordEnvelopeMetadata,
  EncryptionAlgorithm,
  KeyKind,
  KeyReference,
  KeyWrappingMode,
  StoredKeyRecord,
} from './types.js';

export const encryptionAlgorithmSchema = v.picklist(['AES-GCM']);

export const keyKindSchema = v.picklist(['root', 'history', 'bookmark', 'metadata', 'export', 'blob', 'download', 'interop']);

export const keyWrappingModeSchema = v.picklist(['session', 'password', 'webauthn', 'imported', 'indexeddb']);

/**
 * `KeyReference<K>` requires `reference === \`${kind}:${uuid}\``. The base schema
 * enforces the structural shape; `keyReferenceForKind` additionally pins `kind`
 * to a specific literal and cross-checks the reference string.
 */
export const keyReferenceSchema = v.pipe(
  v.object({
    kind: keyKindSchema,
    uuid: v.string(),
    reference: v.string(),
  }),
  v.check((value) => value.reference === `${value.kind}:${value.uuid}`, 'Key reference must equal `${kind}:${uuid}`.'),
) as v.GenericSchema<unknown, KeyReference>;

export function keyReferenceForKind<K extends KeyKind>(kind: K): v.GenericSchema<unknown, KeyReference<K>> {
  return v.pipe(
    v.object({
      kind: v.literal(kind),
      uuid: v.string(),
      reference: v.string(),
    }),
    v.check((value) => value.reference === `${kind}:${value.uuid}`, `Key reference must equal \`${kind}:\${uuid}\`.`),
  ) as v.GenericSchema<unknown, KeyReference<K>>;
}

export const storedKeyRecordSchema = v.pipe(
  v.object({
    kind: keyKindSchema,
    uuid: v.string(),
    reference: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
    wrapping: v.object({
      mode: keyWrappingModeSchema,
      algorithm: v.union([encryptionAlgorithmSchema, v.literal('none')]),
      salt: v.optional(v.string()),
      iv: v.optional(v.string()),
      iterations: v.optional(v.number()),
      wrappedKey: v.optional(v.string()),
    }),
    extractable: v.boolean(),
    key: v.optional(v.instance(CryptoKey)),
  }),
  // Quarantine rows whose reference disagrees with kind/uuid at the IDB boundary, rather
  // than letting a mismatched record hydrate and fail deep in assertKeyReference.
  v.check((record) => record.reference === `${record.kind}:${record.uuid}`, 'Key reference must equal `${kind}:${uuid}`.'),
) as v.GenericSchema<unknown, StoredKeyRecord>;

/**
 * Builds an `EncryptedEnvelope` schema whose `authenticatedMetadata.recordType`
 * is pinned to `recordType`, matching how each store tags its envelopes.
 */
export function encryptedEnvelopeSchema<TRecordType extends string>(
  recordType: TRecordType,
): v.GenericSchema<unknown, EncryptedEnvelope<RecordEnvelopeMetadata<TRecordType>>> {
  return v.object({
    schemaVersion: v.literal(1),
    payloadVersion: v.number(),
    algorithm: encryptionAlgorithmSchema,
    iv: v.string(),
    ciphertext: v.string(),
    key: keyReferenceSchema,
    createdAt: v.string(),
    updatedAt: v.string(),
    // Key order is part of the authenticated bytes: keep `recordType` before `recordId`.
    authenticatedMetadata: v.object({ recordType: v.literal(recordType), recordId: v.optional(v.string()) }),
  }) as v.GenericSchema<unknown, EncryptedEnvelope<RecordEnvelopeMetadata<TRecordType>>>;
}

type _AssertEncryptionAlgorithm = Assert<MutuallyAssignable<v.InferOutput<typeof encryptionAlgorithmSchema>, EncryptionAlgorithm>>;
type _AssertKeyKind = Assert<MutuallyAssignable<v.InferOutput<typeof keyKindSchema>, KeyKind>>;
type _AssertKeyWrappingMode = Assert<MutuallyAssignable<v.InferOutput<typeof keyWrappingModeSchema>, KeyWrappingMode>>;
