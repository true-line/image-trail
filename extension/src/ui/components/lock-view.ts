import { attachPasswordFrame, passwordFrameRuntime, PASSWORD_SUBMIT_EVENT } from './password-frame.js';
type UnlockAction = { readonly name: 'blob-key/unlock'; readonly password: string };

export interface WorkspaceLockViewState {
  readonly unlocking: boolean;
  readonly errorMessage?: string | undefined;
}

/** Opaque top-level replacement for the workspace while the encrypted session is locked. */
export function createWorkspaceLockView(state: WorkspaceLockViewState, dispatch: (action: UnlockAction) => void): HTMLElement {
  const surface = document.createElement('section');
  surface.className = 'image-trail-workspace-lock';
  surface.dataset['secureWorkspaceLock'] = 'true';
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-modal', 'true');
  surface.setAttribute('aria-labelledby', 'image-trail-workspace-lock-title');
  surface.setAttribute('aria-busy', String(state.unlocking));

  const emblem = document.createElement('span');
  emblem.className = 'image-trail-workspace-lock__emblem';
  emblem.setAttribute('aria-hidden', 'true');
  emblem.textContent = 'LOCKED';

  const heading = document.createElement('h2');
  heading.id = 'image-trail-workspace-lock-title';
  heading.textContent = 'Image Trail is locked';

  const description = document.createElement('p');
  description.textContent = 'Enter your encrypted-storage password to restore this workspace.';

  const form = document.createElement('form');
  form.className = 'image-trail-workspace-lock__form';

  const label = document.createElement('label');
  label.textContent = 'Password';
  const password = document.createElement('input');
  password.type = 'password';
  password.required = true;
  password.autofocus = true;
  password.autocomplete = 'current-password';
  password.disabled = state.unlocking;
  password.dataset['secureWorkspacePassword'] = 'true';
  const runtime = passwordFrameRuntime();
  if (runtime) {
    label.append(attachPasswordFrame(runtime, password, { label: 'Password', placeholder: '', autocomplete: 'current-password' }));
    password.addEventListener(PASSWORD_SUBMIT_EVENT, () => form.requestSubmit());
  }
  label.append(password);

  const unlock = document.createElement('button');
  unlock.type = 'submit';
  unlock.disabled = state.unlocking;
  unlock.textContent = state.unlocking ? 'Unlocking…' : 'Unlock workspace';

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = password.value;
    if (value === '' || !form.reportValidity() || state.unlocking) return;
    password.value = '';
    dispatch({ name: 'blob-key/unlock', password: value });
  });
  form.append(label, unlock);

  surface.append(emblem, heading, description);
  if (state.errorMessage) {
    const error = document.createElement('p');
    error.className = 'image-trail-workspace-lock__error';
    error.setAttribute('role', 'alert');
    error.textContent = state.errorMessage;
    surface.append(error);
  }
  surface.append(form);
  return surface;
}
