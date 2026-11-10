import test from 'node:test';
import assert from 'node:assert/strict';

import type { PanelAction } from '../../extension/src/core/types.js';
import {
  createPrivacyModeSettingsView,
  createPrivatePinSettingsView,
  createSearchableMetadataSettingsView,
} from '../../extension/src/ui/components/privacy-settings-view.js';

test('private pin preference dispatches once and explains each storage state', () => {
  const cases = [
    [{ pinSaveStoragePreference: 'plaintext' as const, blobKeyUnlocked: false, blobKeyAvailable: false }, /plaintext by current/],
    [{ pinSaveStoragePreference: 'encrypted' as const, blobKeyUnlocked: true, blobKeyAvailable: true }, /encrypted while/],
    [
      { pinSaveStoragePreference: 'encrypted' as const, blobKeyUnlocked: false, blobKeyAvailable: true },
      /until encrypted storage is unlocked/,
    ],
    [
      { pinSaveStoragePreference: 'encrypted' as const, blobKeyUnlocked: false, blobKeyAvailable: false },
      /until encrypted storage is set up/,
    ],
  ] as const;
  for (const [state, message] of cases) assert.match(createPrivatePinSettingsView(state, () => {}).textContent ?? '', message);

  const actions: PanelAction[] = [];
  const view = createPrivatePinSettingsView(cases[1]![0], (action) => actions.push(action));
  const input = view.querySelector('input');
  assert.ok(input);
  input.checked = false;
  input.dispatchEvent(new Event('change'));
  assert.deepEqual(actions, [{ name: 'settings/update-pin-save-storage-preference', value: 'plaintext' }]);
});

test('privacy mode reflects state and dispatches exactly once', () => {
  const actions: PanelAction[] = [];
  const view = createPrivacyModeSettingsView(true, (action) => actions.push(action));
  const input = view.querySelector('input');
  assert.ok(input);
  assert.equal(input.checked, true);
  input.checked = false;
  input.dispatchEvent(new Event('change'));
  assert.deepEqual(actions, [{ name: 'settings/update-privacy-mode', enabled: false }]);
});

test('metadata changes preserve untouched and always-encrypted fields', () => {
  const actions: PanelAction[] = [];
  const view = createSearchableMetadataSettingsView({ urlDerived: 'encrypted', albumName: 'plaintext', thumbnail: 'encrypted' }, (action) =>
    actions.push(action),
  );
  const labels = Array.from(view.querySelectorAll('label'));
  const urlSelect = labels.find((label) => label.textContent?.includes('Image URLs'))?.querySelector('select');
  const thumbnailSelect = labels.find((label) => label.textContent?.includes('Thumbnails'))?.querySelector('select');
  assert.ok(urlSelect);
  assert.ok(thumbnailSelect);
  assert.equal(thumbnailSelect.disabled, true);
  assert.equal(thumbnailSelect.value, 'encrypted');
  assert.equal(thumbnailSelect.options.length, 1);
  urlSelect.value = 'plaintext';
  urlSelect.dispatchEvent(new Event('change'));
  assert.deepEqual(actions, [
    {
      name: 'settings/update-metadata-policy',
      policy: { urlDerived: 'plaintext', albumName: 'plaintext', thumbnail: 'encrypted' },
    },
  ]);
});

test('searchable metadata description does not present the encrypted mode as password protection', () => {
  const view = createSearchableMetadataSettingsView({ urlDerived: 'encrypted', albumName: 'encrypted', thumbnail: 'encrypted' }, () => {});
  const text = view.textContent ?? '';
  assert.match(text, /not protected by your encryption password/u);
  assert.match(text, /hash can confirm an address they already know/u);
  assert.match(text, /Only private pins and stored originals are password-protected/u);
  assert.doesNotMatch(text, /keeps them out of plaintext/u);
});
