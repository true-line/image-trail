export interface SecureSessionActivityResult {
  readonly unlocked: boolean;
  readonly message?: string | undefined;
}

export interface SecureSessionActivityDeps {
  readonly now?: (() => number) | undefined;
  readonly throttleMs?: number | undefined;
  readonly isTrustedActivity?: ((event: Event) => boolean) | undefined;
  readonly sendActivity: () => Promise<SecureSessionActivityResult>;
  readonly onLocked: (message: string) => void;
}

/** Sends bounded extension-owned activity signals without writing to the host page. */
export class SecureSessionActivityController {
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly isTrustedActivity: (event: Event) => boolean;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private target: EventTarget | null = null;

  constructor(private readonly deps: SecureSessionActivityDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.throttleMs = deps.throttleMs ?? 15_000;
    this.isTrustedActivity = deps.isTrustedActivity ?? ((event) => event.isTrusted);
  }

  connect(target: EventTarget): void {
    if (this.target === target) return;
    this.disconnect();
    this.target = target;
    target.addEventListener('pointermove', this.handleActivity, true);
    target.addEventListener('pointerdown', this.handleActivity, true);
    target.addEventListener('keydown', this.handleActivity, true);
  }

  disconnect(): void {
    if (!this.target) return;
    this.target.removeEventListener('pointermove', this.handleActivity, true);
    this.target.removeEventListener('pointerdown', this.handleActivity, true);
    this.target.removeEventListener('keydown', this.handleActivity, true);
    this.target = null;
  }

  /** Records activity observed somewhere other than `target`, such as typing in the password frame. */
  noteActivity(): void {
    const now = this.now();
    if (now - this.lastSentAt < this.throttleMs) return;
    this.lastSentAt = now;
    void this.deps
      .sendActivity()
      .then((result) => {
        if (!result.unlocked && result.message) this.deps.onLocked(result.message);
      })
      .catch(() => {});
  }

  private readonly handleActivity = (event: Event): void => {
    if (this.isTrustedActivity(event)) this.noteActivity();
  };
}
