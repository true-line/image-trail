# Chrome Web Store Submission

Issue: #502  
Parent release gate: #14  
Last reviewed: 2026-08-07

This is the canonical Chrome Web Store dashboard copy, asset inventory,
reviewer path, and owner-only submission checklist. It is intentionally more
conservative than the feature backlog: a capability is advertised only after it
ships in the exact upload package.

## Listing fields

| Dashboard field   | Submission value                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Name              | Image Trail                                                                                                                                |
| Summary           | Turn image URL patterns into navigable trails, durable galleries, encrypted captures, and recoverable backups.                             |
| Category          | Photos                                                                                                                                     |
| Language          | English                                                                                                                                    |
| Mature content    | No                                                                                                                                         |
| Homepage          | https://true-line.ai                                                                                                                       |
| Support           | https://github.com/true-line/image-trail/issues                                                                                            |
| Privacy policy    | `docs/privacy-and-permissions-review.md` (canonical source; publish a hosted copy of this document as the live CWS URL at submission time) |
| Promotional video | Not supplied. There is no audited promotional video for v0.26.6.                                                                           |

The official listing guidance was re-audited on 2026-08-07. It describes a
YouTube promotional video among the listing information to provide, while the
asset guidance treats video as optional promotional media. If the live
dashboard requires a video, stop and file a focused blocker instead of
improvising an unaudited product claim.

### Single purpose

Image Trail lets a user explicitly invoke an in-page tool to inspect and
navigate related image URLs, keep selected image references in a local gallery,
and protect optional captured originals and backups.

### Detailed description

Image Trail turns patterns already present in image URLs into navigable trails.

Invoke the toolbar action on a page to select an image, inspect and edit useful
URL fields, step through related images, or run a bounded slideshow. Session
Recents remain temporary unless you explicitly pin or capture an item. Durable
pins and bookmarks can be reviewed through Queue, Gallery, and Recall.

Optional privacy and recovery tools can:

- encrypt captured originals, thumbnails, and protected bookmark metadata locally;
- export encrypted images, key backups, and full backups;
- back up password-encrypted data to pCloud;
- request access only to a named image or provider origin when a protected action needs it.

Image Trail does not inject into every site at installation, execute remote
code, sell data, display advertising, or provide a developer service that reads
user libraries. Denying optional site or provider access leaves local URL
inspection and editing available.

Do not add Overlook Move/Sync, Google Drive, or iCloud claims until #560/#590
have released-product evidence and #608/#609 are closed.

## Assets

The versioned submission assets are:

| Use                    | File                                               | Required dimensions |
| ---------------------- | -------------------------------------------------- | ------------------- |
| Store icon             | `extension/icons/icon128.png`                      | 128×128             |
| Primary screenshot     | `store-assets/image-trail-screenshot-1280x800.png` | 1280×800            |
| Small promotional tile | `store-assets/image-trail-small-promo-440x280.png` | 440×280             |

`tests/store-assets.test.ts` rejects a missing, non-PNG, undersized placeholder,
or dimension mismatch. The screenshot is captured from the real packaged panel
over a deterministic local image fixture. The tile uses the shipped extension
icon and contains no unshipped product claim.

## Permission justifications

| Permission                            | Dashboard justification                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activeTab`                           | Gives temporary access to the current tab only after the user invokes Image Trail.                                                                     |
| `scripting`                           | Injects the packaged Image Trail panel into that user-invoked active tab; there is no static content-script registration.                              |
| `downloads`                           | Saves only user-requested image exports, encrypted image files, key backups, and full encrypted backups.                                               |
| `storage`                             | Stores extension-owned settings, durable local records, encryption session state, and provider connection state. Host-page `localStorage` is not used. |
| `identity`                            | Starts an OAuth flow only when the user explicitly connects a supported provider.                                                                      |
| `declarativeNetRequestWithHostAccess` | Applies temporary pCloud request headers only after the user grants the narrow pCloud host pattern.                                                    |
| Optional `http://*/*`, `https://*/*`  | Allows Chromium to ask for one explicit image/provider origin at the moment a protected operation needs it. No origin is granted at install time.      |

The baseline release manifest does not request `nativeMessaging`. Transfer &
Sync and that permission remain behind the explicit
`IMAGE_TRAIL_ENABLE_INTEROP=1` experimental build gate until #590, #608, and
#609 provide the released cross-product and signed-host evidence.

## Privacy dashboard

- **Remote code:** No. All executable JavaScript is packaged in the Manifest V3 extension.
- **Data categories:** Website content; web history/browsing activity;
  user-generated content; authentication information.
- **Data use:** only to provide the user-requested Image Trail feature.
- **Not used for:** sale, advertising, personalized advertising, credit or
  lending, unrelated profiling, or routine human review.
- **Transfer:** only to a provider the user explicitly connects, and only for
  provider authentication or user-requested encrypted objects.
- **Limited use:** certify the Chrome Web Store limited-use requirements.

The full public policy is [Privacy And Permissions Review](../privacy-and-permissions-review.md).

## Reviewer instructions (no private credentials)

1. Install the supplied ZIP as an unpacked extension and pin **Image Trail**.
2. Open a public page containing images, then invoke the toolbar action. The
   Image Trail panel should appear only after this gesture.
3. On a page with several images, use **Set host image** and choose one image.
   The Dashboard shows the chosen URL and parsed fields.
4. Use the URL editor or a parsed field, then use **Prev** / **Next** to exercise
   a bounded trail. **Stop** ends running automation.
5. Use **Pin current**, open **Gallery**, and confirm the durable item. Reopen the
   source page to observe that Recents are session-only while the pin remains.
6. Open **Settings** to review privacy, backup, and optional provider controls.
   Core review requires no pCloud, Google, iCloud, Overlook, or private account.
7. Optional encryption review may use any reviewer-created temporary password;
   no publisher credential is required.

If reviewer test instructions are omitted from the dashboard, these steps remain
the internal acceptance path.

## Exact upload package

Do not upload an arbitrary local `extension/dist` directory. The published
v0.26.6 release is the audited upload candidate. The evidence records:

- Git commit and release tag;
- release ZIP filename and public release URL;
- SHA-256 from the matching `SHA256SUMS`;
- manifest version inside the ZIP;
- successful `npm run ci`, `npm run test:e2e:release`, and release artifact audit.

| Commit/tag                                                                                                                                                                                                | ZIP                                                                                                                | SHA-256                                                            | Manifest version |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------- |
| [`6fbd99522e1e9541620780df9cbeadde06db3a47`](https://github.com/qwts/image-trail/commit/6fbd99522e1e9541620780df9cbeadde06db3a47) / [`v0.26.6`](https://github.com/qwts/image-trail/releases/tag/v0.26.6) | [`image-trail-v0.26.6.zip`](https://github.com/qwts/image-trail/releases/download/v0.26.6/image-trail-v0.26.6.zip) | `8fc3454bd65302933e3f4cb4b82c4bf78ae2f904b93e691ef9ee8fc15fdb388e` | `0.26.6`         |

The release `SHA256SUMS` verifies the downloaded ZIP. Its manifest requests
`activeTab`, `scripting`, `downloads`, `identity`, `storage`, and
`declarativeNetRequestWithHostAccess`, plus optional HTTP/HTTPS host access. A
scan of the entire extracted package found no `nativeMessaging` occurrence.
The exact [CI](https://github.com/qwts/image-trail/actions/runs/31051521404),
[version-cut](https://github.com/qwts/image-trail/actions/runs/31051521263), and
[release](https://github.com/qwts/image-trail/actions/runs/31051828001) workflows
all succeeded. The repository evidence lock records the ZIP size, package and
asset hashes, manifest snapshot, and workflow URLs in
[`store-assets/submission-v0.26.6.json`](https://github.com/qwts/image-trail/blob/main/store-assets/submission-v0.26.6.json).

## Pre-submission checklist

- [x] Listing name, summary, category, language, rating, and detailed description reviewed.
- [x] Single-purpose statement reviewed.
- [x] Public homepage, support, and privacy URLs recorded.
- [x] 128×128 icon versioned and package-tested.
- [x] 1280×800 screenshot versioned and dimension-tested.
- [x] 440×280 promotional tile versioned and dimension-tested.
- [x] Data categories, limited-use statement, and remote-code declaration documented.
- [x] Reviewer path requires no publisher/private credentials.
- [x] Remove `nativeMessaging` and unfinished Transfer & Sync from the baseline release.
- [x] Fill the exact upload-package row from the final release.
- [x] Recheck this copy against the final manifest and release behavior.

## Owner-only dashboard steps

1. Create or open the Chrome Web Store draft and upload only the exact package above.
2. Enter the listing and privacy values from this page without broadening any claim.
3. Upload the three versioned assets and verify Chrome did not crop the icon/tile unexpectedly.
4. If the live dashboard requires a promotional video, stop and file a focused blocker; do not invent one during submission.
5. Complete account, trader, distribution, pricing, and region fields according to the owner's current legal choices.
6. Preview every locale and the privacy disclosure.
7. Save the draft, download or screenshot the dashboard summary for release evidence, and submit for review.

Uploading, entering owner/legal declarations, and clicking **Submit for review**
are owner-only operations and are outside #502's implementation scope.

## Official references

- https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions
- https://developer.chrome.com/docs/webstore/images
