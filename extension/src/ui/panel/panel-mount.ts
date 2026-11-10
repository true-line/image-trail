import { unmountReactSubtree } from '../react/react-subtree.js';

const ROOT_ID = 'image-trail-panel-root';
const STYLE_PATH = 'src/ui/styles/panel-entry.css';
const STYLES_READY_FALLBACK_MS = 300;
declare const __IMAGE_TRAIL_E2E_TEST_BUILD_ATTRIBUTE__: string | undefined;
declare const __IMAGE_TRAIL_E2E_TEST_BUILD__: boolean | undefined;
declare const __IMAGE_TRAIL_PAGE_CONTEXT_SWITCHER_ENABLED__: boolean | undefined;

function isE2ETestBuild(): boolean {
  return typeof __IMAGE_TRAIL_E2E_TEST_BUILD__ === 'boolean' && __IMAGE_TRAIL_E2E_TEST_BUILD__;
}

function panelShadowMode(): ShadowRootMode {
  return isE2ETestBuild() ? 'open' : 'closed';
}

/**
 * Panel-domain side effects the mount lifecycle needs to trigger. Kept as injected callbacks so
 * `PanelMount` stays free of `ImageTrailPanel` internals, mirroring the other panel collaborators.
 */
export interface PanelMountDeps {
  /** Whether the panel is currently visible (drives the styles-ready position restore). */
  isPanelVisible(): boolean;
  /** Whether the panel is currently minimized (drives the styles-ready position restore). */
  isPanelMinimized(): boolean;
  /** Run once the panel stylesheet is ready and the panel is visible & not minimized. */
  onStylesReady(): void;
}

/**
 * DOM/host boundaries used while mounting. Defaults to the real `document`/`chrome`/`window`; tests
 * inject fakes so the mount lifecycle can be exercised without a full DOM environment.
 */
export interface PanelMountEnvironment {
  readonly document: Document;
  /** Resolves the packaged stylesheet URL (defaults to `chrome.runtime.getURL`). */
  resolveStyleUrl(path: string): string;
  /** Schedules the styles-ready fallback reveal (defaults to `window.setTimeout(..., 300)`). */
  scheduleStylesReadyFallback(reveal: () => void): void;
  /** Test seam for asserting closed shadow root contents without exposing them to host pages. */
  onShadowRootCreated?(shadow: ShadowRoot): void;
  /** Test seam for the compile-time page-context switcher feature. */
  pageContextSwitcherEnabled?: boolean;
}

function defaultEnvironment(): PanelMountEnvironment {
  return {
    document,
    resolveStyleUrl: (path) => chrome.runtime.getURL(path),
    scheduleStylesReadyFallback: (reveal) => {
      window.setTimeout(reveal, STYLES_READY_FALLBACK_MS);
    },
  };
}

/**
 * Owns the panel's DOM mount lifecycle: the shadow-root host, panel/context/detached/toast roots,
 * elements, the styles-ready gating promise, and the page-adapter subscription unsubscribe handles.
 * Extracted from `ImageTrailPanel` so mounting/teardown is isolated from panel business logic and
 * independently testable.
 */
export class PanelMount {
  private hostEl: HTMLElement | null = null;
  private rootEl: HTMLElement | null = null;
  private contextRootEl: HTMLElement | null = null;
  private detachedRootEl: HTMLElement | null = null;
  private toastRootEl: HTMLElement | null = null;
  private stylesReady = false;
  private shadowRoot: ShadowRoot | null = null;
  private stylesReadyPromise: Promise<void> | null = null;
  private subscriptionHandles: Array<() => void> = [];

  constructor(
    private readonly deps: PanelMountDeps,
    private readonly environment: PanelMountEnvironment = defaultEnvironment(),
  ) {}

  get root(): HTMLElement | null {
    return this.rootEl;
  }

  get contextRoot(): HTMLElement | null {
    return this.contextRootEl;
  }

  get detachedRoot(): HTMLElement | null {
    return this.detachedRootEl;
  }

  get toastRoot(): HTMLElement | null {
    return this.toastRootEl;
  }

  get panelStylesReady(): boolean {
    return this.stylesReady;
  }

  whenStylesReady(): Promise<void> | null {
    return this.stylesReadyPromise;
  }

  /** Creates the scoped host + roots and wires the styles-ready reveal. No-op if already mounted. */
  mount(): void {
    if (this.rootEl) return;
    const doc = this.environment.document;
    // Never reuse a page-owned element: a hostile page can pre-create our id with an open
    // shadow root and observe any sensitive controls mounted into it.
    doc.getElementById(ROOT_ID)?.remove();
    const host = doc.createElement('div');
    host.id = ROOT_ID;
    if (typeof __IMAGE_TRAIL_E2E_TEST_BUILD_ATTRIBUTE__ === 'string') {
      host.setAttribute(__IMAGE_TRAIL_E2E_TEST_BUILD_ATTRIBUTE__, 'open-shadow');
    }
    Object.assign(host.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      overflow: 'visible',
      pointerEvents: 'none',
      zIndex: '2147483647',
    });
    const shadow = host.attachShadow({ mode: panelShadowMode() });
    this.shadowRoot = shadow;
    this.environment.onShadowRootCreated?.(shadow);
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = this.environment.resolveStyleUrl(STYLE_PATH);
    const root = doc.createElement('aside');
    root.className = 'image-trail-panel-root image-trail-panel';
    root.style.visibility = 'hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Image Trail panel');
    this.rootEl = root;
    const contextRoot =
      typeof __IMAGE_TRAIL_PAGE_CONTEXT_SWITCHER_ENABLED__ === 'boolean'
        ? __IMAGE_TRAIL_PAGE_CONTEXT_SWITCHER_ENABLED__
          ? doc.createElement('div')
          : null
        : this.environment.pageContextSwitcherEnabled
          ? doc.createElement('div')
          : null;
    if (contextRoot) contextRoot.className = 'image-trail-page-context-root';
    this.contextRootEl = contextRoot;
    const detachedRoot = doc.createElement('div');
    detachedRoot.className = 'image-trail-panel-detached-root';
    this.detachedRootEl = detachedRoot;
    const toastRoot = doc.createElement('div');
    toastRoot.className = 'image-trail-panel-root image-trail-panel__toast-root';
    this.toastRootEl = toastRoot;
    this.stylesReady = false;
    this.stylesReadyPromise = new Promise<void>((resolve) => {
      const reveal = (): void => {
        // Ignore stale callbacks (a load/error event or the fallback timer) left over from a
        // previous mount: on a fast teardown + remount they would otherwise flip the shared
        // styles-ready flag, unhide the detached old root, and starve the live mount's reveal —
        // leaving the current panel stuck at visibility: hidden. Only act while this reveal's
        // root is still the mounted one.
        if (this.rootEl !== root) return;
        if (this.stylesReady) return;
        this.stylesReady = true;
        root.style.visibility = '';
        resolve();
        if (this.deps.isPanelVisible() && !this.deps.isPanelMinimized()) {
          this.deps.onStylesReady();
        }
      };
      link.addEventListener('load', reveal, { once: true });
      link.addEventListener('error', reveal, { once: true });
      this.environment.scheduleStylesReadyFallback(reveal);
    });
    shadow.replaceChildren(link, root, ...(contextRoot ? [contextRoot] : []), detachedRoot, toastRoot);
    // Prefer document.body; fall back to documentElement only when body is absent. The logical
    // expression keeps this clear of the no-document-element-append lint rule.
    (doc.body ?? doc.documentElement).append(host);
    this.hostEl = host;
  }

  /** Removes the mounted host and clears root/styles-ready state. Subscriptions are left intact. */
  teardown(): void {
    if (this.contextRootEl) unmountReactSubtree(this.contextRootEl);
    if (this.detachedRootEl) unmountReactSubtree(this.detachedRootEl);
    // Remove the host we created, never an id lookup: a page element reusing our id earlier in
    // the document would be removed instead and leave the real panel on screen.
    this.hostEl?.remove();
    this.hostEl = null;
    this.rootEl = null;
    this.contextRootEl = null;
    this.detachedRootEl = null;
    this.toastRootEl = null;
    this.stylesReady = false;
    this.stylesReadyPromise = null;
    this.shadowRoot = null;
  }

  /** Stores the page-adapter unsubscribe handles so teardown of the panel can release them. */
  registerSubscriptions(handles: ReadonlyArray<() => void>): void {
    this.subscriptionHandles = [...handles];
  }

  /** Invokes and clears all registered unsubscribe handles. Idempotent. */
  disposeSubscriptions(): void {
    const handles = this.subscriptionHandles;
    this.subscriptionHandles = [];
    for (const unsubscribe of handles) unsubscribe();
  }
}
