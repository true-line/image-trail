export interface BookmarkSaveOptions {
  readonly clearStoredOriginal?: boolean | undefined;
  /** The record was private where it came from: save it encrypted or fail, never as plaintext. */
  readonly requireEncrypted?: boolean | undefined;
}
