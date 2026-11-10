import type { BlobKeySessionStorage } from '../data/crypto/blob-key-session.js';

/**
 * The session storage area for this extension instance. `chrome.storage.session` is shared
 * between the regular and the incognito instance even in split mode, so the incognito instance
 * gets a private in-memory area instead: its Recents and unlock state never reach the regular
 * profile and are gone when its worker stops.
 */
export function sessionStorageForContext(): BlobKeySessionStorage | undefined {
  try {
    if (!chrome.extension?.inIncognitoContext) return chrome.storage?.session;
  } catch {
    return undefined;
  }
  const items = new Map<string, unknown>();
  return {
    get: async (key) => (items.has(key) ? { [key]: items.get(key) } : {}),
    set: async (next) => {
      for (const [key, value] of Object.entries(next)) items.set(key, value);
    },
    remove: async (key) => {
      items.delete(key);
    },
    setAccessLevel: async () => undefined,
  };
}
