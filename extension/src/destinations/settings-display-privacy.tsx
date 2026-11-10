import type { RecentHistoryOverflowBehavior, RecentSparseRowDisplayMode } from '../core/types.js';
import { ENCRYPTED_METADATA_MODE_DISCLOSURE, type SearchableMetadataMode } from '../core/metadata-policy.js';
import {
  ApplyButton,
  formValues,
  numberValue,
  selectValue,
  SettingField,
  SettingsGroup,
  SettingNote,
  SettingToggle,
  type SettingsGroupProps,
} from './settings-shared.js';

export function DisplaySettingsGroup({ settings, disabled, save }: SettingsGroupProps) {
  return (
    <SettingsGroup title="Display" open>
      <form
        key={displayFormKey(settings)}
        className="image-trail-destination-settings__form"
        onSubmit={(event) => {
          const data = formValues(event);
          save({
            ...settings,
            visibleBookmarkSoftMax: numberValue(data, 'visibleBookmarkSoftMax'),
            galleryPageLimit: numberValue(data, 'galleryPageLimit'),
            recentHistoryLimit: numberValue(data, 'recentHistoryLimit'),
            recentHistoryRetainedLimit: numberValue(data, 'recentHistoryRetainedLimit'),
            recentSparseRowDisplayMode: selectValue<RecentSparseRowDisplayMode>(data, 'recentSparseRowDisplayMode'),
            recentHistoryOverflowBehavior: selectValue<RecentHistoryOverflowBehavior>(data, 'recentHistoryOverflowBehavior'),
          });
        }}
      >
        <div className="image-trail-destination-settings__grid">
          <SettingField label="Visible pins">
            <input name="visibleBookmarkSoftMax" type="number" min="1" max="200" defaultValue={settings.visibleBookmarkSoftMax} required />
          </SettingField>
          <SettingField label="Gallery page limit">
            <input name="galleryPageLimit" type="number" min="0" max="500" defaultValue={settings.galleryPageLimit} required />
          </SettingField>
          <SettingField label="Visible recents">
            <input name="recentHistoryLimit" type="number" min="1" max="200" defaultValue={settings.recentHistoryLimit} required />
          </SettingField>
          <SettingField label="Max kept recents">
            <input
              name="recentHistoryRetainedLimit"
              type="number"
              min="1"
              max="200"
              defaultValue={settings.recentHistoryRetainedLimit}
              required
            />
          </SettingField>
          <SettingField label="Recents layout">
            <select name="recentSparseRowDisplayMode" defaultValue={settings.recentSparseRowDisplayMode}>
              <option value="adaptive">Adaptive</option>
              <option value="full">Full</option>
              <option value="half">Half</option>
              <option value="compact">Compact</option>
            </select>
          </SettingField>
          <SettingField label="Recents overflow">
            <select name="recentHistoryOverflowBehavior" defaultValue={settings.recentHistoryOverflowBehavior}>
              <option value="drop-oldest">Drop oldest</option>
              <option value="keep-session">Keep for this session</option>
              <option value="auto-pin">Auto-pin overflow</option>
            </select>
          </SettingField>
        </div>
        <ApplyButton disabled={disabled} />
      </form>
      <SettingNote>
        Recents stay transient unless Auto-pin overflow converts older entries into durable Queue pins; it never captures original bytes.
        Gallery page limit 0 means an unlimited durable page; other reads remain bounded.
      </SettingNote>
    </SettingsGroup>
  );
}

function displayFormKey(settings: SettingsGroupProps['settings']): string {
  return [
    settings.visibleBookmarkSoftMax,
    settings.galleryPageLimit,
    settings.recentHistoryLimit,
    settings.recentHistoryRetainedLimit,
    settings.recentSparseRowDisplayMode,
    settings.recentHistoryOverflowBehavior,
  ].join(':');
}

export function PrivacySettingsGroup({ settings, disabled, save }: SettingsGroupProps) {
  const saveMetadata = (key: 'urlDerived' | 'albumName', value: SearchableMetadataMode) => {
    save({ ...settings, searchableMetadataPolicy: { ...settings.searchableMetadataPolicy, [key]: value } });
  };
  return (
    <SettingsGroup title="Privacy">
      <SettingToggle
        label="Prefer encrypted pin saves"
        checked={settings.pinSaveStoragePreference === 'encrypted'}
        disabled={disabled}
        onChange={(checked) => save({ ...settings, pinSaveStoragePreference: checked ? 'encrypted' : 'plaintext' })}
      />
      <SettingToggle
        label="Privacy mode"
        checked={settings.privacyModeEnabled}
        disabled={disabled}
        onChange={(checked) => save({ ...settings, privacyModeEnabled: checked })}
      />
      <SettingNote>Privacy mode masks display metadata. The searchable-metadata policy controls new durable writes at rest.</SettingNote>
      <SettingNote>{ENCRYPTED_METADATA_MODE_DISCLOSURE}</SettingNote>
      <div className="image-trail-destination-settings__grid">
        <SettingField label="Image URLs">
          <select
            value={settings.searchableMetadataPolicy.urlDerived}
            disabled={disabled}
            onChange={(event) => saveMetadata('urlDerived', event.currentTarget.value as SearchableMetadataMode)}
          >
            <option value="plaintext">Plaintext searchable</option>
            <option value="encrypted">Encrypted</option>
          </select>
        </SettingField>
        <SettingField label="Album names">
          <select
            value={settings.searchableMetadataPolicy.albumName}
            disabled={disabled}
            onChange={(event) => saveMetadata('albumName', event.currentTarget.value as SearchableMetadataMode)}
          >
            <option value="plaintext">Plaintext searchable</option>
            <option value="encrypted">Encrypted</option>
          </select>
        </SettingField>
        <SettingField label="Thumbnails">
          <select value="encrypted" disabled aria-label="Thumbnail storage policy">
            <option value="encrypted">Encrypted</option>
          </select>
        </SettingField>
      </div>
      <div className="image-trail-destination-page__unavailable">
        <strong>Encrypted originals</strong>
        <p>Key setup, unlock, and backup remain in the source panel because they operate on the session-only active CryptoKey.</p>
      </div>
    </SettingsGroup>
  );
}
