# Versioning and Releases

Image Trail uses Changesets to accumulate release intent on `main`. Product PRs
do not bump the installed extension version directly. A dedicated workflow
creates or updates one ready version PR that consumes accumulated changesets,
updates the changelog, and synchronizes every committed version artifact.

Merging a version PR is the release-cut action. The version-cut workflow detects
that synchronized version advance and creates the matching tag as
`chores-dumb[bot]`. The tag push starts the Release workflow, which validates the
tagged source, builds a Chrome Web Store-compatible ZIP, and publishes the ZIP
plus its SHA-256 checksum on a GitHub Release as the same bot. Chrome Web Store
upload and publication follow the release-readiness checks without a separate
approval gate. They remain manual operations until dedicated automation has
store credentials.

## Version policy

- `package.json` is the Changesets version source.
- `extension/manifest.json` must carry the exact same version.
- The top-level and root-package `package-lock.json` version fields must carry
  the exact same version.
- Release versions are stable three-component semantic versions such as
  `0.2.0`. Prerelease or build suffixes are not copied into the manifest.
- Chrome's manifest version remains numeric: one to four dot-separated integers,
  each from `0` through `65535`, with no leading zeroes and not all zero.
- Ordinary merges do not bump the package or manifest. They retain the current
  release version and receive fresh development identity at build time.
- Development metadata belongs in `extension/dist/build-info.json`, not in the
  manifest version or `version_name`.

## When a changeset is required

A PR that changes shipping files under `extension/` needs a changeset. The gate
excludes generated `extension/dist/`, tests, component stories, and the
Storybook-only `extension/src/ui/stories/` harness.

Use:

```sh
npm run changeset
```

Choose the semantic bump that matches the release impact:

- `patch` for fixes and compatible user-visible adjustments;
- `minor` for compatible features;
- `major` for intentionally incompatible behavior or data contracts.

The version-policy gate parses each changed changeset. Its frontmatter must
name `image-trail` with a `patch`, `minor`, or `major` bump. Empty or malformed
changesets, `none` bumps, unknown packages, and changesets that omit
`image-trail` fail validation.

The summary becomes a `CHANGELOG.md` entry, so describe the user or operator
impact rather than implementation mechanics.

Tests, documentation, repository automation, and tooling-only changes do not
need a changeset. A refactor under `extension/` that genuinely has no release
impact must use the explicit `no-version-impact` exemption:

- add `no-version-impact` to the PR body or apply that label for CI;
- before a PR exists, include `no-version-impact` in a branch commit message, or
  run the local gate with `VERSION_POLICY_ACK=no-version-impact`.

The exemption is a reviewed assertion, not a substitute for a changeset when
users, permissions, storage behavior, or shipped output change.

## Automated checks

`npm run check:version-policy` enforces both halves of the policy:

1. `package.json`, `extension/manifest.json`, and both root
   `package-lock.json` version fields are synchronized and valid.
2. Release-impacting extension diffs have a valid changeset or an explicit
   exemption. A version PR may consume changesets only when the package version
   advances from its base.

The command runs in `npm run ci` and the required `CI` workflow. Builds also
check that `extension/dist/build-info.json` matches the manifest version and
contains a valid local or release mode.

Use these focused commands when diagnosing the gate:

```sh
npm run check:version
npm run check:changeset
npm run build
npm run build:release
npm run package:release
```

`npm run build` writes `mode: "local"` with commit, branch when available, and
the local worktree label. `npm run build:release` writes `mode: "release"` and
sets the worktree field to `null`; commit and branch still identify the source.

`npm run package:release` runs the release build and writes:

- `release/image-trail-vX.Y.Z.zip`
- `release/image-trail-vX.Y.Z.zip.sha256`

The archive contains the contents of `extension/dist`, not the directory itself,
so `manifest.json` and `build-info.json` are at the ZIP root. The packager rejects
version drift, a non-release build identity, unsafe archive paths, symbolic links,
macOS metadata, and an archive whose contents differ from the validated build.
It requires the `zip` and `unzip` commands available on macOS and GitHub's Ubuntu
runners.

## Version-cut workflow

Every push to `main` runs `.github/workflows/version-cut.yml`. Its prepare,
publish, and tag jobs keep dependency execution separate from repository
credentials while owning the two halves of the release lifecycle.

While changesets are pending, the version-PR job:

1. A read-only dependency job finds accumulated changesets and runs
   `npm run changeset:version`.
2. Changesets updates `package.json` and `CHANGELOG.md` and consumes the entries.
3. `scripts/sync-manifest-version.mjs` validates the new Chrome-compatible
   version and copies it to `extension/manifest.json` plus both root
   `package-lock.json` version fields.
4. The job validates and uploads the generated version patch without carrying
   repository write credentials.
5. A clean publishing job mints a short-lived `chores-dumb[bot]` installation
   token, verifies that at most one open same-repository
   `changeset-release/main` → `main` PR exists, and force-pushes the rolling
   branch.
6. It creates or refreshes the ready PR titled
   `chore: version Image Trail`. The App-authored PR emits ordinary
   `pull_request` CI and E2E runs.

The exact same-repository head and base are the trust boundary. The workflow
does not restrict refreshes based on the existing PR author. App-token minting
is mandatory and fails closed before the branch or PR write; the human
`RELEASE_TOKEN` and the Actions `GITHUB_TOKEN` are not write fallbacks.

The version-PR path does not publish a product release, approve the PR, or merge
it. Ordinary merges only refresh this rolling PR; they do not cut releases
because the committed package version did not change.

After the version PR merges, the tag job sees a changed `package.json` version
with no pending changesets. It verifies that package, manifest, and lockfile
versions match, mints a new `chores-dumb[bot]` installation token, and pushes
`v<version>`. That App-authored tag push starts `.github/workflows/release.yml`
directly. Release mints its own `chores-dumb[bot]` token to create or refresh the
GitHub Release assets.

## Reviewing and merging a version PR

Before merging:

1. Confirm the changelog contains the intended accumulated changes.
2. Confirm `package.json`, `extension/manifest.json`, and both root
   `package-lock.json` version fields have the same version.
3. Run `npm run ci`.
4. Run `npm run build:release` and inspect
   `extension/dist/build-info.json` for the expected version and release mode.
5. After these checks pass, merge the version PR without waiting for separate
   release authorization. The merge is the release-cut action and publishes the
   corresponding GitHub prerelease.

## Cutting a release

Preferred flow:

1. Merge the ready version PR.
2. The `Version cut` workflow verifies the fresh synchronized version and absence
   of pending changesets and creates `v0.2.4` as `chores-dumb[bot]`.
3. `Release` checks out that tag, verifies its commit belongs to `main`, runs
   `npm run ci`, builds the package, and creates or refreshes the GitHub Release.
4. Verify the run, downloadable ZIP, and adjacent checksum before distribution.

Manual recovery for an existing tag uses **Actions → Release → Run workflow**
from `main` with the full tag, including the `v` prefix. Recovery does not create
a tag and Release still checks out the supplied tag rather than the dispatching
branch. To recover a missing rolling PR or a synchronized current version that
was never tagged, send the `version-cut-recovery` repository dispatch after the
`chores-dumb[bot]` App secrets are available. The workflow recreates or refreshes
the rolling PR, or creates the missing tag; if the tag already exists without a
release, it dispatches Release with that tag.

```sh
gh api --method POST repos/qwts/image-trail/dispatches \
  -f event_type=version-cut-recovery
```

The human-tag fallback is:

```sh
git switch main
git pull --ff-only
git tag -a v0.2.4 -m "Image Trail v0.2.4"
git push origin v0.2.4
```

A supplied or pushed tag must exactly match the package/manifest version and its
commit must be on `main`. Otherwise the workflow stops before publishing.
Rerunning a release refreshes the ZIP and checksum assets with `--clobber`; it
does not rewrite the release notes.

### Release credential custody

The App credentials (`CHORES_DUMB_CLIENT_ID`, `CHORES_DUMB_PRIVATE_KEY`) are read
through protected environments, not from an arbitrary branch:

- `release` (Release job): accepts only `main` and `v*.*.*` tags and waits for a
  maintainer's approval. Every release run pauses for that approval.
- `version-cut` (version PR and tag jobs): accepts only `main`, no approval.
- The `protect-release-tags` ruleset lets only repository admins and the release
  App create, move, or delete `v*` tags.

Store the two secrets, and `PCLOUD_CLIENT_ID` for `release`, as environment
secrets. A repository-level copy would still be readable by a workflow run from
any branch, so do not keep one.

### Release credential timing

The Release job installs dependencies, runs the hardened E2E smoke test, and
builds the package with no write credential. It mints the `chores-dumb[bot]`
`contents: write` token in the step directly before "Create or refresh GitHub
Release assets", the only step that uses it. Keep the mint there: moving it
earlier exposes the token to dependency and build code.

Both publish paths go through that late mint and only run on a real tag, so
verify each one the first time it runs after a change to this job:

1. **New release.** Merge a version PR and let the tag start Release. Expected:
   the mint step succeeds after "Build and package release", the run creates a
   prerelease titled `Image Trail vX.Y.Z` authored by `chores-dumb[bot]`, and the
   ZIP and `.sha256` assets are attached and match.
2. **Refresh.** Run **Actions → Release → Run workflow** from `main` with the
   same tag. Expected: the run succeeds, the existing release keeps its notes,
   and the ZIP and `.sha256` assets are replaced.
3. **Failure before publish.** If any step before the mint fails, the log shows
   no "Mint the chores-dumb token" step executed and no release or asset
   changes.

While Image Trail's repository status is pre-release, the workflow marks GitHub
Releases as prereleases even though the Chrome manifest uses stable numeric
versions. Removing that marker requires an explicit release-readiness change;
automatic version-cut orchestration does not promote repository release status.

## Downloading or submitting the package

The GitHub Release exposes the exact same ZIP for both uses:

- users can download it, extract it, and load the extracted directory as an
  unpacked extension;
- an owner can upload the ZIP directly in the Chrome Web Store dashboard because
  `manifest.json` is already at the archive root.

Verify a downloaded package with the adjacent checksum file:

```sh
shasum -a 256 -c image-trail-v0.2.4.zip.sha256
```

Do not re-zip the repository or `extension/dist` directory: doing so can add an
extra parent directory or local-development files. Chrome Web Store listing
copy, privacy/data-use answers, permission justifications, screenshots, review
instructions, upload, and publication are tracked separately from release
packaging. The workflow contains no store credentials and cannot submit or
publish the extension, so complete those operational steps manually after the
release-readiness checks pass; no additional approval is required.
