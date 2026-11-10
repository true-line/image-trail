import type { CaptureStore } from '../../content/capture-controller.js';
import { reducePanelAction } from '../../core/actions.js';
import type { PanelState } from '../../core/types.js';
import type { SecureSessionStatus } from '../../core/secure-session-state.js';

export interface SecureSessionUiControllerDeps {
  getState(): PanelState;
  setState(state: PanelState): void;
  render(): void;
  renderPanelAndRefreshRecall(): void;
  loadBookmarkPage(offset: number, options?: { readonly render?: boolean }): Promise<void>;
  captureStore(): CaptureStore | null;
}

export const SECURE_WORKSPACE_UNLOCKING_MESSAGE = 'Unlocking secure workspace…';

/** Applies secure-session results to panel state without exposing key material to the UI. */
export class SecureSessionUiController {
  private finishUnlockPromise: Promise<void> | null = null;

  constructor(private readonly deps: SecureSessionUiControllerDeps) {}

  async setup(password: string): Promise<void> {
    const captureStore = this.deps.captureStore();
    if (!captureStore) return;
    const result = await captureStore.setupBlobKey(password);
    // A refused duplicate setup means a key exists, so the panel offers unlock instead of setup.
    const hasKey = result.ok || result.reason === 'key-exists';
    this.applyResult(result.message, result.ok, result.ok ? result.keyReference : null, hasKey);
    await this.finishUnlock(result.ok);
  }

  async unlock(password: string): Promise<void> {
    const captureStore = this.deps.captureStore();
    if (!captureStore) return;
    this.deps.setState({
      ...this.deps.getState(),
      status: 'ready',
      message: SECURE_WORKSPACE_UNLOCKING_MESSAGE,
      lastUpdatedAt: Date.now(),
    });
    this.deps.render();
    try {
      const result = await captureStore.unlockBlobKey(password);
      this.applyResult(result.message, result.ok, result.ok ? result.keyReference : null, this.deps.getState().blobKeyAvailable);
      await this.finishUnlock(result.ok);
    } catch {
      this.applyResult('Image Trail could not unlock the secure session.', false, null, this.deps.getState().blobKeyAvailable);
      await this.finishUnlock(false);
    }
  }

  async lock(): Promise<void> {
    const captureStore = this.deps.captureStore();
    if (!captureStore) return;
    const result = await captureStore.lockBlobKey();
    this.applyResult(result.message, result.ok, null, true);
    this.deps.render();
  }

  async refresh(): Promise<void> {
    const captureStore = this.deps.captureStore();
    if (!captureStore) return;
    const result = await captureStore.requestBlobKeyStatus();
    await this.applyStatus(result);
  }

  async applyStatus(result: SecureSessionStatus): Promise<void> {
    const previous = this.deps.getState();
    const state = result.message ? { ...previous, message: result.message, status: 'ready' as const, lastUpdatedAt: Date.now() } : previous;
    this.deps.setState(
      reducePanelAction(state, {
        name: 'blob-key/status',
        unlocked: result.unlocked,
        keyReference: result.keyReference,
        hasKey: result.hasKey,
        message: result.message,
      }),
    );
    if (!previous.blobKeyUnlocked && result.unlocked) {
      await this.finishUnlock(true);
      return;
    }
    this.deps.render();
  }

  private applyResult(message: string, ok: boolean, keyReference: string | null, hasKey: boolean): void {
    this.deps.setState(
      reducePanelAction(
        { ...this.deps.getState(), message, status: ok ? 'ready' : 'error', lastUpdatedAt: Date.now() },
        { name: 'blob-key/status', unlocked: ok && keyReference !== null, keyReference, hasKey, message },
      ),
    );
  }

  private async finishUnlock(ok: boolean): Promise<void> {
    if (!ok) {
      this.deps.render();
      return;
    }
    this.deps.render();
    if (!this.finishUnlockPromise) {
      this.finishUnlockPromise = this.deps
        .loadBookmarkPage(this.deps.getState().bookmarkOffset, { render: false })
        .then(() => this.deps.renderPanelAndRefreshRecall())
        .finally(() => {
          this.finishUnlockPromise = null;
        });
    }
    await this.finishUnlockPromise;
  }
}
