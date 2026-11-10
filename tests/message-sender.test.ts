import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isExtensionPageSender,
  isOwnExtensionSender,
  isPrivateNetworkHost,
  publicPageTargetsPrivateNetwork,
  withSenderCheckedReferrer,
} from '../extension/src/background/message-sender.js';

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

test('private-network hosts are recognised', () => {
  for (const host of [
    'localhost',
    'nas.local',
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.10',
    '172.16.0.1',
    '172.31.255.1',
    '169.254.169.254',
    '[::1]',
    '[fd00::1]',
    '[fe80::1]',
    '[::ffff:10.0.0.1]',
  ]) {
    assert.equal(isPrivateNetworkHost(host), true, host);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '[2606:4700::1111]', 'local.example.com']) {
    assert.equal(isPrivateNetworkHost(host), false, host);
  }
});

test('a public page cannot request a private-network address', () => {
  const request = { type: 't', payload: { url: 'http://192.168.1.10/camera.jpg' } };
  assert.equal(publicPageTargetsPrivateNetwork(request, contentScript, ID), true);
  assert.equal(publicPageTargetsPrivateNetwork(request, { id: ID }, ID), true, 'unknown sender location is treated as public');
});

test('private pages, extension pages, and public targets are unaffected', () => {
  const privateTarget = { type: 't', payload: { url: 'http://192.168.1.10/camera.jpg' } };
  const lanPage = { id: ID, url: 'http://192.168.1.10/index.html' };
  assert.equal(publicPageTargetsPrivateNetwork(privateTarget, lanPage, ID), false);
  assert.equal(publicPageTargetsPrivateNetwork(privateTarget, extensionPage, ID), false);
  assert.equal(publicPageTargetsPrivateNetwork({ payload: { url: 'https://cdn.test/a.jpg' } }, contentScript, ID), false);
  assert.equal(publicPageTargetsPrivateNetwork({ payload: { url: 'data:image/png;base64,AAAA' } }, contentScript, ID), false);
  assert.equal(publicPageTargetsPrivateNetwork({ payload: {} }, contentScript, ID), false);
});
