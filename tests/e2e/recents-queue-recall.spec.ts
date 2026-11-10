import type { Page, Worker } from '@playwright/test';

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
  installDownloadRequestLog,
  openFixturePage,
  openSettingsGroup,
  readDownloadRequestLog,
  setLoadFailureFeedback,
  test,
  togglePanelFromExtensionAction,
  fillPanelPassword,
} from './fixtures.js';
import { pinCurrentImage } from './current-image-actions.js';

const encryptedOriginalsPassword = 'correct horse battery staple';

async function openPanel(page: Page, serviceWorker: Worker): Promise<void> {
  await openFixturePage(page, fixturePaths.singleImage);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
}

async function openImageUtilities(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Image utilities');
}

async function setupEncryptedOriginals(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Encrypted originals');
  if ((await page.getByText(/Encrypted capture is unlocked with blob:/u).count()) > 0) {
    await closeSettings(page);
    return;
  }
  await fillPanelPassword(page, 'New encrypted originals password', encryptedOriginalsPassword);
  await page.getByRole('button', { name: 'Create first key' }).click();
  await expectPanelStatusMessage(page, /Encrypted blob storage unlocked with blob:[a-f0-9-]+\./u);
  await closeSettings(page);
}

async function openQueueMenu(page: Page): Promise<void> {
  const queueMenu = page.getByTitle('Queue scope and maintenance actions.');
  if ((await queueMenu.getAttribute('aria-expanded')) !== 'true') await queueMenu.click();
}

async function setVisiblePins(page: Page, value: string, expectedVisibleCount?: number): Promise<void> {
  await openSettingsGroup(page, 'Display');
  const pins = page
    .getByRole('heading', { name: 'Pins' })
    .locator('xpath=ancestor::div[contains(@class, "image-trail-panel__settings-templates")][1]');
  await pins.locator('input[type="number"]').fill(value);
  await pins.locator('button', { hasText: 'Apply' }).click();
  await closeSettings(page);
  if (expectedVisibleCount !== undefined) {
    await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(expectedVisibleCount);
  }
}

async function setVisibleRecents(
  page: Page,
  input: {
    readonly limit: string;
    readonly retainedLimit?: string;
    readonly overflow: 'Drop oldest' | 'Keep hidden this session' | 'Auto-pin overflow';
    readonly expectedVisibleCount?: number;
  },
): Promise<void> {
  await openSettingsGroup(page, 'Display');
  const recents = page
    .getByRole('heading', { name: 'Recents' })
    .locator('xpath=ancestor::div[contains(@class, "image-trail-panel__settings-templates")][1]');
  await recents.locator('input[type="number"]').nth(0).fill(input.limit);
  await recents
    .locator('input[type="number"]')
    .nth(1)
    .fill(input.retainedLimit ?? input.limit);
  await recents
    .locator('label')
    .filter({ hasText: /^Overflow/u })
    .locator('select')
    .selectOption({ label: input.overflow });
  await recents.locator('button', { hasText: 'Apply' }).click();
  await closeSettings(page);
  if (input.expectedVisibleCount !== undefined) {
    await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(input.expectedVisibleCount);
  }
}

async function setEncryptedPinPreference(page: Page, encrypted: boolean): Promise<void> {
  await openSettingsGroup(page, 'Privacy');
  const preference = page.getByLabel('Prefer encrypted pin saves');
  if ((await preference.isChecked()) !== encrypted) await preference.setChecked(encrypted);
  await closeSettings(page);
}

async function reviewRecentSession(page: Page, expectedVisibleCount: number): Promise<void> {
  await openSettingsGroup(page, 'Display');
  await page.getByRole('button', { name: 'Review recent session' }).click();
  await closeSettings(page);
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(expectedVisibleCount);
  await expect(page.getByRole('button', { name: 'Finish review' })).toBeVisible();
}

async function deleteVisibleRecents(page: Page): Promise<void> {
  const deleteRecents = page.getByRole('button', { name: /Delete recents/u });
  if ((await deleteRecents.count()) > 0) await deleteRecents.click();
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(0);
}

async function deleteAllDurableQueueRows(page: Page): Promise<void> {
  await openSettingsGroup(page, 'System');
  const deleteCurrent = page.getByRole('button', { name: /^Delete current queue \(\d+\)$/u });
  if ((await deleteCurrent.count()) > 0 && !(await deleteCurrent.isDisabled())) {
    await deleteCurrent.click();
    await page.getByRole('button', { name: /^Confirm Delete current queue \(\d+\)$/u }).click();
  }
  const deleteRecall = page.getByRole('button', { name: /^Delete Recall items \(\d+\)$/u });
  if ((await deleteRecall.count()) > 0 && !(await deleteRecall.isDisabled())) {
    await deleteRecall.click();
    await page.getByRole('button', { name: /^Confirm Delete Recall items \(\d+\)$/u }).click();
  }
  await closeSettings(page);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);
}

async function pinCurrent(page: Page, filename: string): Promise<void> {
  await pinCurrentImage(page);
  await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: filename })).toBeVisible();
}

async function exportImages(page: Page, serviceWorker: Worker): Promise<void> {
  await openImageUtilities(page);
  await clearDownloadRequestLog(serviceWorker);
  await page.getByRole('button', { name: /Export images/u }).click();
  await expectPanelStatusMessage(page, /Image export started\.|Started \d+ image downloads\./u);
  await closeSettings(page);
}

async function waitForDownloadCount(serviceWorker: Worker, count: number): Promise<readonly string[]> {
  let filenames: readonly string[] = [];
  await expect
    .poll(async () => {
      filenames = (await readDownloadRequestLog(serviceWorker)).map((download) => download.filename ?? '');
      return filenames.length;
    })
    .toBe(count);
  return filenames;
}

async function clearSelectedQueueRows(page: Page): Promise<void> {
  const selectedQueueRows = page.locator('.image-trail-panel__bookmark-item.is-selected');
  while ((await selectedQueueRows.count()) > 0) {
    await selectedQueueRows.first().dispatchEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  }
}

async function clearSelectedRecentRows(page: Page): Promise<void> {
  const selectedRecentRows = page.locator('.image-trail-panel__history-item.is-selected');
  while ((await selectedRecentRows.count()) > 0) {
    await selectedRecentRows.first().dispatchEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  }
}

function escapedFilenameFromAssetPath(assetPath: string): string {
  const filename = assetPath.split('/').pop();
  if (!filename) throw new Error(`Could not resolve filename from ${assetPath}`);
  return filename.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function filenameFromAssetPath(assetPath: string): string {
  const filename = assetPath.split('/').pop();
  if (!filename) throw new Error(`Could not resolve filename from ${assetPath}`);
  return filename;
}

test('successful loads add Recents while failed loads do not', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  await deleteVisibleRecents(page);
  // Alert mode so the failed apply surfaces the HTTP-error status this test waits on (#450).
  await setLoadFailureFeedback(page, 'alert');

  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetOne));
  await expectPanelStatusMessage(page, /Loaded .*asset-one\.svg|Image loaded but did not change\.|Applied .*asset-one\.svg/u);
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(1);

  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.missingImage));
  await expectPanelStatusMessage(page, /Image failed to load: HTTP 404/u);
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(1);
  await expect(page.locator('.image-trail-panel__history-item', { hasText: 'missing-image.png' })).toHaveCount(0);

  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetTwo));
  await expectPanelStatusMessage(page, /Loaded .*asset-two\.svg/u);
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(2);
});

test('Recents session review reveals retained overflow without persisting or pinning it (#209)', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  await deleteVisibleRecents(page);
  await setVisibleRecents(page, { limit: '2', retainedLimit: '3', overflow: 'Keep hidden this session' });

  const recentUrls = [
    fixtureUrl(fixtureAssetPaths.assetOne),
    fixtureUrl(fixtureAssetPaths.assetTwo),
    fixtureUrl(fixtureAssetPaths.assetThree),
    `${fixtureUrl(fixtureAssetPaths.assetOne)}?newest=1`,
  ];
  for (const url of recentUrls) {
    await applyUrlInEditor(page, url);
    // Wait on THIS load's full URL (query string included): the previous shared-alternation regex
    // matched the stale status from an earlier load, letting the loop race ahead of the in-flight
    // loads and intermittently drop a Recents row under CI load.
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    await expectPanelStatusMessage(page, new RegExp(`(Loaded|Applied) .*${escapedUrl}`, 'u'));
  }

  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(2);
  await expect(page.locator('.image-trail-panel__history-item').first()).toContainText('asset-one.svg');
  await expect(page.locator('.image-trail-panel__history-item', { hasText: 'asset-two.svg' })).toHaveCount(0);

  const queueCountBeforeReview = await page.locator('.image-trail-panel__bookmark-item').count();
  await reviewRecentSession(page, 3);
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(3);
  await expect(page.locator('.image-trail-panel__history-item', { hasText: 'asset-one.svg' })).toHaveCount(1);
  await expect(page.locator('.image-trail-panel__history-item', { hasText: 'asset-two.svg' })).toHaveCount(1);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(queueCountBeforeReview);

  await page.getByRole('button', { name: 'Finish review' }).click();
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(2);
  await openSettingsGroup(page, 'Display');
  const recents = page
    .getByRole('heading', { name: 'Recents' })
    .locator('xpath=ancestor::div[contains(@class, "image-trail-panel__settings-templates")][1]');
  await expect(recents.locator('input[type="number"]').nth(0)).toHaveValue('2');
  await expect(recents.locator('input[type="number"]').nth(1)).toHaveValue('3');
  await closeSettings(page);
  await setVisibleRecents(page, { limit: '30', overflow: 'Drop oldest' });
});

test('Auto-pin overflow promotes through the durable pin path without capturing originals (#148)', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  await setVisiblePins(page, '30');
  await deleteAllDurableQueueRows(page);
  await deleteVisibleRecents(page);
  await setupEncryptedOriginals(page);
  await setEncryptedPinPreference(page, false);
  await setVisibleRecents(page, { limit: '2', retainedLimit: '3', overflow: 'Auto-pin overflow' });

  const autoPinAssets = [fixtureAssetPaths.assetOne, fixtureAssetPaths.assetTwo, fixtureAssetPaths.assetThree] as const;
  for (const [index, assetPath] of autoPinAssets.entries()) {
    await applyUrlInEditor(page, fixtureUrl(assetPath));
    if (index < autoPinAssets.length - 1) {
      await expectPanelStatusMessage(
        page,
        new RegExp(
          `Loaded .*${escapedFilenameFromAssetPath(assetPath)}|Image loaded but did not change\\.|Applied .*${escapedFilenameFromAssetPath(assetPath)}`,
          'u',
        ),
      );
    } else {
      await expectPanelStatusMessage(page, /Auto-pinned 1 overflow recent/u);
    }
  }

  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(2);
  await expect(page.locator('.image-trail-panel__history-item', { hasText: 'asset-one.svg' })).toHaveCount(0);
  const promoted = page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-one.svg' });
  await expect(promoted).toBeVisible();
  await expect(promoted.getByRole('button', { name: 'Capture' })).toBeVisible();
  await expect(promoted.getByRole('button', { name: 'Delete original' })).toHaveCount(0);
  await expectPanelStatusMessage(page, /Auto-pinned 1 overflow recent; 1 saved plaintext \(current storage setting\)\./u);

  await setVisibleRecents(page, { limit: '30', overflow: 'Drop oldest' });
  await setEncryptedPinPreference(page, true);
});

test('pins persist across panel reopen and Recall recalls offscreen durable rows to the capped queue', async ({ page, serviceWorker }) => {
  test.setTimeout(60_000);
  await openPanel(page, serviceWorker);
  await setVisiblePins(page, '30');
  await deleteAllDurableQueueRows(page);
  await deleteVisibleRecents(page);

  for (const assetPath of [fixtureAssetPaths.assetOne, fixtureAssetPaths.assetTwo, fixtureAssetPaths.assetThree]) {
    await applyUrlInEditor(page, fixtureUrl(assetPath));
    await expectPanelStatusMessage(page, new RegExp(`Loaded .*${escapedFilenameFromAssetPath(assetPath)}`, 'u'));
    await pinCurrent(page, filenameFromAssetPath(assetPath));
  }
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(3);

  await page.getByRole('button', { name: 'Close panel' }).click();
  await expectPanelClosed(page);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(3);

  await setVisiblePins(page, '1', 1);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open Recall' }).click();
  const recall = page.getByRole('dialog', { name: 'Recall' });
  await expect(recall).toBeVisible();
  await expect(recall.locator('.image-trail-panel__recall-list > li')).toHaveCount(2);
  await expect(recall.locator('.image-trail-panel__recall-list > li').first()).toContainText('asset-two.svg');

  await recall.locator('.image-trail-panel__recall-list > li', { hasText: 'asset-two.svg' }).click();
  await recall.getByRole('button', { name: 'Recall selected (1)' }).click();
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(1);
  await expect(page.locator('.image-trail-panel__bookmark-item').first()).toContainText('asset-two.svg');
  await expect(recall.locator('.image-trail-panel__recall-list > li')).toHaveCount(2);

  await recall.getByRole('button', { name: 'Clear results' }).click();
  await expect(recall.locator('.image-trail-panel__recall-list > li')).toHaveCount(0);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(1);
  await recall.getByRole('button', { name: 'Close Recall' }).click();
  await expect(recall).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Recall' }).click();
  await expect(page.getByRole('dialog', { name: 'Recall' }).locator('.image-trail-panel__recall-list > li')).toHaveCount(2);
});

test('Recents reflect captured queue state even when the saved row is in Recall', async ({ page, serviceWorker }) => {
  test.setTimeout(60_000);
  await openPanel(page, serviceWorker);
  await setupEncryptedOriginals(page);
  await setVisiblePins(page, '30');
  await deleteAllDurableQueueRows(page);
  await deleteVisibleRecents(page);

  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetOne));
  await expectPanelStatusMessage(page, /Loaded .*asset-one\.svg|Image loaded but did not change\.|Applied .*asset-one\.svg/u);
  await pinCurrent(page, 'asset-one.svg');
  const capturedQueueRow = page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-one.svg' });
  await capturedQueueRow.getByRole('button', { name: 'Capture' }).click();
  await expectPanelStatusMessage(page, /Captured \d+\.\d KB image\./u);
  await expect(capturedQueueRow.locator('.image-trail-panel__stored-original-dot')).toHaveAttribute('title', 'Original stored');

  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetTwo));
  await expectPanelStatusMessage(page, /Loaded .*asset-two\.svg/u);
  await pinCurrent(page, 'asset-two.svg');
  await setVisiblePins(page, '1', 1);
  await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-two.svg' })).toBeVisible();

  await deleteVisibleRecents(page);
  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetOne));
  await expectPanelStatusMessage(page, /Loaded .*asset-one\.svg|Image loaded but did not change\.|Applied .*asset-one\.svg/u);
  const recent = page.locator('.image-trail-panel__history-item', { hasText: 'asset-one.svg' });
  await expect(recent).toContainText('Pinned to queue / Captured original');
  await expect(recent.getByRole('button', { name: 'Pin' })).toHaveCount(0);
  await expect(recent.getByRole('button', { name: 'Capture' })).toHaveCount(0);
  await expect(recent.getByRole('button', { name: 'Delete original' })).toBeVisible();

  await page.getByRole('button', { name: 'Open Recall' }).click();
  const recall = page.getByRole('dialog', { name: 'Recall' });
  await expect(recall.locator('.image-trail-panel__recall-list > li', { hasText: 'asset-one.svg' })).toBeVisible();
});

test('select-all scopes export to visible Recents, visible queue rows, and loaded Recall rows only', async ({ page, serviceWorker }) => {
  test.setTimeout(60_000);
  await installDownloadRequestLog(serviceWorker);
  await openPanel(page, serviceWorker);
  await setVisiblePins(page, '30');
  await deleteAllDurableQueueRows(page);
  await deleteVisibleRecents(page);

  let loadedCount = 0;
  for (const assetPath of [fixtureAssetPaths.assetOne, fixtureAssetPaths.assetTwo, fixtureAssetPaths.assetThree]) {
    await applyUrlInEditor(page, fixtureUrl(assetPath));
    loadedCount += 1;
    // Stale-proof wait: the status title can still show a matching "Loaded ...asset-one.svg..."
    // message left by an earlier test in this serial spec, so wait for the Recents list to reflect
    // THIS load instead of racing ahead on a stale status match.
    await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(loadedCount);
    await expect(page.locator('.image-trail-panel__history-item').first()).toContainText(filenameFromAssetPath(assetPath));
  }

  await page.getByRole('button', { name: 'Select all recents' }).click();
  await exportImages(page, serviceWorker);
  await expect(await waitForDownloadCount(serviceWorker, 3)).toEqual(['asset-three.svg', 'asset-two.svg', 'asset-one.svg']);
  await clearSelectedRecentRows(page);

  for (const filename of ['asset-three.svg', 'asset-two.svg', 'asset-one.svg']) {
    const recent = page.locator('.image-trail-panel__history-item', { hasText: filename });
    await recent.getByRole('button', { name: 'Pin' }).click();
    await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: filename })).toBeVisible();
  }
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(3);
  await setVisiblePins(page, '1', 1);

  await openQueueMenu(page);
  await page.getByRole('button', { name: 'Select all queue' }).click();
  await exportImages(page, serviceWorker);
  await expect(await waitForDownloadCount(serviceWorker, 1)).toEqual(['asset-one.svg']);
  await clearSelectedQueueRows(page);

  await page.getByRole('button', { name: 'Open Recall' }).click();
  const recall = page.getByRole('dialog', { name: 'Recall' });
  await expect(recall.locator('.image-trail-panel__recall-list > li')).toHaveCount(2);
  await expect(recall.locator('.image-trail-panel__recall-list > li', { hasText: 'asset-two.svg' })).toBeVisible();
  await expect(recall.locator('.image-trail-panel__recall-list > li', { hasText: 'asset-three.svg' })).toBeVisible();
  await recall.getByRole('button', { name: 'Select all Recall' }).click();
  await exportImages(page, serviceWorker);
  await expect(await waitForDownloadCount(serviceWorker, 2)).toEqual(['asset-two.svg', 'asset-three.svg']);

  await expect(recall).toHaveCount(0);
  await setVisiblePins(page, '30', 3);
  await deleteAllDurableQueueRows(page);
});

test('selecting a recent row keeps the recents list scroll position (#425)', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  await deleteVisibleRecents(page);
  await setVisibleRecents(page, { limit: '6', overflow: 'Drop oldest' });

  // Five distinct URLs (same image) overflow the three-row default list height so it can scroll.
  for (let index = 1; index <= 5; index += 1) {
    await applyUrlInEditor(page, `${fixtureUrl(fixtureAssetPaths.assetOne)}?scroll=${index}`);
    await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(index);
  }

  const list = page.locator('.image-trail-panel__history-section .image-trail-panel__record-list');
  await list.evaluate((element) => {
    element.scrollTop = 40;
  });
  const target = page.locator('.image-trail-panel__history-item').nth(2);
  await target.scrollIntoViewIfNeeded();
  const scrolled = await list.evaluate((element) => element.scrollTop);
  expect(scrolled).toBeGreaterThan(0);

  // Selecting a row rerenders the whole panel; the list must come back at the same offset.
  await target.click();
  await expect(page.locator('.image-trail-panel__history-item.is-selected')).toHaveCount(1);
  await expect.poll(async () => list.evaluate((element) => element.scrollTop)).toBe(scrolled);
});

test('re-expanding Recents restores the scroll position from before the collapse (#443)', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  await deleteVisibleRecents(page);
  await setVisibleRecents(page, { limit: '6', overflow: 'Drop oldest' });

  // Five rows overflow the three-row list height so the list can scroll.
  for (let index = 1; index <= 5; index += 1) {
    await applyUrlInEditor(page, `${fixtureUrl(fixtureAssetPaths.assetOne)}?scroll=${index}`);
    await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(index);
  }

  const list = page.locator('.image-trail-panel__history-section .image-trail-panel__record-list');
  await page.locator('.image-trail-panel__history-item').nth(4).scrollIntoViewIfNeeded();
  const scrolled = await list.evaluate((element) => element.scrollTop);
  expect(scrolled).toBeGreaterThan(0);

  // Collapse drops the list from the DOM entirely, then expand rebuilds it.
  await page.getByRole('button', { name: 'Hide Recent history' }).click();
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show Recent history' }).click();
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(5);

  // The rebuilt list must reopen at the parked offset, not scrollTop 0.
  await expect.poll(async () => list.evaluate((element) => element.scrollTop)).toBe(scrolled);
});

test('the Recents and Queue sections collapse and expand from their heading toggles (#438)', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  await deleteVisibleRecents(page);
  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetOne));
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(1);

  // The whole header row toggles (#441) — but its toolbar buttons are descendants, so toggle
  // clicks aim at the row's own surface: the heading side and the far-right hint area.
  const recentsToggle = page.getByRole('button', { name: 'Hide Recent history' });
  const headerBox = (await recentsToggle.boundingBox())!;
  // Geometry pin: the hint shares the header ROW (no stray second line under the heading).
  expect(headerBox.height).toBeLessThan(44);
  // The far-right hint area is a live part of the toggle.
  await recentsToggle.click({ position: { x: headerBox.width - 6, y: headerBox.height / 2 } });
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(0);
  // The header row keeps its actions while collapsed.
  await expect(page.getByRole('button', { name: 'Select all recents' })).toBeVisible();
  // The heading side expands it again.
  await page.getByRole('button', { name: 'Show Recent history' }).click();
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(1);

  const queueToggle = page.getByRole('button', { name: 'Hide Queue' });
  const queueActions = page.locator('.image-trail-panel__bookmark-actions');
  await expect(queueToggle.locator('select')).toHaveCount(0);
  await expect(queueActions.locator('select[aria-label="Queue order"]')).toBeVisible();
  await expect(queueActions.locator(':scope > :first-child')).toHaveAttribute('aria-label', 'Queue order');
  await queueToggle.click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.image-trail-panel__bookmark-status-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Capture original' })).toBeVisible();
  // Primary-workflow clicks never toggle Queue collapse: pin with Shift, then expand and see the row.
  await pinCurrentImage(page);
  await expect(page.getByRole('button', { name: 'Hide Queue' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show Queue' }).click();
  await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-one.svg' })).toBeVisible();
});
