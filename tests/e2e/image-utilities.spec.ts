import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Download, Page, Worker } from '@playwright/test';

import {
  applyUrlInEditor,
  clearDownloadRequestLog,
  closeSettings,
  expect,
  expectPanelClosed,
  expectPanelOpen,
  expectPanelStatusMessage,
  fixtureAssetPaths,
  fixturePaths,
  fixtureUrl,
  imageNavigationSnapshot,
  installDownloadRequestLog,
  openFixturePage,
  openSettingsGroup,
  readDownloadRequestLog,
  test,
  togglePanelFromExtensionAction,
  type ExtensionDownloadRequest,
  fillPanelPassword,
} from './fixtures.js';
import { pinCurrentImage } from './current-image-actions.js';

const primaryImage = '#fixture-primary-image';
const password = 'correct horse battery staple';
const wrongPassword = 'wrong horse battery staple';

const oversizedAssetRoute = '/assets/generated-oversized.svg';
// Just past DEFAULT_MAX_ORIGINAL_BYTES (25 MiB), so the background capture fetch
// must refuse the original on its declared Content-Length.
const oversizedAssetBytes = 26 * 1024 * 1024;

test.beforeAll(async () => {
  const assetPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages', oversizedAssetRoute);
  const existing = await stat(assetPath).catch(() => null);
  if (existing && existing.size >= oversizedAssetBytes) return;
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7744aa"/><!--';
  const tail = '--></svg>';
  await writeFile(assetPath, head + 'x'.repeat(oversizedAssetBytes - head.length - tail.length) + tail);
});

async function openPanel(page: Page, serviceWorker: Worker): Promise<void> {
  await openFixturePage(page, fixturePaths.singleImage);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
}

async function openImageUtilities(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Image utilities');
}

async function setVisiblePins(page: Page, value: string, expectedVisibleCount: number): Promise<void> {
  await openSettingsGroup(page, 'Display');
  const pins = page
    .getByRole('heading', { name: 'Pins' })
    .locator('xpath=ancestor::div[contains(@class, "image-trail-panel__settings-templates")][1]');
  await pins.locator('input[type="number"]').fill(value);
  await pins.locator('button', { hasText: 'Apply' }).click();
  await closeSettings(page);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(expectedVisibleCount);
}

async function openEncryptedOriginals(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Encrypted originals');
}

async function openQueueMenu(page: Page): Promise<void> {
  const queueMenu = page.getByTitle('Queue scope and maintenance actions.');
  if ((await queueMenu.getAttribute('aria-expanded')) !== 'true') await queueMenu.click();
}

async function deleteVisibleRecents(page: Page): Promise<void> {
  const deleteRecents = page.getByRole('button', { name: /Delete recents/u });
  if ((await deleteRecents.count()) > 0) await deleteRecents.click();
}

async function deleteVisibleQueueRows(page: Page): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await openSettingsGroup(page, 'System');
    await confirmQueueDeletion(page, /^Delete current queue \(\d+\)$/u, /^Confirm Delete current queue \(\d+\)$/u);
    await confirmQueueDeletion(page, /^Delete Recall items \(\d+\)$/u, /^Confirm Delete Recall items \(\d+\)$/u);
    await closeSettings(page);
    if ((await page.locator('.image-trail-panel__bookmark-item').count()) === 0) return;
  }
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);
}

async function confirmQueueDeletion(page: Page, actionName: RegExp, confirmName: RegExp): Promise<void> {
  const action = page.getByRole('button', { name: actionName });
  if ((await action.count()) === 0 || (await action.isDisabled())) return;
  await action.click();
  await page.getByRole('button', { name: confirmName }).click();
}

async function setupEncryptedOriginals(page: Page, serviceWorker: Worker, value = password): Promise<void> {
  await openEncryptedOriginals(page);
  if ((await page.getByRole('button', { name: 'Clear key' }).count()) > 0) {
    await clearEncryptedOriginalsKey(page);
    await openEncryptedOriginals(page);
  } else if ((await page.getByRole('button', { name: 'Unlock', exact: true }).count()) > 0) {
    await clearStoredBlobKeys(serviceWorker);
    await reopenPanel(page, serviceWorker);
    await openEncryptedOriginals(page);
  }
  await fillPanelPassword(page, 'New encrypted originals password', value);
  await page.getByRole('button', { name: 'Create first key' }).click();
  await expectPanelStatusMessage(page, /Encrypted blob storage unlocked with blob:[a-f0-9-]+\./u);
  await expect(page.locator('.image-trail-panel__encryption-badge')).toHaveText('Unlocked');
  await closeSettings(page);
}

async function clearEncryptedOriginalsKey(page: Page): Promise<void> {
  await openEncryptedOriginals(page);
  await page.getByRole('button', { name: 'Clear key' }).click();
  await page.getByRole('button', { name: 'Confirm clear key' }).click();
  await expectPanelStatusMessage(page, /Encrypted blob key cleared\. Import a key backup to recover encrypted originals\./u);
  await closeSettings(page);
}

// Removes every stored blob key directly from the extension database. Used to reset
// a key that a service-worker restart has left present-but-locked: the panel offers
// no Clear key control in that state, so the UI cannot clear it. This is safe because
// a locked key means no unlocked key is held in service-worker memory, so deleting the
// stored record cannot desync an active in-memory key. Mirrors handleClearBlobKey,
// which removes the same 'blob'-kind rows from the 'keys' store.
async function clearStoredBlobKeys(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(
    ({ dbName, storeName, indexName, kind }) =>
      new Promise<void>((resolve, reject) => {
        const openRequest = indexedDB.open(dbName);
        openRequest.onerror = () => reject(openRequest.error);
        openRequest.onsuccess = () => {
          const db = openRequest.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            resolve();
            return;
          }
          const transaction = db.transaction(storeName, 'readwrite');
          const cursorRequest = transaction.objectStore(storeName).index(indexName).openCursor(IDBKeyRange.only(kind));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            cursor.delete();
            cursor.continue();
          };
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    { dbName: 'image-trail', storeName: 'keys', indexName: 'keys.byKind', kind: 'blob' },
  );
}

// Closes and reopens the panel so it re-queries blob-key status from the service
// worker (the panel refreshes that status on open), reflecting a storage-level reset.
async function reopenPanel(page: Page, serviceWorker: Worker): Promise<void> {
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelClosed(page);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
}

async function exportImages(page: Page, serviceWorker: Worker, options: { readonly saveAs?: boolean } = {}): Promise<void> {
  await openImageUtilities(page);
  await clearDownloadRequestLog(serviceWorker);
  if (options.saveAs) {
    // This test owns the export handler's Shift/saveAs contract. Real keyboard
    // modifier rendering is covered separately; holding Shift here re-renders the
    // entire panel and detaches the export control before its click can complete.
    await page.getByRole('button', { name: /Export images/u }).dispatchEvent('click', {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
    });
  } else {
    await page.getByRole('button', { name: /Export images/u }).click();
  }
  await expectPanelStatusMessage(page, /Image export started\.|Started \d+ image downloads\./u);
  await closeSettings(page);
}

async function exportEncryptedImage(page: Page): Promise<{ readonly download: Download; readonly fileContent: string }> {
  await openImageUtilities(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export encrypted/u }).click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  await expectPanelStatusMessage(page, /Encrypted image export started\./u);
  const fileContent = await readFile(path!, 'utf8');
  await closeSettings(page);
  return { download, fileContent };
}

async function importEncryptedImage(page: Page, fileContent: string, fileName = 'asset-one.image-trail-encrypted.json'): Promise<void> {
  await openImageUtilities(page);
  const imageUtilities = page.locator('.image-trail-panel__image-transfer');
  await imageUtilities
    .locator('input[type="file"][accept=".json,.image-trail-encrypted.json"]')
    .setInputFiles({ name: fileName, mimeType: 'application/json', buffer: Buffer.from(fileContent) });
  await imageUtilities.getByRole('button', { name: 'Import encrypted' }).click();
  await closeSettings(page);
}

async function waitForDownloadRequests(serviceWorker: Worker, count: number) {
  let snapshot: ExtensionDownloadRequest[] = [];
  await expect
    .poll(async () => {
      snapshot = await readDownloadRequestLog(serviceWorker);
      return snapshot.length;
    })
    .toBe(count);
  return snapshot;
}

async function encryptedOriginalsStorageText(page: Page): Promise<string> {
  await openSettingsGroup(page, 'System');
  const usage = page
    .locator('.image-trail-panel__storage-health dt', { hasText: 'Encrypted originals' })
    .locator('xpath=following-sibling::dd[1]');
  const text = (await usage.textContent()) ?? '';
  await closeSettings(page);
  return text;
}

async function clearSelectedQueueRows(page: Page) {
  const selectedQueueRows = page.locator('.image-trail-panel__bookmark-item.is-selected');
  while ((await selectedQueueRows.count()) > 0) {
    await selectedQueueRows.first().dispatchEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  }
}

async function clearSelectedRecentRows(page: Page) {
  const selectedRecentRows = page.locator('.image-trail-panel__history-item.is-selected');
  while ((await selectedRecentRows.count()) > 0) {
    await selectedRecentRows.first().dispatchEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  }
}

test('exports the current host image and records shifted Save As metadata', async ({ page, serviceWorker }) => {
  await installDownloadRequestLog(serviceWorker);
  await openPanel(page, serviceWorker);

  await exportImages(page, serviceWorker, { saveAs: true });

  const downloads = await waitForDownloadRequests(serviceWorker, 1);
  expect(downloads[0]).toMatchObject({
    url: fixtureUrl(fixtureAssetPaths.assetOne),
    filename: 'asset-one.svg',
    saveAs: true,
    conflictAction: 'uniquify',
  });
});

test('exports selected recents, queue rows, and Recall rows in UI order', async ({ page, serviceWorker }) => {
  test.setTimeout(60_000);
  await installDownloadRequestLog(serviceWorker);
  await openPanel(page, serviceWorker);
  await deleteVisibleRecents(page);
  await deleteVisibleQueueRows(page);

  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetOne));
  await expectPanelStatusMessage(page, /Loaded .*asset-one\.svg|Image loaded but did not change\./u);
  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetTwo));
  await expectPanelStatusMessage(page, /Loaded .*asset-two\.svg/u);
  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetThree));
  await expectPanelStatusMessage(page, /Loaded .*asset-three\.svg/u);

  await page.getByRole('button', { name: 'Select all recents' }).click();
  await exportImages(page, serviceWorker);
  let downloads = await waitForDownloadRequests(serviceWorker, 3);
  expect(downloads.map((download) => download.filename)).toEqual(['asset-three.svg', 'asset-two.svg', 'asset-one.svg']);

  await page.locator('.image-trail-panel__history-item', { hasText: 'asset-three.svg' }).click();
  await pinCurrentImage(page);
  await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-three.svg' })).toBeVisible();
  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetTwo));
  await pinCurrentImage(page);
  await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-two.svg' })).toBeVisible();
  await clearSelectedRecentRows(page);
  await openQueueMenu(page);
  await page.getByRole('button', { name: 'Select all queue' }).click();
  await exportImages(page, serviceWorker);
  downloads = await waitForDownloadRequests(serviceWorker, 2);
  expect(downloads.map((download) => download.filename)).toEqual(['asset-two.svg', 'asset-three.svg']);
  await clearSelectedQueueRows(page);
  await expect(page.locator('.image-trail-panel__bookmark-item.is-selected')).toHaveCount(0);

  await setVisiblePins(page, '1', 1);
  await page.getByRole('button', { name: 'Open Recall' }).click();
  const recall = page.getByRole('dialog', { name: 'Recall' });
  await expect(recall.locator('.image-trail-panel__recall-list > li', { hasText: 'asset-three.svg' })).toBeVisible();
  await recall.getByRole('button', { name: 'Select all Recall' }).click();
  await exportImages(page, serviceWorker);
  downloads = await waitForDownloadRequests(serviceWorker, 1);
  expect(downloads.map((download) => download.filename)).toEqual(['asset-three.svg']);

  await expect(page.getByRole('dialog', { name: 'Recall' })).toHaveCount(0);
  await setVisiblePins(page, '30', 2);
});

test('captures originals, prefers stored bytes for export, and round-trips encrypted image files fail closed', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await installDownloadRequestLog(serviceWorker);
  await openPanel(page, serviceWorker);
  await setupEncryptedOriginals(page, serviceWorker);

  await pinCurrentImage(page);
  const queueRow = page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-one.svg' });
  await expect(queueRow).toBeVisible();
  await queueRow.getByRole('button', { name: 'Capture' }).click();
  await expectPanelStatusMessage(page, /Captured \d+\.\d KB image\./u);
  await expect(queueRow.locator('.image-trail-panel__stored-original-dot')).toHaveAttribute('title', 'Original stored');

  await openQueueMenu(page);
  await page.getByRole('button', { name: 'Select captured bookmarks' }).click();
  await openImageUtilities(page);
  await expect(page.getByRole('button', { name: 'Export images (1)' })).toBeVisible();
  await exportImages(page, serviceWorker);
  const plainDownloads = await waitForDownloadRequests(serviceWorker, 1);
  expect(plainDownloads[0]?.url).toMatch(/^data:image\/svg\+xml;base64,/u);
  expect(plainDownloads[0]?.filename).toBe('asset-one.svg');

  const { download, fileContent } = await exportEncryptedImage(page);
  expect(download.suggestedFilename()).toBe('asset-one.svg.image-trail-encrypted.json');
  const encryptedExport = JSON.parse(fileContent) as { readonly header: { readonly payloadType: string; readonly recordCount: number } };
  expect(encryptedExport.header).toMatchObject({ payloadType: 'image', recordCount: 1 });

  const bookmarkCountBeforeFailures = await page.locator('.image-trail-panel__bookmark-item').count();
  await importEncryptedImage(page, fileContent);
  await expectPanelStatusMessage(page, /Imported 1 encrypted image into bookmarks and recent history\./u);
  const bookmarkCountAfterImport = await page.locator('.image-trail-panel__bookmark-item').count();
  expect(bookmarkCountAfterImport).toBeGreaterThanOrEqual(bookmarkCountBeforeFailures);
  const importedRecent = page.locator('.image-trail-panel__history-item', { hasText: 'asset-one.svg' }).first();
  // A single click only selects (#426). A real double-click may reapply the public source URL,
  // but protected import bytes must never materialize in the host page as a data URL.
  await importedRecent.click();
  await expect(importedRecent).toHaveClass(/is-selected/u);
  await importedRecent.dblclick();
  await expect.poll(async () => (await imageNavigationSnapshot(page, primaryImage)).src).toBe(fixtureUrl(fixtureAssetPaths.assetOne));

  const historyCountBeforeWrongType = await page.locator('.image-trail-panel__history-item').count();
  await importEncryptedImage(page, JSON.stringify({ header: { payloadType: 'bookmarks' }, payload: '' }), 'wrong-type.json');
  await expectPanelStatusMessage(page, /Invalid export file|Unexpected payload type/u);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(bookmarkCountAfterImport);
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(historyCountBeforeWrongType);

  await deleteVisibleQueueRows(page);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);
  await clearEncryptedOriginalsKey(page);
  await setupEncryptedOriginals(page, serviceWorker, wrongPassword);
  const historyCountBeforeWrongKey = await page.locator('.image-trail-panel__history-item').count();
  await importEncryptedImage(page, fileContent);
  await expectPanelStatusMessage(page, /Unlock blob:[a-f0-9-]+ before importing this encrypted image\./u);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(historyCountBeforeWrongKey);
});

test('refuses to store oversized originals and keeps stored-original usage bounded', async ({ page, serviceWorker }) => {
  test.setTimeout(60_000);
  await openPanel(page, serviceWorker);
  await setupEncryptedOriginals(page, serviceWorker);

  await pinCurrentImage(page);
  const baselineRow = page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-one.svg' });
  await expect(baselineRow).toBeVisible();
  await baselineRow.getByRole('button', { name: 'Capture' }).click();
  await expectPanelStatusMessage(page, /Captured \d+\.\d KB image\./u);
  await expect(baselineRow.locator('.image-trail-panel__stored-original-dot')).toHaveAttribute('title', 'Original stored');
  // The capture flow refreshes storage usage after every attempt, so the
  // Storage health readout is current after each capture completes.
  const baselineUsage = await encryptedOriginalsStorageText(page);
  expect(baselineUsage).toMatch(/^1 record ·/u);

  // The fixture displays a normal thumbnail whose richer source URL points to the
  // oversized asset. The host image is therefore pinnable while capture still sees
  // and refuses the oversized response body.
  await openFixturePage(page, fixturePaths.oversizedImage);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
  await expectPanelStatusMessage(page, 'Auto-selected the only qualifying image.');
  await page.locator(primaryImage).evaluate((image: HTMLImageElement, thumbnailUrl) => {
    image.removeAttribute('srcset');
    image.src = thumbnailUrl;
  }, fixtureUrl(fixtureAssetPaths.assetOne));
  await expect
    .poll(() => page.locator(primaryImage).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), {
      timeout: 20_000,
    })
    .toBe(true);

  // Pin the oversized image into a durable queue row and attempt the capture from
  // there, so the refusal is exercised against a pinned queue record (matching the
  // acceptance flow) and a regression that mutated or dropped the durable row on an
  // oversized capture would be caught.
  await pinCurrentImage(page);
  const oversizedRow = page.locator('.image-trail-panel__bookmark-item', { hasText: 'generated-oversized.svg' });
  await expect(oversizedRow).toBeVisible();

  await oversizedRow.getByRole('button', { name: 'Capture' }).click();
  // Capture failures surface through the status toast, not the header status line.
  await expect(page.locator('.image-trail-panel__toast-message')).toHaveText(/exceeds limit|exceeds the 25 MB size limit/u);
  // The refused record stays a valid pinned queue row without a stored-original
  // marker, and the originals count/bytes stay at the pre-attempt baseline.
  await expect(oversizedRow).toBeVisible();
  await expect(oversizedRow.locator('.image-trail-panel__stored-original-dot[title="Original stored"]')).toHaveCount(0);
  expect(await encryptedOriginalsStorageText(page)).toBe(baselineUsage);

  // The extension context is shared with later spec files: drop the queue rows
  // this test pinned so their exports keep their expected record counts.
  await deleteVisibleQueueRows(page);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);
});
