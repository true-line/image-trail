import assert from 'node:assert/strict';
import test from 'node:test';
import { act, type ReactNode } from 'react';

import type { RecallRecordsResult } from '../../extension/src/content/recall-store.js';
import type { RecallCandidate, UrlReviewStatusRecord } from '../../extension/src/core/types.js';
import { DEFAULT_LOCAL_SETTINGS, type PlaintextLocalSettings } from '../../extension/src/data/local-settings.js';
import { DashboardDestination } from '../../extension/src/destinations/dashboard-destination.js';
import { RecallDestination } from '../../extension/src/destinations/recall-destination.js';
import { SettingsDestination } from '../../extension/src/destinations/settings-destination.js';
import type { DashboardSnapshot, DestinationServices, RecallWindow } from '../../extension/src/destinations/destination-services.js';
import { renderReactSubtree, unmountReactSubtree } from '../../extension/src/ui/react/react-subtree.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noopSubscription = (): (() => void) => () => undefined;

function candidate(id: string, privacyStatus?: 'locked'): RecallCandidate {
  return {
    id,
    url: `https://private.example.test/${id}.jpg`,
    label: `Private ${id}`,
    timestamp: '2026-07-14T12:00:00.000Z',
    queueUpdatedAt: '2026-07-14T12:00:00.000Z',
    envelopeCreatedAt: '2026-07-14T12:00:00.000Z',
    source: 'bookmark',
    privacyStatus,
  };
}

function recallWindow(items: readonly RecallCandidate[], privacyMode = false): RecallWindow {
  return {
    privacyMode,
    windowStart: 30,
    result: {
      ok: true,
      candidates: items,
      total: items.length,
      nextOffset: 30 + items.length,
      hasMore: false,
      failedCount: 0,
      message: `Loaded ${items.length} recall records.`,
    },
  };
}

function services(overrides: Partial<DestinationServices> = {}): DestinationServices {
  const dashboard: DashboardSnapshot = {
    limit: 200,
    total: 1,
    captured: 0,
    pins: 1,
    truncated: false,
  };
  return {
    loadDashboard: async () => dashboard,
    loadRecall: async () => recallWindow([]),
    recall: async (): Promise<RecallRecordsResult> => ({ ok: true, records: [], failedCount: 0, message: 'Recalled records.' }),
    loadSettings: async () => DEFAULT_LOCAL_SETTINGS,
    loadUrlReviewStatus: async () => [],
    saveSettings: async () => undefined,
    loadBuildIdentity: async () => null,
    subscribeLibrary: noopSubscription,
    subscribeSettings: noopSubscription,
    ...overrides,
  };
}

async function mount(content: ReactNode): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  await act(async () => {
    renderReactSubtree(root, content);
    await Promise.resolve();
  });
  return root;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function cleanup(root: HTMLElement): Promise<void> {
  await act(async () => unmountReactSubtree(root));
  root.remove();
}

test('dashboard reports exact durable total and bounded snapshot semantics', async () => {
  const root = await mount(
    <DashboardDestination
      services={services({
        loadDashboard: async () => ({
          limit: 200,
          total: 412,
          captured: 1,
          pins: 1,
          truncated: true,
        }),
      })}
    />,
  );
  try {
    await flush();
    assert.match(root.textContent ?? '', /412Durable records/u);
    assert.match(root.textContent ?? '', /1Loaded pins/u);
    assert.match(root.textContent ?? '', /1Loaded bookmarks/u);
    assert.match(root.textContent ?? '', /bounded 200-record snapshot/u);
    assert.match(root.textContent ?? '', /does not clone page-coupled target/u);
  } finally {
    await cleanup(root);
  }
});

test('dashboard ignores a stale response after a newer library refresh', async () => {
  const resolvers: Array<(snapshot: DashboardSnapshot) => void> = [];
  let refresh: () => void = () => undefined;
  const api = services({
    loadDashboard: () => new Promise((resolve) => resolvers.push(resolve)),
    subscribeLibrary: (listener) => {
      refresh = listener;
      return () => undefined;
    },
  });
  const root = await mount(<DashboardDestination services={api} />);
  try {
    await act(async () => refresh());
    await flush();
    assert.equal(resolvers.length, 2);
    resolvers[1]?.({ limit: 200, total: 2, captured: 0, pins: 2, truncated: false });
    await flush();
    resolvers[0]?.({ limit: 200, total: 99, captured: 0, pins: 99, truncated: false });
    await flush();
    assert.match(root.textContent ?? '', /2Durable records/u);
    assert.doesNotMatch(root.textContent ?? '', /99Durable records/u);
  } finally {
    await cleanup(root);
  }
});

test('Recall masks private metadata and moves only selected durable records', async () => {
  const recalled: string[][] = [];
  const api = services({
    loadRecall: async () => recallWindow([candidate('pin-1'), candidate('pin-2', 'locked')], true),
    recall: async (ids) => {
      recalled.push([...ids]);
      return { ok: true, records: [], failedCount: 0, message: 'Moved 1 record to the front.' };
    },
  });
  const root = await mount(<RecallDestination services={api} />);
  try {
    await flush();
    assert.equal(root.querySelectorAll('ol > li').length, 2);
    assert.doesNotMatch(root.innerHTML, /private\.example|Private pin-1|Private pin-2/u);
    assert.equal(root.querySelectorAll('[data-privacy="true"]').length, 2);
    await act(async () => root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    await flush();
    const recall = Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes('Recall selected'));
    await act(async () => recall?.click());
    await flush();
    assert.deepEqual(recalled, [['pin-1']]);
    assert.match(root.textContent ?? '', /durable queue producer only/u);
  } finally {
    await cleanup(root);
  }
});

test('Settings renders all groups and persists through the extension-owned service', async () => {
  const saved: Array<{ readonly privacy: boolean; readonly down: string }> = [];
  const api = services({
    saveSettings: async (settings) => {
      saved.push({ privacy: settings.privacyModeEnabled, down: settings.downArrowAction });
    },
  });
  const root = await mount(<SettingsDestination services={api} />);
  try {
    await flush();
    assert.deepEqual(
      Array.from(root.querySelectorAll('summary')).map((summary) => summary.textContent),
      ['Display', 'Privacy', 'Automation', 'URL review history', 'Utilities', 'System'],
    );
    const privacyGroup = Array.from(root.querySelectorAll('details')).find(
      (details) => details.querySelector('summary')?.textContent === 'Privacy',
    );
    const privacyToggle = Array.from(privacyGroup?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []).find((input) =>
      input.parentElement?.textContent?.includes('Privacy mode'),
    );
    await act(async () => privacyToggle?.click());
    await flush();
    assert.deepEqual(saved, [{ privacy: true, down: 'capture' }]);
    assert.match(root.textContent ?? '', /Settings saved/u);
    assert.match(root.textContent ?? '', /session-only active CryptoKey/u);
    assert.match(privacyGroup?.textContent ?? '', /not protected by your encryption password/u);
    assert.match(privacyGroup?.textContent ?? '', /Only private pins and stored originals are password-protected/u);
    const thumbnailPolicy = root.querySelector<HTMLSelectElement>('[aria-label="Thumbnail storage policy"]');
    assert.equal(thumbnailPolicy?.value, 'encrypted');
    assert.equal(thumbnailPolicy?.disabled, true);
    assert.equal(thumbnailPolicy?.options.length, 1);
    const preloadCache = root.querySelector<HTMLInputElement>('input[name="neighborPreloadCacheLimit"]');
    assert.equal(preloadCache?.min, '1');
    assert.equal(preloadCache?.max, '500');
    assert.match(root.textContent ?? '', /Cache holds 1–500 image responses per page session/u);
  } finally {
    await cleanup(root);
  }
});

test('Settings reviews URL status by site and status without loading durable or transient libraries', async () => {
  let dashboardLoads = 0;
  let recallLoads = 0;
  let currentReviews = reviewRecords();
  const root = await mount(
    <SettingsDestination
      services={services({
        loadDashboard: async () => {
          dashboardLoads += 1;
          throw new Error('unexpected dashboard read');
        },
        loadRecall: async () => {
          recallLoads += 1;
          throw new Error('unexpected Recall read');
        },
        loadUrlReviewStatus: async () => currentReviews,
      })}
    />,
  );
  try {
    await flush();
    assert.equal(dashboardLoads, 0);
    assert.equal(recallLoads, 0);
    assert.match(root.textContent ?? '', /3 matching review records/u);
    assert.match(root.textContent ?? '', /First reviewed: 2026-07-14 10:00:00Z/u);
    assert.match(root.textContent ?? '', /Last reviewed: 2026-07-14 12:30:00Z/u);
    assert.match(root.textContent ?? '', /Elapsed span: 2 hours 30 min/u);
    assert.deepEqual(
      Array.from(root.querySelectorAll<HTMLSelectElement>('[aria-label="URL review site"] option')).map((option) => option.textContent),
      ['All sites', 'alpha.example.test', 'images.example.test'],
    );

    const site = root.querySelector<HTMLSelectElement>('[aria-label="URL review site"]');
    const status = root.querySelector<HTMLSelectElement>('[aria-label="URL review status"]');
    await act(async () => {
      if (site) {
        site.value = 'site-2';
        site.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (status) {
        status.value = 'failed';
        status.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await flush();
    assert.equal(root.querySelectorAll('.image-trail-url-review__record').length, 1);
    assert.match(root.textContent ?? '', /https:\/\/images\.example\.test\/broken\.jpg/u);
    assert.match(root.textContent ?? '', /Image failed: HTTP 404/u);
    assert.doesNotMatch(root.textContent ?? '', /alpha\.example\.test\/one/u);

    currentReviews = [
      {
        schemaVersion: 1,
        hostname: 'aardvark.example.test',
        pageUrl: 'https://aardvark.example.test/page',
        sourceUrl: 'https://aardvark.example.test/new.jpg',
        status: 'failed',
        fieldIds: [],
        activeFieldId: null,
        updatedAt: '2026-07-14T13:00:00.000Z',
      },
      ...currentReviews,
    ];
    const reload = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Reload review history');
    await act(async () => reload?.click());
    await flush();
    assert.equal(root.querySelector<HTMLSelectElement>('[aria-label="URL review site"]')?.value, 'site-3');
    assert.match(root.textContent ?? '', /https:\/\/images\.example\.test\/broken\.jpg/u);
    assert.doesNotMatch(root.textContent ?? '', /aardvark\.example\.test\/new/u);
  } finally {
    await cleanup(root);
  }
});

test('Settings opts into a local-only backup reminder without invoking library or provider services', async () => {
  const saved: PlaintextLocalSettings[] = [];
  const root = await mount(
    <SettingsDestination
      services={services({
        saveSettings: async (settings) => {
          saved.push(settings);
        },
      })}
    />,
  );
  try {
    await flush();
    const automation = Array.from(root.querySelectorAll('details')).find(
      (details) => details.querySelector('summary')?.textContent === 'Automation',
    );
    automation?.querySelector('summary')?.click();
    const enabled = Array.from(automation?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []).find((input) =>
      input.parentElement?.textContent?.includes('manual encrypted backups'),
    );
    await act(async () => enabled?.click());
    await flush();
    assert.equal(saved.at(-1)?.backupReminderEnabled, true);
    assert.equal(saved.at(-1)?.backupReminderIntervalDays, 30);
    assert.match(saved.at(-1)?.backupReminderNextAt ?? '', /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(root.textContent ?? '', /Nothing uploads automatically/u);
  } finally {
    await cleanup(root);
  }
});

test('Settings adds exact-host Grab rules and masks saved hostnames in Privacy Mode', async () => {
  const saved: PlaintextLocalSettings[] = [];
  const root = await mount(
    <SettingsDestination
      services={services({
        loadSettings: async () => ({
          ...DEFAULT_LOCAL_SETTINGS,
          privacyModeEnabled: true,
          siteCaptureRules: { 'private.example.test': 'capture-original' },
        }),
        saveSettings: async (settings) => {
          saved.push(settings);
        },
      })}
    />,
  );
  try {
    await flush();
    assert.doesNotMatch(root.innerHTML, /private\.example\.test/u);
    assert.match(root.textContent ?? '', /Saved site 1/u);
    const hostname = root.querySelector<HTMLInputElement>('input[name="siteCaptureHostname"]');
    const behavior = root.querySelector<HTMLSelectElement>('select[name="siteCaptureBehavior"]');
    const form = hostname?.closest('form');
    await act(async () => {
      if (hostname) hostname.value = 'images.example.test';
      if (behavior) behavior.value = 'capture-original';
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    assert.equal(saved.at(-1)?.siteCaptureRules['private.example.test'], 'capture-original');
    assert.equal(saved.at(-1)?.siteCaptureRules['images.example.test'], 'capture-original');
  } finally {
    await cleanup(root);
  }
});

test('Settings URL review history masks site, URL, field, reason, and exact time metadata in Privacy Mode', async () => {
  const root = await mount(
    <SettingsDestination
      services={services({
        loadSettings: async () => ({ ...DEFAULT_LOCAL_SETTINGS, privacyModeEnabled: true }),
        loadUrlReviewStatus: async () => reviewRecords(),
      })}
    />,
  );
  try {
    await flush();
    assert.doesNotMatch(root.innerHTML, /alpha\.example|images\.example|broken\.jpg|field-secret|HTTP 404|2026-07-14T|2026-07-14 1/iu);
    assert.match(root.textContent ?? '', /Private site 1/u);
    assert.match(root.textContent ?? '', /Private source URL/u);
    assert.match(root.textContent ?? '', /Exact review timing is hidden in Privacy Mode/u);
    assert.equal(root.querySelectorAll('.image-trail-url-review__record[data-privacy="true"]').length, 3);
  } finally {
    await cleanup(root);
  }
});

test('standalone Settings preserves and submits the auto-pin overflow policy', async () => {
  const saved: string[] = [];
  const root = await mount(
    <SettingsDestination
      services={services({
        loadSettings: async () => ({ ...DEFAULT_LOCAL_SETTINGS, recentHistoryOverflowBehavior: 'auto-pin' }),
        saveSettings: async (settings) => {
          saved.push(settings.recentHistoryOverflowBehavior);
        },
      })}
    />,
  );
  try {
    await flush();
    const overflow = root.querySelector<HTMLSelectElement>('select[name="recentHistoryOverflowBehavior"]');
    assert.equal(overflow?.value, 'auto-pin');
    assert.deepEqual(
      Array.from(overflow?.options ?? []).map((option) => [option.value, option.textContent]),
      [
        ['drop-oldest', 'Drop oldest'],
        ['keep-session', 'Keep for this session'],
        ['auto-pin', 'Auto-pin overflow'],
      ],
    );
    assert.match(root.textContent ?? '', /converts older entries into durable Queue pins; it never captures original bytes/u);

    const displayApply = root.querySelector<HTMLButtonElement>('button[type="submit"]');
    await act(async () => displayApply?.click());
    await flush();
    assert.deepEqual(saved, ['auto-pin']);
  } finally {
    await cleanup(root);
  }
});

test('React Settings uses the handoff keybinding control and persists the Down assignment', async () => {
  const saved: string[] = [];
  const root = await mount(
    <SettingsDestination
      services={services({
        saveSettings: async (settings) => {
          saved.push(settings.downArrowAction);
        },
      })}
    />,
  );
  try {
    await flush();
    const select = root.querySelector<HTMLSelectElement>('[aria-label="Down arrow action"]');
    assert.equal(select?.value, 'capture');
    await act(async () => {
      if (select) {
        select.value = 'off';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await flush();
    assert.deepEqual(saved, ['off']);
    assert.match(
      root.textContent ?? '',
      /Modifier shortcuts like Grab Mode and Slideshow are set in your browser's extension keyboard shortcuts page/u,
    );
  } finally {
    await cleanup(root);
  }
});

test('Settings reloads uncontrolled form drafts before a duplicate tab can overwrite newer values', async () => {
  let current = DEFAULT_LOCAL_SETTINGS;
  let refresh: () => void = () => undefined;
  const saved: Array<typeof DEFAULT_LOCAL_SETTINGS> = [];
  const api = services({
    loadSettings: async () => current,
    saveSettings: async (settings) => {
      saved.push(settings);
    },
    subscribeSettings: (listener) => {
      refresh = listener;
      return () => undefined;
    },
  });
  const root = await mount(<SettingsDestination services={api} />);
  try {
    await flush();
    const visiblePins = root.querySelector<HTMLInputElement>('input[name="visibleBookmarkSoftMax"]');
    const requestInterval = root.querySelector<HTMLInputElement>('input[name="requestThrottleMs"]');
    assert.equal(visiblePins?.value, String(DEFAULT_LOCAL_SETTINGS.visibleBookmarkSoftMax));
    assert.equal(requestInterval?.value, String(DEFAULT_LOCAL_SETTINGS.requestThrottleMs));

    current = { ...current, visibleBookmarkSoftMax: 45, requestThrottleMs: 1_234 };
    await act(async () => refresh());
    await flush();

    assert.equal(root.querySelector<HTMLInputElement>('input[name="visibleBookmarkSoftMax"]')?.value, '45');
    assert.equal(root.querySelector<HTMLInputElement>('input[name="requestThrottleMs"]')?.value, '1234');
    const applyButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[type="submit"]'));
    await act(async () => applyButtons[0]?.click());
    await flush();
    await act(async () => applyButtons[1]?.click());
    await flush();
    assert.deepEqual(
      saved.map((settings) => [settings.visibleBookmarkSoftMax, settings.requestThrottleMs]),
      [
        [45, 1_234],
        [45, 1_234],
      ],
    );
  } finally {
    await cleanup(root);
  }
});

test('Settings exposes a retry path after a repository load failure', async () => {
  let attempts = 0;
  const api = services({
    loadSettings: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('fixture failure');
      return DEFAULT_LOCAL_SETTINGS;
    },
  });
  const root = await mount(<SettingsDestination services={api} />);
  try {
    await flush();
    assert.match(root.textContent ?? '', /Settings could not be loaded/u);
    const retry = Array.from(root.querySelectorAll('button')).find((button) => button.textContent === 'Retry');
    await act(async () => retry?.click());
    await flush();
    assert.equal(attempts, 2);
    assert.equal(root.querySelectorAll('.image-trail-destination-settings__group').length, 6);
  } finally {
    await cleanup(root);
  }
});

function reviewRecords(): readonly UrlReviewStatusRecord[] {
  return [
    {
      schemaVersion: 1,
      hostname: 'images.example.test',
      pageUrl: 'https://images.example.test/gallery?private=one',
      sourceUrl: 'https://images.example.test/broken.jpg',
      status: 'failed',
      fieldIds: ['field-secret'],
      activeFieldId: 'field-secret',
      reason: 'Image failed: HTTP 404',
      updatedAt: '2026-07-14T12:30:00.000Z',
    },
    {
      schemaVersion: 1,
      hostname: 'images.example.test',
      pageUrl: 'https://images.example.test/gallery?private=two',
      sourceUrl: 'https://images.example.test/unchanged.jpg',
      status: 'unchanged',
      fieldIds: ['field-secret'],
      activeFieldId: null,
      updatedAt: '2026-07-14T11:00:00.000Z',
    },
    {
      schemaVersion: 1,
      hostname: 'alpha.example.test',
      pageUrl: 'https://alpha.example.test/page',
      sourceUrl: 'https://alpha.example.test/one.jpg',
      status: 'passed',
      fieldIds: [],
      activeFieldId: null,
      updatedAt: '2026-07-14T10:00:00.000Z',
    },
  ];
}
