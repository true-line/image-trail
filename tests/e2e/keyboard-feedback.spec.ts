import type { Page, Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyUrlInEditor,
  clearDownloadRequestLog,
  closeSettings,
  expect,
  expectPanelClosed,
  expectPanelOpen,
  expectPanelStatusMessage,
  fixturePaths,
  fixtureUrl,
  installDownloadRequestLog,
  launchPersistentExtensionSession,
  openFixturePage,
  openSettingsGroup,
  readDownloadRequestLog,
  test,
  togglePanelFromExtensionAction,
} from './fixtures.js';

const feedbackSelector = '.image-trail-panel__shortcut-feedback';

async function openPanel(
  page: Page,
  serviceWorker: Worker,
  fixture: (typeof fixturePaths)[keyof typeof fixturePaths] = fixturePaths.singleImage,
): Promise<void> {
  await openFixturePage(page, fixture);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
}

async function setDownArrowAction(page: Page, action: 'capture' | 'download' | 'off'): Promise<void> {
  await page.keyboard.press(',');
  await expect(page.locator('.image-trail-panel__settings-section')).toBeVisible();
  await openSettingsGroup(page, 'Automation');
  await page.getByRole('combobox', { name: 'Down arrow action' }).selectOption(action);
  await page.keyboard.press('Escape');
  await expect(page.locator('.image-trail-panel__settings-section')).toHaveCount(0);
}

async function expectFeedback(page: Page, copy: string | RegExp): Promise<void> {
  const feedback = page.locator(feedbackSelector);
  await expect(feedback).toBeVisible();
  await expect(feedback).toHaveText(copy);
  expect(await feedback.textContent()).not.toMatch(/https?:\/\/|blob:/u);
}

async function ensureBlobKeyUnavailable(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Encrypted originals');
  const clear = page.getByRole('button', { name: 'Clear key' });
  if ((await clear.count()) > 0) {
    await clear.click();
    await page.getByRole('button', { name: 'Confirm clear key' }).click();
    await expectPanelStatusMessage(page, /Encrypted blob key cleared/u);
  }
  await closeSettings(page);
}

async function waitForDownloads(serviceWorker: Worker, expected: number): Promise<void> {
  await expect.poll(async () => (await readDownloadRequestLog(serviceWorker)).length).toBe(expected);
}

async function storedDownArrowAction(serviceWorker: Worker): Promise<string | undefined> {
  return serviceWorker.evaluate(async () => {
    const stored = (await chrome.storage.local.get('imageTrail.localSettings'))['imageTrail.localSettings'];
    const settings = typeof stored === 'string' ? (JSON.parse(stored) as Record<string, unknown>) : stored;
    return settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>)['downArrowAction'] as string | undefined)
      : undefined;
  });
}

async function includeQueryFrame(page: Page): Promise<void> {
  const fields = page.locator('.image-trail-panel__fields');
  if (!(await fields.evaluate((element) => element.hasAttribute('open')))) {
    await page.getByRole('button', { name: 'Show Field Editor' }).click();
  }
  await page.getByRole('button', { name: /Increment .*frame/u }).click();
  const include = page.getByRole('button', { name: /Include query frame/u });
  if ((await include.count()) > 0) await include.click();
}

test('canonical bare keys route surfaces and reset privacy-safe capture feedback', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  await ensureBlobKeyUnavailable(page);

  await page.keyboard.press('c');
  await expectFeedback(page, 'Pinned — unlock encryption to store the original');
  await expect(page.locator('.image-trail-panel__capture-hint')).toHaveText('Pinned — unlock encryption to store the original');
  // The panel's 1400ms dismissal timer starts when it shows the feedback, so
  // measure from the moment it is visible: the first deadline falls at or
  // before this moment plus 1400ms.
  const firstShownAt = Date.now();

  await page.waitForTimeout(900);
  await page.keyboard.press('C');
  await expectFeedback(page, 'Pinned — unlock encryption to store the original');
  // The second press must have RESTARTED the timer, not merely shown the same
  // text again. "It eventually goes away" cannot tell those apart: without a
  // reset, the ORIGINAL timer would remove the feedback about 500ms after the
  // second press and the test would still pass. So check the feedback is
  // still there once the first timer's deadline has passed — between that
  // deadline and the one a reset would create — and only then that it goes.
  //
  // The sample point is 300ms past the first deadline (the panel starts the
  // timer no later than the moment the feedback was observed) and 600ms
  // before the earliest deadline a reset could have set (the second press
  // happened at least 900ms later, so a fresh 1400ms runs to at least
  // firstShownAt + 2300).
  const firstDeadlinePassed = firstShownAt + 1_400 + 300;
  const waitUntilFirstDeadline = firstDeadlinePassed - Date.now();
  if (waitUntilFirstDeadline > 0) await page.waitForTimeout(waitUntilFirstDeadline);
  await expect(page.locator(feedbackSelector)).toHaveCount(1, { timeout: 500 });
  await expect(page.locator(feedbackSelector)).toHaveCount(0, { timeout: 3_000 });
  await expect(page.locator('.image-trail-panel__capture-hint')).toHaveText('Press C to capture; hold Shift on Capture or press P to pin.');

  await page.keyboard.press('p');
  await expectFeedback(page, 'Pinned current image ✓');
  await expect(page.locator(feedbackSelector)).toHaveCount(0, { timeout: 1_800 });
  await page.keyboard.press('b');
  await expectFeedback(page, 'Pinned — unlock encryption to store the original');
  await expect(page.locator(feedbackSelector)).toHaveCount(0, { timeout: 1_800 });

  await page.locator('body').dispatchEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true });
  await expect(page.locator('.image-trail-panel__help-section')).toBeVisible();
  await page.keyboard.press(',');
  await expect(page.locator('.image-trail-panel__settings-section')).toBeVisible();
  await expect(page.locator('.image-trail-panel__help-section')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.image-trail-panel__settings-section')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expectPanelClosed(page);

  await page.keyboard.press('c');
  await expect(page.locator(feedbackSelector)).toHaveCount(0);
});

test('typing, modifier, and native record-row contexts retain their keyboard events', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  const editor = page.locator('.image-trail-panel__full-url-input');
  await editor.focus();
  await page.keyboard.press('End');
  await page.keyboard.type('cpg?');
  await expect(editor).toHaveValue(/cpg\?$/u);
  await expect(page.locator(feedbackSelector)).toHaveCount(0);

  await page.keyboard.press('Control+C');
  await expect(page.locator(feedbackSelector)).toHaveCount(0);
  await page.evaluate(() => {
    (window as typeof window & { imageTrailNativeDown?: number }).imageTrailNativeDown = 0;
    document.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        (window as typeof window & { imageTrailNativeDown?: number }).imageTrailNativeDown = 1;
      }
    });
  });
  const row = page.locator('[data-image-trail-row-id]').first();
  await row.focus();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => (window as typeof window & { imageTrailNativeDown?: number }).imageTrailNativeDown)).toBe(1);
  await expect(page.locator(feedbackSelector)).toHaveCount(0);
});

test('Trail arrows and Grab Mode use the canonical registry', async ({ page, serviceWorker }) => {
  await page.context().route(/\/dynamic-image\.svg\?frame=/u, async (route) => {
    const frame = new URL(route.request().url()).searchParams.get('frame') ?? 'unknown';
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><text x="10" y="60">${frame}</text></svg>`,
    });
  });
  await openPanel(page, serviceWorker);
  await applyUrlInEditor(page, fixtureUrl('/dynamic-image.svg?frame=1'));
  await expectPanelStatusMessage(page, /frame=1/u);
  await includeQueryFrame(page);
  await expectPanelStatusMessage(page, /frame=2/u);
  await page.keyboard.press('ArrowRight');
  await expectPanelStatusMessage(page, /frame=3/u);
  await page.keyboard.press('ArrowLeft');
  await expectPanelStatusMessage(page, /frame=2/u);

  await openFixturePage(page, fixturePaths.multipleImages);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
  await page.keyboard.press('g');
  await expect(page.getByRole('button', { name: 'Stop Grab Mode' })).toBeVisible();
  await page.keyboard.press('G');
  await expect(page.getByRole('button', { name: 'Grab Mode' })).toBeVisible();
});

test('Down assignment persists, uses the existing download path, and reloads across source tabs', async ({
  page,
  serviceWorker,
  extensionContext,
}) => {
  await installDownloadRequestLog(serviceWorker);
  await clearDownloadRequestLog(serviceWorker);
  await openPanel(page, serviceWorker);
  await setDownArrowAction(page, 'download');
  const originalPageCount = extensionContext.pages().length;

  await page.keyboard.press('ArrowDown');
  await expectFeedback(page, 'Downloading current image…');
  await waitForDownloads(serviceWorker, 1);
  expect(extensionContext.pages()).toHaveLength(originalPageCount);
  expect((await readDownloadRequestLog(serviceWorker))[0]).toMatchObject({
    url: fixtureUrl('/assets/asset-one.svg'),
    saveAs: false,
  });

  const secondPage = await extensionContext.newPage();
  try {
    await openPanel(secondPage, serviceWorker, fixturePaths.redrawImage);
    await secondPage.keyboard.press('ArrowDown');
    await waitForDownloads(serviceWorker, 2);

    await setDownArrowAction(page, 'off');
    await expect.poll(() => storedDownArrowAction(serviceWorker)).toBe('off');
    await secondPage.keyboard.press(',');
    await openSettingsGroup(secondPage, 'Automation');
    await expect(secondPage.getByRole('combobox', { name: 'Down arrow action' })).toHaveValue('off');
    await secondPage.keyboard.press('Escape');
    await secondPage.evaluate(() => {
      (window as typeof window & { imageTrailNativeDown?: number }).imageTrailNativeDown = 0;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          (window as typeof window & { imageTrailNativeDown?: number }).imageTrailNativeDown = 1;
        }
      });
    });
    await secondPage.keyboard.press('ArrowDown');
    await expect.poll(async () => (await readDownloadRequestLog(serviceWorker)).length).toBe(2);
    expect(await secondPage.evaluate(() => (window as typeof window & { imageTrailNativeDown?: number }).imageTrailNativeDown)).toBe(1);

    await secondPage.reload();
    await togglePanelFromExtensionAction(secondPage, serviceWorker);
    await expectPanelOpen(secondPage);
    await secondPage.keyboard.press('ArrowDown');
    await expect.poll(async () => (await readDownloadRequestLog(serviceWorker)).length).toBe(2);
  } finally {
    await secondPage.close();
  }
});

test('Down download resolves an imported data image without exposing it in feedback', async ({ page, serviceWorker }) => {
  const dataImageUrl = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#7cf3c5"/></svg>',
  )}`;
  await installDownloadRequestLog(serviceWorker);
  await clearDownloadRequestLog(serviceWorker);
  await openFixturePage(page, fixturePaths.singleImage);
  await page
    .locator('img')
    .first()
    .evaluate((image, url) => {
      const target = image as HTMLImageElement;
      target.removeAttribute('srcset');
      target.src = url;
    }, dataImageUrl);
  await expect
    .poll(() =>
      page
        .locator('img')
        .first()
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
  await setDownArrowAction(page, 'download');

  await page.keyboard.press('ArrowDown');

  await expectFeedback(page, 'Downloading current image…');
  await waitForDownloads(serviceWorker, 1);
  expect((await readDownloadRequestLog(serviceWorker))[0]).toMatchObject({ url: dataImageUrl, saveAs: false });
});

test('Down assignment survives an extension process restart without duplicate listeners', async ({ headless }) => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'image-trail-keyboard-reload-'));
  try {
    const first = await launchPersistentExtensionSession(userDataDir, headless);
    try {
      const source = await first.context.newPage();
      await openPanel(source, first.serviceWorker);
      await setDownArrowAction(source, 'off');
      await expect.poll(() => storedDownArrowAction(first.serviceWorker)).toBe('off');
    } finally {
      await first.context.close();
    }

    const second = await launchPersistentExtensionSession(userDataDir, headless);
    try {
      const source = await second.context.newPage();
      await openPanel(source, second.serviceWorker);
      await source.keyboard.press(',');
      await openSettingsGroup(source, 'Automation');
      await expect(source.getByRole('combobox', { name: 'Down arrow action' })).toHaveValue('off');
      await expect(source.locator('#image-trail-panel-root')).toHaveCount(1);
    } finally {
      await second.context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
