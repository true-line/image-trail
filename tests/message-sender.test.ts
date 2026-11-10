import test from 'node:test';
import assert from 'node:assert/strict';

import { isExtensionPageSender, isOwnExtensionSender, withSenderCheckedReferrer } from '../extension/src/background/message-sender.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const contentScript = { id: ID, url: 'https://site.test/gallery', origin: 'https://site.test', tab: { url: 'https://site.test/gallery' } };
const extensionPage = { id: ID, url: `chrome-extension://${ID}/gallery/gallery.html` };

test('only messages from this extension are accepted', () => {
  assert.equal(isOwnExtensionSender(contentScript, ID), true);
  assert.equal(isOwnExtensionSender({ id: 'someotherextensionidsomeotherext' }, ID), false);
  assert.equal(isOwnExtensionSender({}, ID), false);
});

test('extension pages are told apart from content scripts', () => {
  assert.equal(isExtensionPageSender(extensionPage, ID), true);
  assert.equal(isExtensionPageSender(contentScript, ID), false);
  assert.equal(isExtensionPageSender({ id: 'x', url: extensionPage.url }, ID), false);
});

test('a content script keeps a referrer on its own origin', () => {
  const message = { type: 't', payload: { url: 'https://site.test/a.jpg', referrer: 'https://site.test/gallery?page=2' } };
  assert.equal(withSenderCheckedReferrer(message, contentScript, ID), message);
});

test('a content script cannot claim another origin as referrer', () => {
  const message = { type: 't', payload: { url: 'https://bank.test/a.jpg', referrer: 'https://bank.test/' } };
  const checked = withSenderCheckedReferrer(message, contentScript, ID);
  assert.deepEqual(checked, { type: 't', payload: { url: 'https://bank.test/a.jpg', referrer: undefined } });
});

test('a referrer is dropped when the sender origin is unknown or opaque', () => {
  const message = { type: 't', payload: { referrer: 'https://site.test/' } };
  assert.equal(withSenderCheckedReferrer(message, { id: ID }, ID).payload.referrer, undefined);
  assert.equal(withSenderCheckedReferrer(message, { id: ID, origin: 'null' }, ID).payload.referrer, undefined);
});

test('extension pages and payloads without a referrer pass through unchanged', () => {
  const withReferrer = { type: 't', payload: { referrer: 'https://site.test/' } };
  assert.equal(withSenderCheckedReferrer(withReferrer, extensionPage, ID), withReferrer);
  const without = { type: 't', payload: { url: 'https://site.test/a.jpg' } };
  assert.equal(withSenderCheckedReferrer(without, contentScript, ID), without);
  const none: { type: string; payload?: unknown } = { type: 't' };
  assert.equal(withSenderCheckedReferrer(none, contentScript, ID), none);
});
