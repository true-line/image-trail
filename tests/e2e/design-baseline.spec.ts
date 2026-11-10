import type { Locator, Page, TestInfo, Worker } from '@playwright/test';

import {
  ensureBlobKeyUnavailable,
  expect,
  expectPanelOpen,
  fixturePaths,
  openFixturePage,
  test,
  togglePanelFromExtensionAction,
} from './fixtures.js';

const referenceViewport = { width: 924, height: 540 };
const narrowViewport = { width: 360, height: 740 };
const settingsGroups = [
  ['Display', '11a-settings-display'],
  ['Privacy', '12-settings-privacy'],
  ['Automation', '13-settings-automation'],
  ['Utilities', '14-settings-utilities'],
  ['System', '15-settings-system'],
] as const;

async function openPanel(page: Page, serviceWorker: Worker, viewport = referenceViewport): Promise<Locator> {
  await page.setViewportSize(viewport);
  await openFixturePage(page, fixturePaths.singleImage);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
  const panel = page.getByRole('dialog', { name: 'Image Trail panel' });
  await hideBuildOverlay(page);
  return panel;
}

async function captureArtifact(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

function settingsGroup(panel: Locator, name: string): Locator {
  return panel
    .locator('.image-trail-panel__settings-section > details.image-trail-panel__settings-utility-section', { hasText: name })
    .first();
}

async function hideBuildOverlay(page: Page): Promise<void> {
  const overlay = page.locator('#image-trail-build-identity-overlay');
  if ((await overlay.count()) === 0) return;
  await overlay.evaluate((element) => element.remove());
  await expect(overlay).toHaveCount(0);
}

async function openSettings(page: Page, serviceWorker: Worker): Promise<Locator> {
  const panel = await openPanel(page, serviceWorker);
  await page.getByRole('button', { name: 'Show settings' }).click();
  await expect(panel.locator('.image-trail-panel__settings-section')).toBeVisible();
  return panel;
}

async function showOnlySettingsGroup(panel: Locator, targetName: string): Promise<void> {
  for (const [name] of settingsGroups) {
    const group = settingsGroup(panel, name);
    const isOpen = (await group.getAttribute('open')) !== null;
    if (isOpen !== (name === targetName)) await group.locator(':scope > summary').click();
  }
  await settingsGroup(panel, targetName).scrollIntoViewIfNeeded();
}

test('panel shell matches the approved standard and narrow geometry', async ({ page, serviceWorker }, testInfo) => {
  const panel = await openPanel(page, serviceWorker);
  await expect
    .poll(async () => {
      const box = await panel.boundingBox();
      return box ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) } : null;
    })
    .toEqual({ x: 12, y: 12, width: 420 });
  await expect(panel.locator('.image-trail-panel__target-utility')).toContainText('Selected');
  await expect(panel.locator('.image-trail-panel__dock-button')).toHaveCount(4);
  await captureArtifact(page, testInfo, '01-panel');

  await page.setViewportSize(narrowViewport);
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeLessThanOrEqual(336);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await captureArtifact(page, testInfo, '01-panel-narrow');
});

test('every dashboard section uses the same explicit Hide/Show header control (#755)', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  const initialActions = [
    'Hide Host target',
    'Hide URL editor',
    'Show Field Editor',
    'Hide Controls',
    'Hide Recent history',
    'Hide Queue',
  ] as const;
  for (const name of initialActions) await expect(page.getByRole('button', { name })).toBeVisible();

  await page.getByRole('button', { name: 'Hide Host target' }).click();
  await expect(page.getByRole('button', { name: 'Show Host target' })).toBeVisible();
  await expect(page.locator('.image-trail-panel__target-card')).toBeHidden();

  await page.getByRole('button', { name: 'Hide URL editor' }).click();
  await expect(page.getByRole('button', { name: 'Show URL editor' })).toBeVisible();
  await expect(page.locator('.image-trail-panel__full-url-input')).toBeHidden();

  await page.getByRole('button', { name: 'Show Field Editor' }).click();
  await expect(page.getByRole('button', { name: 'Hide Field Editor' })).toBeVisible();

  await page.getByRole('button', { name: 'Hide Controls' }).click();
  await expect(page.getByRole('button', { name: 'Show Controls' })).toBeVisible();
  await expect(page.locator('.image-trail-panel__secondary-controls-body-shell')).toBeHidden();
});

test('locked capture uses the approved bottom-center pin feedback', async ({ page, serviceWorker }, testInfo) => {
  await openPanel(page, serviceWorker);
  // The extension profile is worker-scoped, so a spec that set an
  // encrypted-originals key up in this worker leaves the workspace unlocked.
  // This assertion is about the locked behaviour, so lock it explicitly.
  await ensureBlobKeyUnavailable(page);
  await page.keyboard.press('c');
  const toast = page.locator('.image-trail-panel__shortcut-feedback');
  await expect(toast).toHaveText('Pinned — unlock encryption to store the original');
  const box = await toast.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.x + box!.width / 2 - referenceViewport.width / 2)).toBeLessThan(2);
  await captureArtifact(page, testInfo, '03-capture-flash');
});

test('Settings presents the five approved groups as one reserved surface', async ({ page, serviceWorker }, testInfo) => {
  const panel = await openSettings(page, serviceWorker);
  await expect(panel.locator('.image-trail-panel__settings-section > details > summary')).toHaveText(settingsGroups.map(([name]) => name));
  await captureArtifact(page, testInfo, '07-settings');
});

for (const [groupName, artifactName] of settingsGroups) {
  test(`Settings ${groupName} group has a deterministic visual artifact`, async ({ page, serviceWorker }, testInfo) => {
    const panel = await openSettings(page, serviceWorker);
    await showOnlySettingsGroup(panel, groupName);
    await expect(settingsGroup(panel, groupName)).toHaveAttribute('open', '');
    if (groupName === 'Privacy') {
      const thumbnailPolicy = settingsGroup(panel, groupName).getByRole('combobox', { name: 'Thumbnails' });
      await expect(thumbnailPolicy).toBeDisabled();
      await expect(thumbnailPolicy).toHaveValue('encrypted');
    }
    await captureArtifact(page, testInfo, artifactName);
  });
}

test('Help replaces dashboard content with the approved grouped surface', async ({ page, serviceWorker }, testInfo) => {
  const panel = await openPanel(page, serviceWorker);
  await page.getByRole('button', { name: 'Show help' }).click();
  await expect(panel.locator('.image-trail-panel__help-section')).toBeVisible();
  await expect(panel).toHaveAttribute('data-surface', 'help');
  await captureArtifact(page, testInfo, '10-help');

  await page.getByRole('button', { name: 'Show settings' }).click();
  await expect(panel.locator('.image-trail-panel__settings-section')).toBeVisible();
  await expect(panel.locator('.image-trail-panel__help-section')).toHaveCount(0);
  await expect(panel).toHaveAttribute('data-surface', 'settings');

  await page.getByRole('button', { name: 'Show help' }).click();
  await expect(panel.locator('.image-trail-panel__help-section')).toBeVisible();
  await expect(panel.locator('.image-trail-panel__settings-section')).toHaveCount(0);
});

test('detached workspace preserves the approved stacked floating-window chrome', async ({ page, serviceWorker }, testInfo) => {
  await openPanel(page, serviceWorker);
  const shadedTitles = ['Host target', 'URL editor', 'Field Editor', 'Manual controls', 'Recent history'] as const;
  for (const title of shadedTitles) {
    const detach = page.getByRole('button', { name: `Detach ${title} into a floating window (drag to place)` });
    await detach.scrollIntoViewIfNeeded();
    await detach.click();
    const floating = page.getByRole('dialog', { name: `${title} (floating)` });
    await expect(floating).toBeVisible();
    await floating.getByRole('button', { name: `Shade ${title}` }).click();
  }
  const detachQueue = page.getByRole('button', { name: 'Detach Queue into a floating window (drag to place)' });
  await detachQueue.scrollIntoViewIfNeeded();
  await detachQueue.click();
  await expect(page.getByRole('dialog', { name: 'Queue (floating)' })).toBeVisible();
  await page.getByRole('button', { name: 'Show help' }).click();
  await expect(page.locator('.image-trail-panel__help-section')).toBeVisible();
  await captureArtifact(page, testInfo, '11-detached-windows');
});
