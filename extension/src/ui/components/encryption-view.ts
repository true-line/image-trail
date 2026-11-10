import type { PanelAction } from '../../core/types.js';
import type { SessionInactivityTimeoutMinutes } from '../../core/secure-session-policy.js';
import { createActionGroup } from './action-group.js';
import { createFilePickerField, createPasswordField } from './form-controls.js';
import { onPasswordSubmit } from './password-frame.js';
import { createBadge } from './primitives.js';
import { addTrustedClickListener } from './trusted-events.js';

let encryptedOriginalsOpen = false;

type EncryptionAction = Extract<
  PanelAction,
  {
    readonly name:
      | 'blob-key/setup'
      | 'blob-key/unlock'
      | 'blob-key/lock'
      | 'blob-key/clear'
      | 'blob-key/export'
      | 'blob-key/import'
      | 'capture/cleanup-orphans'
      | 'settings/update-blob-key-inactivity-timeout';
  }
>;

interface EncryptionViewState {
  readonly unlocked: boolean;
  readonly keyReference: string | null;
  readonly hasKey: boolean;
  readonly busy: boolean;
  readonly abandonedOriginalCount: number;
  readonly inactivityTimeoutMinutes: SessionInactivityTimeoutMinutes;
}

export function createEncryptionView(state: EncryptionViewState, dispatch: (action: EncryptionAction) => void): HTMLElement {
  const section = document.createElement('details');
  section.className = 'image-trail-panel__settings-templates image-trail-panel__encryption image-trail-ds__settings-integration';
  section.classList.toggle('is-waiting', state.busy);
  section.open = encryptedOriginalsOpen;
  section.addEventListener('toggle', () => {
    encryptedOriginalsOpen = section.open;
  });
  const header = document.createElement('div');
  header.className = 'image-trail-panel__encryption-header';

  const heading = document.createElement('h4');
  heading.textContent = 'Encrypted originals';

  const badge = createBadge({
    label: state.busy ? 'Working' : state.unlocked ? 'Unlocked' : 'AES-GCM',
    tone: state.busy ? 'warning' : state.unlocked ? 'success' : 'encryption',
    uppercase: true,
    className: `image-trail-panel__encryption-badge${state.unlocked ? ' is-unlocked' : ''}${state.busy ? ' is-waiting' : ''}`,
  });

  header.append(heading, badge);

  const summary = document.createElement('summary');
  summary.className = 'image-trail-panel__encryption-summary';
  summary.append(header);

  const body = document.createElement('div');
  body.className = 'image-trail-panel__encryption-body image-trail-ds__card';
  body.dataset['tone'] = 'encryption';

  const description = document.createElement('p');
  description.className = 'image-trail-panel__meta';
  description.textContent = state.unlocked
    ? `Encrypted capture is unlocked${state.keyReference ? ` with ${state.keyReference}` : ''}.`
    : state.hasKey
      ? 'Unlock encrypted blob storage before capturing original image bytes.'
      : 'Create the first encrypted blob storage key before capturing original image bytes.';

  body.append(description, createInactivityControls(state.inactivityTimeoutMinutes, dispatch));

  const cleanup = document.createElement('button');
  cleanup.type = 'button';
  cleanup.textContent = state.busy ? 'Working...' : 'Clean up unused originals';
  cleanup.className = 'image-trail-panel__secondary-action';
  cleanup.classList.toggle('is-waiting', state.busy);
  cleanup.disabled = state.busy;
  addTrustedClickListener(cleanup, () => dispatch({ name: 'capture/cleanup-orphans' }));

  if (state.unlocked) {
    if (state.abandonedOriginalCount > 0) {
      body.append(createActionGroup('Maintenance', [cleanup], { secondary: true }));
    }
    body.append(
      createSessionLockControls(state, dispatch),
      createKeyBackupControls(state, dispatch),
      createKeyRemovalControls(state, dispatch),
    );
    section.append(summary, body);
    return section;
  }

  const passwordControl = createPasswordField({
    label: state.hasKey ? 'Encrypted originals password' : 'New encrypted originals password',
    description: state.hasKey
      ? 'Unlocks encrypted original image storage for this browser session.'
      : 'Creates the first key used to protect captured original image bytes.',
    placeholder: 'Encryption password',
    autocomplete: state.hasKey ? 'current-password' : 'new-password',
    disabled: state.busy,
  });
  const password = passwordControl.input;

  const unlockWithPassword = (): void => {
    if (!state.hasKey) {
      dispatch({ name: 'blob-key/setup', password: password.value });
      password.value = '';
      return;
    }
    dispatch({ name: 'blob-key/unlock', password: password.value });
    password.value = '';
  };

  const setup = document.createElement('button');
  setup.type = 'button';
  setup.textContent = state.busy ? 'Creating key...' : 'Create first key';
  setup.className = 'image-trail-panel__secondary-action';
  setup.classList.toggle('is-waiting', state.busy);
  setup.disabled = state.busy;
  addTrustedClickListener(setup, () => {
    dispatch({ name: 'blob-key/setup', password: password.value });
    password.value = '';
  });

  const unlock = document.createElement('button');
  unlock.type = 'button';
  unlock.textContent = state.busy ? 'Unlocking...' : 'Unlock';
  unlock.className = 'image-trail-panel__primary-action';
  unlock.classList.toggle('is-waiting', state.busy);
  unlock.disabled = state.busy;
  addTrustedClickListener(unlock, unlockWithPassword);

  onPasswordSubmit(password, unlockWithPassword);

  body.append(
    passwordControl.field,
    createActionGroup(state.hasKey ? 'Unlock storage' : 'Setup', [state.hasKey ? unlock : setup]),
    createKeyBackupControls(state, dispatch),
  );
  section.append(summary, body);
  return section;
}

function createKeyBackupControls(
  state: { readonly hasKey: boolean; readonly busy: boolean },
  dispatch: (action: EncryptionAction) => void,
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'image-trail-panel__subsection';

  const label = document.createElement('h4');
  label.className = 'image-trail-panel__action-group-title';
  label.textContent = 'Key backup';

  const passwordControl = createPasswordField({
    label: 'Password',
    description: state.hasKey
      ? 'Protects the exported key backup file with a password.'
      : 'Unlocks the selected key backup file before importing it.',
    placeholder: 'Backup password',
    autocomplete: state.hasKey ? 'new-password' : 'current-password',
    disabled: state.busy,
  });
  const password = passwordControl.input;

  const fileControl = createFilePickerField({
    label: 'Key backup file',
    description: 'Choose a previously exported Image Trail key backup JSON file.',
    buttonText: 'Choose key backup',
    noFileText: 'No key backup selected',
    accept: '.json,application/json',
    disabled: state.busy,
  });
  const file = fileControl.input;

  const exportKey = document.createElement('button');
  exportKey.type = 'button';
  exportKey.textContent = state.busy ? 'Working...' : 'Export key backup';
  exportKey.className = 'image-trail-panel__secondary-action';
  exportKey.classList.toggle('is-waiting', state.busy);
  exportKey.disabled = state.busy;
  addTrustedClickListener(exportKey, () => {
    dispatch({ name: 'blob-key/export', password: password.value });
    password.value = '';
  });

  const importKey = document.createElement('button');
  importKey.type = 'button';
  importKey.textContent = state.busy ? 'Working...' : 'Import key backup';
  importKey.className = 'image-trail-panel__secondary-action';
  importKey.classList.toggle('is-waiting', state.busy);
  importKey.disabled = state.busy;
  addTrustedClickListener(importKey, () => {
    readFileInput(file, (fileContent) => {
      dispatch({ name: 'blob-key/import', fileContent, password: password.value });
      password.value = '';
      file.value = '';
    });
  });

  const controls = document.createElement('div');
  controls.className = 'image-trail-panel__control-stack';
  controls.append(passwordControl.field);
  if (!state.hasKey) controls.append(fileControl.field);

  group.append(label, controls, createActionGroup('Backup file', [state.hasKey ? exportKey : importKey]));
  return group;
}

function createSessionLockControls(state: { readonly busy: boolean }, dispatch: (action: EncryptionAction) => void): HTMLElement {
  const lock = document.createElement('button');
  lock.type = 'button';
  lock.textContent = 'Lock now';
  lock.className = 'image-trail-panel__secondary-action';
  lock.disabled = state.busy;
  addTrustedClickListener(lock, () => dispatch({ name: 'blob-key/lock' }));
  return createActionGroup('Session', [lock]);
}

function createKeyRemovalControls(state: { readonly busy: boolean }, dispatch: (action: EncryptionAction) => void): HTMLElement {
  let confirming = false;

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = state.busy ? 'Working...' : 'Clear key';
  clear.title = 'Removes the stored encrypted originals key. Export a key backup first.';
  clear.className = 'image-trail-panel__secondary-action';
  clear.classList.toggle('is-waiting', state.busy);
  clear.disabled = state.busy;
  addTrustedClickListener(clear, () => {
    if (!confirming) {
      confirming = true;
      clear.textContent = 'Confirm clear key';
      clear.classList.add('is-danger');
      clear.title = 'Click again to remove the stored key. Encrypted originals need an imported backup key to recover.';
      return;
    }
    dispatch({ name: 'blob-key/clear' });
  });

  return createActionGroup('Key removal', [clear], { secondary: true });
}

function createInactivityControls(
  timeoutMinutes: SessionInactivityTimeoutMinutes,
  dispatch: (action: EncryptionAction) => void,
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'image-trail-panel__subsection';
  const heading = document.createElement('h4');
  heading.className = 'image-trail-panel__action-group-title';
  heading.textContent = 'Automatic lock';
  const field = document.createElement('label');
  field.className = 'image-trail-panel__settings-field';
  const label = document.createElement('span');
  label.textContent = 'Lock after inactivity';
  const select = document.createElement('select');
  select.className = 'image-trail-panel__settings-select';
  for (const option of [
    { value: '5', label: '5 minutes' },
    { value: '10', label: '10 minutes' },
    { value: '15', label: '15 minutes' },
    { value: 'never', label: 'Never' },
  ]) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    element.selected = String(timeoutMinutes) === option.value;
    select.append(element);
  }
  select.addEventListener('change', () => {
    const value = select.value === 'never' ? 'never' : Number(select.value);
    if (value === 'never' || value === 5 || value === 10 || value === 15) {
      dispatch({ name: 'settings/update-blob-key-inactivity-timeout', value });
    }
  });
  const description = document.createElement('p');
  description.className = 'image-trail-panel__settings-empty';
  description.textContent =
    timeoutMinutes === 'never'
      ? 'Stays unlocked until manual lock, extension reload/update, or browser shutdown.'
      : `Locks after ${timeoutMinutes} minutes without pointer or keyboard activity.`;
  field.append(label, select);
  group.append(heading, field, description);
  return group;
}

function readFileInput(input: HTMLInputElement, onRead: (fileContent: string) => void): void {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') onRead(reader.result);
  };
  reader.readAsText(file);
}
