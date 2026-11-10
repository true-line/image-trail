import { isSearchableMetadataMode, type SearchableMetadataMode, type SearchableMetadataPolicy } from '../../core/metadata-policy.js';
import type { PanelAction, PinSaveStoragePreference } from '../../core/types.js';

export interface PrivatePinSettingsState {
  readonly pinSaveStoragePreference: PinSaveStoragePreference;
  readonly blobKeyUnlocked: boolean;
  readonly blobKeyAvailable: boolean;
}

export function createPrivatePinSettingsView(state: PrivatePinSettingsState, dispatch: (action: PanelAction) => void): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'image-trail-panel__settings-templates';
  const heading = document.createElement('h4');
  heading.textContent = 'Private pins';
  const label = document.createElement('label');
  label.className = 'image-trail-panel__settings-checkbox';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = state.pinSaveStoragePreference === 'encrypted';
  input.addEventListener('change', () => {
    dispatch({ name: 'settings/update-pin-save-storage-preference', value: input.checked ? 'encrypted' : 'plaintext' });
  });
  const text = document.createElement('span');
  text.textContent = 'Prefer encrypted pin saves';
  label.append(input, text);
  const meta = document.createElement('p');
  meta.className = 'image-trail-panel__settings-empty';
  meta.textContent = privatePinSettingsMessage(state);
  wrapper.append(heading, label, meta);
  return wrapper;
}

export function createPrivacyModeSettingsView(privacyModeEnabled: boolean, dispatch: (action: PanelAction) => void): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'image-trail-panel__settings-templates';
  const heading = document.createElement('h4');
  heading.textContent = 'Privacy';
  const label = document.createElement('label');
  label.className = 'image-trail-panel__settings-checkbox';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = privacyModeEnabled;
  input.addEventListener('change', () => dispatch({ name: 'settings/update-privacy-mode', enabled: input.checked }));
  const text = document.createElement('span');
  text.textContent = 'Privacy mode';
  const meta = document.createElement('p');
  meta.className = 'image-trail-panel__settings-empty';
  meta.textContent = 'Masks panel rows and visible URLs for screen sharing without changing saved records or actions.';
  label.append(input, text);
  wrapper.append(heading, label, meta);
  return wrapper;
}

export function createSearchableMetadataSettingsView(
  policy: SearchableMetadataPolicy,
  dispatch: (action: PanelAction) => void,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'image-trail-panel__settings-templates';
  const heading = document.createElement('h4');
  heading.textContent = 'Searchable metadata';
  const meta = document.createElement('p');
  meta.className = 'image-trail-panel__settings-empty';
  meta.textContent =
    'Controls which optional fields may stay in plaintext searchable metadata on disk. Encrypted seals them with a key kept in this browser profile, so they are not stored as readable text, but they are not protected by your encryption password: someone with access to this profile can recover them, and the URL lookup hash can confirm an address they already know. Only private pins and stored originals are password-protected. This is separate from Privacy mode, which only masks the display.';

  const urlSelect = createMetadataModeSelect(policy.urlDerived);
  const albumSelect = createMetadataModeSelect(policy.albumName);
  const thumbnailSelect = createEncryptedMetadataModeSelect();
  const dispatchCurrent = (): void => {
    dispatch({
      name: 'settings/update-metadata-policy',
      policy: {
        urlDerived: parseMetadataMode(urlSelect.value, policy.urlDerived),
        albumName: parseMetadataMode(albumSelect.value, policy.albumName),
        thumbnail: 'encrypted',
      },
    });
  };
  urlSelect.addEventListener('change', dispatchCurrent);
  albumSelect.addEventListener('change', dispatchCurrent);
  wrapper.append(
    heading,
    meta,
    createMetadataModeField('Image URLs', urlSelect),
    createMetadataModeField('Album names', albumSelect),
    createMetadataModeField('Thumbnails', thumbnailSelect),
  );
  return wrapper;
}

function createMetadataModeSelect(mode: SearchableMetadataMode): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'image-trail-panel__settings-select';
  for (const option of [
    { value: 'encrypted' as const, label: 'Encrypted' },
    { value: 'plaintext' as const, label: 'Plaintext' },
  ]) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    element.selected = mode === option.value;
    select.append(element);
  }
  return select;
}

function createEncryptedMetadataModeSelect(): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'image-trail-panel__settings-select';
  select.disabled = true;
  const option = document.createElement('option');
  option.value = 'encrypted';
  option.textContent = 'Encrypted';
  option.selected = true;
  select.append(option);
  return select;
}

function createMetadataModeField(labelText: string, select: HTMLSelectElement): HTMLElement {
  const field = document.createElement('label');
  field.className = 'image-trail-panel__settings-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  field.append(text, select);
  return field;
}

function parseMetadataMode(value: string, fallback: SearchableMetadataMode): SearchableMetadataMode {
  return isSearchableMetadataMode(value) ? value : fallback;
}

function privatePinSettingsMessage(state: PrivatePinSettingsState): string {
  if (state.pinSaveStoragePreference === 'plaintext') return 'New pins save plaintext by current storage setting.';
  if (state.blobKeyUnlocked) return 'New pins save encrypted while encrypted storage is unlocked.';
  if (state.blobKeyAvailable) return 'New pins save plaintext until encrypted storage is unlocked.';
  return 'New pins save plaintext until encrypted storage is set up.';
}
