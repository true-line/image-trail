# Testing Strategy

> Canonical reference for how Image Trail is tested: the layers, what runs
> when and where, and the policy for adding coverage when features land.
> This is the source-controlled testing strategy for the repository.

## TL;DR

- Seven test layers, from static analysis up to Playwright acceptance flows.
- **Local "before done" gate is fast and narrow**: `lint && format:check && test && build`.
  `npm test` is typecheck + unit + DOM only.
- **CI runs everything** on every PR to `main`, including the coverage gate,
  Playwright E2E, and Storybook interaction tests.
- Acceptance coverage is governed by a **ledger** — `tests/e2e/coverage-map.json`,
  enforced by `scripts/check-e2e-coverage-map.mjs`. Every canonical flow is either
  automated, deliberately `manual` (with a reason), or `deferred` (with an issue).
- **Policy:** a new or changed user-facing flow must land with a coverage-map
  entry — automated, or manual/deferred-with-reason. Automation debt is allowed,
  but it must be _recorded_, never invisible.

## The layers

| #   | Layer             | Command                                                                                                          | Scope                                                                                                         | Tier       |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Static            | `lint` (eslint + `check-package-pins` + `madge --circular` + `knip`), `typecheck`, `format:check`                | Import boundaries, cycles, dead code, types, style                                                            | Static     |
| 2   | Unit              | `test:unit` — `node:test` on `tests/*.test.js`                                                                   | Pure domain/controller logic, no DOM                                                                          | Unit       |
| 3   | DOM               | `test:dom` — happy-dom on `tests/dom/*.test.js` (registered via `tests/dom/register.ts`)                         | Controllers/rendering against a real DOM                                                                      | Unit       |
| 4   | Invariants        | `tests/invariants.test.ts` + `no-restricted-syntax` eslint rule                                                  | Product-model guarantees: recents never persisted; queue order is `queueUpdatedAt`; Recall pages the producer | Unit       |
| 5   | Coverage          | `test:cov` — `c8`, floor in `.c8rc.json` (**lines 54 / branches 79**)                                            | Ratchet over unit + DOM                                                                                       | Unit       |
| 6   | Story             | `test:stories:ci` — Storybook `play` interaction tests                                                           | Component-level UI behavior                                                                                   | Component  |
| 7a  | **Smoke**         | `extension-smoke.spec.ts` (Playwright)                                                                           | Extension surface loads and renders without crashing                                                          | Acceptance |
| 7b  | **Acceptance**    | Playwright specs: `image-utilities`, `recents-queue-recall`, `url-editor-parsed-fields`, `automation-governance` | Canonical end-to-end user flows                                                                               | Acceptance |
| 7c  | Acceptance ledger | `check-e2e-coverage-map.mjs` over `coverage-map.json`                                                            | Governance: every flow declares its coverage                                                                  | Gate       |

### DOM harness: stylesheet loading stays enabled

`tests/dom/register.ts` registers happy-dom with `enableCSSFileLoading: true`. happy-dom 21 disables CSS file loading by
default and dispatches `error` **synchronously** when a `<link rel="stylesheet">` connects. `PanelMount` treats a stylesheet
`error` as a fail-open reveal, so with loading disabled the panel is already visible when `mount()` returns and no DOM test
can observe the pre-reveal hidden state. Enabling loading resolves the harness's `data:` URLs locally and asynchronously, as
a browser does, so tests drive the reveal by dispatching `load` themselves. Keep this setting when bumping happy-dom; the
fail-open reveal itself stays covered by `tests/panel-mount.test.ts`.

### Smoke vs. acceptance vs. QA

- **Smoke** — one Playwright spec (`extension-smoke.spec.ts`) answering "does it
  come up at all?" Fast, broad, shallow. First thing to break when something is
  badly wrong.
- **Acceptance** — the remaining Playwright specs plus the coverage-map ledger.
  Each spec drives a canonical user flow end to end and is registered in
  `coverage-map.json` against a named acceptance flow.
- **QA (manual)** — deliberate, tracked human verification. Not ad hoc: it is the
  `manual` coverage type in the ledger (with a required `reason`) plus the
  `AGENTS.md` rule to _"provide a manual test run before the PR enters final review."_

## What runs when & where

### Local — the "before done" gate (`AGENTS.md`)

```sh
npm run lint && npm run format:check && npm test && npm run build
```

`npm test` = `typecheck` + `test:compile` + unit + DOM. **E2E, Storybook, and the
c8 coverage gate do _not_ run here by default.** The `/check` command wraps this
gate and reports the product invariants explicitly.

For UI or flow changes, run the fuller set before pushing (see _Recommended
additions_).

### CI — `.github/workflows/ci.yml` (on `pull_request` → `main`)

Runs the full stack, in order:

1. `lint`
2. `format:check`
3. `test:cov` ← coverage gate (unit + DOM under c8)
4. upload `coverage/lcov.info` artifact
5. `build`
6. `playwright install --with-deps chromium`
7. `test:e2e` ← coverage-map gate **then** Playwright specs
8. upload `playwright-report/` artifact (14-day history; uploads on red runs too)
9. `test:stories:ci` ← builds + serves static Storybook, runs `play` tests

A follow-up `e2e-report` job then publishes the Playwright HTML report — per-test
steps, plus screenshots/videos/time-travel traces on failure — to GitHub Pages at
a stable per-PR URL, linked from the run summary:

```
https://qwts.github.io/image-trail/reports/pr-<number>/
```

Safeguards: deploys are serialized across PRs, skipped when the run's commit is
no longer the PR head (stale-run guard), and **verified against the Pages API**
before the link is printed — with one automatic rerun of GitHub's managed deploy
if it flakes ("Deployment failed, try again later"). The link only appears when
the page is confirmed serving that run's deploy.

There is **no scheduled/nightly run** — all automation is PR-triggered.

### E2E execution model & the parallelism ceiling

The Playwright suite is parallelized at the **spec-file** level (PR #380):

- The extension is built **once** in `tests/e2e/global-setup.ts`; each worker loads
  the prebuilt `extension/dist` read-only. (Previously the worker fixture rebuilt
  it — which is exactly why the suite couldn't be parallelized: concurrent
  `npm run build` runs each start with `rm -rf dist` and would clobber each other.)
- `fullyParallel: false` with `workers: 3` on CI: tests **within** a spec run
  serially, and **distinct spec files run concurrently**.
- Every test opens its own fresh `mkdtemp` persistent profile. No test may rely on
  state left by an earlier test or spec; a test that needs the encrypted-originals
  key or a locked workspace sets that up itself (`ensureBlobKeyCreated`,
  `ensureBlobKeyUnavailable` in `tests/e2e/fixtures.ts`).
- Historical result (PR #380, shared worker profile): the E2E CI step dropped from
  ~3m21s to ~46s. A fresh profile per test costs a browser launch per test; one
  local run of the full suite took 6.1 min against 4.7 min with shared profiles.

**The ceiling:** because parallelism is file-level, wall-clock ≈ the **slowest
single spec file**. With only six spec files we are already near that ceiling —
adding workers beyond ~3 buys nothing. **The next real lever as flows grow is to
split the larger spec files** (e.g. `image-utilities`, `import-export-settings`)
into smaller focused specs so more workers can actually help; only then do more
workers / matrix sharding pay off. When adding an acceptance flow, prefer a new
focused spec file over piling onto an existing large one.

Planned follow-ups that **do not** reduce per-PR coverage (issue #379): (a) split
E2E into its own CI job, run in parallel with lint/unit/build — requires adding the
new job as a required check on the branch ruleset, or E2E silently becomes
non-blocking; (b) path-filter the E2E job to skip docs-/test-/config-only PRs. A
`@smoke` subset per PR + full suite on merge/nightly is a later, coverage-trading
option, held until file-level parallelism is exhausted.

## The coverage-map ledger (the important part)

See also the [Acceptance Tests](acceptance-tests/README.md) hub (the canonical flows) and
[ADR-0001 Automation Check Governance](adr/0001-automation-check-governance.md).

`tests/e2e/coverage-map.json` (issue #304) lists **25 canonical acceptance flows**.
Each entry declares one or more coverage sources:

| Type             | Meaning                     | Required fields              |
| ---------------- | --------------------------- | ---------------------------- |
| `playwright-e2e` | Automated E2E spec          | `path` → existing `.spec.ts` |
| `storybook`      | Covered by a `play` test    | `path`                       |
| `unit-dom`       | Covered by unit/DOM test    | `path`                       |
| `manual`         | Deliberately human-verified | `reason`                     |
| `deferred`       | Automation not yet done     | `issue` (tracking #)         |

Current distribution: `playwright-e2e: 12 · unit-dom: 16 · storybook: 7 · manual: 6 · deferred: 7`.

`scripts/check-e2e-coverage-map.mjs` (run first inside `test:e2e`) enforces:

- every entry has `id`, `documentation`, and ≥1 coverage source;
- every referenced `path`/`repoPath` exists on disk;
- every Playwright `path` ends in `.spec.ts`;
- `manual` entries carry a `reason`; `deferred` entries carry a positive-integer `issue`;
- **every Playwright spec on disk is referenced by the map** (no orphan specs);
- **every referenced spec exists** (no dangling references).

This is what makes automation debt explicit: a flow is never silently untested —
it is automated, or manual-with-reason, or deferred-to-an-issue.

## Policy: coverage travels with the change

When a user-facing flow is **introduced or fixed**:

1. **Add or update its coverage-map entry.** Pick the honest coverage type. If you
   are not automating it now, use `deferred` with a tracking issue, or `manual`
   with a reason — do not leave the flow off the ledger.
2. **Prefer the cheapest layer that proves the behavior.** Unit/DOM for logic;
   Storybook for component interaction; Playwright only for true end-to-end flows.
3. **Regression fixes ship with a failing-then-passing test** at the layer that
   would have caught the bug. (See #263: prev/next stepping had no acceptance
   entry — exactly the gap this policy closes.)
4. **Never lower a floor to pass.** The c8 thresholds and coverage-map are
   ratchets: raise them as coverage improves.

## Known gaps & recommended additions

1. **E2E/stories are CI-only.** Local `npm test` can pass while an acceptance flow
   is broken; it surfaces only at PR time.
   → Add a `test:full` script (`test:cov` + `test:e2e` + `test:stories:ci`) and
   document it as the pre-push gate for UI/flow changes.
2. **Smoke runs synthetic pages, not the real MV3 extension.** Playwright serves
   `tests/e2e/pages/*.html` on `:4173`; it exercises extension _logic on test
   pages_, not the built extension loaded in Chrome with a live service worker and
   content-script injection. True "load-unpacked" smoke is currently `manual`/`deferred`.
   → Decide: invest in real-extension smoke for a few critical paths, or formalize
   it as `manual` with a source-controlled SOP.
3. **No forcing function for new-feature coverage.** The ledger validates existing
   entries; nothing flags a feature that shipped with no entry.
   → Institutionalize via PR template + review checklist (tracked in issue #343).
4. **Coverage numbers aren't visible on the PR.** ~~E2E results~~ — **closed
   2026-07-04**: Playwright reports are now published per-PR to GitHub Pages,
   linked from the run summary, and verified live before linking (see the CI
   section above). Still open for the _c8 side_: line/branch totals vs. the
   floor and the coverage-map distribution are not surfaced on the PR.
   → Write a Markdown summary to `$GITHUB_STEP_SUMMARY` with c8 totals vs.
   floor and the coverage-map distribution (tracked alongside issue #343).
5. **No scheduled smoke on `main`.** PR-only runs miss environment/dependency drift.
   → Consider a nightly `test:e2e` against `main`.
6. **Coverage floor is low (lines 54%).** By design a ratchet — only ever raise it.

## Command quick reference

```sh
# Fast local gate (before "done")
npm run lint && npm run format:check && npm test && npm run build

# Coverage gate (as CI runs it)
npm run test:cov

# Acceptance
npm run test:e2e            # coverage-map gate + Playwright specs
npm run test:e2e:ui         # Playwright UI mode
npm run test:stories:ci     # Storybook interaction tests (CI form)

# Invariants + full gate report
/check
```
