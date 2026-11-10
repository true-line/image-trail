import { PAGE_SHORTCUTS } from '../core/keyboard-shortcuts.js';
import { isTrustedActivation } from '../core/trusted-activation.js';

export type KeyTarget = 'typing' | 'button' | 'record-row' | 'detached-window' | 'panel' | 'page';

export interface KeyBinding {
  readonly key: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly action: string;
}

export type KeyActionHandler = (action: string) => boolean;
export type ShiftModifierHandler = (active: boolean) => void;

export interface KeyCodeShortcut {
  readonly code: string;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
}

function shortcutBinding(shortcut: (typeof PAGE_SHORTCUTS)[number]): KeyBinding {
  return {
    key: shortcut.key,
    ...(shortcut.shift === undefined ? {} : { shift: shortcut.shift }),
    ...(shortcut.ctrl === undefined ? {} : { ctrl: shortcut.ctrl }),
    ...(shortcut.alt === undefined ? {} : { alt: shortcut.alt }),
    action: shortcut.action,
  };
}

export const DEFAULT_BINDINGS: KeyBinding[] = PAGE_SHORTCUTS.map(shortcutBinding);

export function classifyTarget(event: KeyboardEvent): KeyTarget {
  const composedPath = event.composedPath?.() ?? [];
  const composedTarget = composedPath[0];
  const el = (composedTarget ?? event.target) as unknown as Record<string, unknown> | null;
  if (!el || typeof el['tagName'] !== 'string') return 'page';
  const tag = el['tagName'] as string;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return 'typing';
  if (el['isContentEditable'] === true) return 'typing';
  if (composedPath.some(isRecordRow)) return 'record-row';
  if (typeof el['closest'] === 'function' && (el as unknown as HTMLElement).closest('[data-image-trail-row-id]')) return 'record-row';
  if (composedPath.some(isDetachedWindow)) return 'detached-window';
  if (typeof el['closest'] === 'function' && (el as unknown as HTMLElement).closest('[data-image-trail-detached-window]')) {
    return 'detached-window';
  }
  if (tag === 'BUTTON') return 'button';
  if (composedPath.some(isPanelHost)) return 'panel';
  if (typeof el['closest'] === 'function' && (el as unknown as HTMLElement).closest('#image-trail-panel-root')) return 'panel';
  return 'page';
}

function isRecordRow(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const candidate = node as { dataset?: { imageTrailRowId?: unknown }; getAttribute?: (name: string) => string | null };
  return (
    typeof candidate.dataset?.imageTrailRowId === 'string' ||
    (typeof candidate.getAttribute === 'function' && candidate.getAttribute('data-image-trail-row-id') !== null)
  );
}

function isPanelHost(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  return (node as { id?: unknown }).id === 'image-trail-panel-root';
}

function isDetachedWindow(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const candidate = node as { dataset?: { imageTrailDetachedWindow?: unknown }; getAttribute?: (name: string) => string | null };
  return (
    typeof candidate.dataset?.imageTrailDetachedWindow === 'string' ||
    (typeof candidate.getAttribute === 'function' && candidate.getAttribute('data-image-trail-detached-window') !== null)
  );
}

export function shouldRouteKeyboardShortcut(target: KeyTarget, action: string, _key?: string): boolean {
  if (target === 'typing') return false;
  if (target === 'record-row') return false;
  if (target === 'detached-window' && action === 'close-surface') return false;
  return true;
}

export function matchesKeyCodeShortcut(event: KeyboardEvent, shortcut: KeyCodeShortcut): boolean {
  if (event.code !== shortcut.code) return false;
  if ((shortcut.shift ?? false) !== (event.shiftKey === true)) return false;
  if ((shortcut.ctrl ?? false) !== (event.ctrlKey === true)) return false;
  if ((shortcut.alt ?? false) !== (event.altKey === true)) return false;
  if ((shortcut.meta ?? false) !== (event.metaKey === true)) return false;
  return true;
}

function matchesBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
  const key = /^[a-z]$/u.test(binding.key) ? event.key.toLowerCase() : event.key;
  if (key !== binding.key) return false;
  if (binding.shift !== undefined && binding.shift !== event.shiftKey) return false;
  if ((binding.ctrl ?? false) !== event.ctrlKey) return false;
  if ((binding.alt ?? false) !== event.altKey) return false;
  if (event.metaKey) return false;
  return true;
}

export class KeyboardRouter {
  private active = false;
  private shiftModifierActive = false;
  private bindings: KeyBinding[];

  constructor(
    private readonly handler: KeyActionHandler,
    bindings?: KeyBinding[],
    private readonly onShiftModifierChange?: ShiftModifierHandler,
  ) {
    this.bindings = bindings ?? [...DEFAULT_BINDINGS];
  }

  enable(): void {
    if (this.active) return;
    this.active = true;
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('blur', this.onWindowBlur);
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('keyup', this.onKeyUp, true);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('blur', this.onWindowBlur);
    this.setShiftModifier(false);
  }

  updateBindings(bindings: KeyBinding[]): void {
    this.bindings = bindings;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = classifyTarget(event);
    if (isTrustedActivation(event) && target !== 'typing' && target !== 'record-row') this.setShiftModifier(event.shiftKey);
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Every shortcut needs a real key press: navigation starts extension-privileged image
    // requests, so a host-page script must not be able to drive it with dispatched events.
    if (!isTrustedActivation(event)) return;

    for (const binding of this.bindings) {
      if (matchesBinding(event, binding)) {
        if (!shouldRouteKeyboardShortcut(target, binding.action, binding.key)) return;
        if (!this.handler(binding.action)) return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!isTrustedActivation(event)) return;
    if (event.key === 'Shift' || !event.shiftKey) this.setShiftModifier(false);
  };

  private onWindowBlur = (event: Event): void => {
    if (!isTrustedActivation(event)) return;
    this.setShiftModifier(false);
  };
  private onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') this.setShiftModifier(false);
  };
  private setShiftModifier(active: boolean): void {
    if (this.shiftModifierActive === active) return;
    this.shiftModifierActive = active;
    this.onShiftModifierChange?.(active);
  }
}
