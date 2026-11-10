# image-trail

## 0.27.9

### Patch Changes

- 527e971: Restore "Image Trail by True Line AI LLC" as the public name (store listing, extension name, README, notices) and add the manifest short name "Image Trail" for places where the browser has little room.

## 0.27.8

### Patch Changes

- 2b3b937: Shorten the extension name to Image Trail. True Line AI LLC remains the publisher and copyright holder; the long form "Image Trail by True Line AI LLC" no longer appears as the product name.

## 0.27.7

### Patch Changes

- d6f3e9a: Saving a pin no longer undoes a Recall or drops a captured original that another save attached at the same moment. Pin saves, Recall moves, and removals now take turns instead of overwriting each other.
- ff5e859: In experimental Transfer & Sync builds, a Move no longer deletes the source record when it was edited or gained a captured original after review; finalization now stops instead.
- 108796d: Saving a pin now reports a failure when Image Trail storage cannot be opened instead of appearing to succeed, and a failed storage open is retried on the next action.
- 770114f: Encrypted storage setup now saves the new key before unlocking and refuses to replace an existing key, restoring a backup keeps originals that are already stored instead of overwriting them, and orphan cleanup deletes nothing while any bookmark record is unreadable.
- 26cca37: Unlocking encrypted storage now tries every stored key and prefers this device's own key, so importing another device's key backup no longer locks you out of your local private pins and originals.

## 0.27.6

### Patch Changes

- cdb7e93: pCloud API calls no longer send the browser's pCloud web cookies.

## 0.27.5

### Patch Changes

- ea972d3: Encrypted records are now bound to the row they were saved in.
- 7fbebdc: Exports and downloads no longer place a temporary link in the page you are viewing. The page can no longer see, cancel, or read an export as it starts.
- a232f9a: Restoring a backup now keeps only inline image thumbnails. A thumbnail that points at a remote address is dropped and shown as a placeholder instead of being loaded.
- 8f60553: Incognito windows now run their own separate copy of the extension. Recents, cached images, the unlock state, and saved records are no longer shared between incognito and regular windows, and anything saved in incognito is discarded when the incognito session ends.
- b07f77c: Backup, export, and key files with out-of-range password-protection settings are now rejected instead of being processed. This stops a damaged or crafted file from freezing the browser or from being accepted with protection too weak to be meaningful.
- ae4b22f: The background worker now accepts messages only from Image Trail itself, and decides whether an image request may carry cookies from the page the browser reports rather than from the request's own claim.
- 4b077fb: The Searchable metadata setting now describes its Encrypted option accurately: it keeps URL-derived details from being stored as readable text, but it is not protected by your encryption password. Only private pins and stored originals are.
- 92319de: Password fields in the in-page panel are now typed into an extension-owned frame.
- 29d48c7: Closing the panel now removes the exact host element the extension mounted, so the panel reliably disappears even when the page contains another element with the same id.
- f94bc94: The request-header adjustment Image Trail uses for pCloud now applies only to Image Trail's own background requests, not to pages you have open. The saved pCloud connection is also shielded from page-side scripts as soon as the extension starts, and a leftover header rule from an earlier session can no longer make a later pCloud request fail.
- 590a309: pCloud backup uploads work again. The upload sent its sign-in token after the file, where pCloud ignores it, so every upload failed with "Log in required".
- 3929b90: A page on the public internet can no longer make Image Trail request an image from a device on your own network (for example a router, NAS, or camera address), even if you granted that address earlier. Pages that are themselves on your network work as before.
- d5244b3: Private pins now stay private. Pinning an image that is already a private pin while encryption is locked no longer creates a second, unencrypted copy. Backups now record which pins were private, and restoring them saves them encrypted or, if encryption is locked, leaves them out and tells you to unlock and restore again.
- b6850c5: Rebrand and relicense Image Trail as Image Trail by True Line AI LLC: the LICENSE file now carries the MIT License text with Copyright (c) 2026 True Line AI LLC, package.json and package-lock.json declare MIT with author True Line AI LLC, the extension manifest is named "Image Trail by True Line AI LLC", and the README and third-party attribution header were updated to match.
- 4815454: Page keyboard shortcuts, including Next and Previous, now respond only to real key presses. Key events generated by a page script are ignored.

## 0.27.4

### Patch Changes

- f8246e9: Prefer a pairing-scoped local Overlook connection while keeping cloud fallback explicit and active transfer routes stable.
- bafd9dd: Add a hardened, fixed-ID experimental package for released-product interoperability acceptance while keeping baseline releases unchanged.

## 0.27.3

### Patch Changes

- c47108c: Wire encrypted Move and Sync journals into resumable live local Overlook sessions.

## 0.27.2

### Patch Changes

- 14ef4f2: Add the authenticated experimental live local transport seam for Overlook.

## 0.27.1

### Patch Changes

- 3e6ffbf: fix(ui): pin Host target, URL editor, Controls and Field Editor detach controls and remove redundant Queue Recall button
- 3e6ffbf: fix(ui): Host target visible and collapsible — scope collapsed opacity to details and allow gallery collapse

## 0.27.0

### Minor Changes

- 89d8ab0: Add an opt-in Auto-pin overflow policy that promotes older Recents through the normal durable pin path while retaining failed promotions in session state.
- aa8787a: Add opt-in, local-only reminders for manual encrypted backup workflows.
- 4b9f4a9: Add conservative, exact-host rules for explicit Grab clicks to capture encrypted originals after pinning.
- 99e28b2: Add an explicit session-only review mode for retained Recents without changing retention settings or creating durable pins.
- dafae3f: Add a privacy-safe, read-only URL review history in Settings with site and status filters plus first, last, and elapsed review timing.
- a57c4dd: Unify Capture and Pin in one primary control that switches to Pin while Shift is held.
- 0ae2264: Add bounded MP4, MOV, WebM, Matroska, AVI, MPEG program-stream, and MP2 capture with exact encrypted custody, portable media facts, honest native or preserved-only previews, and deterministic acceptance fixtures.

### Patch Changes

- 3c59964: Enable Apply to Host when the edited image URL differs from the URL currently projected into the selected host image.
- d7748db: Keep provider action pending through transient recovery probes and preserve request ordering so duplicate OAuth windows cannot open and stale status does not overwrite newer selection.
- d5f3319: Keep the Host target action and image-fit flyout at a usable viewport-bounded width instead of collapsing it to the trigger width.
- 41dc79c: Hide the page-context override switcher in production builds behind an explicit build-time feature flag while keeping automatic context detection active.
- 9017e91: Open the Transfer & Sync workflow inside the production panel's closed Shadow DOM instead of appending an invisible unstyled modal to the host page body.
- e971c28: Carry overflowing split-field edits across the fixed-width source number and preserve the split when resetting parsed values.
- e430c98: Keep encrypted image imports inside protected background storage and confirm their durable queue record before reporting success.
- 4397c23: Record the published Chrome Web Store beta extension identity and require it for the signed Overlook iCloud interoperability host instead of trusting whatever identity the running build reports.
- c97db4c: Move Recents and Queue sort controls out of title bars and into their related context and action rows.
- f80d1c3: Give every dashboard section the same explicit Hide/Show header control while preserving independent header actions and expanded detached windows.

## 0.26.6

### Patch Changes

- 389df43: Move the ExtensionRequest and ExtensionResponse unions into their own module so adding a message type no longer grows the message barrel file.

## 0.26.5

### Patch Changes

- 368241b: Re-enable regular pCloud backups through a release-injected OAuth client ID and store backups under the shared Playbook Engineering application root.

## 0.26.4

### Patch Changes

- 186e35b: Show a padlock glyph for the unlocked title-bar Lock workspace control instead of clipped Lock text.

## 0.26.3

### Patch Changes

- e230367: Require trusted user activation before privileged capture and destructive panel actions.

## 0.26.2

### Patch Changes

- d424e68: Redact learned URL metadata while preserving private exact-page template and grab-pattern matching.
- 6dc165c: Prevent protected-pin conversion from exposing stale plaintext metadata or deleting a captured original.
- 5f302f0: Hash existing bookmark URL indexes when the searchable metadata policy is saved as encrypted.

## 0.26.1

### Patch Changes

- 093bef6: Keep production panel Shadow DOM closed even when test environment variables leak into packaging, while preserving an explicit disposable release-mode E2E build.
- Keep experimental pairing credentials in an extension-owned page and refresh Transfer & Sync after returning to the workflow.

## 0.26.0

### Minor Changes

- 8b09171: Add bounded MPEG-TS capture, encrypted original custody, honest playable and preserved-only previews, exact export and backup metadata, and gated Photos interoperability.

### Patch Changes

- a43d2e4: Keep MPEG-TS preview labels and exported filenames aligned with verified playback and media classification.

## 0.25.0

### Minor Changes

- 6061085: Preserve original GIF and WebP animation metadata through capture, encrypted backup, interoperability, downloads, and accessible reduced-motion previews.

### Patch Changes

- 982f387: Back up pCloud data as independently verified encrypted parts with a manifest published last, bounded original transfer, cancelable progress, safe partial cleanup, and backward-compatible restore.
- da8d1bb: Reuse one durable-library snapshot across Gallery search, filter, facet, and paging interactions.
- 9596956: Reuse one decrypted interoperability-pin snapshot across each experimental transfer translation session.
- 891bbbf: Revoke discarded buffered-navigation image URLs while retaining the selected display blob until replacement or disposal.
- 107f86f: Keep panel dragging and active viewport resizing free of repeated panel and Recall rebuilds.
- d5a36e4: Avoid repeated full-library bookmark decrypts during ordinary URL lookup, Queue paging, and storage-health refreshes while retaining a one-time scan for legacy interoperability custody.
- 4524c42: Show compact, privacy-safe warmed, warming, failed, skipped, and unknown counts for parsed-field neighbors.
- f14a6b0: Keep storage-health and unused-original cleanup scans lightweight by reading only blob IDs, creation times, and encrypted byte-length indexes instead of materializing encrypted image bytes.
- e987300: Reduce host-page layout work during context detection, target recovery, and Grab Mode previews.
- c6b98d6: Split background message contracts and creators into focused domain modules behind the existing compatibility barrel.
- e2ec8aa: Keep digit widths, field status, and saved template choices attached to the intended parsed URL token when an earlier token is split or recombined.
- e91cf68: Keep the Queue on the newest requested page when IndexedDB responses resolve out of order, without discarding the latest response after a same-scope page URL update.
- 0883c0f: Keep Recall selection updates scoped to the Recall destination so the panel and list scroll remain stable.
- e5f1366: Bound neighbor-preload caching to 1–500 page-session entries and migrate the former unlimited setting to the safe default.

## 0.24.10

### Patch Changes

- 6726139: Prevent linked-page image discovery from sending credentials across origins or fetching pages without explicit host permission.
- 818e1ea: Serve injected panel styles through per-session extension resource URLs to reduce installation fingerprinting.
- 8a9c847: Encrypt parsed-field resume and URL review metadata at rest when URL-derived searchable metadata is set to encrypted.
- ddb26bb: Retry IndexedDB after blocked or failed opens instead of leaving extension storage unavailable for the service worker lifetime.
- abdb201: Require trusted search-page origins and HTTP(S) URLs before saving image-wrapper source links.

## 0.24.9

### Patch Changes

- 6d877cc: Keep detached Host target controls focused after preview-fit rerenders.
- c6d04ea: Hide unfinished Transfer and Sync behind an explicit experimental build flag and remove native messaging from baseline releases.

## 0.24.8

### Patch Changes

- 0b83a69: Harden the page-injected panel so encrypted-original passwords and decrypted bytes are not exposed to host pages.

## 0.24.7

### Patch Changes

- 6e2a4dc: Align verified original identity hashes and sealed transport validation with the shared interop contract.

## 0.24.6

### Patch Changes

- d19624c: Fix buffered parsed-field navigation by serializing image bytes safely across extension runtime messages.
- 3f849f5: Reject malformed SHA-256 fingerprints at the buffered-image runtime message boundary.

## 0.24.5

### Patch Changes

- 9632d9e: Restore thumbnails, readable filenames, and accurate image-type labels for captured Queue and Recent records.

## 0.24.4

### Patch Changes

- 9774786: Protect newly captured originals from orphan cleanup with a one-hour grace period and keep the displayed orphan count aligned with cleanup.

## 0.24.3

### Patch Changes

- eb6af00: Keep Recents available when the browser suspends and restarts the extension service worker.

## 0.24.2

### Patch Changes

- 8fbb04a: Preserve captured originals when an existing plain or protected pin is re-saved without new original metadata.

## 0.24.1

### Patch Changes

- 9acb894: Keep inbound Sync conflicts count-only until conflict resolution is available.

## 0.24.0

### Minor Changes

- fd73fe4: Discover pairing-key-encrypted Overlook Sync replies and surface review-only conflicts without exposing record metadata at rest.
- 0d959d0: Publish selected Sync snapshots through a durable pairing-key-encrypted provider outbox.

## 0.23.0

### Minor Changes

- 3001da8: Transfer captured originals as pairing-key-encrypted files and require verified destination custody before completing a Move.

## 0.22.0

### Minor Changes

- d928490: Discover sealed Move acknowledgements from connected interoperability providers and finalize eligible source bookmarks only after verified destination custody.

## 0.21.0

### Minor Changes

- f7fe872: Connect Move publication to separately authorized pCloud interoperability storage and enable Google Drive when the extension has a drive.file OAuth client.

## 0.20.0

### Minor Changes

- 7caf6dd: Queue reviewed Move selections with stable canonical identities and a restart-safe pairing-key-encrypted provider outbox without changing bookmark queue order.

## 0.19.0

### Minor Changes

- a33f243: Replace the Transfer & Sync placeholder with a schema-validated background runtime, durable isolated provider choice, and live provider and Overlook pairing controls.

## 0.18.2

### Patch Changes

- 8adb43e: Add the reviewed Chrome Web Store screenshot and promotional tile for the release submission package.

## 0.18.1

### Patch Changes

- ff81768: Keep Settings in place after choosing or cancelling a key-backup file.

## 0.18.0

### Minor Changes

- 6f72ee5: Add truthful Overlook Transfer and Sync entry points plus review, conflict, progress, recovery, provider, pairing, and locked-workspace states.

### Patch Changes

- 067b064: Gate cross-product interoperability evidence and manual release closeout against the exact pinned Photos contract.

## 0.17.0

### Minor Changes

- ef2ce9c: Add isolated, resumable pCloud, Google Drive, and signed native iCloud interoperability transports.

## 0.16.0

### Minor Changes

- 50a780d: Add durable, deterministic sync journals with explicit conflict and delete review.

## 0.15.0

### Minor Changes

- f470df2: Add durable acknowledged Move journals with replay-safe counts and verified source deletion guards.

## 0.14.1

### Patch Changes

- 1388a80: Keep imported interop pins discoverable by their source URL and preserve protected Image Trail relationships during round trips.

## 0.14.0

### Minor Changes

- b39c226: Persist canonical Overlook records and album metadata in encrypted durable pins with deterministic interop previews and exact round-trip export.

## 0.13.0

### Minor Changes

- ebccfa0: Adopt the canonical Overlook interoperability contract and secure pairing key custody.

## 0.12.4

### Patch Changes

- e64a217: Replace every protected workspace and preview with one opaque unlock surface whenever encrypted storage is locked.

## 0.12.3

### Patch Changes

- 9627f35: Keep encrypted originals unlocked for the configured inactivity period across Manifest V3 worker restarts, with 5, 10, 15 minute and Never policies plus immediate manual lock.

## 0.12.2

### Patch Changes

- 6f0eca3: Let detached Recents and Queue windows grow with new rows until users choose a persistent custom size.

## 0.12.1

### Patch Changes

- e179cf2: Report thumbnail storage as always encrypted and migrate legacy settings that incorrectly labeled it plaintext.

## 0.12.0

### Minor Changes

- 0bd10f6: Add transient Recents scopes for the current page, current site, and all sites.

## 0.11.0

### Minor Changes

- 2884396: Add metadata-only source, record-kind, and image-type filters to Gallery.

## 0.10.2

### Patch Changes

- fb9c473: Minify and audit production release artifacts before packaging.

## 0.10.1

### Patch Changes

- ca53801: Harden workspace overlays across complex host layouts, interrupted gestures, private restart restoration, touch targets, zoom, reduced motion, and exact teardown.

## 0.10.0

### Minor Changes

- c6c6978: Add React-rendered floating workspace windows and four edge rails with shade, snap, ordered stacks, keyboard previews, and private per-page layout restoration.

## 0.9.0

### Minor Changes

- 9027223: Align bare-key navigation, capture, pinning, Help, and Settings with the updated workspace handoff; add a persisted Down-arrow assignment and privacy-safe capture/download feedback.

## 0.8.0

### Minor Changes

- 9781b17: Add self-contained React Dashboard, Gallery, Recall, and Settings extension pages with durable shared state and source-tab return handling.

## 0.7.0

### Minor Changes

- b356e31: Add accessible Dashboard, Gallery, Recall, and Settings dock routes with compact in-panel views, focus and scroll restoration, and a real Gallery-tab action.

## 0.6.0

### Minor Changes

- e364853: Detect single-image, gallery, and feed page contexts, expose a capability-aware React context switcher, and persist explicit per-host overrides in extension-owned settings.

## 0.5.0

### Minor Changes

- bb93d32: Align the injected panel, Settings, Help, capture feedback, and detached-window presentation with the approved design-system handoff, and add versioned visual-acceptance coverage for every supplied screenshot.

## 0.4.0

### Minor Changes

- f3c22ba: Adopt a locally bundled React UI boundary for the panel header, destination dock, and Host target while preserving the existing extension state, action, controller, detach, focus, and storage architecture.

## 0.3.1

### Patch Changes

- 23b4b2b: Add branded extension and toolbar icons for Chrome and the Chrome Web Store.

## 0.3.0

### Minor Changes

- 88c0533: Complete the design-system migration by aligning Gallery header, search, paging, albums, status, cards, locked and empty states on canonical tokens and shared primitives with focused accessibility and packaged-extension acceptance coverage.
- 6a29c88: Migrate the panel shell, status surfaces, Host target, URL editor, detached chrome, and primary navigation, capture, slideshow, and Grab Mode workflow to the shared design system.
- 70bd2fd: Migrate the Field Editor to the shared design-system FieldRow, active-field hierarchy, responsive states, and critique-ready Storybook coverage while preserving existing editing and navigation behavior.
- c183676: Unify Queue, Recents, Recall, and Gallery records on the shared design-system RecordRow with consistent selection, stored-original, encrypted, unavailable-key, privacy, and thumbnail states.
- 1088f9a: Migrate Settings, encrypted and cloud integrations, maintenance controls, shortcuts, and Help to the shared design system while preserving existing behavior and native control state.

### Patch Changes

- 6b5c96d: Add accessible plain-DOM design-system primitives with shared interaction states and Storybook coverage.

## 0.2.6

### Patch Changes

- 77e03b9: Add the shared production design-token foundation used by the injected panel and Gallery.

## 0.2.5

### Patch Changes

- ab59acc: Treat thumbnail and malformed blob rows as missing during original repair verification without reading encrypted payloads.

## 0.2.4

### Patch Changes

- a2fae10: Verify repairable encrypted originals without loading their ciphertext into memory.

## 0.2.3

### Patch Changes

- 9711f90: Add reviewable saved URL stepping presets for numbered filenames, gallery paths, and query parameters.

## 0.2.2

### Patch Changes

- b93864e: Add a queue repair flow that re-captures missing encrypted originals for selected durable pins without changing queue order.

## 0.2.1

### Patch Changes

- 93209dc: Clear stale pCloud backup details from Settings when persisted backup history is empty.

## 0.2.0

### Minor Changes

- 4b0dc5d: Add persisted display-only ordering controls for Recents and Queue.

### Patch Changes

- f8ccb97: Expose the build-info overlay toggle in Chromium extension keyboard shortcut settings.
- 627f761: Restore centered Recent metadata for Adaptive layouts with three or more visible rows and full-width, edge-feathered backgrounds for two-row layouts.
- 730864b: Add a recoverable permission grant and capture retry action.
- d5e4740: Harden CI/CD and repo automation (#278): cancel superseded PR CI runs, run CI on pushes to main, grouped weekly Dependabot updates, a husky + lint-staged pre-commit hook, and a changesets release flow whose `changeset:version` script keeps `extension/manifest.json` in step with `package.json`.
- fb629e7: Detachable sections are complete: the Queue section can now detach like Recent history and Settings, and the detach control supports drag-out — press and drag it to place the floating window exactly where you drop it (a plain click still detaches at the default spot).
- adf190f: Every panel section is now detachable — URL editor, Host target, Parsed fields, Manual controls, Recent history, Queue, and Settings — and you can grab a section by its header (or any empty surface) and drag it straight out of the panel to place its floating window; Escape cancels an in-progress drag, including window moves.
- 641d7d5: Add the detachable-section pattern and pilot it on Recent history: a keyboard-accessible detach control moves the section into a floating extension-owned window (drag its title to move, Escape or Restore returns it), leaving a stable placeholder in the panel.
- a634932: Detached section windows now have standard window chrome: a minimize button collapses the window to its title bar (session-only), and a close (X) button restores the section back into the panel, replacing the text Restore button.
- 3fb5c88: Centralize Field Editor display state and clarify Previous/Next field selection labels.
- 77e3aaf: Show parsed-field split lengths and add decimal/hex display toggles for numeric fields.
- 6af159c: Load a focused Recent history row when Enter is pressed.
- 45ab58e: Replace install-time all-sites access with active-tab injection and optional per-origin grants, including a narrow pCloud permission prompt.
- 6ae69f3: Add a Max kept recents setting so visible Recents can stay capped while hidden session-only overflow is separately bounded.
- a097397: Define empty and delimiter-changing parsed-field commits so raw delimiters reparse the projected field structure, reject split-invalidating edits, and add a structure reset.
- b2d516e: Recover the selected host image without a visible reset when redraw-heavy pages replace its DOM node.
- 89de32c: Refresh Gallery automatically when durable pins, captures, bookmarks, or album memberships change in another extension context, and add a lint-time guard against oversized new source files.
- 727913c: Rename the Parsed fields section to Field Editor.
- 303e619: Update row click and keyboard behavior so Recent, Queue, and Recall rows select first and project selected rows.
- 05c408c: Settings can now detach from the panel into its own floating window: a detach control beside the Settings heading moves the whole surface (all groups, encryption, import/export, cloud backup) into a wider window with the standard minimize/close chrome, while the header gear keeps toggling Settings open and closed wherever it lives. Escape pressed inside a text field no longer restores a detached window mid-edit.
- 36ef0aa: Remember verified pCloud backup details across sessions without storing provider secrets.
