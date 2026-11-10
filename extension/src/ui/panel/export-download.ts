import { requestEncryptedImageExport, requestImageDownload } from '../../content/download-controller.js';
import { filenameFromImageRecord, filenameFromUrl } from '../../core/image/downloads.js';
import type { ImageDisplayRecord } from '../../core/display-records.js';

export function downloadTextFile(fileContent: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([fileContent], { type: 'application/json' }));
  downloadUrl(url, fileName);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadUrlsInSeries(
  downloads: readonly { readonly url: string; readonly fileName: string }[],
  saveAs: boolean,
): Promise<{
  readonly requested: number;
  readonly started: number;
  readonly failed: number;
  readonly saveAsFallbacks: number;
  readonly failedFileNames: readonly string[];
}> {
  let started = 0;
  let failed = 0;
  let saveAsFallbacks = 0;
  const failedFileNames: string[] = [];
  for (const [index, download] of downloads.entries()) {
    const result = await downloadImageFile(download.url, download.fileName, saveAs);
    if (result.ok) {
      started += 1;
      if (result.saveAsFallback) saveAsFallbacks += 1;
    } else {
      failed += 1;
      failedFileNames.push(download.fileName);
    }
    if (index < downloads.length - 1) await delay(120);
  }
  return { requested: downloads.length, started, failed, saveAsFallbacks, failedFileNames };
}

export async function exportEncryptedImagesInSeries(
  downloads: readonly { readonly url: string; readonly fileName: string; readonly blobId?: string | undefined }[],
): Promise<{
  readonly requested: number;
  readonly started: number;
  readonly failed: number;
  readonly encryptionLocked: boolean;
  readonly failedFileNames: readonly string[];
}> {
  let started = 0;
  let failed = 0;
  let encryptionLocked = false;
  const failedFileNames: string[] = [];
  for (const [index, download] of downloads.entries()) {
    const result = await requestEncryptedImageExport(download);
    if (result.ok) {
      downloadTextFile(result.fileContent, result.fileName);
      started += 1;
    } else {
      failed += 1;
      if (result.reason === 'encryption-locked') encryptionLocked = true;
      failedFileNames.push(download.fileName);
    }
    if (index < downloads.length - 1) await delay(120);
  }
  return { requested: downloads.length, started, failed, encryptionLocked, failedFileNames };
}

export function encryptedImageExportResultMessage(result: {
  readonly requested: number;
  readonly started: number;
  readonly failed: number;
  readonly encryptionLocked: boolean;
  readonly failedFileNames: readonly string[];
}): string {
  if (result.started === 0) {
    const failedName = result.failedFileNames[0];
    return failedName ? `Encrypted image export failed for ${failedName}.` : 'Encrypted image export could not be started.';
  }
  if (result.failed > 0) {
    return `Started ${result.started} of ${result.requested} encrypted image exports. ${result.failed} failed.`;
  }
  return result.started === 1 ? 'Encrypted image export started.' : `Started ${result.started} encrypted image exports.`;
}

export async function downloadImageFile(
  url: string,
  fileName: string,
  saveAs: boolean,
): Promise<{ readonly ok: true; readonly saveAsFallback?: boolean } | { readonly ok: false; readonly message: string }> {
  const result = await requestImageDownload({ url, fileName, saveAs });
  if (result.ok) return result;
  downloadUrl(url, fileName);
  return { ok: true, saveAsFallback: saveAs };
}

export function imageDownloadResultMessage(result: {
  readonly requested: number;
  readonly started: number;
  readonly failed: number;
  readonly saveAsFallbacks: number;
  readonly failedFileNames: readonly string[];
}): string {
  if (result.started === 0) {
    const failedName = result.failedFileNames[0];
    return failedName ? `Image export failed for ${failedName}.` : 'Image export could not be started.';
  }
  if (result.failed > 0) {
    return `Started ${result.started} of ${result.requested} image downloads. ${result.failed} failed.`;
  }
  if (result.saveAsFallbacks > 0) {
    return `Save As unavailable; started ${result.started === 1 ? '1 image download normally' : `${result.started} image downloads normally`}.`;
  }
  return result.started === 1 ? 'Image export started.' : `Started ${result.started} image downloads.`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function isFocusablePanelControl(
  element: HTMLElement,
): element is HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

export function filenameForExportedImage(url: string): string {
  if (!url.startsWith('data:image/')) return filenameFromUrl(url);
  const extension = /^data:image\/([a-z0-9.+-]+);/iu.exec(url)?.[1]?.toLowerCase();
  const normalized = extension === 'jpeg' ? 'jpg' : extension;
  return `image-trail-image.${normalized && /^[a-z0-9]+$/u.test(normalized) ? normalized : 'png'}`;
}

export function filenameForExportedImageRecord(record: Pick<ImageDisplayRecord, 'url' | 'title' | 'label' | 'storedOriginal'>): string {
  return filenameFromImageRecord({ ...record, originalFileName: record.storedOriginal?.fileName });
}

export function downloadUrl(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  // Clicked while detached, never inserted into the host page: the click then has no path
  // through the page's document, so page scripts can neither cancel the export nor read the
  // link, which may be an object URL or a data URL holding exported or decrypted content.
  anchor.click();
}
