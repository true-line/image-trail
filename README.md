# Image Trail by True Line AI LLC

[![CI](https://github.com/true-line/image-trail/actions/workflows/ci.yml/badge.svg)](https://github.com/true-line/image-trail/actions/workflows/ci.yml)
![status: pre-release](https://img.shields.io/badge/status-pre--release-orange)
![install: source only](https://img.shields.io/badge/install-source%20only-blue)
![node: 24.18.0](https://img.shields.io/badge/node-24.18.0-339933)
![platform: Chromium MV3](https://img.shields.io/badge/platform-Chromium%20MV3-4285F4)
![encrypted originals](https://img.shields.io/badge/originals-encrypted-6f42c1)
![pCloud backup](https://img.shields.io/badge/backup-pCloud-17a2b8)

Image Trail by True Line AI LLC is a Brave/Chromium extension for turning image URL structure into
navigable trails and local galleries. It lets the URL patterns already present
on a site drive image progression, so you can recover images from hosted
services or run your own web photo server without hardcoding one-off gallery
rules for every URL shape.

It is built around a small in-page panel with target image selection, parsed URL
controls, transient Recents, durable pins/bookmarks, encrypted original capture,
Recall, encrypted backups, pCloud integration, and import/export workflows.

> **Status:** Image Trail is pre-release software. It is not product-ready, not
> published to an extension store, and should be installed from source only for
> development and review.

## What It Does

- Select a host-page image and project related image URLs back into that target.
- Parse URL structure into editable fields so numeric and patterned image
  trails can drive next/previous navigation.
- Learn source-specific URL patterns instead of requiring hardcoded gallery
  rules for each site or photo server.
- Keep Recents as transient session history while saving pins/bookmarks as
  durable queue records.
- Capture original image bytes into encrypted local storage linked from durable
  bookmark records, with key backup/restore flows for recovery.
- Use Recall to page durable pins/bookmarks back into the visible queue.
- Import, export, back up, and restore local Image Trail data, including
  encrypted backup files and pCloud-backed restore workflows.
- In explicit experimental builds, move or sync reviewed records through a
  same-computer Overlook connection or an explicitly chosen cloud provider.
- Govern automation with bounded request, retry, slideshow, shortcut, and
  neighbor-preload controls.

## Experimental Transfer & Sync

Baseline and release builds keep Transfer & Sync disabled and omit the
`nativeMessaging` permission. An explicit experimental build can connect to a
compatible signed Overlook app on the same computer after its matching pairing
is imported. Native Messaging is used only to obtain short-lived loopback
authority; visited pages do not receive pairing material or connection details.

Cloud providers are separate, explicit cross-machine routes. Image Trail does
not automatically fall back from local Overlook to a cloud provider, and an
active reviewed Move or Sync journal remains bound to its selected route until
it completes or is cancelled.

## Local Development

Use the Node version pinned in `.nvmrc`.

```sh
nvm use
npm ci
npm run build
```

The compiled extension is written to `extension/dist/`. Load that directory as
an unpacked extension in Brave or another Chromium browser:

1. Open the browser extension management page.
2. Enable developer mode.
3. Choose **Load unpacked**.
4. Select this repository's `extension/dist/` directory.

The extension manifest currently identifies the extension as Image Trail by True Line AI LLC and
ships the built MV3 service worker/content-script bundle from `extension/dist/`.

## Documentation

Canonical documentation lives in source-controlled markdown under `docs/`:

- [Contributing](docs/contributing.md)
- [Testing Strategy](docs/testing-strategy.md)
- [Versioning and Releases](docs/versioning-and-releases.md)
- [Privacy and Permissions Review](docs/privacy-and-permissions-review.md)
- [Design brief](DESIGN.md)
- [Acceptance Tests](docs/acceptance-tests/README.md)
- [User Stories](docs/user-stories/README.md)
- [Architecture Decision Records](docs/adr/README.md)
- [Versioning automation planning](https://github.com/true-line/image-trail/issues/387)

## Validation

```sh
npm run lint
npm run format:check
npm test
npm run build
```

Before marking a pull request ready, run the CI-equivalent gate locally:

```sh
npm run ci
```

`npm run ci` runs lint, format check, coverage-gated tests, and build. The
coverage gate uses `.c8rc.json`; CI uploads `coverage/lcov.info` when it runs.
Draft pull requests start no GitHub Actions jobs. After pushing the final branch
SHA, an agent may manually dispatch the complete `CI` workflow for exact-SHA
preflight evidence; ready pull requests reuse that result only when it matches
their current head. Merge-queue candidates always run the complete suite against
the synthetic commit containing current `main`.

## Licensing

Image Trail by True Line AI LLC is released under the [MIT License](LICENSE)
(Copyright (c) 2026 True Line AI LLC).

The extension bundles third-party open-source packages (react, react-dom, and
their runtime dependencies), each under its own permissive license. Their
notices ship inside the packaged extension as `THIRD-PARTY-LICENSES.txt`.
`npm run ci` runs `npm run check:licenses`, which fails the build if any shipped
dependency carries a non-permissive or unknown license and verifies the
attribution file is current. Regenerate it with `npm run licenses:write` after
changing production dependencies.

## README Freshness Contract

`README.md` is the stable public front door for the project. Keep it current
when product-facing capabilities, install/build instructions, validation
commands, or release/versioning expectations change.

Detailed SOPs, ADRs, acceptance criteria, test strategy, implementation notes,
and planning details are versioned with the code under `docs/`. If a PR changes
behavior that affects this README but intentionally does not update it, the PR
should state why.
