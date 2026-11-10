import { test as base, chromium, expect, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ExtensionFixtures {
  extensionId: string;
  serviceWorker: Worker;
  page: Page;
  extensionContext: BrowserContext;
}

export interface ExtensionDownloadRequest {
  readonly url: string;
  readonly filename?: string;
  readonly saveAs?: boolean;
  readonly conflictAction?: string;
}

export interface PersistentExtensionSession {
  readonly context: BrowserContext;
  readonly serviceWorker: Worker;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensionPath = path.join(repoRoot, 'extension/dist');
const fixtureBaseUrl = 'http://127.0.0.1:4173';
const fixturePaths = {
  singleImage: '/single-image.html',
  multipleImages: '/multiple-images.html',
  feed: '/feed.html',
  brokenImage: '/broken-image.html',
  gallerySequence: '/gallery-sequence.html',
  oversizedImage: '/oversized-image.html',
  redrawImage: '/redraw-image.html',
  thirdPartyCdn: '/third-party-cdn.html',
  workspaceHostMatrix: '/workspace-host-matrix.html',
  animatedMedia: '/animated-media.html',
} as const;
const fixtureAssetPaths = {
  assetOne: '/assets/asset-one.svg',
  assetTwo: '/assets/asset-two.svg',
  assetThree: '/assets/asset-three.svg',
  missingImage: '/missing-image.png',
  animatedGif: '/assets/animated/animated.gif',
  animatedWebp: '/assets/animated/animated.webp',
  staticWebp: '/assets/animated/static.webp',
  truncatedGif: '/assets/animated/truncated.gif',
  supportedMpegTs: '/assets/media/supported.m2ts',
  commonWebm: '/assets/media/common/vp9-opus.webm',
} as const;

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  const worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
  if (worker) return worker;

  while (true) {
    const candidate = await context.waitForEvent('serviceworker');
    if (candidate.url().startsWith('chrome-extension://')) return candidate;
  }
}

export async function launchPersistentExtensionSession(userDataDir: string, headless: boolean): Promise<PersistentExtensionSession> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  return { context, serviceWorker: await waitForServiceWorker(context) };
}

function extensionIdFromWorker(worker: Worker): string {
  const match = /^chrome-extension:\/\/(?<extensionId>[^/]+)\//u.exec(worker.url());
  const extensionId = match?.groups?.['extensionId'];
  if (!extensionId) throw new Error(`Could not resolve extension id from service worker URL: ${worker.url()}`);
  return extensionId;
}

// The extension profile is opened per test rather than per worker. A worker-scoped profile is
// shared by every test Playwright happens to co-locate in that worker, so the state one spec file
// leaves behind — the encrypted-originals key, the Recents and Queue rows, the remembered window
// size and layout — is still there for the next one, and a spec that expects a fresh profile
// fails on state it never created. Playwright assigns files to workers by size, so editing any
// spec file moves the failures to a different spec; a profile per test makes the lane independent
// of that assignment.
export const test = base.extend<ExtensionFixtures>({
  extensionContext: [
    async ({ headless }, use) => {
      // The extension is built once in global-setup.ts; each test only loads it.
      const userDataDir = await mkdtemp(path.join(tmpdir(), 'image-trail-e2e-'));
      const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      });

      try {
        await use(context);
      } finally {
        await context.close();
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
    { scope: 'test' },
  ],

  serviceWorker: async ({ extensionContext }, use) => {
    await use(await waitForServiceWorker(extensionContext));
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(extensionIdFromWorker(serviceWorker));
  },

  page: async ({ extensionContext }, use) => {
    const page = await extensionContext.newPage();
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
});

export { expect, fixtureAssetPaths, fixturePaths };

export async function openFixturePage(page: Page, fixturePath: (typeof fixturePaths)[keyof typeof fixturePaths]): Promise<void> {
  await page.goto(new URL(fixturePath, fixtureBaseUrl).href);
  await page.waitForLoadState('load');
}

export function fixtureUrl(pathname: string): string {
  return new URL(pathname, fixtureBaseUrl).href;
}

export async function resetExtensionLibrary(
  page: Page,
  extensionId: string,
  options: { readonly recentPageUrl?: string; readonly recordLabels?: readonly string[] } = {},
): Promise<void> {
  if (page.isClosed()) return;
  await page.goto(`chrome-extension://${extensionId}/src/gallery/gallery.html`);
  const result = await page.evaluate(
    async ({ pageUrl, recordLabels }) => {
      const matchesTarget = (item: { readonly label?: string }): boolean =>
        recordLabels === null || (!!item.label && recordLabels.includes(item.label));
      const bookmarkSnapshot = await chrome.runtime.sendMessage({
        type: 'imageTrail.loadBookmarks',
        version: 1,
        payload: { offset: 0, limit: 500, scope: 'global' },
      });
      const bookmarkIds = ((bookmarkSnapshot?.payload?.items ?? []) as Array<{ id: string; label?: string }>)
        .filter(matchesTarget)
        .map((item) => item.id);
      const bookmarkResult =
        bookmarkIds.length > 0
          ? await chrome.runtime.sendMessage({
              type: 'imageTrail.removeBookmarks',
              version: 1,
              payload: { ids: bookmarkIds },
            })
          : null;

      const loadRecent = () =>
        chrome.runtime.sendMessage({
          type: 'imageTrail.loadRecentHistory',
          version: 1,
          payload: { pageUrl, includeRetained: true, scope: 'all' },
        });
      const recentSnapshot = await loadRecent();
      const recentIds = [
        ...new Set(
          ((recentSnapshot?.payload?.items ?? []) as Array<{ id: string; label?: string }>).filter(matchesTarget).map((item) => item.id),
        ),
      ];
      await Promise.all(
        recentIds.map((id) =>
          chrome.runtime.sendMessage({
            type: 'imageTrail.removeRecentHistory',
            version: 1,
            payload: { pageUrl, id, scope: 'all' },
          }),
        ),
      );
      const remainingBookmarks = await chrome.runtime.sendMessage({
        type: 'imageTrail.loadBookmarks',
        version: 1,
        payload: { offset: 0, limit: 500, scope: 'global' },
      });
      const remainingRecent = await loadRecent();
      const orphanCleanup = await chrome.runtime.sendMessage({
        type: 'imageTrail.cleanupOrphanedBlobs',
        version: 1,
        payload: {},
      });
      return {
        bookmarkIds,
        bookmarkResult,
        orphanCleanup,
        remainingBookmarkCount: ((remainingBookmarks?.payload?.items ?? []) as Array<{ label?: string }>).filter(matchesTarget).length,
        remainingRecentCount: ((remainingRecent?.payload?.items ?? []) as Array<{ label?: string }>).filter(matchesTarget).length,
      };
    },
    {
      pageUrl: options.recentPageUrl ?? fixtureUrl(fixturePaths.singleImage),
      recordLabels: options.recordLabels ?? null,
    },
  );
  if (result.bookmarkResult) {
    expect(result.bookmarkResult?.payload?.ok).toBe(true);
    expect(result.bookmarkResult?.payload?.removedCount).toBe(result.bookmarkIds.length);
  }
  expect(result.remainingBookmarkCount).toBe(0);
  expect(result.remainingRecentCount).toBe(0);
  expect(result.orphanCleanup?.type).toBe('imageTrail.cleanupOrphanedBlobsResult');
}

export async function togglePanelFromExtensionAction(page: Page, serviceWorker: Worker): Promise<void> {
  await page.bringToFront();
  const url = page.url();
  const result = await serviceWorker.evaluate(async (activeUrl) => {
    const findTargetTab = async (): Promise<chrome.tabs.Tab | undefined> => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return tabs.find((candidate) => candidate.url === activeUrl) ?? tabs.find((candidate) => candidate.active);
    };

    const sendStatusMessage = async (tabId: number, type: 'imageTrail.ping' | 'imageTrail.togglePanel') => {
      return chrome.tabs.sendMessage(tabId, {
        type,
        version: 1,
        payload: type === 'imageTrail.ping' ? { sentAt: Date.now() } : { source: 'browserAction' },
      });
    };

    const sleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));
    let tabId: number | undefined;
    let scriptReady = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tab = await findTargetTab();
      tabId = tab?.id;
      if (typeof tabId === 'number') {
        try {
          const response = await sendStatusMessage(tabId, 'imageTrail.ping');
          if (response?.type === 'imageTrail.status') {
            scriptReady = true;
            break;
          }
        } catch {
          // The production manifest injects only after an explicit activeTab gesture.
        }
      }
      await sleep(100);
    }

    if (typeof tabId !== 'number') throw new Error(`Could not find tab for ${activeUrl}`);
    if (!scriptReady) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content-script.js'] });
    }
    const response = await sendStatusMessage(tabId, 'imageTrail.togglePanel');
    return response;
  }, url);

  expect(result).toMatchObject({
    type: 'imageTrail.status',
    version: 1,
  });
}

export async function expectPanelOpen(page: Page): Promise<void> {
  await expect(page.locator('#image-trail-panel-root')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Image Trail panel' })).toBeVisible();
}

export async function expectPanelClosed(page: Page): Promise<void> {
  await expect(page.locator('#image-trail-panel-root')).toHaveCount(0);
}

export function panelStatus(page: Page) {
  return page.locator('.image-trail-panel__header-status');
}

export async function expectPanelStatusMessage(page: Page, message: string | RegExp): Promise<void> {
  await expect(panelStatus(page)).toHaveAttribute('title', message);
}

export async function installDownloadRequestLog(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(() => {
    const globalScope = globalThis as typeof globalThis & {
      __imageTrailDownloadLog?: unknown[];
      __imageTrailOriginalDownload?: typeof chrome.downloads.download;
    };
    if (globalScope.__imageTrailOriginalDownload) {
      globalScope.__imageTrailDownloadLog = [];
      return;
    }
    globalScope.__imageTrailDownloadLog = [];
    globalScope.__imageTrailOriginalDownload = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = ((...args: Parameters<typeof chrome.downloads.download>) => {
      const [options] = args;
      globalScope.__imageTrailDownloadLog?.push({
        url: options.url,
        filename: options.filename,
        saveAs: options.saveAs,
        conflictAction: options.conflictAction,
      });
      return globalScope.__imageTrailOriginalDownload!(...args);
    }) as typeof chrome.downloads.download;
  });
}

export async function clearDownloadRequestLog(serviceWorker: Worker): Promise<void> {
  await serviceWorker.evaluate(() => {
    const globalScope = globalThis as typeof globalThis & { __imageTrailDownloadLog?: unknown[] };
    globalScope.__imageTrailDownloadLog = [];
  });
}

export async function readDownloadRequestLog(serviceWorker: Worker): Promise<ExtensionDownloadRequest[]> {
  return serviceWorker.evaluate(() => {
    const globalScope = globalThis as typeof globalThis & { __imageTrailDownloadLog?: unknown[] };
    return (globalScope.__imageTrailDownloadLog ?? []) as ExtensionDownloadRequest[];
  });
}

export async function applyUrlInEditor(page: Page, url: string): Promise<void> {
  const editor = page.locator('.image-trail-panel__full-url-input');
  await editor.fill(url);
  await editor.press('Enter');
}

export async function openTargetControls(page: Page): Promise<void> {
  const details = page.locator('.image-trail-panel__target-controls').filter({ visible: true }).first();
  if ((await details.getAttribute('open')) !== null) return;
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
}

export async function openSettingsGroup(page: Page, name: string): Promise<void> {
  const showSettings = page.getByRole('button', { name: 'Show settings' });
  if ((await showSettings.count()) > 0) await showSettings.click();
  // Role locators intentionally exclude headings inside closed disclosures. Find the semantic
  // heading by text first so the owning top-level group can be opened before role visibility exists.
  const exactName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');
  const heading = page.locator('h3, h4, h5').filter({ hasText: exactName }).first();
  const topLevel = heading.locator(
    'xpath=ancestor::details[contains(concat(" ", normalize-space(@class), " "), " image-trail-ds__settings-group ")][1]',
  );
  if ((await topLevel.count()) > 0 && (await topLevel.getAttribute('open')) === null) {
    await topLevel.locator(':scope > summary').click();
  }
  const group = heading.locator('xpath=ancestor::details[1]');
  if ((await group.getAttribute('open')) === null) await group.locator(':scope > summary').click();
  await expect(group).toHaveAttribute('open', '');
}

export async function closeSettings(page: Page): Promise<void> {
  const hideSettings = page.getByRole('button', { name: 'Hide settings' });
  if ((await hideSettings.count()) > 0) await hideSettings.click();
}

// Clears the encrypted-originals key the profile already holds, if it holds one. The "Clear key"
// button is only there while a key exists and the workspace is unlocked, so this is a no-op on a
// profile that has no key. Settings stays open afterwards.
async function clearBlobKeyIfPresent(page: Page): Promise<void> {
  const clear = page.getByRole('button', { name: 'Clear key' });
  if ((await clear.count()) === 0) return;
  await clear.click();
  await page.getByRole('button', { name: 'Confirm clear key' }).click();
  await expectPanelStatusMessage(page, /Encrypted blob key cleared/u);
}

// Puts the workspace back in the state a fresh profile has: no encrypted-originals key, so the
// blob key is unavailable and the panel is locked. A test that asserts the locked behaviour says
// so itself instead of depending on what ran before it in the same profile. Self-contained: opens Settings, clears the key if there is one, then
// closes Settings again.
export async function ensureBlobKeyUnavailable(page: Page): Promise<void> {
  await openSettingsGroup(page, 'Encrypted originals');
  await clearBlobKeyIfPresent(page);
  await closeSettings(page);
}

// Creates the encrypted-originals key from `password`, replacing any key the profile already
// holds. When a key exists the panel offers to unlock or clear it instead of asking for a new one,
// so the "New encrypted originals password" field is gone. A spec that needs the key therefore
// clears what the profile holds first, so the key it creates is the one it encrypts with. Self-contained: opens Settings,
// clears the key if there is one, creates the key, then closes Settings again.
export async function ensureBlobKeyCreated(page: Page, password: string): Promise<void> {
  await openSettingsGroup(page, 'Encrypted originals');
  await clearBlobKeyIfPresent(page);
  await fillPanelPassword(page, 'New encrypted originals password', password);
  await page.getByRole('button', { name: 'Create first key' }).click();
  await expect(page.locator('.image-trail-panel__encryption-badge')).toHaveText('Unlocked');
  await closeSettings(page);
}

// Sets the parsed-field load-failure feedback mode (#450). The control lives in Settings → Automation
// → Preload; the default is Mute, so tests that assert a red field ring or an HTTP-error status must
// opt into Display/Alert. Self-contained: opens Settings, selects the mode, then closes Settings so
// it can be dropped into any test without disturbing the surrounding panel interactions.
export async function setLoadFailureFeedback(page: Page, mode: 'alert' | 'display' | 'mute'): Promise<void> {
  const showSettings = page.getByRole('button', { name: 'Show settings' });
  if ((await showSettings.count()) > 0) await showSettings.click();
  const group = page.getByRole('heading', { name: 'Automation' }).locator('xpath=ancestor::details[1]');
  if (!(await group.evaluate((element) => element.hasAttribute('open')))) {
    await page.getByRole('heading', { name: 'Automation' }).click();
  }
  await page.getByLabel('Failure feedback').selectOption(mode);
  const hideSettings = page.getByRole('button', { name: 'Hide settings' });
  if ((await hideSettings.count()) > 0) await hideSettings.click();
}

export async function imageNavigationSnapshot(page: Page, imageSelector: string, sourceSelector?: string) {
  return page.locator(imageSelector).evaluate((image, selector) => {
    const source = selector ? document.querySelector(selector) : null;
    return {
      src: image.getAttribute('src'),
      propertySrc: image instanceof HTMLImageElement ? image.src : null,
      currentSrc: image instanceof HTMLImageElement ? image.currentSrc : null,
      srcset: image.getAttribute('srcset'),
      sizes: image.getAttribute('sizes'),
      sourceSrcset: source?.getAttribute('srcset') ?? null,
      sourceSizes: source?.getAttribute('sizes') ?? null,
      style: image.getAttribute('style'),
      selected: image.getAttribute('data-image-trail-selected'),
      handle: image.getAttribute('data-image-trail-handle'),
      lockBox: image.getAttribute('data-image-trail-lock-box'),
    };
  }, sourceSelector);
}

/**
 * Password fields in the in-page panel are typed into an extension-origin frame titled with the
 * field's label, so the visited page cannot observe keystrokes.
 */
export function panelPasswordField(scope: Page | Locator, label: string): Locator {
  return scope.frameLocator(`iframe[title="${label}"]`).locator('input');
}

/** Fills a panel password field and waits until the panel has received the value from the frame. */
export async function fillPanelPassword(scope: Page | Locator, label: string, value: string): Promise<void> {
  await panelPasswordField(scope, label).fill(value);
  await expect(scope.locator(`iframe[title="${label}"] + input`)).toHaveValue(value);
}
