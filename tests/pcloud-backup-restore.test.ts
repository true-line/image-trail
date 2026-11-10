import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createInitialPanelState } from '../extension/src/core/state.js';
import type { CaptureStore } from '../extension/src/content/capture-controller.js';
import {
  cloudBackupPartFileName,
  createCloudBackupCryptoSession,
  encryptCloudBackupManifest,
  encryptCloudBackupPart,
  type CloudBackupManifestV1,
  type CloudBackupPartPayload,
  type CloudBackupPartReference,
} from '../extension/src/data/import-export/chunked-cloud-backup.js';
import {
  PCloudBackupRestoreCoordinator,
  type ChunkedCloudRestoreContext,
  type PCloudBackupRestoreDeps,
} from '../extension/src/ui/panel/pcloud-backup-restore.js';
import type { BookmarksImportResult } from '../extension/src/data/import-export/bookmarks-import.js';

const NOW = '2026-07-28T12:00:00.000Z';
const BACKUP_ID = '00000000-0000-4000-8000-000000000223';
const MANIFEST_NAME = 'image-trail-pcloud-backup-2026-07-28T12-00-00Z.image-trail-encrypted.json';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const session = await createCloudBackupCryptoSession('backup-password', BACKUP_ID);
  const payloads: readonly CloudBackupPartPayload[] = [
    {
      schemaVersion: 1,
      backupId: BACKUP_ID,
      partId: 'metadata-000001',
      kind: 'metadata',
      albums: [],
      blobKeyBackups: [],
      missingOriginalBlobIds: [],
    },
    {
      schemaVersion: 1,
      backupId: BACKUP_ID,
      partId: 'records-000001',
      kind: 'records',
      bookmarks: [
        {
          uuid: 'bookmark-1',
          payload: {
            url: 'https://example.test/one.jpg',
            bookmarkedAt: NOW,
            storedOriginal: { blobId: 'blob-1', mimeType: 'image/jpeg', byteLength: 3, capturedAt: NOW },
          },
        },
      ],
    },
    {
      schemaVersion: 1,
      backupId: BACKUP_ID,
      partId: 'original-000001',
      kind: 'original',
      originalBlob: {
        id: 'blob-1',
        kind: 'original',
        schemaVersion: 1,
        algorithm: 'AES-GCM',
        iv: 'blob-iv',
        ciphertext: 'AQID',
        encryptedByteLength: 3,
        createdAt: NOW,
        key: { kind: 'blob', uuid: 'key-1', reference: 'blob:key-1' },
        referenceCount: 1,
      },
    },
  ];
  const files = new Map<number, { readonly fileName: string; readonly fileContent: string }>();
  const parts: CloudBackupPartReference[] = [];
  for (const [restoreOrder, payload] of payloads.entries()) {
    const fileId = 600 + restoreOrder;
    const fileName = cloudBackupPartFileName(BACKUP_ID, restoreOrder, payload.kind);
    const fileContent = await encryptCloudBackupPart(session, payload);
    files.set(fileId, { fileName, fileContent });
    parts.push({
      partId: payload.partId,
      kind: payload.kind,
      restoreOrder,
      fileId,
      fileName,
      sizeBytes: new TextEncoder().encode(fileContent).byteLength,
      sha256: sha256(fileContent),
      ...(payload.kind === 'original' ? { originalBlobId: payload.originalBlob.id } : {}),
    });
  }
  const manifest: CloudBackupManifestV1 = {
    schemaVersion: 1,
    backupId: BACKUP_ID,
    createdAt: NOW,
    recordCount: 1,
    albumCount: 0,
    originalCount: 1,
    originalBytes: 3,
    missingOriginalCount: 0,
    parts,
  };
  const manifestContent = await encryptCloudBackupManifest(session, manifest);
  files.set(500, { fileName: MANIFEST_NAME, fileContent: manifestContent });
  return { files, manifest };
}

function createHarness(files: ReadonlyMap<number, { readonly fileName: string; readonly fileContent: string }>) {
  let state = createInitialPanelState(0);
  const downloadedIds: number[] = [];
  const importedRecords: string[][] = [];
  const captureStore = {
    importBlobKeyBackup: async () => ({ ok: true as const, keyReference: 'blob:key-1', message: 'Imported.' }),
    importOriginalBlobRecords: async (records: readonly { readonly id: string }[]) => {
      importedRecords.push(records.map((record) => record.id));
      return { ok: true as const, importedCount: records.length, skippedCount: 0, message: 'Imported.' };
    },
  } as unknown as CaptureStore;
  const deps: PCloudBackupRestoreDeps = {
    getState: () => state,
    setState: (next) => {
      state = next;
    },
    render: () => {},
    captureStore: () => captureStore,
    listPCloudBackups: (async () => ({ ok: false, message: 'unused' })) as PCloudBackupRestoreDeps['listPCloudBackups'],
    downloadPCloudBackup: (async (input: { readonly fileId: number; readonly fileName: string }) => {
      downloadedIds.push(input.fileId);
      const file = files.get(input.fileId);
      if (!file) {
        return {
          ok: false as const,
          status: { connected: true as const },
          reason: 'missing',
          message: 'Missing fixture.',
        };
      }
      return {
        ok: true as const,
        status: { connected: true as const, apiHost: 'api.pcloud.com' as const },
        folderPath: '/Applications/Playbook-Eng-Trail-Overlook-1/backups',
        apiHost: 'api.pcloud.com' as const,
        fileId: input.fileId,
        fileName: input.fileName,
        fileContent: file.fileContent,
        sizeBytes: new TextEncoder().encode(file.fileContent).byteLength,
        sha256: sha256(file.fileContent),
        downloadedAt: NOW,
        message: `Downloaded ${input.fileName}.`,
      };
    }) as PCloudBackupRestoreDeps['downloadPCloudBackup'],
    refreshBlobKeyStatus: async () => {},
    refreshStorageUsage: async () => {},
  };
  return {
    coordinator: new PCloudBackupRestoreCoordinator(deps),
    getState: () => state,
    downloadedIds,
    importedRecords,
  };
}

test('chunked restore previews metadata and records first, then imports originals one at a time on confirm', async () => {
  const backup = await fixture();
  const harness = createHarness(backup.files);
  let preview: BookmarksImportResult | null = null;
  let context: ChunkedCloudRestoreContext | null = null;

  await harness.coordinator.previewRestoreFile(
    500,
    MANIFEST_NAME,
    'backup-password',
    async () => assert.fail('chunked manifest must not use the legacy import path'),
    async (result, preparedContext) => {
      preview = result;
      context = preparedContext;
    },
  );

  const preparedPreview = preview as unknown as BookmarksImportResult;
  const preparedContext = context as unknown as ChunkedCloudRestoreContext;
  assert.ok(preparedPreview);
  assert.ok(preparedContext);
  assert.deepEqual(harness.downloadedIds, [500, 600, 601], 'preview does not download encrypted original bytes');
  assert.equal(preparedPreview.entries.length, 1);
  assert.equal(preparedPreview.entries[0]?.payload.storedOriginal?.blobId, 'blob-1');

  const restored = await harness.coordinator.restoreOriginals(preparedContext, 'backup-password');

  assert.equal(restored.ok, true);
  assert.deepEqual(harness.downloadedIds, [500, 600, 601, 600, 602]);
  assert.deepEqual(harness.importedRecords, [['blob-1']], 'each original crosses the runtime boundary in its own import call');
  assert.equal(harness.getState().pcloudBackup.connectionState, 'connected');
});

test('chunked restore rejects a part whose downloaded SHA-256 differs from the encrypted manifest', async () => {
  const backup = await fixture();
  const corrupted = new Map(backup.files);
  const records = corrupted.get(601)!;
  corrupted.set(601, { ...records, fileContent: `${records.fileContent} ` });
  const harness = createHarness(corrupted);
  let previewed = false;

  await harness.coordinator.previewRestoreFile(
    500,
    MANIFEST_NAME,
    'backup-password',
    async () => assert.fail('chunked manifest must not use the legacy import path'),
    async () => {
      previewed = true;
    },
  );

  assert.equal(previewed, false);
  assert.equal(harness.getState().pcloudBackup.messageIsError, true);
  assert.match(harness.getState().pcloudBackup.message ?? '', /SHA-256 verification/u);
  assert.deepEqual(harness.importedRecords, []);
});
