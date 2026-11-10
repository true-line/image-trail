import {
  createLoadBuildIdentityMessage,
  createBlobKeyActivityMessage,
  isLoadBuildIdentityResultMessage,
  isBlobKeyStatusResultMessage,
  createStatusMessage,
  createUnknownMessageResponse,
  isExtensionRequest,
  MessageType,
} from '../background/messages.js';
import { isShortcutActionMessage } from '../background/shortcut-action-message.js';
import { isSettingsChangeMessage } from '../background/settings-change-message.js';
import { isNonProductionBuildIdentity, type BuildIdentity } from '../core/build-info.js';
import { PageAdapter } from './page-adapter.js';
import { BuildIdentityOverlay } from './build-identity-overlay.js';
import { ExtensionBookmarkStore } from './extension-bookmark-store.js';
import { CaptureController } from './capture-controller.js';
import { RecentHistoryStore } from './recent-history-store.js';
import { RecallStore } from './recall-store.js';
import { ExtensionPanelPositionStore } from './panel-position-store.js';
import { ExtensionWorkspaceLayoutStore } from './workspace-layout-store.js';
import { ExtensionParsedFieldStateStore } from './parsed-field-state-store.js';
import { ExtensionLocalSettingsStore } from './local-settings-store.js';
import { ExtensionUrlTemplateStore } from './url-template-store.js';
import { ExtensionUrlReviewStatusStore } from './url-review-status-store.js';
import { ImageTrailPanel } from '../ui/panel.js';
import { sendRuntimeMessage } from './runtime-message.js';
import { classifyTarget, matchesKeyCodeShortcut, shouldRouteKeyboardShortcut } from './keyboard.js';
import { LOCAL_SETTINGS_KEY } from '../data/local-settings.js';
import { isPasswordFrameMessage, isPasswordFrameSender } from '../core/password-frame-protocol.js';
import { SecureSessionActivityController } from './secure-session-activity.js';
import { isSecureSessionChangeMessage } from '../background/secure-session-change-message.js';

interface ImageTrailContentController {
  readonly panel: ImageTrailPanel;
  readonly destroy: () => void;
}

interface BuildIdentityOverlayController {
  readonly applyVisibility: (visible: boolean) => boolean;
  readonly toggle: () => boolean;
  readonly isVisible: () => boolean;
  readonly hide: () => void;
  readonly load: (panel: ImageTrailPanel, localSettingsStore: ExtensionLocalSettingsStore) => void;
}

declare global {
  interface Window {
    __imageTrailContentController?: ImageTrailContentController;
  }
}

function hasRuntimeMessaging(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.onMessage && typeof chrome.runtime.getURL === 'function';
}

function isBuildIdentityOverlayShortcut(event: KeyboardEvent): boolean {
  return matchesKeyCodeShortcut(event, { code: 'KeyB', shift: true, alt: true });
}

async function loadBuildIdentity(): Promise<BuildIdentity | null> {
  try {
    const response = await sendRuntimeMessage(createLoadBuildIdentityMessage());
    if (!isLoadBuildIdentityResultMessage(response)) return null;
    if (response.payload.ok) return response.payload.identity;
    console.warn('Image Trail build identity could not be loaded.', response.payload.message);
    return null;
  } catch {
    return null;
  }
}

function createBuildIdentityOverlayController(): BuildIdentityOverlayController {
  const buildOverlay = new BuildIdentityOverlay();
  let buildIdentity: BuildIdentity | null = null;
  let buildIdentityLoaded = false;

  const applyVisibility = (visible: boolean): boolean => {
    if (!visible) {
      buildOverlay.hide();
      return true;
    }
    if (!buildIdentityLoaded || !isNonProductionBuildIdentity(buildIdentity)) {
      buildOverlay.hide();
      return false;
    }
    return buildOverlay.show(buildIdentity);
  };

  return {
    applyVisibility,
    toggle: () => {
      if (!buildIdentityLoaded || !isNonProductionBuildIdentity(buildIdentity)) return false;
      return buildOverlay.toggle(buildIdentity);
    },
    isVisible: () => buildOverlay.isVisible(),
    hide: () => buildOverlay.hide(),
    load: (panel, localSettingsStore) => {
      void Promise.all([loadBuildIdentity(), localSettingsStore.load()]).then(([identity, settings]) => {
        buildIdentity = identity;
        buildIdentityLoaded = true;
        if (identity) panel.setBuildIdentity(identity);
        applyVisibility(settings.buildInfoOverlayVisible);
      });
    },
  };
}

function createController(): ImageTrailContentController {
  const pageAdapter = new PageAdapter();
  pageAdapter.prepareStandaloneImageBackdrop({ requireBodyOnlyImage: true });
  const buildOverlay = createBuildIdentityOverlayController();
  const localSettingsStore = new ExtensionLocalSettingsStore();
  const panel = new ImageTrailPanel(
    pageAdapter,
    new ExtensionBookmarkStore(),
    new CaptureController(),
    new RecentHistoryStore(),
    new RecallStore(),
    new ExtensionPanelPositionStore(),
    localSettingsStore,
    new ExtensionUrlTemplateStore(),
    new ExtensionParsedFieldStateStore(),
    new ExtensionUrlReviewStatusStore(),
    new ExtensionWorkspaceLayoutStore(),
    {
      applyBuildInfoOverlayVisibility: (visible) => {
        buildOverlay.applyVisibility(visible);
      },
    },
  );
  buildOverlay.load(panel, localSettingsStore);
  const secureSessionActivity = new SecureSessionActivityController({
    sendActivity: async () => {
      const response = await sendRuntimeMessage(createBlobKeyActivityMessage());
      return isBlobKeyStatusResultMessage(response) ? response.payload : { unlocked: false };
    },
    onLocked: () => panel.refreshSecureSessionStatus(),
  });

  function toggleBuildIdentityOverlay(): boolean {
    const toggled = buildOverlay.toggle();
    if (toggled) panel.setBuildInfoOverlayVisible(buildOverlay.isVisible());
    return toggled;
  }

  const handleMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): boolean => {
    if (isPasswordFrameMessage(message)) {
      if (isPasswordFrameSender(sender, chrome.runtime.id)) secureSessionActivity.noteActivity();
      return false;
    }
    if (isSecureSessionChangeMessage(message)) {
      panel.refreshSecureSessionStatus();
      return false;
    }
    if (isSettingsChangeMessage(message)) {
      void panel.reloadLocalSettings();
      return false;
    }
    if (isShortcutActionMessage(message)) {
      if (!panel.visible) {
        sendResponse(createStatusMessage(false, 'Panel is closed.'));
        return false;
      }
      panel.handleShortcutAction(message.payload.action);
      sendResponse(createStatusMessage(panel.visible, panel.statusMessage));
      return false;
    }

    if (!isExtensionRequest(message)) {
      sendResponse(createUnknownMessageResponse('Unsupported Image Trail message.'));
      return false;
    }

    switch (message.type) {
      case MessageType.TogglePanel: {
        const state = panel.toggle();
        sendResponse(createStatusMessage(state.visible, state.message));
        return false;
      }
      case MessageType.ToggleBuildIdentityOverlay: {
        const toggled = toggleBuildIdentityOverlay();
        sendResponse(createStatusMessage(panel.visible, toggled ? 'Build info overlay toggled.' : 'Build identity is not available.'));
        return false;
      }
      case MessageType.Ping:
        sendResponse(createStatusMessage(panel.visible, panel.statusMessage));
        return false;
      default:
        return false;
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!isBuildIdentityOverlayShortcut(event)) return;
    if (!shouldRouteKeyboardShortcut(classifyTarget(event), 'build-data-overlay-toggle')) return;
    if (!toggleBuildIdentityOverlay()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
    if (areaName === 'local' && LOCAL_SETTINGS_KEY in changes) void panel.reloadLocalSettings();
  };

  const handlePageHide = (event: PageTransitionEvent): void => {
    buildOverlay.hide();
    if (event.persisted) {
      panel.destroy();
      return;
    }
    destroy();
  };

  const destroy = (): void => {
    if (hasRuntimeMessaging()) chrome.runtime.onMessage.removeListener(handleMessage);
    chrome.storage?.onChanged.removeListener(handleStorageChanged);
    document.removeEventListener('keydown', handleKeyDown, true);
    secureSessionActivity.disconnect();
    window.removeEventListener('pagehide', handlePageHide);
    buildOverlay.hide();
    panel.disconnect();
    delete window.__imageTrailContentController;
  };

  chrome.runtime.onMessage.addListener(handleMessage);
  chrome.storage?.onChanged.addListener(handleStorageChanged);
  document.addEventListener('keydown', handleKeyDown, true);
  secureSessionActivity.connect(document);
  window.addEventListener('pagehide', handlePageHide);

  return { panel, destroy };
}

if (hasRuntimeMessaging() && !window.__imageTrailContentController) {
  window.__imageTrailContentController = createController();
}
