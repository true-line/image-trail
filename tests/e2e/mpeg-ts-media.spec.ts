import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Page, Worker } from '@playwright/test';

import {
  clearDownloadRequestLog,
  closeSettings,
  expect,
  expectPanelOpen,
  expectPanelStatusMessage,
  fixtureAssetPaths,
  fixturePaths,
  fixtureUrl,
  installDownloadRequestLog,
  openFixturePage,
  openSettingsGroup,
  readDownloadRequestLog,
  resetExtensionLibrary,
  test,
  togglePanelFromExtensionAction,
  fillPanelPassword,
} from './fixtures.js';

const supportedHash = 'da3d70e6479b8ce82d73ffa6b31b930a1555cb1c6e4d523854076ed2fab092d9';
const preservedHash = '095b7bfb8cfb4f4eaaa37bc7600a5870b3d3a8561769bcbdaa17e6603fb4a756';
const importedFileNames: readonly string[] = ['supported.m2ts', 'preserved.mts'];
const fixturePageUrl = fixtureUrl(fixturePaths.singleImage);

test.afterEach(async ({ extensionId, page }) => {
  await resetExtensionLibrary(page, extensionId, { recentPageUrl: fixturePageUrl, recordLabels: importedFileNames });
});

test('MPEG-TS import preserves exact bytes, rejects partial state, and provides honest previews', async ({
  extensionId,
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  const preserved = await readFile(new URL('../fixtures/mpeg-ts/preserved-mpeg2-mp2.mpegts', import.meta.url));
  const truncated = await readFile(new URL('../fixtures/mpeg-ts/truncated-h264-aac.mpegts', import.meta.url));

  await installDownloadRequestLog(serviceWorker);
  await openFixturePage(page, fixturePaths.singleImage);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
  await setupEncryptedOriginals(page);
  await openSettingsGroup(page, 'Image utilities');

  await page.getByLabel('Media files').setInputFiles([{ name: 'preserved.mts', mimeType: 'video/mp2t', buffer: preserved }]);
  await page.getByRole('button', { name: 'Import selected' }).click();
  await expectPanelStatusMessage(page, 'Imported 1 media item into bookmarks and recent history.');

  await page.getByLabel('Direct media URL').fill(fixtureUrl(fixtureAssetPaths.supportedMpegTs));
  await page.getByRole('button', { name: 'Capture URL' }).click();
  await expectPanelStatusMessage(page, 'Imported 1 media item into bookmarks and recent history.');

  const validationPage = await page.context().newPage();
  await validationPage.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html`);
  const importedRecords = await validationPage.evaluate(async (fileNames) => {
    const response = await chrome.runtime.sendMessage({
      type: 'imageTrail.loadBookmarks',
      version: 1,
      payload: { offset: 0, limit: 500, scope: 'global' },
    });
    return (
      (response?.payload?.items ?? []) as Array<{
        captureStatus?: string;
        label?: string;
        storedOriginal?: { fileName?: string };
        thumbnail?: string;
      }>
    )
      .filter((item) => item.label && fileNames.includes(item.label))
      .map((item) => ({
        captureStatus: item.captureStatus,
        fileName: item.storedOriginal?.fileName,
        hasPoster: item.thumbnail?.startsWith('data:image/svg+xml;base64,') ?? false,
        label: item.label,
      }))
      .sort((left, right) => (left.label ?? '').localeCompare(right.label ?? ''));
  }, importedFileNames);
  expect(importedRecords).toEqual([
    { captureStatus: 'captured', fileName: 'preserved.mts', hasPoster: true, label: 'preserved.mts' },
    { captureStatus: 'captured', fileName: 'supported.m2ts', hasPoster: true, label: 'supported.m2ts' },
  ]);

  const supportedRow = page.locator('.image-trail-panel__bookmark-item', { hasText: 'supported.m2ts' });
  await expect(supportedRow).toBeVisible();
  await expect(supportedRow.locator('.image-trail-panel__stored-original-dot')).toHaveAttribute('title', 'Original stored');
  await expect(supportedRow.locator('.image-trail-ds__record-thumbnail')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/u);
  await expect(supportedRow).toContainText('M2TS');

  const malformed = await captureDataUrlAtomically(
    validationPage,
    `data:video/mp2t;base64,${truncated.toString('base64')}`,
    'truncated.ts',
  );
  await validationPage.close();
  expect(malformed.result).toMatchObject({ status: 'failed', reason: 'not-media' });
  expect(malformed.after).toBe(malformed.before);

  await supportedRow.press(' ');
  await expect(supportedRow).toHaveAttribute('aria-selected', 'true');
  await clearDownloadRequestLog(serviceWorker);
  await page.getByRole('button', { name: /Export (?:images|media) \(1\)/u }).click();
  await expectPanelStatusMessage(page, /(?:Image|Media) export started\./u);
  const [download] = await waitForDownloadRequests(serviceWorker, 1);
  expect(download?.filename).toBe('supported.m2ts');
  expect(hashDataUrl(download?.url ?? '')).toBe(supportedHash);

  await closeSettings(page);
  await page.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html`);
  await expect(page.getByRole('heading', { name: 'Gallery', level: 1 })).toBeVisible();

  const supportedPreview = await openGalleryPreview(page, 'supported.m2ts');
  const video = supportedPreview.locator('.image-trail-preview-media__video');
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate((element) => {
        const media = element as HTMLVideoElement;
        return { autoplay: media.autoplay, controls: media.controls, paused: media.paused };
      }),
    )
    .toEqual({ autoplay: false, controls: true, paused: true });
  await expect(supportedPreview.locator('.image-trail-preview-media__video-status')).toContainText(/MPEG-TS ready/u, {
    timeout: 20_000,
  });
  await expect(video).toHaveAttribute('poster', /^data:image\/png/u);
  await video.focus();
  await expect(video).toBeFocused();
  await video.evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    media.muted = true;
    media.volume = 0.5;
    await media.play();
  });
  await expect(supportedPreview.locator('.image-trail-preview-media__video-status')).toContainText('MPEG-TS playing');
  await expect
    .poll(() =>
      video.evaluate((element) => {
        const media = element as HTMLVideoElement;
        return media.currentTime > 0 || media.ended;
      }),
    )
    .toBe(true);
  await video.evaluate((element) => (element as HTMLVideoElement).pause());
  await expect(supportedPreview.locator('.image-trail-preview-media__video-status')).toContainText(/MPEG-TS paused|playback complete/u);
  await supportedPreview.close();

  const preservedPreview = await openGalleryPreview(page, 'preserved.mts');
  await expect(preservedPreview.locator('.image-trail-preview-media__video')).toHaveCount(0);
  await expect(preservedPreview.locator('.image-trail-preview-media__placeholder')).toContainText('Playback unavailable');
  await expect(preservedPreview.locator('.image-trail-preview-media__video-status')).toContainText(
    'Preserved-only MPEG-TS (MPEG-2 Video + MP2)',
  );
  await preservedPreview.close();

  expect(createHash('sha256').update(preserved).digest('hex')).toBe(preservedHash);
});

async function setupEncryptedOriginals(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Encrypted originals');
  if (
    (await page
      .locator('.image-trail-panel__encryption-badge')
      .filter({ hasText: /^Unlocked$/u })
      .count()) > 0
  ) {
    await closeSettings(page);
    return;
  }
  await fillPanelPassword(page, 'New encrypted originals password', 'mpeg-ts-original-password');
  await page.getByRole('button', { name: 'Create first key' }).click();
  await expect(page.locator('.image-trail-panel__encryption-badge')).toHaveText('Unlocked');
  await closeSettings(page);
}

async function waitForDownloadRequests(serviceWorker: Worker, count: number) {
  let downloads = await readDownloadRequestLog(serviceWorker);
  await expect
    .poll(async () => {
      downloads = await readDownloadRequestLog(serviceWorker);
      return downloads.length;
    })
    .toBe(count);
  return downloads;
}

function hashDataUrl(dataUrl: string): string {
  const encoded = /^data:video\/mp2t;base64,(.+)$/u.exec(dataUrl)?.[1];
  expect(encoded).toBeDefined();
  return createHash('sha256').update(Buffer.from(encoded!, 'base64')).digest('hex');
}

async function captureDataUrlAtomically(
  extensionPage: Page,
  dataUrl: string,
  fileName: string,
): Promise<{ readonly before: number; readonly after: number; readonly result: unknown }> {
  return extensionPage.evaluate(
    async ({ source, name }) => {
      const originalCount = () =>
        new Promise<number>((resolve, reject) => {
          const open = indexedDB.open('image-trail');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const transaction = db.transaction('originalBlobIndex', 'readonly');
            const count = transaction.objectStore('originalBlobIndex').count();
            count.onsuccess = () => resolve(count.result);
            count.onerror = () => reject(count.error);
            transaction.oncomplete = () => db.close();
          };
        });
      const before = await originalCount();
      const response = await chrome.runtime.sendMessage({
        type: 'imageTrail.captureImage',
        version: 1,
        payload: { url: source, sourceType: 'bookmark', fileName: name },
      });
      const after = await originalCount();
      return { before, after, result: response?.payload };
    },
    { source: dataUrl, name: fileName },
  );
}

async function openGalleryPreview(gallery: Page, fileName: string): Promise<Page> {
  const card = gallery.locator('.image-trail-gallery__card', { hasText: fileName });
  const opened = gallery.context().waitForEvent('page');
  await card.locator('.image-trail-gallery__card-button').click();
  const preview = await opened;
  await preview.waitForLoadState('domcontentloaded');
  await expect(preview.locator('.image-trail-preview-media')).toBeVisible();
  return preview;
}
