import { inlineImageThumbnail } from '../../core/display-records.js';

export type RecordRowState = 'default' | 'selected' | 'locked-encrypted' | 'key-unavailable';

export interface RecordRowOptions {
  readonly className?: string;
  readonly layout?: 'panel' | 'recall' | 'gallery';
  readonly state?: RecordRowState;
  readonly privacyMasked?: boolean;
  readonly storedOriginal?: boolean;
  readonly thumbnail?: string | undefined;
  readonly thumbnailAlt?: string | undefined;
  readonly thumbnailFallback: string;
  readonly source?: string | undefined;
  readonly sourceTitle?: string | undefined;
  readonly name: string;
  readonly nameTitle?: string | undefined;
  readonly meta?: string | undefined;
  readonly metaTitle?: string | undefined;
  readonly warning?: string | undefined;
  readonly warningTitle?: string | undefined;
  readonly bodyClassName?: string;
  readonly nameClassName?: string;
  readonly metaClassName?: string;
  readonly warningClassName?: string;
  readonly leading?: HTMLElement;
  readonly actions?: HTMLElement;
  readonly interactionTarget?: 'root' | 'button';
}

export interface RecordRowElements {
  readonly root: HTMLLIElement;
  readonly interactionTarget: HTMLLIElement | HTMLButtonElement;
  readonly visual: HTMLElement;
  readonly body: HTMLElement;
}

export function createRecordRow(options: RecordRowOptions): RecordRowElements {
  const layout = options.layout ?? 'panel';
  const state = options.state ?? 'default';
  const root = document.createElement('li');
  root.className = classNames('image-trail-ds__record-row', options.className);
  root.dataset['layout'] = layout;
  root.dataset['state'] = state;
  applyRecordRowState(root, state, options);

  const interactionTarget = createInteractionTarget(root, options.interactionTarget ?? 'root');
  const visual = createRecordVisual(options);
  const body = createRecordBody(options);
  interactionTarget.append(visual, body);

  if (options.leading) {
    options.leading.classList.add('image-trail-ds__record-leading');
    interactionTarget.prepend(options.leading);
  }
  if (options.actions) {
    options.actions.classList.add('image-trail-ds__record-actions');
    root.append(options.actions);
  }
  if (options.privacyMasked) {
    const veil = document.createElement('span');
    veil.className = 'image-trail-ds__record-privacy-veil';
    veil.setAttribute('aria-hidden', 'true');
    root.append(veil);
  }
  return { root, interactionTarget, visual, body };
}

function createInteractionTarget(root: HTMLLIElement, target: 'root' | 'button'): HTMLLIElement | HTMLButtonElement {
  if (target === 'root') return root;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'image-trail-ds__record-button';
  root.append(button);
  return button;
}

function createRecordVisual(options: RecordRowOptions): HTMLElement {
  // Records saved before restore dropped remote thumbnails may still carry one: check here too,
  // so no row in the Queue, Recents, or Recall requests a thumbnail from a remote address.
  const thumbnail = inlineImageThumbnail(options.thumbnail);
  if (thumbnail && !options.privacyMasked && options.state !== 'locked-encrypted' && options.state !== 'key-unavailable') {
    const image = document.createElement('img');
    image.className = thumbnailClasses(options.layout, false, false);
    image.src = thumbnail;
    image.alt = options.thumbnailAlt ?? '';
    image.loading = 'lazy';
    return image;
  }
  const fallback = document.createElement('span');
  fallback.className = thumbnailClasses(options.layout, true, options.privacyMasked === true);
  fallback.textContent = options.thumbnailFallback;
  fallback.setAttribute('aria-hidden', 'true');
  return fallback;
}

function thumbnailClasses(layout: RecordRowOptions['layout'], fallback: boolean, privacyMasked: boolean): string {
  return classNames(
    'image-trail-ds__record-thumbnail',
    layout === 'gallery' ? 'image-trail-gallery__thumbnail' : 'image-trail-panel__record-thumbnail',
    fallback && 'image-trail-ds__record-thumbnail--fallback',
    fallback && layout === 'gallery' && 'image-trail-gallery__thumbnail--fallback',
    fallback && layout !== 'gallery' && 'image-trail-panel__record-thumbnail--empty',
    privacyMasked && 'image-trail-ds__record-thumbnail--privacy',
    privacyMasked && layout !== 'gallery' && 'image-trail-panel__record-thumbnail--privacy',
  );
}

function createRecordBody(options: RecordRowOptions): HTMLElement {
  const body = document.createElement(options.layout === 'gallery' ? 'span' : 'div');
  body.className = classNames('image-trail-ds__record-body', options.bodyClassName);

  const identity = document.createElement('span');
  identity.className = 'image-trail-ds__record-identity';
  if (options.source) identity.append(createRecordSource(options));
  if (options.storedOriginal) identity.append(createStoredOriginalIndicator());
  body.append(identity);

  const name = document.createElement('span');
  name.className = classNames('image-trail-ds__record-name', options.nameClassName);
  name.textContent = options.name;
  if (options.nameTitle) name.title = options.nameTitle;
  body.append(name);

  if (options.meta) {
    const meta = document.createElement('span');
    meta.className = classNames('image-trail-ds__record-meta', options.metaClassName);
    meta.textContent = options.meta;
    meta.title = options.metaTitle ?? options.meta;
    body.append(meta);
  }

  if (options.warning) {
    const warning = document.createElement('span');
    warning.className = classNames('image-trail-ds__record-warning', options.warningClassName);
    warning.textContent = options.warning;
    warning.title = options.warningTitle ?? options.warning;
    body.append(warning);
  }
  return body;
}

function createRecordSource(options: RecordRowOptions): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'image-trail-ds__record-source-wrap image-trail-panel__record-extension-wrap';
  const source = document.createElement('span');
  source.className = 'image-trail-ds__record-source image-trail-panel__bookmark-source';
  source.textContent = options.source ?? '';
  source.title = options.sourceTitle ?? source.textContent;
  wrapper.append(source);
  return wrapper;
}

function createStoredOriginalIndicator(): HTMLElement {
  const dot = document.createElement('span');
  dot.className = 'image-trail-ds__record-stored-original image-trail-panel__stored-original-dot';
  dot.title = 'Original stored';
  dot.setAttribute('aria-label', 'Original stored');
  return dot;
}

function applyRecordRowState(root: HTMLLIElement, state: RecordRowState, options: RecordRowOptions): void {
  root.classList.toggle('is-selected', state === 'selected');
  root.classList.toggle('is-locked-encrypted', state === 'locked-encrypted' || state === 'key-unavailable');
  root.classList.toggle('is-key-unavailable', state === 'key-unavailable');
  root.classList.toggle('is-captured', options.storedOriginal === true);
  root.classList.toggle('is-privacy-masked', options.privacyMasked === true);
}

function classNames(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}
