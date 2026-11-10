import { computeSha256 } from './image/fingerprints.js';

// #451 — user-controlled searchable-metadata privacy policy.
//
// Image Trail stores durable records as encrypted envelopes with a small amount of PLAINTEXT
// bookkeeping alongside each one (uuid, queue timestamps, key references). A few OPTIONAL fields
// have historically lived in that plaintext layer purely to be searchable/dedupable without
// decryption. This policy is the single source of truth for whether each optional class may remain
// in plaintext searchable metadata ('plaintext') or must be kept out of it ('encrypted' — hashed
// for URLs, sealed in the envelope for album names).
//
// This governs AT-REST metadata and is distinct from Privacy mode, which only masks the DISPLAY for
// screen sharing. URL-derived metadata and album names remain user-selectable. Thumbnail bytes are
// always encrypted: inline bookmark thumbnails live inside the bookmark AES-GCM envelope and
// protected-pin thumbnails live in the encrypted thumbnail repository.

export type SearchableMetadataMode = 'plaintext' | 'encrypted';

export const SEARCHABLE_METADATA_CLASSES = ['urlDerived', 'albumName', 'thumbnail'] as const;
export type SearchableMetadataClass = (typeof SEARCHABLE_METADATA_CLASSES)[number];

export interface SearchableMetadataPolicy {
  // URL-derived lookup and workflow metadata. For plain bookmarks, 'encrypted' writes a SHA-256
  // index for NEW records — dedup still works and the real URL stays in the encrypted payload.
  // Protected pins already hash their URL unconditionally. Parsed-field resume and URL-review rows
  // additionally reconcile to opaque hash keys with their URL-bearing values sealed in AES-GCM
  // envelopes, redacting legacy plaintext rows whenever the policy changes.
  readonly urlDerived: SearchableMetadataMode;
  // User-authored album names ('encrypted' seals the name in an envelope — Slice 2).
  readonly albumName: SearchableMetadataMode;
  // Thumbnail/preview bytes. Already encrypted everywhere at rest — 'encrypted' is the only supported
  // state; there is no plaintext-thumbnail write path.
  readonly thumbnail: 'encrypted';
}

// URL and album defaults preserve compatibility. Thumbnail storage has no plaintext mode; legacy
// settings that claimed otherwise are sanitized to the effective encrypted-at-rest contract.
export const DEFAULT_SEARCHABLE_METADATA_POLICY: SearchableMetadataPolicy = {
  urlDerived: 'plaintext',
  albumName: 'plaintext',
  thumbnail: 'encrypted',
};

export function isSearchableMetadataMode(value: unknown): value is SearchableMetadataMode {
  return value === 'plaintext' || value === 'encrypted';
}

export function isSearchableMetadataPolicy(value: unknown): value is SearchableMetadataPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isSearchableMetadataMode(record['urlDerived']) && isSearchableMetadataMode(record['albumName']) && record['thumbnail'] === 'encrypted'
  );
}

export function sanitizeSearchableMetadataPolicy(value: unknown): SearchableMetadataPolicy {
  if (typeof value !== 'object' || value === null) return DEFAULT_SEARCHABLE_METADATA_POLICY;
  const record = value as Record<string, unknown>;
  return {
    urlDerived: isSearchableMetadataMode(record['urlDerived']) ? record['urlDerived'] : DEFAULT_SEARCHABLE_METADATA_POLICY.urlDerived,
    albumName: isSearchableMetadataMode(record['albumName']) ? record['albumName'] : DEFAULT_SEARCHABLE_METADATA_POLICY.albumName,
    thumbnail: 'encrypted',
  };
}

export function isSearchablePlaintext(cls: SearchableMetadataClass, policy: SearchableMetadataPolicy): boolean {
  return policy[cls] === 'plaintext';
}

export function shouldReconcileBookmarkUrlIndexes(previous: SearchableMetadataPolicy, next: SearchableMetadataPolicy): boolean {
  return previous.urlDerived !== 'encrypted' && next.urlDerived === 'encrypted';
}

// SHA-256 hex used for the URL index value. Identical to the hash protected pins already use, so plain
// and protected records stay consistent.
export function hashSearchableUrl(url: string): Promise<string> {
  return computeSha256(new TextEncoder().encode(url).buffer);
}

// The bookmark URL index value under the active policy: the URL itself when the class is allowed
// plaintext, otherwise its hash. Existing plaintext records are reconciled when encryption is enabled.
export async function bookmarkSearchIndexKey(url: string, policy: SearchableMetadataPolicy): Promise<string> {
  return isSearchablePlaintext('urlDerived', policy) ? url : hashSearchableUrl(url);
}

/** What the `encrypted` searchable-metadata mode does and does not protect. Shown on every Settings surface. */
export const ENCRYPTED_METADATA_MODE_DISCLOSURE =
  'Encrypted seals them with a key kept in this browser profile, so they are not stored as readable text, but they are not protected by your encryption password: someone with access to this profile can recover them, and the URL lookup hash can confirm an address they already know. Only private pins and stored originals are password-protected.';
