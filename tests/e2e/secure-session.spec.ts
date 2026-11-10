import type { Page, Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeSettings,
  expect,
  expectPanelOpen,
  expectPanelStatusMessage,
  fixturePaths,
  launchPersistentExtensionSession,
  openFixturePage,
  openSettingsGroup,
  test,
  togglePanelFromExtensionAction,
  fillPanelPassword,
} from './fixtures.js';
import { pinCurrentImage } from './current-image-actions.js';
import { detachHistory } from './workspace-test-helpers.js';

async function stopExtensionWorker(page: Page, worker: Worker): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const { targetInfos } = await session.send('Target.getTargets');
  const target = targetInfos.find((candidate) => candidate.type === 'service_worker' && candidate.url === worker.url());
  if (!target) throw new Error(`Extension service-worker target not found: ${worker.url()}`);
  const closed = await session.send('Target.closeTarget', { targetId: target.targetId });
  expect(closed.success).toBe(true);
  await session.detach();
  const observer = await page.context().newCDPSession(page);
  await expect
    .poll(async () => (await observer.send('Target.getTargets')).targetInfos.some((candidate) => candidate.targetId === target.targetId), {
      timeout: 20_000,
    })
    .toBe(false);
  await observer.detach();
}

test('one secure lock conceals and restores panel, detached, destination, Gallery, and preview surfaces', async ({ headless }) => {
  test.setTimeout(60_000);
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'image-trail-secure-session-'));
  const { context, serviceWorker } = await launchPersistentExtensionSession(userDataDir, headless);
  const page = await context.newPage();
  const extensionId = /^chrome-extension:\/\/(?<id>[^/]+)/u.exec(serviceWorker.url())?.groups?.['id'];
  if (!extensionId) throw new Error(`Could not resolve extension id from ${serviceWorker.url()}`);
  const destination = await context.newPage();
  const gallery = await context.newPage();
  let preview: Page | null = null;
  let coldGallery: Page | null = null;
  try {
    await openFixturePage(page, fixturePaths.singleImage);
    await togglePanelFromExtensionAction(page, serviceWorker);
    await expectPanelOpen(page);
    const sourceTabId = await serviceWorker.evaluate(async (sourceUrl) => {
      const source = (await chrome.tabs.query({ currentWindow: true })).find((tab) => tab.url === sourceUrl);
      return source?.id;
    }, page.url());
    if (typeof sourceTabId !== 'number') throw new Error(`Could not resolve source tab for ${page.url()}`);

    await openSettingsGroup(page, 'Encrypted originals');
    await fillPanelPassword(page, 'New encrypted originals password', 'secure-session-test-password');
    await page.getByRole('button', { name: 'Create first key' }).click();
    await expect(page.locator('.image-trail-panel__encryption-badge')).toHaveText('Unlocked');
    await closeSettings(page);

    await pinCurrentImage(page);
    const row = page.locator('.image-trail-panel__bookmark-item').first();
    await expect(row).toBeVisible();
    await stopExtensionWorker(page, serviceWorker);

    await row.getByRole('button', { name: 'Capture' }).click();
    await expectPanelStatusMessage(page, /Captured \d+(?:\.\d+)? (?:B|KB|MB) image\./u);
    await expect(row.locator('.image-trail-panel__stored-original-dot')).toHaveAttribute('title', 'Original stored');

    await detachHistory(page);
    await destination.goto(`chrome-extension://${extensionId}/src/destinations/view.html?view=dashboard`);
    await expect(destination.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await gallery.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html?view=gallery`);
    await expect(gallery.getByRole('heading', { name: 'Gallery', level: 1 })).toBeVisible();
    const previewOpened = context.waitForEvent('page');
    await destination.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'imageTrail.createDataUrlPreview',
        version: 1,
        payload: { dataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' },
      });
    });
    preview = await previewOpened;
    await preview.waitForLoadState('domcontentloaded');
    await expect(preview.locator('img')).toBeVisible();

    await destination.evaluate(async (tabId) => chrome.tabs.update(tabId, { active: true }), sourceTabId);
    await page.bringToFront();
    await page.getByRole('button', { name: 'Lock workspace' }).click();
    const panelLock = page.locator('[data-secure-workspace-lock="true"]');
    await expect(panelLock).toBeVisible();
    await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);
    await expect(page.locator('[data-image-trail-detached-window]')).toHaveCount(0);
    await expect(page.locator('.image-trail-panel-root img')).toHaveCount(0);
    await expect(page.locator('#image-trail-panel-root')).toHaveCount(1);
    await expect(preview.locator('img')).toHaveCount(0);
    await expect(preview.getByRole('heading', { name: 'Image Trail is locked' })).toBeVisible();

    await expect(destination.getByRole('heading', { name: 'Image Trail is locked' })).toBeVisible();
    await expect(destination.getByText('Durable records')).toHaveCount(0);
    await expect(gallery.getByRole('heading', { name: 'Image Trail is locked' })).toBeVisible();
    await expect(gallery.locator('.image-trail-gallery__card')).toHaveCount(0);

    coldGallery = await context.newPage();
    await coldGallery.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html?view=gallery`);
    await expect(coldGallery.getByRole('heading', { name: 'Image Trail is locked' })).toBeVisible();
    await expect(coldGallery.locator('#image-trail-gallery-root')).toHaveCount(0);
    await expect(coldGallery.locator('.image-trail-gallery__card')).toHaveCount(0);

    await gallery.getByLabel('Password').fill('wrong-password');
    await gallery.getByRole('button', { name: 'Unlock workspace' }).click();
    await expect(gallery.getByRole('alert')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);

    await gallery.getByLabel('Password').fill('secure-session-test-password');
    await gallery.getByRole('button', { name: 'Unlock workspace' }).click();
    await expect(gallery.getByRole('heading', { name: 'Gallery', level: 1 })).toBeVisible({ timeout: 20_000 });
    await expect(destination.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(panelLock).toHaveCount(0);
    await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(1);
    await expect(page.locator('[data-image-trail-detached-window="history"]')).toBeVisible();
    await expect(page.locator('#image-trail-panel-root')).toHaveCount(1);
    await expect(preview.locator('img')).toBeVisible();
  } finally {
    if (preview && !preview.isClosed()) await preview.close();
    if (coldGallery && !coldGallery.isClosed()) await coldGallery.close();
    await destination.close();
    await gallery.close();
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
