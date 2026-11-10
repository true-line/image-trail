export type EncryptionAlgorithm = 'AES-GCM';
export type KeyKind = 'root' | 'history' | 'bookmark' | 'metadata' | 'export' | 'blob' | 'download' | 'interop';
export type KeyWrappingMode = 'session' | 'password' | 'webauthn' | 'imported' | 'indexeddb';
export type KeyReferenceString<K extends KeyKind = KeyKind> = `${K}:${string}`;

export interface KeyReference<K extends KeyKind = KeyKind> {
  readonly kind: K;
  readonly uuid: string;
  readonly reference: KeyReferenceString<K>;
}

export interface StoredKeyRecord<K extends KeyKind = KeyKind> extends KeyReference<K> {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly wrapping: {
    readonly mode: KeyWrappingMode;
    readonly algorithm: EncryptionAlgorithm | 'none';
    readonly salt?: string;
    readonly iv?: string;
    readonly iterations?: number;
    readonly wrappedKey?: string;
  };
  readonly extractable: boolean;
  readonly key?: CryptoKey;
}

/**
 * Authenticated metadata of a stored record's envelope. `recordId` binds the ciphertext to the
 * row it was sealed for; envelopes written before the binding existed do not carry it.
 */
export interface RecordEnvelopeMetadata<TRecordType extends string> extends Record<string, unknown> {
  readonly recordType: TRecordType;
  readonly recordId?: string | undefined;
}

export interface EncryptedEnvelope<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  readonly schemaVersion: 1;
  readonly payloadVersion: number;
  readonly algorithm: EncryptionAlgorithm;
  readonly iv: string;
  readonly ciphertext: string;
  readonly key: KeyReference;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authenticatedMetadata: TMetadata;
}
