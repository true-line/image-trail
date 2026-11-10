# Image Trail Design Brief

This is the repo-local design brief for AI design editors and human UI
reviewers. Use it to propose Image Trail UI/UX directions without changing the
product model, storage behavior, security posture, or feature scope.

Image Trail is pre-release, source-only Brave/Chromium extension software. Do
not describe it as published, store-ready, cloud-first, or product-ready.

## Design Goal

Image Trail turns image URL structure into navigable trails and local galleries.
The UI should feel like a compact image-workbench overlay: precise, inspectable,
privacy-conscious, and stable during repeated navigation.

Primary audience:

- People reviewing image sequences from hosted sites or self-hosted photo
  servers.
- Developers and power users running a source-only extension during pre-release
  development.
- Reviewers using Storybook and acceptance tests to critique states before full
  browser flows hide UI issues.

Design proposals may improve hierarchy, density, accessibility, labels,
interaction feedback, and visual polish. They must not invent new product
capabilities or change persistence/encryption semantics.

## Product Model To Preserve

- The host-page target image is the active image. URL edits, previews, and
  navigation apply to that selected target only.
- Parsed URL fields are controls for image trails. Numeric, hex, split, path,
  filename, query, and text fields must remain understandable and editable.
- Recents are transient session state. They are not durable memory.
- Pins are durable queue records and persist when they enter the queue.
- Bookmarks are pins with associated captured original bytes.
- Captured original bytes live separately in the encrypted blob/original store and
  are linked from durable pin/bookmark records.
- Signature-validated video and audio originals follow the same encrypted custody
  boundary. Deterministic posters and bounded metadata are derivatives, never a
  replacement for or copy of the original bytes.
- Recall pages durable pins/bookmarks from the queue producer after the visible
  queue window. Recall is not a browser over encrypted blobs and must not add
  records to Recents.
- Queue ordering is based on `queueUpdatedAt`. Metadata refreshes and thumbnail
  updates must not visually imply a reorder unless the user intentionally moves
  a pin.
- Extension-owned settings and storage use extension-owned stores, not host-page
  `localStorage`.

## Primary Workflows

- Select a target image automatically on simple pages or manually with target
  picking on multi-image pages.
- Project image URL changes back into the selected target while preserving page
  cleanup and target ownership.
- Edit URL fields, preview changes, and use previous/next navigation over
  included fields.
- Review Recents for active-session image activity.
- Pin durable records into the visible queue from the primary Capture control by
  holding Shift, or with the P shortcut. Queue actions must not duplicate that
  current-image action or confuse clear/presentation actions with destructive
  delete actions.
- Capture originals explicitly from the primary control or C shortcut, show
  capture status, and keep stored-original state distinct from selection.
- Import supported common video and audio explicitly, preserve exact encrypted
  originals, never autoplay list surfaces, and distinguish native playback from
  honest preserved-only fallback without persisting device playability as fact.
- Keep Grab metadata-only by default. An inspectable exact-host rule may make an
  explicit Grab click pin first and then capture the encrypted original; it must
  not auto-capture visible images or change the Shift-modified Capture control.
- Open Recall to page durable offscreen queue records back into the current
  workflow.
- Unlock, import, export, back up, and restore encrypted local data through
  explicit user actions.
- Use pCloud backup as a provider-backed encrypted backup flow; do not imply
  server sync or cloud-native storage.

## UI Surfaces

Current inspectable surfaces live in Storybook under `Extension UI/*`:

- Panel layout: `extension/src/ui/render.stories.ts`
- Host target: `extension/src/ui/components/target-picker-view.stories.ts`
- URL editor: `extension/src/ui/components/url-editor-view.stories.ts`
- Field Editor: `extension/src/ui/components/fields-view.stories.ts`
- Status and async cues: `extension/src/ui/components/status-view.stories.ts`
- Recent history: `extension/src/ui/components/history-view.stories.ts`
- Queue: `extension/src/ui/components/bookmarks-view.stories.ts`
- Recall drawer: `extension/src/ui/components/recall-drawer-view.stories.ts`
- Encrypted originals: `extension/src/ui/components/encryption-view.stories.ts`
- Import, export, and cloud backup:
  `extension/src/ui/components/import-export-view.stories.ts`
- Settings action groups:
  `extension/src/ui/components/action-group.stories.ts`

Design review should start from Storybook and the canonical acceptance pages:

- [Storybook UI Review](docs/acceptance-tests/storybook-ui-review.md)
- [Row And List Visual System](docs/acceptance-tests/row-list-visual-system.md)
- [Panel Layout Stability](docs/acceptance-tests/panel-layout-stability.md)
- [Queue And Recall Clear/Delete Semantics](docs/acceptance-tests/queue-recall-clear-delete.md)
- [pCloud Provider Boundary](docs/acceptance-tests/pcloud-provider-boundary.md)
- [Common Video And Audio Media](docs/acceptance-tests/common-video-and-audio-media.md)

## Stable Visual Primitives

- Selected target/row state must remain visually stronger than
  stored-original/captured state.
- Stored-original/captured state should be an indicator, not a competing
  selected-row background.
- Recents, queue rows, and Recall rows should read as the same row family.
- Thumbnail and extension-label treatments are stable primitives across queue
  and Recall rows.
- Locked/private rows must avoid exposing sensitive URL, title, thumbnail, or
  metadata while still showing clear safe actions.
- Status, loading, retry, permission, and error states must be visible without
  leaking sensitive URLs when privacy masking is active.
- Compact and narrow layouts must keep controls reachable, labels legible, and
  hit targets stable.
- The panel is an overlay workbench; redesigns should not make it feel like a
  marketing page, media gallery replacement, or standalone cloud app.

## Privacy, Storage, And Security Constraints

- Do not show plaintext protected metadata while encrypted storage is locked.
- Do not suggest host-page storage for extension-owned state.
- Do not broaden permissions for visual convenience.
- Incognito windows run a separate extension instance (`"incognito": "split"`):
  Recents, image caches, the unlocked key, and stored records are never shared
  between incognito and regular windows, and incognito data is discarded when
  the incognito session ends.
- Do not imply automatic capture of every visible image. Capture is explicit.
- Do not imply pCloud receives plaintext Image Trail data; backups are
  password-encrypted before upload.
- Do not collapse key backup, encrypted import/export, original capture, and
  pCloud provider states into one generic "sync" concept.
- Do not add design language that suggests vector search, hosted LLM defaults,
  mobile ingestion, or photo-library replacement unless a future issue promotes
  those capabilities.

## Accessibility Ground Rules (WCAG 2.2 AA)

These rules are constraints on the design itself, applied while designing —
not an audit run afterward. They are app-generic: the same rules apply to
every product in this family. If a proposal deliberately breaks one, say so
in the proposal with the reason; silence is treated as an oversight.

Interaction design:

- Every action a pointer can do, a keyboard can do. When a design includes a
  pointer gesture (drag, wheel, hover, long-press), specify the keyboard and
  single-click equivalent in the same proposal, not as a follow-up. Watch
  paired interactions: if zoom gets keys, pan gets keys.
- Nothing important lives only in a hover state. Hover-revealed controls also
  reveal on keyboard focus.
- No unmodified single-character shortcuts unless remappable and disableable.
- Timed UI must be pausable, extendable, or persistent: no toast whose action
  disappears with it, no chrome that auto-hides with no keyboard wake, no
  countdown a slow user cannot finish.
- Interactive targets are 24×24 px minimum; 44×44 preferred for primary
  actions.
- Never nest interactive elements (a clickable row containing buttons —
  restructure so each control is its own element).

Structure and semantics:

- Design in native elements first: button, a, label+input, dl,
  fieldset/legend, h1–h6, nav/main/aside. A div with a role is a last resort
  with a written reason.
- Every screen has a heading outline and landmarks; every control's visible
  label is its accessible name (no placeholder-as-label, no icon-only control
  without a name).
- Modals and drawers: focus moves in on open, is trapped while open, and is
  restored on close; the background is inert to assistive technology. Where
  focus goes on close is part of the spec.
- Async operations (saving, capturing, importing, backup) get a designed
  announcement: what the live region says, and when.
- Composite widgets (menus, tab bars, radio groups, grids) follow the ARIA
  APG pattern: one Tab stop, arrow keys inside, stated in the spec.

Visual design:

- All text and meaningful icons meet 4.5:1 contrast (3:1 for large text)
  against every background they sit on — including muted, faint, and danger
  tones, which are the usual failures. Text over images gets a scrim.
- State is never color-alone: pair it with an icon, weight, or text.
- Design the reduced-motion variant of every animation at the same time as
  the animation. Layouts survive 200% text scaling without loss.
- Nothing critical sits where floating UI (toasts, pills, banners) can fully
  cover a focused element.

Content and media:

- If a design includes audio or video, captions and transcripts are part of
  the design, not an enhancement.
- Never ask the user to re-enter information the app already has (password
  confirmation for security is the one exception).
- If a help affordance exists, it appears in the same place on every screen.

Deliverable expectations: for each component or screen proposal, include
keyboard behavior, focus behavior, accessible names, announcement text for
state changes, and the reduced-motion variant.

## Design Tool Instructions

When prompting an external design editor, include this file and current
Storybook screenshots or captures when available. Ask for UI/UX exploration
within the existing feature set.

Good directions:

- Improve hierarchy and grouping inside the compact panel.
- Clarify selected, pinned, captured, locked, loading, error, and disabled
  states.
- Reduce visual noise while preserving information density.
- Improve accessibility cues, labels, focus states, and keyboard-visible
  controls.
- Propose consistent row/list treatments for Recents, queue, and Recall.
- Make import/export, encryption, and pCloud backup states easier to scan
  without changing what those flows do.

Avoid these directions:

- Do not add new released-product claims or extension-store readiness.
- Do not redesign Image Trail into a cloud gallery, social product, generic
  download manager, or photo-library replacement.
- Do not blur Recents, queue pins, bookmarks, captured originals, and Recall
  into one undifferentiated saved-items model.
- Do not make captured/stored-original state look like the primary selected
  state.
- Do not remove privacy masking, locked placeholders, explicit permission
  prompts, or encrypted backup wording.
- Do not move parser, storage, crypto, content-script, background, or pCloud
  behavior into UI-only concepts.

## Review Checklist

Review each design proposal against this checklist:

- Current feature scope is preserved.
- Storybook surfaces are used as the current-state reference.
- Selected state remains distinct from captured/stored-original state.
- Recents remain transient; pins/bookmarks remain durable queue records.
- Recall remains an offscreen durable queue browser, not encrypted-blob search.
- Encryption, lock, key backup, import/export, and pCloud backup flows remain
  explicit and privacy-preserving.
- Pre-release, source-only status is not overstated.
- No screenshots or assets are added unless they are current and verified.
- Accessibility Ground Rules are met, and any deliberate exception is stated
  in the proposal with its reason.
- Every pointer/hover/drag interaction in the proposal names its keyboard
  equivalent, and every timed or auto-hiding element names its persistent or
  keyboard-wakeable path.
