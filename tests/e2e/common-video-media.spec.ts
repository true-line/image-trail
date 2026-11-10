import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Page, Worker } from '@playwright/test';

import {
  clearDownloadRequestLog,
  closeSettings,
  ensureBlobKeyCreated,
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
} from './fixtures.js';

const commonFixtureUrl = new URL('./pages/assets/media/common/', import.meta.url);
const mp4Hash = '255d0bf97174c3be46680efa94e9fc5a0fc22509c94cf7e92e805bd013eca020';
const importedFileNames: readonly string[] = ['mislabeled.webm', 'h264-aac.mkv', 'audio-only.mp2', 'vp9-opus.webm'];
const fixturePageUrl = fixtureUrl(fixturePaths.singleImage);

test.afterEach(async ({ extensionId, page }) => {
  await resetExtensionLibrary(page, extensionId, { recentPageUrl: fixturePageUrl, recordLabels: importedFileNames });
});

test('common video/audio import keeps exact custody, safe preview tiers, and atomic failures', async ({
  extensionId,
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  const [mp4, matroska, mp2, truncated, spoofed] = await Promise.all([
    readFile(new URL('h264-aac.mp4', commonFixtureUrl)),
    readFile(new URL('h264-aac.mkv', commonFixtureUrl)),
    readFile(new URL('audio-only.mp2', commonFixtureUrl)),
    readFile(new URL('truncated.mp4', commonFixtureUrl)),
    readFile(new URL('spoofed.mp4', commonFixtureUrl)),
  ]);

  await installDownloadRequestLog(serviceWorker);
  await openFixturePage(page, fixturePaths.singleImage);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
  await setupEncryptedOriginals(page);
  await openSettingsGroup(page, 'Image utilities');

  await page.getByLabel('Media files').setInputFiles([
    { name: 'mislabeled.webm', mimeType: 'video/webm', buffer: mp4 },
    { name: 'h264-aac.mkv', mimeType: 'video/x-matroska', buffer: matroska },
    { name: 'audio-only.mp2', mimeType: 'audio/mpeg', buffer: mp2 },
  ]);
  await page.getByRole('button', { name: 'Import selected' }).click();
  await expectPanelStatusMessage(page, 'Imported 3 media items into bookmarks and recent history.');

  await page.getByLabel('Direct media URL').fill(fixtureUrl(fixtureAssetPaths.commonWebm));
  await page.getByRole('button', { name: 'Capture URL' }).click();
  await expectPanelStatusMessage(page, 'Imported 1 media item into bookmarks and recent history.');

  for (const [name, extension] of [
    ['mislabeled.webm', 'MP4'],
    ['h264-aac.mkv', 'MKV'],
    ['audio-only.mp2', 'MP2'],
    ['vp9-opus.webm', 'WEBM'],
  ] as const) {
    const row = page.locator('.image-trail-panel__bookmark-item', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText(extension);
    await expect(row.locator('.image-trail-panel__stored-original-dot')).toHaveAttribute('title', 'Original stored');
    await expect(row.locator('.image-trail-ds__record-thumbnail')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/u);
  }

  const validationPage = await page.context().newPage();
  await validationPage.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html`);
  for (const [name, bytes] of [
    ['truncated.mp4', truncated],
    ['spoofed.mp4', spoofed],
  ] as const) {
    const malformed = await captureDataUrlAtomically(validationPage, `data:video/mp4;base64,${bytes.toString('base64')}`, name);
    expect(malformed.result).toMatchObject({ status: 'failed', reason: 'not-media' });
    expect(malformed.after).toBe(malformed.before);
  }
  await validationPage.close();

  const mp4Row = page.locator('.image-trail-panel__bookmark-item', { hasText: 'mislabeled.webm' });
  await mp4Row.click();
  await expect(mp4Row).toHaveAttribute('aria-selected', 'true');
  await clearDownloadRequestLog(serviceWorker);
  await page.getByRole('button', { name: /Export (?:images|media) \(1\)/u }).click();
  await expectPanelStatusMessage(page, /(?:Image|Media) export started\./u);
  const [download] = await waitForDownloadRequests(serviceWorker, 1);
  expect(download?.filename).toBe('mislabeled.mp4');
  expect(hashMediaDataUrl(download?.url ?? '')).toBe(mp4Hash);

  await closeSettings(page);
  await page.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html`);
  await expect(page.getByRole('heading', { name: 'Gallery', level: 1 })).toBeVisible();

  const webmPreview = await openGalleryPreview(page, 'vp9-opus.webm');
  const video = webmPreview.locator('.image-trail-preview-media__video');
  await expect(video).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate((element) => {
        const media = element as HTMLVideoElement;
        return { autoplay: media.autoplay, controls: media.controls, paused: media.paused };
      }),
    )
    .toEqual({ autoplay: false, controls: true, paused: true });
  await expect(webmPreview.locator('.image-trail-preview-media__video-status')).toContainText(/WEBM ready/u, {
    timeout: 20_000,
  });
  await expect(video).toHaveAttribute('poster', /^data:image\/png/u);
  await video.focus();
  await expect(video).toBeFocused();
  await video.evaluate(async (element) => {
    const media = element as HTMLVideoElement;
    media.muted = true;
    await media.play();
  });
  await expect(webmPreview.locator('.image-trail-preview-media__video-status')).toContainText('WEBM playing');
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime > 0 || (element as HTMLVideoElement).ended))
    .toBe(true);
  await video.evaluate((element) => (element as HTMLVideoElement).pause());
  await expect(webmPreview.locator('.image-trail-preview-media__video-status')).toContainText(/WEBM paused|playback complete/u);
  await webmPreview.close();

  const matroskaPreview = await openGalleryPreview(page, 'h264-aac.mkv');
  await expect(matroskaPreview.locator('.image-trail-preview-media__video')).toHaveCount(0);
  await expect(matroskaPreview.locator('.image-trail-preview-media__placeholder')).toContainText('Playback unavailable');
  await expect(matroskaPreview.locator('.image-trail-preview-media__video-status')).toContainText('Preserved-only MKV (H.264 + AAC)');
  await matroskaPreview.close();

  const audioPreview = await openGalleryPreview(page, 'audio-only.mp2');
  await expect(audioPreview.locator('.image-trail-preview-media__audio')).toHaveCount(0);
  await expect(audioPreview.locator('.image-trail-preview-media__video-status')).toContainText('Preserved-only MP2 (MP2)');
  await audioPreview.close();
});

async function setupEncryptedOriginals(page: Page): Promise<void> {
  await ensureBlobKeyCreated(page, 'common-media-original-password');
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

function hashMediaDataUrl(dataUrl: string): string {
  const encoded = /^data:(?:video|audio)\/[^;]+;base64,(.+)$/u.exec(dataUrl)?.[1];
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
