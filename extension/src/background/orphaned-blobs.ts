import type { OriginalBlobReferences } from '../data/original-blob-references.js';

export const ORPHANED_BLOB_GRACE_PERIOD_MS = 60 * 60 * 1000;
const CANONICAL_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface OrphanBlobCandidate {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * Merges bookmark and Recent history blob references for orphan cleanup. Returns null — delete
 * nothing — while any bookmark row is unreadable, because that row could link any original.
 */
export function cleanupReferencedBlobIds(
  bookmarked: OriginalBlobReferences,
  recentHistory: Iterable<readonly { readonly blobId?: string | undefined }[]>,
): Set<string> | null {
  if (bookmarked.unreadableCount > 0) return null;
  const referenced = new Set(bookmarked.ids);
  for (const history of recentHistory) {
    for (const item of history) {
      if (item.blobId) referenced.add(item.blobId);
    }
  }
  return referenced;
}

export function findDeletableOrphanBlobIds(
  blobs: readonly OrphanBlobCandidate[],
  referencedBlobIds: ReadonlySet<string> | null,
  now = Date.now(),
): readonly string[] {
  if (!referencedBlobIds) return [];
  const graceCutoff = now - ORPHANED_BLOB_GRACE_PERIOD_MS;
  return blobs
    .filter((blob) => {
      if (referencedBlobIds.has(blob.id)) return false;
      if (!CANONICAL_ISO_TIMESTAMP_PATTERN.test(blob.createdAt)) return false;
      const createdAt = Date.parse(blob.createdAt);
      return Number.isFinite(createdAt) && new Date(createdAt).toISOString() === blob.createdAt && createdAt <= graceCutoff;
    })
    .map((blob) => blob.id);
}
