import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext, type Download, type Page, type Worker } from '@playwright/test';

import {
  applyUrlInEditor,
  closeSettings,
  expect,
  expectPanelOpen,
  expectPanelStatusMessage,
  fixtureAssetPaths,
  fixturePaths,
  fixtureUrl,
  imageNavigationSnapshot,
  openFixturePage,
  openSettingsGroup,
  test,
  togglePanelFromExtensionAction,
  fillPanelPassword,
  panelPasswordField,
} from './fixtures.js';
import { pinCurrentImage } from './current-image-actions.js';

const primaryImage = '#fixture-primary-image';
const encryptionPassword = 'correct horse battery staple';
const backupPassword = 'portable key backup';
const wrongPassword = 'wrong key backup';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionPath = path.join(repoRoot, 'extension/dist');

interface CleanExtensionSession {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly serviceWorker: Worker;
  close(): Promise<void>;
}

async function waitForExtensionServiceWorker(context: BrowserContext): Promise<Worker> {
  const existingWorker = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
  if (existingWorker) return existingWorker;

  while (true) {
    const candidate = await context.waitForEvent('serviceworker');
    if (candidate.url().startsWith('chrome-extension://')) return candidate;
  }
}

async function createCleanExtensionSession(headless: boolean): Promise<CleanExtensionSession> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'image-trail-e2e-clean-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const serviceWorker = await waitForExtensionServiceWorker(context);
  const page = await context.newPage();

  return {
    context,
    page,
    serviceWorker,
    async close() {
      try {
        await context.close();
      } finally {
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  };
}

async function openPanel(page: Page, serviceWorker: Worker): Promise<void> {
  await openFixturePage(page, fixturePaths.singleImage);
  await togglePanelFromExtensionAction(page, serviceWorker);
  await expectPanelOpen(page);
}

async function showSettings(page: Page): Promise<void> {
  const showSettingsButton = page.getByRole('button', { name: 'Show settings' });
  if ((await showSettingsButton.count()) > 0) await showSettingsButton.click();
}

async function hideSettings(page: Page): Promise<void> {
  const hideSettingsButton = page.getByRole('button', { name: 'Hide settings' });
  if ((await hideSettingsButton.count()) > 0) await hideSettingsButton.click();
}

async function closeSettingsGroup(page: Page, name: string): Promise<void> {
  await openSettingsGroup(page, name);
  const group = page.getByRole('heading', { name }).locator('xpath=ancestor::details[1]');
  if (await group.evaluate((element) => element.hasAttribute('open'))) await page.getByRole('heading', { name }).click();
}

async function openImportExport(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Import / Export');
}

async function openEncryptedOriginals(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Encrypted originals');
}

async function openPCloud(page: Page): Promise<void> {
  await openSettingsGroup(page, 'pCloud');
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

async function exportRecordJson(
  page: Page,
  buttonName: string | RegExp,
): Promise<{ readonly download: Download; readonly fileContent: string }> {
  await openImportExport(page);
  const importExport = page.locator('.image-trail-panel__import-export');
  await importExport.getByLabel('Plaintext').check();
  const [download] = await Promise.all([page.waitForEvent('download'), importExport.getByRole('button', { name: buttonName }).click()]);
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  const fileContent = await readFile(filePath!, 'utf8');
  await closeSettings(page);
  return { download, fileContent };
}

async function importRecordJson(page: Page, buttonName: string, fileContent: string, fileName: string): Promise<void> {
  await openImportExport(page);
  const importExport = page.locator('.image-trail-panel__import-export');
  await importExport
    .locator('input[type="file"][accept=".json"]')
    .setInputFiles({ name: fileName, mimeType: 'application/json', buffer: Buffer.from(fileContent) });
  await importExport.getByRole('button', { name: buttonName }).click();
  await expect(importExport.locator('.image-trail-panel__restore-preview')).toBeVisible();
  await importExport.getByRole('button', { name: 'Confirm import' }).click();
  await closeSettings(page);
}

async function setupEncryptedOriginals(page: Page): Promise<void> {
  await openEncryptedOriginals(page);
  const section = page.locator('.image-trail-panel__encryption');
  if ((await section.getByRole('button', { name: 'Clear key' }).count()) > 0) {
    await section.getByRole('button', { name: 'Clear key' }).click();
    await section.getByRole('button', { name: 'Confirm clear key' }).click();
    await expectPanelStatusMessage(page, /Encrypted blob key cleared\. Import a key backup to recover encrypted originals\./u);
  }
  const newPassword = panelPasswordField(section, 'New encrypted originals password');
  if ((await newPassword.count()) > 0 && (await newPassword.isVisible())) {
    await fillPanelPassword(section, 'New encrypted originals password', encryptionPassword);
    await section.getByRole('button', { name: 'Create first key' }).click();
  } else {
    await fillPanelPassword(section, 'Encrypted originals password', encryptionPassword);
    await section.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(section.locator('.image-trail-panel__encryption-badge')).toHaveText('Unlocked');
  await closeSettings(page);
}

async function exportKeyBackup(page: Page): Promise<{ readonly download: Download; readonly fileContent: string }> {
  await openEncryptedOriginals(page);
  const keyBackup = page
    .getByRole('heading', { name: 'Key backup' })
    .locator('xpath=ancestor::div[contains(@class, "image-trail-panel__subsection")][1]');
  await fillPanelPassword(keyBackup, 'Password', backupPassword);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    keyBackup.getByRole('button', { name: 'Export key backup' }).click(),
  ]);
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  const fileContent = await readFile(filePath!, 'utf8');
  await closeSettings(page);
  return { download, fileContent };
}

async function clearEncryptedOriginalsKey(page: Page): Promise<void> {
  await openEncryptedOriginals(page);
  await page.getByRole('button', { name: 'Clear key' }).click();
  await page.getByRole('button', { name: 'Confirm clear key' }).click();
  await expectPanelStatusMessage(page, /Encrypted blob key cleared\. Import a key backup to recover encrypted originals\./u);
  await closeSettings(page);
}

async function importKeyBackup(page: Page, fileContent: string, password: string): Promise<void> {
  await openEncryptedOriginals(page);
  const keyBackup = page
    .getByRole('heading', { name: 'Key backup' })
    .locator('xpath=ancestor::div[contains(@class, "image-trail-panel__subsection")][1]');
  await keyBackup
    .locator('input[type="file"][accept=".json,application/json"]')
    .setInputFiles({ name: 'image-trail-key-backup.json', mimeType: 'application/json', buffer: Buffer.from(fileContent) });
  await fillPanelPassword(keyBackup, 'Password', password);
  await keyBackup.getByRole('button', { name: 'Import key backup' }).click();
}

async function unlockWorkspaceAfterKeyImport(page: Page): Promise<void> {
  const lock = page.locator('[data-secure-workspace-lock="true"]');
  await expect(lock).toBeVisible();
  await fillPanelPassword(lock, 'Password', encryptionPassword);
  await lock.getByRole('button', { name: 'Unlock workspace' }).click();
  await expect(lock).toHaveCount(0, { timeout: 20_000 });
  await expectPanelStatusMessage(page, /Encrypted blob storage unlocked with blob:[a-f0-9-]+\./u);
  await closeSettings(page);
}

async function installPCloudMock(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __imageTrailPCloudMock?: {
        files: Record<number, { fileContent: string; fileName: string }>;
        uploadCount: number;
        requestedUrls: string[];
      };
      __imageTrailOriginalFetch?: typeof fetch;
      __imageTrailOriginalLaunchWebAuthFlow?: typeof chrome.identity.launchWebAuthFlow;
    };
    scope.__imageTrailPCloudMock = { files: {}, uploadCount: 0, requestedUrls: [] };

    const json = (body: Record<string, unknown>): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const parametersFromBody = (body: BodyInit | null | undefined): URLSearchParams => {
      if (body instanceof URLSearchParams) return body;
      if (typeof body === 'string') return new URLSearchParams(body);
      return new URLSearchParams();
    };

    scope.__imageTrailOriginalFetch ??= fetch.bind(globalThis);
    scope.__imageTrailOriginalLaunchWebAuthFlow ??= chrome.identity.launchWebAuthFlow.bind(chrome.identity);
    chrome.identity.launchWebAuthFlow = ((details, callback) => {
      const authorizeUrl = new URL(details.url);
      if (authorizeUrl.searchParams.get('client_id') !== 'image-trail-e2e-client') {
        throw new Error('The regular pCloud backup OAuth client id was not injected into the E2E build.');
      }
      const state = authorizeUrl.searchParams.get('state') ?? '';
      const redirectUrl = `${chrome.identity.getRedirectURL('pcloud')}#access_token=e2e-pcloud-token&state=${encodeURIComponent(
        state,
      )}&hostname=api.pcloud.com`;
      callback(redirectUrl);
    }) as typeof chrome.identity.launchWebAuthFlow;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      scope.__imageTrailPCloudMock?.requestedUrls.push(url.href);
      if (url.hostname === 'e2e.pcloud.com') {
        const fileId = Number(url.pathname.match(/backup-(\d+)\.json$/u)?.[1]);
        return new Response(scope.__imageTrailPCloudMock?.files[fileId]?.fileContent ?? '', { status: 200 });
      }
      if (url.hostname !== 'api.pcloud.com') return scope.__imageTrailOriginalFetch!(input, init);

      const method = url.pathname.split('/').pop();
      if (method === 'userinfo') return json({ result: 0, premium: true, quota: 1000000, usedquota: 250000 });
      if (method === 'createfolderifnotexists') {
        const params = parametersFromBody(init?.body);
        const parent = params.get('folderid');
        const name = params.get('name');
        if (parent === '0' && name === 'Applications') return json({ result: 0, metadata: { isfolder: true, folderid: 41 } });
        if (parent === '41' && name === 'Playbook-Eng-Trail-Overlook-1') {
          return json({ result: 0, metadata: { isfolder: true, folderid: 42 } });
        }
        if (parent === '42' && name === 'backups') return json({ result: 0, metadata: { isfolder: true, folderid: 43 } });
        throw new Error(`Unexpected pCloud backup folder segment ${name ?? ''} under ${parent ?? ''}.`);
      }
      if (method === 'uploadfile' && init?.body instanceof FormData) {
        const file = init.body.get('file');
        scope.__imageTrailPCloudMock!.uploadCount += 1;
        const fileId = 308 + scope.__imageTrailPCloudMock!.uploadCount;
        const fileName = file instanceof File ? file.name : 'image-trail-e2e.image-trail-encrypted.json';
        const fileContent = file instanceof File ? await file.text() : '';
        scope.__imageTrailPCloudMock!.files[fileId] = { fileName, fileContent };
        return json({
          result: 0,
          metadata: [{ fileid: fileId, name: fileName, size: fileContent.length }],
        });
      }
      if (method === 'listfolder') {
        const params = parametersFromBody(init?.body);
        const files = params.get('folderid') === '43' ? Object.entries(scope.__imageTrailPCloudMock?.files ?? {}) : [];
        return json({
          result: 0,
          metadata: {
            contents: files.map(([fileId, file]) => ({
              id: `f${fileId}`,
              fileid: Number(fileId),
              name: file.fileName,
              size: file.fileContent.length,
              modified: '2026-07-04T04:00:00Z',
            })),
          },
        });
      }
      if (method === 'checksumfile') return json({ result: 0, sha1: 'fake-sha1' });
      if (method === 'getfilelink') {
        const params = parametersFromBody(init?.body);
        return json({ result: 0, hosts: ['e2e.pcloud.com'], path: `/backup-${params.get('fileid') ?? '0'}.json` });
      }
      if (method === 'deletefile') {
        const params = parametersFromBody(init?.body);
        delete scope.__imageTrailPCloudMock!.files[Number(params.get('fileid'))];
        return json({ result: 0 });
      }
      return json({ result: 2000, error: `Unhandled mocked pCloud method: ${method ?? 'unknown'}` });
    }) as typeof fetch;
  });
}

async function uninstallPCloudMock(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __imageTrailPCloudMock?: unknown;
      __imageTrailOriginalFetch?: typeof fetch;
      __imageTrailOriginalLaunchWebAuthFlow?: typeof chrome.identity.launchWebAuthFlow;
    };
    if (scope.__imageTrailOriginalFetch) {
      globalThis.fetch = scope.__imageTrailOriginalFetch;
      delete scope.__imageTrailOriginalFetch;
    }
    if (scope.__imageTrailOriginalLaunchWebAuthFlow) {
      chrome.identity.launchWebAuthFlow = scope.__imageTrailOriginalLaunchWebAuthFlow;
      delete scope.__imageTrailOriginalLaunchWebAuthFlow;
    }
    delete scope.__imageTrailPCloudMock;
  });
}

test('history and bookmark exports restore through preview without durable side effects', async ({ page, serviceWorker }) => {
  await openPanel(page, serviceWorker);
  await deleteVisibleRecents(page);
  await deleteVisibleQueueRows(page);

  await applyUrlInEditor(page, fixtureUrl(fixtureAssetPaths.assetTwo));
  await expectPanelStatusMessage(page, /Loaded .*asset-two\.svg/u);
  await pinCurrentImage(page);
  await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-two.svg' })).toBeVisible();

  const historyExport = await exportRecordJson(page, 'Export history');
  const bookmarkExport = await exportRecordJson(page, 'Export bookmarks');
  expect(historyExport.download.suggestedFilename()).toMatch(/^image-trail-history-\d{4}-\d{2}-\d{2}\.plain\.json$/u);
  expect(bookmarkExport.download.suggestedFilename()).toMatch(/^image-trail-bookmarks-\d{4}-\d{2}-\d{2}\.plain\.json$/u);

  await deleteVisibleRecents(page);
  await deleteVisibleQueueRows(page);
  await expect(page.locator('.image-trail-panel__history-item')).toHaveCount(0);
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);

  await importRecordJson(page, 'Import history', historyExport.fileContent, 'history.json');
  await expectPanelStatusMessage(page, /Imported 1 record.*reloaded into extension state\./u);
  await expect(page.locator('.image-trail-panel__history-item', { hasText: 'asset-two.svg' })).toBeVisible();
  await expect(page.locator('.image-trail-panel__bookmark-item')).toHaveCount(0);

  await importRecordJson(page, 'Import bookmarks', bookmarkExport.fileContent, 'bookmarks.json');
  await expectPanelStatusMessage(page, /Imported 1 bookmark.*encrypted into bookmark storage\./u);
  await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-two.svg' })).toBeVisible();
});

test('key backup import fails closed with a wrong password and restores the captured original key', async ({
  page,
  serviceWorker,
  headless,
}) => {
  test.setTimeout(60_000);
  await openPanel(page, serviceWorker);
  await setupEncryptedOriginals(page);
  await deleteVisibleQueueRows(page);
  await pinCurrentImage(page);
  const queueRow = page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-one.svg' });
  await expect(queueRow).toBeVisible();
  await queueRow.getByRole('button', { name: 'Capture' }).click();
  await expectPanelStatusMessage(page, /Captured \d+\.\d KB image\./u);

  const { download, fileContent } = await exportKeyBackup(page);
  expect(download.suggestedFilename()).toMatch(/^image-trail-key-backup-blob-[a-f0-9-]+\.json$/u);
  const backup = JSON.parse(fileContent) as Record<string, unknown>;
  expect(JSON.stringify(backup)).not.toContain(encryptionPassword);
  expect(JSON.stringify(backup)).not.toContain('CryptoKey');

  const cleanSession = await createCleanExtensionSession(headless);
  try {
    await openPanel(cleanSession.page, cleanSession.serviceWorker);
    await importKeyBackup(cleanSession.page, fileContent, wrongPassword);
    await expectPanelStatusMessage(cleanSession.page, /Failed to unwrap key backup|Key backup import failed|decrypt/u);
    await expect(cleanSession.page.locator('.image-trail-panel__encryption-badge')).toHaveText('AES-GCM');
    await importKeyBackup(cleanSession.page, fileContent, backupPassword);
    await unlockWorkspaceAfterKeyImport(cleanSession.page);
  } finally {
    await cleanSession.close();
  }

  await clearEncryptedOriginalsKey(page);
  await importKeyBackup(page, fileContent, wrongPassword);
  await expectPanelStatusMessage(page, /Failed to unwrap key backup|Key backup import failed|decrypt/u);
  await expect(page.locator('.image-trail-panel__encryption-badge')).toHaveText('AES-GCM');

  await importKeyBackup(page, fileContent, backupPassword);
  await unlockWorkspaceAfterKeyImport(page);
  await expect(queueRow.locator('.image-trail-panel__stored-original-dot')).toHaveAttribute('title', 'Original stored');
});

test('settings utilities persist through rerenders and pCloud remains a mocked manual backup boundary', async ({ page, serviceWorker }) => {
  test.setTimeout(60_000);
  await openPanel(page, serviceWorker);
  await setupEncryptedOriginals(page);
  await deleteVisibleQueueRows(page);
  await pinCurrentImage(page);
  await expect(page.locator('.image-trail-panel__bookmark-item', { hasText: 'asset-one.svg' })).toBeVisible();

  await closeSettingsGroup(page, 'Encrypted originals');
  await openSettingsGroup(page, 'Image utilities');
  await openImportExport(page);
  await openPCloud(page);
  await openSettingsGroup(page, 'Display');
  const pins = page
    .getByRole('heading', { name: 'Pins' })
    .locator('xpath=ancestor::div[contains(@class, "image-trail-panel__settings-templates")][1]');
  await pins.locator('input[type="number"]').fill('5');
  await pins.locator('button', { hasText: 'Apply' }).click();

  await expect(page.getByRole('heading', { name: 'Encrypted originals' }).locator('xpath=ancestor::details[1]')).not.toHaveAttribute(
    'open',
    '',
  );
  await expect(page.getByRole('heading', { name: 'Image utilities' }).locator('xpath=ancestor::details[1]')).toHaveAttribute('open', '');
  await expect(page.getByRole('heading', { name: 'Import / Export' }).locator('xpath=ancestor::details[1]')).toHaveAttribute('open', '');
  await expect(page.getByRole('heading', { name: 'pCloud' }).locator('xpath=ancestor::details[1]')).toHaveAttribute('open', '');

  await hideSettings(page);
  await expect(page.locator('.image-trail-panel__image-transfer')).toHaveCount(0);
  await expect(page.locator('.image-trail-panel__import-export')).toHaveCount(0);
  await showSettings(page);
  await openPCloud(page);

  await installPCloudMock(serviceWorker);
  try {
    await page.getByRole('button', { name: 'Connect pCloud' }).click();
    await expect(page.locator('.image-trail-panel__cloud-provider')).toContainText('pCloud is connected.');
    await expect(page.locator('.image-trail-panel__cloud-provider')).toContainText('api.pcloud.com');
    await expect(page.locator('.image-trail-panel__cloud-provider')).not.toContainText('e2e-pcloud-token');

    await fillPanelPassword(page, 'Cloud backup password', backupPassword);
    await page.getByRole('button', { name: 'Back up now' }).click();
    const cloudProvider = page.locator('.image-trail-panel__cloud-provider');
    await expect(cloudProvider).toContainText(/Uploaded and verified .*\.image-trail-encrypted\.json/u);
    const uploadedNames = await serviceWorker.evaluate(() =>
      Object.values(
        (
          globalThis as typeof globalThis & {
            __imageTrailPCloudMock?: { files: Record<number, { fileName: string }> };
          }
        ).__imageTrailPCloudMock?.files ?? {},
      ).map((file) => file.fileName),
    );
    expect(uploadedNames.slice(0, -1).every((fileName) => fileName.endsWith('.image-trail-part.json'))).toBe(true);
    expect(uploadedNames.at(-1)).toMatch(/\.image-trail-encrypted\.json$/u);
    await expect(cloudProvider).toContainText('/Applications/Playbook-Eng-Trail-Overlook-1/backups');
    await expect(cloudProvider.getByRole('heading', { name: 'Backup history (1)' })).toBeVisible();
    await expect(cloudProvider.locator('.image-trail-panel__backup-history-item')).toContainText('Image Trail SHA-256');
    await expect(cloudProvider.locator('.image-trail-panel__backup-history-item')).toContainText('Downloaded bytes matched export');

    await page.getByRole('button', { name: 'Choose restore file' }).click();
    await expect(page.locator('.image-trail-panel__cloud-provider')).toContainText('Found 1 encrypted pCloud backup.');
    await fillPanelPassword(page, 'Cloud backup password', backupPassword);
    await page.locator('.image-trail-panel__cloud-restore-row').click();
    await expect(cloudProvider.locator('.image-trail-panel__restore-preview')).toContainText('Bookmarks');
    await cloudProvider.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(cloudProvider).toContainText('pCloud disconnected.');
    await expect(cloudProvider.getByRole('heading', { name: 'Backup history (1)' })).toBeVisible();
    await page.reload();
    await openPanel(page, serviceWorker);
    await showSettings(page);
    await openPCloud(page);
    await expect(page.getByRole('heading', { name: 'Backup history (1)' })).toBeVisible();
  } finally {
    await uninstallPCloudMock(serviceWorker);
  }

  const selected = await imageNavigationSnapshot(page, primaryImage);
  expect(selected.propertySrc).toBe(fixtureUrl(fixtureAssetPaths.assetOne));
});
