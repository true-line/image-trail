import { createHash } from 'node:crypto';

import type { Page, Worker } from '@playwright/test';

import {
  applyUrlInEditor,
  clearDownloadRequestLog,
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
  test,
  togglePanelFromExtensionAction,
} from './fixtures.js';
import { pinCurrentImage } from './current-image-actions.js';

const expectedHashes = new Map([
  ['animated.gif', 'e91380db853442ee77466f0f4a4b85f86c07b1607597efce84f1985ed38267f0'],
  ['animated.webp', 'b0a4e06afd321fbcefdf834e165224734e99f0df811ab532c5bd3e94518f9b18'],
  ['static.webp', '786ba2cc8b977a04ec253aae1b5807485716d62927faecea9a364fcbbe601065'],
]);

test('GIF/WebP capture keeps exact originals, static posters, safe failures, and controllable full previews', async ({
  extensionId,
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  await installDownloadRequestLog(serviceWorker);
  await openFixturePage(page, fixturePaths.animatedMedia);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
  await setupEncryptedOriginals(page);

  const captures = [
    { fileName: 'animated.gif', url: fixtureUrl(fixtureAssetPaths.animatedGif) },
    { fileName: 'animated.webp', url: fixtureUrl(fixtureAssetPaths.animatedWebp) },
    { fileName: 'static.webp', url: fixtureUrl(fixtureAssetPaths.staticWebp) },
  ] as const;

  for (const [index, capture] of captures.entries()) {
    if (index > 0) {
      await applyUrlInEditor(page, capture.url);
      await expectPanelStatusMessage(page, new RegExp(`Loaded .*${capture.fileName.replace('.', '\\.')}`, 'u'));
    }
    await pinCurrentImage(page);
    const row = page.locator('.image-trail-panel__bookmark-item', { hasText: capture.fileName });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Capture' }).click();
    await expectPanelStatusMessage(page, /Captured \d+\.\d KB image\./u);
    await expect(row.locator('.image-trail-panel__stored-original-dot')).toHaveAttribute('title', 'Original stored');
    const thumbnail = row.locator('.image-trail-ds__record-thumbnail');
    await expect(thumbnail).toHaveAttribute('src', /^data:image\/jpeg/u);
    const poster = await thumbnail.getAttribute('src');
    await page.waitForTimeout(350);
    expect(await thumbnail.getAttribute('src')).toBe(poster);

    await row.press(' ');
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await openSettingsGroup(page, 'Image utilities');
    await clearDownloadRequestLog(serviceWorker);
    await page.getByRole('button', { name: 'Export images (1)' }).click();
    await expectPanelStatusMessage(page, 'Image export started.');
    const [download] = await waitForDownloadRequests(serviceWorker, 1);
    expect(download?.filename).toBe(capture.fileName);
    expect(hashDataUrl(download!.url)).toBe(expectedHashes.get(capture.fileName));
    await page.getByRole('button', { name: 'Close settings' }).click();
  }

  const extensionPage = await page.context().newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html`);
  const malformed = await captureMalformedFixture(extensionPage, fixtureUrl(fixtureAssetPaths.truncatedGif));
  await extensionPage.close();
  expect(malformed.result).toMatchObject({ status: 'failed', reason: 'not-image' });
  expect(malformed.after).toBe(malformed.before);

  await page.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html`);
  await expect(page.getByRole('heading', { name: 'Gallery', level: 1 })).toBeVisible();
  const gifPreview = await openGalleryPreview(page, 'animated.gif');
  await expect(gifPreview.locator('.image-trail-preview-media__image')).toHaveAttribute('src', /^data:image\/gif;base64,/u);
  await expectDecodedMedia(gifPreview);

  await gifPreview.emulateMedia({ reducedMotion: 'reduce' });
  const play = gifPreview.getByRole('button', { name: 'Play animation' });
  await expect(play).toBeVisible();
  await expect(gifPreview.locator('.image-trail-preview-media__image')).toHaveAttribute('src', /^data:image\/png/u);
  const poster = await gifPreview.locator('.image-trail-preview-media__image').getAttribute('src');
  await gifPreview.waitForTimeout(350);
  expect(await gifPreview.locator('.image-trail-preview-media__image').getAttribute('src')).toBe(poster);
  await play.click();
  await expect(gifPreview.getByRole('button', { name: 'Stop animation' })).toBeVisible();
  await expect(gifPreview.locator('.image-trail-preview-media__image')).toHaveAttribute('src', /^data:image\/gif;base64,/u);
  await gifPreview.getByRole('button', { name: 'Stop animation' }).click();
  await expect(gifPreview.locator('.image-trail-preview-media__image')).toHaveAttribute('src', poster!);
  await gifPreview.close();

  const webpPreview = await openGalleryPreview(page, 'animated.webp');
  await expect(webpPreview.locator('.image-trail-preview-media__image')).toHaveAttribute('src', /^data:image\/webp;base64,/u);
  await expectDecodedMedia(webpPreview);
  await webpPreview.close();

  const staticPreview = await openGalleryPreview(page, 'static.webp');
  await expect(staticPreview.locator('.image-trail-preview-media__image')).toHaveAttribute('src', /^data:image\/webp;base64,/u);
  await staticPreview.emulateMedia({ reducedMotion: 'reduce' });
  await expect(staticPreview.getByRole('button', { name: 'Play animation' })).toHaveCount(0);
  await staticPreview.close();
});

async function setupEncryptedOriginals(page: Page): Promise<void> {
  await ensureBlobKeyCreated(page, 'gif-webp-original-password');
}

async function captureMalformedFixture(
  extensionPage: Page,
  url: string,
): Promise<{ readonly before: number; readonly after: number; readonly result: unknown }> {
  return extensionPage.evaluate(async (sourceUrl) => {
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
    const result = await chrome.runtime.sendMessage({
      type: 'imageTrail.captureImage',
      version: 1,
      payload: { url: sourceUrl, sourceType: 'target' },
    });
    const after = await originalCount();
    return { before, after, result: result?.payload };
  }, url);
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
  const encoded = /^data:image\/[^;]+;base64,(.+)$/u.exec(dataUrl)?.[1];
  expect(encoded).toBeDefined();
  return createHash('sha256').update(Buffer.from(encoded!, 'base64')).digest('hex');
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

async function expectDecodedMedia(preview: Page): Promise<void> {
  await expect
    .poll(() =>
      preview.locator('.image-trail-preview-media__image').evaluate((image) => ({
        complete: image instanceof HTMLImageElement && image.complete,
        width: image instanceof HTMLImageElement ? image.naturalWidth : 0,
        height: image instanceof HTMLImageElement ? image.naturalHeight : 0,
      })),
    )
    .toEqual({ complete: true, width: 40, height: 40 });
}
