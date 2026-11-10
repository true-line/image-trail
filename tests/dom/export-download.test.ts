import test from 'node:test';
import assert from 'node:assert/strict';

import { createDownloadImageResultMessage, createExportEncryptedImageResultMessage } from '../../extension/src/background/messages.js';
import {
  delay,
  downloadImageFile,
  downloadTextFile,
  downloadUrl,
  downloadUrlsInSeries,
  exportEncryptedImagesInSeries,
  isFocusablePanelControl,
} from '../../extension/src/ui/panel/export-download.js';

interface AnchorClick {
  readonly href: string;
  readonly download: string;
  readonly connectedOnClick: boolean;
}

function captureAnchorClicks(): { readonly clicks: AnchorClick[]; restore(): void } {
  const clicks: AnchorClick[] = [];
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download, connectedOnClick: this.isConnected });
  };
  return {
    clicks,
    restore: () => {
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

function stubChromeSendMessage(sendMessage: (message: unknown) => Promise<unknown>): () => void {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: { id: 'test-extension', sendMessage },
  } as unknown as typeof chrome;
  return () => {
    globalThis.chrome = originalChrome;
  };
}

test('downloadUrl clicks a detached anchor that the host page never sees', () => {
  const anchors = captureAnchorClicks();
  const inserted: Node[] = [];
  const observer = new MutationObserver((records) => inserted.push(...records.flatMap((record) => [...record.addedNodes])));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  try {
    downloadUrl('https://example.test/one.jpg', 'one.jpg');
    inserted.push(...observer.takeRecords().flatMap((record) => [...record.addedNodes]));
  } finally {
    observer.disconnect();
    anchors.restore();
  }

  assert.equal(anchors.clicks.length, 1);
  assert.equal(anchors.clicks[0]?.href, 'https://example.test/one.jpg');
  assert.equal(anchors.clicks[0]?.download, 'one.jpg');
  assert.equal(anchors.clicks[0]?.connectedOnClick, false, 'the link is never part of the page document');
  assert.deepEqual(inserted, [], 'nothing is inserted into the page document');
  assert.equal(document.querySelector('a'), null);
});

test('downloadTextFile downloads an object URL and revokes it afterwards', async () => {
  const anchors = captureAnchorClicks();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = () => 'blob:image-trail/test-object';
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };

  try {
    downloadTextFile('{"records":[]}', 'export.json');
    await delay(1);
  } finally {
    anchors.restore();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }

  assert.equal(anchors.clicks[0]?.download, 'export.json');
  assert.match(anchors.clicks[0]?.href ?? '', /blob:image-trail\/test-object$/u);
  assert.deepEqual(revoked, ['blob:image-trail/test-object']);
});

test('downloadImageFile falls back to an anchor download when the background download fails', async () => {
  const anchors = captureAnchorClicks();
  const restoreChrome = stubChromeSendMessage(async () => createDownloadImageResultMessage({ ok: false, message: 'Download blocked.' }));

  try {
    const result = await downloadImageFile('https://example.test/one.jpg', 'one.jpg', true);
    assert.deepEqual(result, { ok: true, saveAsFallback: true });
  } finally {
    anchors.restore();
    restoreChrome();
  }

  assert.equal(anchors.clicks.length, 1);
  assert.equal(anchors.clicks[0]?.download, 'one.jpg');
});

test('downloadUrlsInSeries counts started downloads and save-as fallbacks', async () => {
  const anchors = captureAnchorClicks();
  let call = 0;
  const restoreChrome = stubChromeSendMessage(async () => {
    call += 1;
    return call === 1
      ? createDownloadImageResultMessage({ ok: true, downloadId: 7 })
      : createDownloadImageResultMessage({ ok: false, message: 'Download blocked.' });
  });

  try {
    const result = await downloadUrlsInSeries(
      [
        { url: 'https://example.test/one.jpg', fileName: 'one.jpg' },
        { url: 'https://example.test/two.jpg', fileName: 'two.jpg' },
      ],
      true,
    );
    assert.deepEqual(result, { requested: 2, started: 2, failed: 0, saveAsFallbacks: 1, failedFileNames: [] });
  } finally {
    anchors.restore();
    restoreChrome();
  }

  assert.equal(anchors.clicks.length, 1);
});

test('exportEncryptedImagesInSeries downloads successful exports and flags encryption-locked failures', async () => {
  const anchors = captureAnchorClicks();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:image-trail/encrypted-export';
  URL.revokeObjectURL = () => undefined;
  let call = 0;
  const restoreChrome = stubChromeSendMessage(async () => {
    call += 1;
    return call === 1
      ? createExportEncryptedImageResultMessage({ ok: true, fileContent: '{"payload":true}', fileName: 'one.json', message: 'ok' })
      : createExportEncryptedImageResultMessage({ ok: false, reason: 'encryption-locked', message: 'Locked.' });
  });

  try {
    const result = await exportEncryptedImagesInSeries([
      { url: 'https://example.test/one.jpg', fileName: 'one.jpg', blobId: 'blob-1' },
      { url: 'https://example.test/two.jpg', fileName: 'two.jpg' },
    ]);
    assert.deepEqual(result, { requested: 2, started: 1, failed: 1, encryptionLocked: true, failedFileNames: ['two.jpg'] });
  } finally {
    anchors.restore();
    restoreChrome();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }

  assert.equal(anchors.clicks.length, 1);
  assert.equal(anchors.clicks[0]?.download, 'one.json');
});

test('isFocusablePanelControl accepts form controls and rejects other panel elements', () => {
  assert.equal(isFocusablePanelControl(document.createElement('button')), true);
  assert.equal(isFocusablePanelControl(document.createElement('input')), true);
  assert.equal(isFocusablePanelControl(document.createElement('select')), true);
  assert.equal(isFocusablePanelControl(document.createElement('textarea')), true);
  assert.equal(isFocusablePanelControl(document.createElement('div')), false);
});
