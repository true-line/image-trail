export function hasTrustedExtensionStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

export async function restrictStorageToTrustedContexts(): Promise<void> {
  if (!hasTrustedExtensionStorage()) throw new Error('Extension storage is unavailable.');
  if (typeof chrome.storage.local.setAccessLevel !== 'function') throw new Error('Trusted extension storage is unavailable.');
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

// chrome.storage.local is readable by content scripts until restricted, and it holds the cloud
// connection. Restrict it as soon as the worker loads instead of on the first cloud operation.
if (hasTrustedExtensionStorage() && typeof chrome.storage.local.setAccessLevel === 'function') {
  void restrictStorageToTrustedContexts().catch(() => undefined);
}
