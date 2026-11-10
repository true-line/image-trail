# Privacy And Permissions Review

Issues: #57, #14, #502, #560, #590, #608, #609, #675

Last reviewed: 2026-08-30

This page is Image Trail's public privacy policy and permission rationale. Image
Trail is a user-invoked browser extension for inspecting image URL patterns,
navigating related images, and keeping optional local pins, encrypted captures,
and encrypted backups.

## Data handling summary

- Image Trail runs on a page only after the user invokes the extension action or
  a configured extension shortcut.
- Session Recents use browser-managed `chrome.storage.session`: they survive
  MV3 service-worker suspension but are not restored after the browser session.
- Pins, bookmark metadata, settings, and encryption state are stored in
  extension-owned browser storage. Captured original bytes are stored separately
  in the encrypted original/blob store.
- When protection is enabled, captured originals, thumbnails, and protected
  bookmark metadata are encrypted locally before durable storage or export.
- Optional provider connections send only user-requested OAuth traffic and
  encrypted backup/interop objects to the selected provider.
- Image Trail does not sell data, use it for advertising or credit decisions,
  expose it for routine human review, or execute remotely hosted code.

## Data categories

The conservative Chrome Web Store disclosure covers:

| Category                        | Data handled                                                                                                  | Purpose                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Website content                 | User-selected image/page URLs, fetched image or linked-page bytes, titles, dimensions, and derived URL fields | Inspect, navigate, preview, pin, or capture the image the user chose |
| Web history / browsing activity | URLs from pages and images where the user explicitly invokes Image Trail                                      | Preserve the active trail and durable records requested by the user  |
| User-generated content          | Labels, albums, settings, review status, and imported metadata                                                | Organize the user's local gallery and backups                        |
| Authentication information      | Optional provider OAuth tokens and connection state                                                           | Connect only the provider chosen by the user                         |

Data is retained until the user clears the relevant Recents, pin/bookmark,
original, provider connection, or all extension storage. Removing the extension
also removes browser-managed extension storage; exported files and provider
objects remain under the user's control until they delete them.

## Host-access posture

Image Trail does not receive persistent access to every site at installation.

- The production manifest has no required `host_permissions` and no static `content_scripts` registration.
- `activeTab` and `scripting` let the extension inject its panel only after the user invokes the toolbar action or an extension keyboard command.
- `optional_host_permissions` declares HTTP and HTTPS so Image Trail can request one exact image origin when encrypted-original capture needs cross-origin bytes.
- Approval persists under Chromium host controls until the user removes it. Denial leaves the URL or durable source intact and produces a retryable error.
- Connecting pCloud requests `https://*.pcloud.com/*` from the Connect pCloud gesture. The wildcard is limited to pCloud because its API chooses regional API hosts and dynamic download subdomains.
- `web_accessible_resources.matches` makes only packaged UI styles available to
  HTTP/HTTPS pages where the user opens the panel. It does not grant Image Trail
  permission to read those pages.

The automated E2E build adds a generated-only `http://127.0.0.1/*` required host permission after compiling the production manifest. This is limited to the local fixture server and is never copied back into `extension/manifest.json`.

## Named permission rationale

| Permission                            | Product use                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `activeTab`                           | Temporary access to the current page after an explicit extension gesture.                                        |
| `scripting`                           | Inject the content script into that active page.                                                                 |
| `storage`                             | Extension-owned settings and the background-owned pCloud connection record.                                      |
| `downloads`                           | Export images and encrypted artifacts through Chromium downloads.                                                |
| `identity`                            | Run explicit pCloud and Google Drive OAuth flows selected by the user.                                           |
| `declarativeNetRequestWithHostAccess` | Apply short-lived pCloud request-header rules only after pCloud host access is granted.                          |
| `nativeMessaging`                     | In experimental builds only, ask the signed Overlook host for a one-use, loopback-only local-session capability. |

The production manifest contains no remotely hosted script, `eval`-based code
loader, or required all-sites access. All executable JavaScript ships inside the
extension package.

## Store-listing rationale

Suggested disclosure:

> Image Trail runs on a page only when you invoke it. Capturing an original from another image host may ask for access to that specific host. Cloud backup asks separately for access to pCloud. Denying either request leaves browsing and URL editing available; Image Trail does not request access to all sites during installation.

## Optional providers and disclosure

- pCloud connection begins only from **Connect pCloud**. A denied host grant does
  not open OAuth or store a token.
- Google Drive connection, when enabled in a release, uses the least-privilege
  `drive.file` boundary so the app can access only files it created or the user
  explicitly selected.
- Baseline and release builds omit `nativeMessaging` and hide Transfer & Sync.
  The permission and workflow are added only to an explicit experimental build
  with `IMAGE_TRAIL_ENABLE_INTEROP=1`. The permission does not let Image Trail
  enumerate or invoke arbitrary native applications: the background worker
  addresses only the signed `com.qwts.overlook.interop` host. Its live-local
  bootstrap accepts only the released Image Trail extension identity and a
  previously paired operation, then returns one capability for an exact
  `ws://127.0.0.1:<port>/session/<uuid>` endpoint. The capability expires within
  15 seconds, is redeemed as the first WebSocket frame, and is never written to
  extension storage, sent to a content script or host page, or logged.
- Live-local data frames contain only the existing encrypted interoperability
  objects. The service worker enforces the 64 KiB control-frame, 4 MiB
  ciphertext-frame, and negotiated 8 MiB in-flight ceilings; complete objects
  are checksum-verified before durable acknowledgement. Browser sleep, worker
  suspension, disconnect, or cancellation discards the socket authority and
  requires a fresh native bootstrap while the durable encrypted journal remains
  paused. #590, #608, and #609 remain release blockers before the experimental
  gate can be enabled for users.
- Provider uploads contain password-encrypted backup or encrypted interop
  objects, not a plaintext user library.

## Denial and revocation behavior

- Page injection still works through `activeTab` when unrelated optional origins are denied.
- A denied image-origin request remains a named, retryable remote-only capture state.
- A denied pCloud request does not open OAuth or store a token and shows an explicit disconnected error.
- pCloud OAuth uses `https://<extension-id>.chromiumapp.org/pcloud`; the installed
  extension ID must be registered as an allowed redirect host in the pCloud app
  before Connect pCloud can complete authorization.
- If a previously granted origin is revoked, the next protected operation returns to its permission-needed path.
- Existing pCloud users who revoke host access can disconnect and reconnect to approve the narrow pCloud host pattern again.

## Verification

- The audited v0.26.6 upload candidate is pinned in the [Chrome Web Store Submission](acceptance-tests/chrome-web-store-submission.md) exact-package row and repository `store-assets/submission-v0.26.6.json`; its extracted baseline manifest omits `nativeMessaging`.
- `tests/manifest-commands.test.ts` guards the absence of required all-sites access and static injection.
- `tests/permissions.test.ts` guards exact origin patterns and fail-closed browser API behavior.
- `tests/pcloud-permissions.test.ts` guards the narrow pCloud request and denial boundary.
- `tests/interop-live-local.test.ts` guards strict bootstrap authority, exact
  loopback endpoints, capability expiry and replay failure, bounded encrypted
  framing, acknowledgement backpressure, cancellation, heartbeat, and
  fresh-bootstrap reconnect.
- `tests/e2e/interop-ui.spec.ts` proves the live-local probe is absent from the
  baseline package and exercises the injected native/socket seam only in an
  explicit experimental Chromium test build.
- `tests/e2e/extension-smoke.spec.ts` exercises on-demand injection with only the generated local fixture grant.
- [Third-Party CDN Permission Flow](acceptance-tests/third-party-cdn-permission-flow.md) covers live capture approval, denial, and retry.
- [pCloud Provider Boundary](acceptance-tests/pcloud-provider-boundary.md) covers the pCloud grant before OAuth.

## Contact and public links

- Publisher: True Line AI LLC, https://true-line.ai
- Project: https://github.com/true-line/image-trail
- Support and privacy requests: https://github.com/true-line/image-trail/issues
- Chrome Web Store submission checklist: [Chrome Web Store Submission](acceptance-tests/chrome-web-store-submission.md)
