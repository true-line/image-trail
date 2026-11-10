import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordRow } from '../../extension/src/ui/components/record-row.js';

test('RecordRow renders the canonical thumbnail, hierarchy, actions, and stored-original indicator', () => {
  const actions = document.createElement('span');
  actions.append(document.createElement('button'));
  const row = createRecordRow({
    className: 'consumer-row',
    thumbnail: 'data:image/jpeg;base64,AAAA',
    thumbnailFallback: 'JPG',
    source: 'JPG',
    name: 'photo.jpg',
    meta: '1920 x 1080',
    storedOriginal: true,
    state: 'selected',
    actions,
  });

  assert.equal(row.root.tagName, 'LI');
  assert.equal(row.root.dataset['state'], 'selected');
  assert.ok(row.root.classList.contains('consumer-row'));
  assert.ok(row.root.classList.contains('is-selected'));
  assert.ok(row.root.classList.contains('is-captured'));
  assert.equal(row.visual.getAttribute('src'), 'data:image/jpeg;base64,AAAA');
  assert.equal(row.body.querySelector('.image-trail-ds__record-meta')?.textContent, '1920 x 1080');
  assert.equal(row.body.querySelector('.image-trail-ds__record-source')?.textContent, 'JPG');
  assert.equal(row.body.querySelector('.image-trail-ds__record-name')?.textContent, 'photo.jpg');
  assert.equal(row.body.querySelector('.image-trail-ds__record-identity .image-trail-ds__record-name'), null);
  assert.deepEqual(
    Array.from(row.body.children, (child) => child.classList[0]),
    ['image-trail-ds__record-identity', 'image-trail-ds__record-name', 'image-trail-ds__record-meta'],
  );
  assert.ok(row.root.querySelector('.image-trail-ds__record-stored-original'));
  assert.equal(row.root.querySelector('.image-trail-ds__record-actions'), actions);
});

test('RecordRow masks private thumbnails and applies locked and key-unavailable states without private copy', () => {
  const row = createRecordRow({
    layout: 'recall',
    thumbnail: 'https://private.example/secret.jpg',
    thumbnailFallback: 'PRIVATE',
    source: 'PRIVATE',
    name: 'Private image',
    meta: 'Private metadata',
    state: 'key-unavailable',
    privacyMasked: true,
  });

  assert.ok(row.root.classList.contains('is-locked-encrypted'));
  assert.ok(row.root.classList.contains('is-key-unavailable'));
  assert.ok(row.root.classList.contains('is-privacy-masked'));
  assert.equal(row.root.querySelector('img'), null);
  assert.ok(row.root.querySelector('.image-trail-ds__record-privacy-veil'));
  assert.ok(!row.root.outerHTML.includes('private.example'));
  assert.ok(!row.root.outerHTML.includes('secret.jpg'));
});

test('Gallery RecordRow keeps native button semantics inside its list item', () => {
  const row = createRecordRow({
    layout: 'gallery',
    interactionTarget: 'button',
    thumbnailFallback: 'PNG',
    source: 'PNG',
    name: 'image.png',
  });

  assert.equal(row.interactionTarget.tagName, 'BUTTON');
  assert.equal((row.interactionTarget as HTMLButtonElement).type, 'button');
  assert.equal(row.root.dataset['layout'], 'gallery');
  assert.ok(row.visual.classList.contains('image-trail-gallery__thumbnail'));
});

test('a row renders an inline thumbnail and shows the placeholder for any other thumbnail URL', () => {
  const inline = createRecordRow({ thumbnailFallback: 'IMG', name: 'row', thumbnail: 'data:image/png;base64,AAAA' });
  assert.equal(inline.root.querySelector('img')?.getAttribute('src'), 'data:image/png;base64,AAAA');
  const remote = createRecordRow({ thumbnailFallback: 'IMG', name: 'row', thumbnail: 'https://tracker.test/pixel.gif' });
  assert.equal(remote.root.querySelector('img'), null);
});
