import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelMount, type PanelMountDeps, type PanelMountEnvironment } from '../extension/src/ui/panel/panel-mount.js';

const ROOT_ID = 'image-trail-panel-root';

class FakeShadowRoot {
  children: FakeElement[] = [];
  replaceChildren(...nodes: FakeElement[]): void {
    this.children = nodes;
  }
}

class FakeElement {
  id = '';
  className = '';
  rel = '';
  href = '';
  removed = false;
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  shadowRoot: FakeShadowRoot | null = null;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  attachShadow(): FakeShadowRoot {
    this.shadowRoot = new FakeShadowRoot();
    return this.shadowRoot;
  }

  addEventListener(type: string, listener: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  append(child: FakeElement): void {
    this.children.push(child);
  }

  remove(): void {
    this.removed = true;
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeDocument {
  readonly body = new FakeElement('body');
  readonly documentElement = new FakeElement('html');
  readonly created: FakeElement[] = [];

  getElementById(id: string): FakeElement | null {
    return this.created.find((element) => element.id === id && !element.removed) ?? null;
  }

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName);
    this.created.push(element);
    return element;
  }

  createdByTag(tagName: string): FakeElement[] {
    return this.created.filter((element) => element.tagName === tagName);
  }
}

interface Harness {
  readonly mount: PanelMount;
  readonly doc: FakeDocument;
  readonly fireStylesReadyFallback: () => void;
  onStylesReadyCalls: number;
}

function createHarness(overrides: Partial<PanelMountDeps> = {}): Harness {
  const doc = new FakeDocument();
  let fallbackReveal: (() => void) | null = null;
  const harness: Harness = {
    mount: undefined as unknown as PanelMount,
    doc,
    fireStylesReadyFallback: () => fallbackReveal?.(),
    onStylesReadyCalls: 0,
  };
  const deps: PanelMountDeps = {
    isPanelVisible: () => true,
    isPanelMinimized: () => false,
    onStylesReady: () => {
      harness.onStylesReadyCalls += 1;
    },
    ...overrides,
  };
  const environment: PanelMountEnvironment = {
    document: doc as unknown as Document,
    resolveStyleUrl: (path) => `chrome-extension://test/${path}`,
    scheduleStylesReadyFallback: (reveal) => {
      fallbackReveal = reveal;
    },
    pageContextSwitcherEnabled: true,
  };
  (harness as { mount: PanelMount }).mount = new PanelMount(deps, environment);
  return harness;
}

test('mount() creates the four roots inside a scoped host appended to document.body', () => {
  const { mount, doc } = createHarness();
  mount.mount();

  const host = doc.getElementById(ROOT_ID);
  assert.ok(host, 'host element with the panel root id is created');
  assert.equal(doc.body.children.includes(host!), true, 'host is appended to document.body');
  assert.equal(doc.documentElement.children.length, 0, 'host is not appended to documentElement');
  assert.equal(host.style['pointerEvents'], 'none', 'the zero-size shadow host must not intercept host-page hit testing');

  assert.ok(mount.root, 'root getter exposes the mounted aside');
  assert.ok(mount.contextRoot, 'contextRoot getter exposes the page-context root');
  assert.ok(mount.detachedRoot, 'detachedRoot getter exposes the detached-sections root');
  assert.ok(mount.toastRoot, 'toastRoot getter exposes the toast root');
  assert.equal(mount.root!.tagName, 'aside');
  assert.equal(host!.shadowRoot?.children.length, 5, 'shadow root holds link + four roots');
  assert.equal(mount.root!.style.visibility, 'hidden', 'root starts hidden until styles are ready');
});

test('mount() is a no-op when already mounted', () => {
  const { mount, doc } = createHarness();
  mount.mount();
  const firstRoot = mount.root;
  mount.mount();
  assert.equal(mount.root, firstRoot, 'root is unchanged on a second mount');
  assert.equal(doc.createdByTag('aside').length, 1, 'a second aside is not created');
});

test('a stale reveal from a previous mount does not starve the live mount after a fast remount', async () => {
  const harness = createHarness();
  harness.mount.mount();
  const staleRoot = harness.mount.root;
  harness.mount.teardown();
  harness.mount.mount();

  // Fire the leftover load event from the first (now detached) mount.
  const staleLink = harness.doc.createdByTag('link')[0];
  assert.ok(staleLink, 'the first mount created a stylesheet link');
  staleLink.fire('load');

  assert.equal(harness.mount.panelStylesReady, false, 'stale reveal does not mark the live mount ready');
  assert.equal(staleRoot!.style.visibility, 'hidden', 'stale reveal does not touch the detached root');
  assert.equal(harness.mount.root!.style.visibility, 'hidden', 'the live root is still hidden');
  assert.equal(harness.onStylesReadyCalls, 0, 'stale reveal does not run onStylesReady');

  // The live mount's own reveal still works.
  const liveLink = harness.doc.createdByTag('link')[1];
  assert.ok(liveLink, 'the second mount created its own stylesheet link');
  liveLink.fire('load');
  await harness.mount.whenStylesReady();
  assert.equal(harness.mount.panelStylesReady, true, 'the live mount becomes ready on its own reveal');
  assert.equal(harness.mount.root!.style.visibility, '', 'the live root is unhidden');
  assert.equal(harness.onStylesReadyCalls, 1, 'onStylesReady runs once for the live mount');
});

test('styles-ready reveal shows the root, resolves the promise, and runs onStylesReady when visible', async () => {
  const harness = createHarness();
  harness.mount.mount();
  assert.equal(harness.mount.panelStylesReady, false);

  const link = harness.doc.createdByTag('link')[0];
  assert.ok(link, 'mount created a stylesheet link');
  link.fire('load');

  await harness.mount.whenStylesReady();
  assert.equal(harness.mount.panelStylesReady, true);
  assert.equal(harness.mount.root!.style.visibility, '', 'root becomes visible once styles are ready');
  assert.equal(harness.onStylesReadyCalls, 1, 'onStylesReady runs once on reveal');
});

test('styles-ready reveal skips onStylesReady when the panel is minimized', async () => {
  const harness = createHarness({ isPanelMinimized: () => true });
  harness.mount.mount();
  harness.fireStylesReadyFallback();
  await harness.mount.whenStylesReady();
  assert.equal(harness.mount.panelStylesReady, true);
  assert.equal(harness.onStylesReadyCalls, 0, 'onStylesReady is skipped while minimized');
});

test('the reveal is idempotent across load, error, and the fallback timer', async () => {
  const harness = createHarness();
  harness.mount.mount();
  const link = harness.doc.createdByTag('link')[0];
  assert.ok(link, 'mount created a stylesheet link');
  link.fire('load');
  link.fire('error');
  harness.fireStylesReadyFallback();
  await harness.mount.whenStylesReady();
  assert.equal(harness.onStylesReadyCalls, 1, 'onStylesReady runs at most once');
});

test('teardown() removes the host and clears root/styles-ready state', async () => {
  const harness = createHarness();
  harness.mount.mount();
  const host = harness.doc.getElementById(ROOT_ID);
  harness.doc.createdByTag('link')[0]!.fire('load');
  await harness.mount.whenStylesReady();

  harness.mount.teardown();

  assert.equal(host!.removed, true, 'host is removed from the page');
  assert.equal(harness.mount.root, null, 'root is cleared');
  assert.equal(harness.mount.contextRoot, null, 'contextRoot is cleared');
  assert.equal(harness.mount.detachedRoot, null, 'detachedRoot is cleared');
  assert.equal(harness.mount.toastRoot, null, 'toastRoot is cleared');
  assert.equal(harness.mount.panelStylesReady, false, 'styles-ready flag is reset');
  assert.equal(harness.mount.whenStylesReady(), null, 'styles-ready promise is cleared');
});

test('disposeSubscriptions() invokes every registered handle and is idempotent', () => {
  const { mount } = createHarness();
  const calls: string[] = [];
  mount.registerSubscriptions([() => calls.push('a'), () => calls.push('b'), () => calls.push('c')]);

  mount.disposeSubscriptions();
  assert.deepEqual(calls, ['a', 'b', 'c'], 'all handles run once, in order');

  mount.disposeSubscriptions();
  assert.deepEqual(calls, ['a', 'b', 'c'], 'a second dispose does not re-invoke handles');
});

test('teardown() removes the mounted host even when a page element reuses the root id', () => {
  const harness = createHarness();
  harness.mount.mount();
  const host = harness.doc.getElementById(ROOT_ID);
  const decoy = new FakeElement('div');
  decoy.id = ROOT_ID;
  harness.doc.created.unshift(decoy);

  harness.mount.teardown();

  assert.equal(host!.removed, true, 'the host created by mount() is removed');
  assert.equal(decoy.removed, false, 'a page-owned element with the same id is left alone');
});
