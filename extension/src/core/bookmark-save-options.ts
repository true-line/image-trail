export interface BookmarkSaveOptions {
  readonly clearStoredOriginal?: boolean | undefined;
  /** The record was private where it came from: save it encrypted or fail, never as plaintext. */
  readonly requireEncrypted?: boolean | undefined;
}

/** Failure message for a save that must be encrypted while no key is available. */
export const PRIVATE_PIN_NEEDS_UNLOCK_MESSAGE = 'Unlock encryption to restore this private pin.';
