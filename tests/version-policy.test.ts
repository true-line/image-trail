import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type VersionPolicyModule = {
  validateChromeExtensionVersion(version: unknown): string[];
  evaluateVersionArtifacts(input: {
    packageVersion: string;
    manifestVersion: string;
    lockVersion: string;
    lockRootVersion: string;
    buildInfo?: Record<string, unknown> | null;
    requiredBuildMode?: string | null;
  }): string[];
  evaluateChangesetCoverage(input: {
    changedFiles: string[];
    changesets?: { path: string; content: string }[];
    releaseVersionAdvanced?: boolean;
    body?: string;
    labels?: string[];
  }): {
    ok: boolean;
    productFiles: string[];
    reason: string;
    errors?: string[];
  };
};

type ReleasePackageModule = {
  expectedReleaseTag(version: string): string;
  validateReleaseTag(tag: string, version: string): string[];
  validateArchiveEntries(entries: string[]): string[];
  releaseArtifactNames(version: string): { archive: string; checksum: string };
  experimentalArtifactNames(version: string): { archive: string; checksum: string };
  prepareArtifactOutput(directory: string, names: { archive: string; checksum: string }): Promise<void>;
};

type VersionCutModule = {
  validateChangedEntries(entries: { path: string; status: string }[], pendingChangesets: string[]): string[];
  validateVersionDocuments(input: {
    basePackage: Record<string, unknown>;
    nextPackage: Record<string, unknown>;
    baseManifest: Record<string, unknown>;
    nextManifest: Record<string, unknown>;
    baseLock: Record<string, unknown>;
    nextLock: Record<string, unknown>;
    baseChangelog: string;
    nextChangelog: string;
  }): string[];
};

const policy = (await import(pathToFileURL(join(process.cwd(), 'scripts/check-version-policy.mjs')).href)) as VersionPolicyModule;
const releasePackage = (await import(
  pathToFileURL(join(process.cwd(), 'scripts/package-extension-release.mjs')).href
)) as ReleasePackageModule;
const versionCut = (await import(pathToFileURL(join(process.cwd(), 'scripts/validate-version-cut.mjs')).href)) as VersionCutModule;

function versionArtifacts(packageVersion = '0.1.0', manifestVersion = packageVersion) {
  return { packageVersion, manifestVersion, lockVersion: packageVersion, lockRootVersion: packageVersion };
}

test('accepts Chrome numeric extension versions and rejects invalid components', () => {
  assert.deepEqual(policy.validateChromeExtensionVersion('0.1.0'), []);
  assert.deepEqual(policy.validateChromeExtensionVersion('3.1.2.4567'), []);
  assert.match(policy.validateChromeExtensionVersion('1.2.3.4.5').join(' '), /one to four/u);
  assert.match(policy.validateChromeExtensionVersion('1.02.3').join(' '), /leading zero/u);
  assert.match(policy.validateChromeExtensionVersion('1.65536.0').join(' '), /65535/u);
  assert.match(policy.validateChromeExtensionVersion('0.0.0').join(' '), /must not all be zero/u);
  assert.match(policy.validateChromeExtensionVersion('1.2-beta').join(' '), /decimal integers/u);
});

test('requires stable synchronized package and manifest versions', () => {
  assert.deepEqual(policy.evaluateVersionArtifacts(versionArtifacts()), []);
  assert.match(policy.evaluateVersionArtifacts(versionArtifacts('0.1.1', '0.1.0')).join(' '), /versions differ/u);
  assert.match(policy.evaluateVersionArtifacts(versionArtifacts('0.2.0-beta.1', '0.2.0')).join(' '), /stable three-component semver/u);
});

test('requires both package-lock version fields to match package.json', () => {
  assert.match(
    policy.evaluateVersionArtifacts({ ...versionArtifacts(), lockVersion: '0.0.9' }).join(' '),
    /package-lock\.json \(0\.0\.9\)/u,
  );
  assert.match(policy.evaluateVersionArtifacts({ ...versionArtifacts(), lockRootVersion: '0.0.9' }).join(' '), /root package \(0\.0\.9\)/u);
});

test('validates local, release, and experimental build identity policy', () => {
  assert.deepEqual(
    policy.evaluateVersionArtifacts({
      ...versionArtifacts(),
      buildInfo: { version: '0.1.0', mode: 'local', worktree: 'image-trail' },
      requiredBuildMode: 'local',
    }),
    [],
  );
  assert.deepEqual(
    policy.evaluateVersionArtifacts({
      ...versionArtifacts(),
      buildInfo: { version: '0.1.0', mode: 'experimental', worktree: null },
      requiredBuildMode: 'experimental',
    }),
    [],
  );
  assert.deepEqual(
    policy.evaluateVersionArtifacts({
      ...versionArtifacts(),
      buildInfo: { version: '0.1.0', mode: 'release', worktree: null },
      requiredBuildMode: 'release',
    }),
    [],
  );
  assert.match(
    policy
      .evaluateVersionArtifacts({
        ...versionArtifacts(),
        buildInfo: { version: '0.1.1', mode: 'release', worktree: 'dev' },
        requiredBuildMode: 'release',
      })
      .join(' '),
    /does not match.*worktree/u,
  );
});

test('requires changesets for shipping extension source', () => {
  const result = policy.evaluateChangesetCoverage({ changedFiles: ['extension/src/core/url/rebuild-url.ts'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.productFiles, ['extension/src/core/url/rebuild-url.ts']);
});

test('accepts a valid image-trail changeset for shipping extension source', () => {
  const result = policy.evaluateChangesetCoverage({
    changedFiles: ['extension/manifest.json', '.changeset/user-visible-fix.md'],
    changesets: [
      {
        path: '.changeset/user-visible-fix.md',
        content: '---\n"image-trail": patch\n---\nFix a user-visible issue.\n',
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, /valid image-trail changeset/u);
});

test('rejects empty, malformed, none, and unknown-package changesets', () => {
  const cases = [
    { content: '---\n---\n', message: /missing a release/u },
    { content: 'not changeset frontmatter', message: /could not parse/u },
    { content: '---\n"image-trail": none\n---\nNo release.\n', message: /patch, minor, or major/u },
    { content: '---\n"other-package": patch\n---\nWrong package.\n', message: /unknown package/u },
  ];

  for (const { content, message } of cases) {
    const result = policy.evaluateChangesetCoverage({
      changedFiles: ['extension/manifest.json', '.changeset/invalid.md'],
      changesets: [{ path: '.changeset/invalid.md', content }],
    });
    assert.equal(result.ok, false);
    assert.match(result.errors?.join(' ') ?? '', message);
  }
});

test('accepts consumed changesets only when a release version advances', () => {
  const input = {
    changedFiles: ['extension/manifest.json', '.changeset/consumed.md'],
    changesets: [],
  };
  assert.equal(policy.evaluateChangesetCoverage({ ...input, releaseVersionAdvanced: true }).ok, true);
  assert.equal(policy.evaluateChangesetCoverage(input).ok, false);
});

test('supports explicit no-version-impact PR exemptions', () => {
  assert.equal(
    policy.evaluateChangesetCoverage({
      changedFiles: ['extension/src/core/url/rebuild-url.ts'],
      body: 'Internal refactor only. no-version-impact',
    }).ok,
    true,
  );
  assert.equal(
    policy.evaluateChangesetCoverage({
      changedFiles: ['extension/src/core/url/rebuild-url.ts'],
      labels: ['No-Version-Impact'],
    }).ok,
    true,
  );
});

test('ignores tests, Storybook-only files, and repository tooling', () => {
  const result = policy.evaluateChangesetCoverage({
    changedFiles: [
      'extension/src/core/url/rebuild-url.test.ts',
      'extension/src/ui/components/fields-view.stories.ts',
      'extension/src/ui/stories/harness.ts',
      'tests/version-policy.test.ts',
      'scripts/check-version-policy.mjs',
      '.github/workflows/version-cut.yml',
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.productFiles, []);
});

test('version-cut workflow refreshes a checked Changesets PR and tags only fresh version merges', () => {
  const workflow = readFileSync('.github/workflows/version-cut.yml', 'utf8');

  assert.match(workflow, /npm run changeset:version/u);
  assert.match(workflow, /actions: write/u);
  // Branch, PR, and tag writes require a short-lived chores-dumb App token
  // because GITHUB_TOKEN events trigger no downstream workflow and
  // github-actions[bot] is not an authorized Actions actor here.
  assert.match(workflow, /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/u);
  assert.equal(workflow.match(/client-id: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID \}\}/gu)?.length, 2);
  assert.doesNotMatch(workflow, /\bapp-id:/u);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/u);
  assert.doesNotMatch(workflow, /RELEASE_TOKEN|\|\| github\.token/u);
  const mints = workflow.split(/- name: Mint the chores-dumb token/u).slice(1);
  assert.equal(mints.length, 2);
  for (const mint of mints) {
    const beforeUses = mint.split('uses:')[0] ?? '';
    assert.doesNotMatch(beforeUses, /continue-on-error|if:/u);
  }
  assert.doesNotMatch(workflow, /PUSH_TOKEN/u);
  assert.match(workflow, /gh pr create/u);
  assert.match(workflow, /repository_dispatch:\s*\n\s+types:\s*\n\s+- version-cut-recovery/u);
  assert.doesNotMatch(workflow, /workflow_dispatch:/u);
  assert.equal(workflow.match(/gh auth setup-git/gu)?.length, 2);
  assert.doesNotMatch(workflow, /^\s+token:/mu);
  assert.doesNotMatch(workflow, /gh workflow run ci\.yml/u);
  assert.match(workflow, /actions\/runs\?event=push&head_sha=\$GITHUB_SHA/u);
  assert.match(workflow, /gh run watch "\$run_id" --exit-status/u);
  assert.match(workflow, /\.name == "CI" and \.conclusion == "success"/u);
  assert.match(workflow, /Version unchanged \(\$cur\) — not a version-cut merge/u);
  assert.match(workflow, /Changesets pending — nothing to tag/u);
  assert.match(workflow, /package, manifest, and lockfile versions are not synchronized/u);
  assert.match(workflow, /git tag -a "\$version"/u);
  assert.match(workflow, /git push origin "\$version"/u);
  // The only surviving dispatch is stranded-tag recovery: an already-existing
  // tag has no push event left to replay. The fresh tag's own push starts
  // release.yml directly.
  assert.deepEqual(workflow.match(/gh workflow run \S+/gu), ['gh workflow run release.yml']);
  assert.doesNotMatch(workflow, /^\s+publish:/mu);
  assert.doesNotMatch(workflow, /^\s+prDraft:/mu);
  assert.doesNotMatch(workflow, /gh pr merge|auto-merge/u);
});

test('version-cut keeps dependency code off the clean token-bearing runner', () => {
  const workflow = readFileSync('.github/workflows/version-cut.yml', 'utf8');
  const prepareJob = workflow.slice(workflow.indexOf('\n  prepare-version-pr:'), workflow.indexOf('\n  publish-version-pr:'));
  const publishJob = workflow.slice(workflow.indexOf('\n  publish-version-pr:'), workflow.indexOf('\n  tag:'));
  const verifyStep = publishJob.slice(
    publishJob.indexOf('- name: Verify the ready version PR'),
    publishJob.indexOf('- name: Push the version branch'),
  );
  const pushStep = publishJob.slice(
    publishJob.indexOf('- name: Push the version branch'),
    publishJob.indexOf('- name: Create or refresh the ready version PR'),
  );
  const refreshStep = publishJob.slice(publishJob.indexOf('- name: Create or refresh the ready version PR'));

  assert.match(
    prepareJob,
    /uses: true-line\/trueline-agent-ci\/\.github\/actions\/bounded-command@8ec38da39c9b43af2181d1f5e5b7e09226c0bfad/u,
  );
  assert.match(prepareJob, /arguments-json: '\["ci"\]'/u);
  assert.match(prepareJob, /npm run changeset:version/u);
  assert.match(prepareJob, /actions\/upload-artifact@[0-9a-f]{40} # v7\.0\.1/u);
  assert.doesNotMatch(prepareJob, /RELEASE_TOKEN|GH_TOKEN|contents: write|pull-requests: write/u);

  assert.match(publishJob, /needs: prepare-version-pr/u);
  assert.match(publishJob, /actions\/download-artifact@[0-9a-f]{40} # v8\.0\.1/u);
  assert.match(publishJob, /node "\$trusted_validator"/u);
  assert.match(publishJob, /git -c core\.hooksPath=\/dev\/null -c commit\.gpgsign=false commit/u);
  assert.match(publishJob, /git -c core\.hooksPath=\/dev\/null push/u);
  assert.match(verifyStep, /GITHUB_REPOSITORY_OWNER:\$BRANCH/u);
  assert.match(verifyStep, /repos\/\$GITHUB_REPOSITORY\/pulls/u);
  assert.doesNotMatch(verifyStep, /< <\(/u);
  assert.doesNotMatch(verifyStep, /RELEASE_TOKEN/u);
  assert.match(pushStep, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/u);
  assert.match(refreshStep, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/u);
  assert.match(refreshStep, /gh pr create --base main --head "\$BRANCH"/u);
  assert.match(refreshStep, /gh pr edit "\$PR_NUMBER"/u);
  assert.doesNotMatch(publishJob, /qwts-codex-agent\[bot\]|bot-authored/u);
  const verifyExactHead = publishJob.indexOf('-f head="$GITHUB_REPOSITORY_OWNER:$BRANCH"');
  const pushBranch = publishJob.indexOf('git -c core.hooksPath=/dev/null push');
  assert.ok(verifyExactHead >= 0, 'the exact same-repo version PR head must be checked');
  assert.ok(pushBranch > verifyExactHead, 'the trusted head lookup must run before the branch refresh');
  assert.ok(
    publishJob.indexOf('pr_numbers=$(') < pushBranch,
    'a failed PR listing assignment must stop the job before the token-bearing push step',
  );
  assert.doesNotMatch(publishJob, /npm ci|npm run changeset:version/u);
});

test('version-cut preserves its trusted validator before an artifact can replace repository code', () => {
  const workflow = readFileSync('.github/workflows/version-cut.yml', 'utf8');
  const publishJob = workflow.slice(workflow.indexOf('\n  publish-version-pr:'), workflow.indexOf('\n  tag:'));
  const preserveValidator = publishJob.indexOf('cp scripts/validate-version-cut.mjs "$trusted_validator"');
  const applyArtifact = publishJob.indexOf('git apply --index "$RUNNER_TEMP/version-cut/version.patch"');
  const runValidator = publishJob.indexOf('node "$trusted_validator"');

  assert.ok(preserveValidator >= 0, 'trusted validator must be copied out of the worktree');
  assert.ok(applyArtifact > preserveValidator, 'untrusted patch must be applied only after preserving the validator');
  assert.ok(runValidator > applyArtifact, 'the preserved validator must inspect the applied patch');
  assert.doesNotMatch(publishJob, /node scripts\/validate-version-cut\.mjs/u);
});

test('version-cut validator accepts only synchronized version artifacts and consumed changesets', () => {
  const entries = [
    { status: 'M', path: 'CHANGELOG.md' },
    { status: 'M', path: 'extension/manifest.json' },
    { status: 'M', path: 'package-lock.json' },
    { status: 'M', path: 'package.json' },
    { status: 'D', path: '.changeset/steady-release.md' },
  ];
  assert.deepEqual(versionCut.validateChangedEntries(entries, ['.changeset/steady-release.md']), []);

  const basePackage = { name: 'image-trail', version: '0.25.0', scripts: { test: 'npm run test:unit' } };
  const nextPackage = { ...basePackage, version: '0.25.1' };
  const baseManifest = { manifest_version: 3, name: 'Image Trail', version: '0.25.0' };
  const nextManifest = { ...baseManifest, version: '0.25.1' };
  const baseLock = {
    name: 'image-trail',
    version: '0.25.0',
    lockfileVersion: 3,
    packages: { '': { name: 'image-trail', version: '0.25.0' } },
  };
  const nextLock = structuredClone(baseLock);
  nextLock.version = '0.25.1';
  nextLock.packages[''].version = '0.25.1';
  assert.deepEqual(
    versionCut.validateVersionDocuments({
      basePackage,
      nextPackage,
      baseManifest,
      nextManifest,
      baseLock,
      nextLock,
      baseChangelog: '# image-trail\n\n## 0.25.0\n\n- Previous.\n',
      nextChangelog: '# image-trail\n\n## 0.25.1\n\n- Fixed.\n\n## 0.25.0\n\n- Previous.\n',
    }),
    [],
  );
});

test('version-cut validator rejects executable drift and malformed patches', () => {
  const errors = versionCut.validateChangedEntries(
    [
      { status: 'M', path: 'CHANGELOG.md' },
      { status: 'M', path: 'extension/manifest.json' },
      { status: 'M', path: 'package-lock.json' },
      { status: 'M', path: 'package.json' },
      { status: 'M', path: '.changeset/steady-release.md' },
      { status: 'M', path: '.github/workflows/release.yml' },
    ],
    ['.changeset/steady-release.md'],
  );
  assert.match(errors.join(' '), /must be deleted/u);
  assert.match(errors.join(' '), /forbidden path/u);

  const basePackage = { name: 'image-trail', version: '0.25.0', scripts: { test: 'npm run test:unit' } };
  const nextPackage = { ...basePackage, version: '0.25.1', scripts: { test: 'curl attacker.invalid' } };
  const baseManifest = { manifest_version: 3, version: '0.25.0' };
  const nextManifest = { ...baseManifest, version: '0.25.1' };
  const baseLock = { version: '0.25.0', packages: { '': { version: '0.25.0' } } };
  const nextLock = { version: '0.25.1', packages: { '': { version: '0.25.1' } } };
  assert.match(
    versionCut
      .validateVersionDocuments({
        basePackage,
        nextPackage,
        baseManifest,
        nextManifest,
        baseLock,
        nextLock,
        baseChangelog: '# image-trail\n\n## 0.25.0\n\n- Previous.\n',
        nextChangelog: '# image-trail\n\n## 0.25.1\n\n- Fixed.\n\n## 0.25.0\n\n- Previous.\n',
      })
      .join(' '),
    /package\.json changes fields other than version/u,
  );
});

test('no workflow that carries repository automation credentials can reach a third-party action', () => {
  // Repository automation credentials stay inside actions/* steps and our own
  // run: blocks — never inside an action whose future versions nobody here
  // controls. This is why `changeset:version` is invoked as a script rather
  // than through changesets/action (AGENTS.md → Branch And GitHub Hygiene).
  for (const file of ['version-cut.yml', 'release.yml']) {
    const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');
    if (!workflow.includes('CHORES_DUMB_PRIVATE_KEY')) continue;
    const foreign = [...workflow.matchAll(/^\s*uses: (?<action>[^@\s]+)/gmu)]
      .map((match) => match.groups?.['action'] ?? '')
      .filter((action) => !action.startsWith('actions/') && action !== 'true-line/trueline-agent-ci/.github/actions/bounded-command');
    assert.deepEqual(foreign, [], `${file} passes a third-party action into a credential-bearing workflow`);
  }
});

test('required CI runs the version-policy gate', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.match(workflow, /run: npm run check:version-policy/u);
  assert.match(workflow, /run: npm run ci:tokenless/u);
  assert.match(workflow, /run: npm run check:acceptance-coverage/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /- exact-sha-preflight/u);
});

test('required CI retains PR base history for consumed-changeset validation', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const ciJob = workflow.slice(workflow.indexOf('\n  complete:'), workflow.indexOf('\n  e2e:'));

  assert.ok(ciJob.includes('uses: actions/checkout@'));
  assert.ok(ciJob.includes('fetch-depth: 0'));
});

test('Dependabot keeps TypeScript versions outside the parser peer range out of the broad dev-dependency bundle', () => {
  const dependabot = readFileSync('.github/dependabot.yml', 'utf8');

  assert.match(
    dependabot,
    /ignore:\s*\n\s*# typescript-eslint 8\.x supports TypeScript only below 6\.1\.[\s\S]*dependency-name: typescript\s*\n\s*versions:\s*\n\s*- '>=6\.1\.0'/u,
  );
});

test('all workflow checkouts avoid persisting credentials', () => {
  for (const file of ['ci.yml', 'close-linked-issues.yml', 'codeql.yml', 'release.yml', 'version-cut.yml', 'zizmor.yml']) {
    const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');
    const checkoutCount = workflow.match(/uses: actions\/checkout@/gu)?.length ?? 0;
    const hardenedCheckoutCount = workflow.match(/persist-credentials: false/gu)?.length ?? 0;
    assert.ok(checkoutCount > 0, `${file} should contain at least one checkout`);
    assert.equal(hardenedCheckoutCount, checkoutCount, `${file} must harden every checkout`);
  }
});

test('zizmor is digest-pinned without a disallowed wrapper action and enforces the governed action-ref policy', () => {
  const workflow = readFileSync('.github/workflows/zizmor.yml', 'utf8');
  const config = readFileSync('.github/zizmor.yml', 'utf8');
  const dependabot = readFileSync('.github/dependabot.yml', 'utf8');

  assert.doesNotMatch(workflow, /uses: zizmorcore\/zizmor-action@/u);
  assert.match(workflow, /releases\/download\/v1\.28\.0\/zizmor-x86_64-unknown-linux-gnu\.tar\.gz/u);
  assert.match(workflow, /ZIZMOR_SHA256: e87b67160194884e375a46a12c57ccc904f762b53845f254fab7f17d98809c09/u);
  assert.match(workflow, /sha256sum --check --strict/u);
  assert.match(workflow, /test "\$\("\$RUNNER_TEMP\/zizmor" --version\)" = 'zizmor 1\.28\.0'/u);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(workflow, /--persona auditor --format github/u);
  assert.match(workflow, /--config \.github\/zizmor\.yml \./u);
  assert.match(config, /allow:\s*\n\s+- CHORES_DUMB_CLIENT_ID\s*\n\s+- CHORES_DUMB_PRIVATE_KEY/u);
  assert.match(config, /['"]\*['"]: hash-pin/u);
  assert.doesNotMatch(config, /ref-pin/u);
  assert.equal(dependabot.match(/default-days: 7/gu)?.length, 2);
});

test('release builds do not consume dependency caches or interpolate the tag in shell source', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

  assert.match(workflow, /uses: actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/u);
  assert.match(workflow, /client-id: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID \}\}/u);
  assert.doesNotMatch(workflow, /\bapp-id:/u);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/u);
  assert.doesNotMatch(workflow, /RELEASE_TOKEN|continue-on-error/u);
  assert.doesNotMatch(workflow, /^\s+cache: npm/mu);
  assert.match(workflow, /package-manager-cache: false/u);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ steps\.release\.outputs\.tag \}\}/u);
  assert.match(workflow, /npm run package:release -- --tag "\$RELEASE_TAG"/u);
});

test('release packaging requires an exact version tag and stable artifact names', () => {
  assert.equal(releasePackage.expectedReleaseTag('1.2.3'), 'v1.2.3');
  assert.deepEqual(releasePackage.validateReleaseTag('v1.2.3', '1.2.3'), []);
  assert.match(releasePackage.validateReleaseTag('1.2.3', '1.2.3').join(' '), /exactly "v1\.2\.3"/u);
  assert.match(releasePackage.validateReleaseTag('v1.2.3', '1.2.3-beta.1').join(' '), /stable three-component semver/u);
  assert.deepEqual(releasePackage.releaseArtifactNames('1.2.3'), {
    archive: 'image-trail-v1.2.3.zip',
    checksum: 'image-trail-v1.2.3.zip.sha256',
  });
  assert.deepEqual(releasePackage.experimentalArtifactNames('1.2.3'), {
    archive: 'image-trail-v1.2.3-experimental.zip',
    checksum: 'image-trail-v1.2.3-experimental.zip.sha256',
  });
});

test('packaging one variant preserves the other variant', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'image-trail-package-variants-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const releaseNames = releasePackage.releaseArtifactNames('1.2.3');
  const experimentalNames = releasePackage.experimentalArtifactNames('1.2.3');
  for (const name of [...Object.values(releaseNames), ...Object.values(experimentalNames)]) {
    writeFileSync(join(directory, name), name);
  }

  await releasePackage.prepareArtifactOutput(directory, releaseNames);

  assert.equal(existsSync(join(directory, releaseNames.archive)), false);
  assert.equal(existsSync(join(directory, releaseNames.checksum)), false);
  assert.equal(existsSync(join(directory, experimentalNames.archive)), true);
  assert.equal(existsSync(join(directory, experimentalNames.checksum)), true);
});

test('release packaging enforces a Chrome Web Store-compatible archive root', () => {
  assert.deepEqual(releasePackage.validateArchiveEntries(['build-info.json', 'manifest.json', 'src/content/content-script.js']), []);
  assert.match(releasePackage.validateArchiveEntries(['extension/dist/manifest.json']).join(' '), /manifest\.json at its root/u);
  assert.match(releasePackage.validateArchiveEntries(['manifest.json', '../secret', '.DS_Store']).join(' '), /safe relative.*forbidden/u);
});

test('release workflow checks out a supplied tag and publishes assets without store publication', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /tags:\s*\n\s*- 'v\*\.\*\.\*'/u);
  assert.match(workflow, /tag:\s*\n\s+description: 'Existing exact v<package-version> tag/u);
  assert.match(workflow, /ref: \$\{\{ steps\.release\.outputs\.tag \}\}/u);
  assert.doesNotMatch(workflow, /run: npm run ci/u);
  assert.match(workflow, /head_sha=\$source_sha/u);
  assert.match(workflow, /event=pull_request&head_sha=\$pr_head/u);
  assert.match(workflow, /\.name == "CI" and \.conclusion == "success"/u);
  assert.match(
    workflow,
    /uses: true-line\/trueline-agent-ci\/\.github\/actions\/bounded-command@8ec38da39c9b43af2181d1f5e5b7e09226c0bfad/u,
  );
  assert.match(workflow, /arguments-json: '\["playwright","install","--with-deps","chromium"\]'/u);
  assert.match(workflow, /run: npm run test:e2e:release/u);
  assert.match(workflow, /npm run package:release -- --tag/u);
  assert.match(workflow, /Release tag must be stable three-component semver/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$\(git rev-list -n 1 "\$TAG_NAME"\)" origin\/main/u);
  assert.match(workflow, /gh release create/u);
  assert.match(workflow, /--prerelease/u);
  assert.match(workflow, /gh release edit.*--prerelease/u);
  assert.match(workflow, /gh release upload.*--clobber/u);
  assert.doesNotMatch(workflow, /git tag -a|git push origin/u);
  assert.doesNotMatch(workflow, /chrome-webstore-upload|webstore.*publish/iu);
});

test('version sync updates manifest and lockfile versions and refuses invalid Chrome versions', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'image-trail-version-sync-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'extension'));
  const manifestPath = join(directory, 'extension/manifest.json');
  const packageLockPath = join(directory, 'package-lock.json');
  const syncScript = join(process.cwd(), 'scripts/sync-manifest-version.mjs');

  writeFileSync(join(directory, 'package.json'), '{"name":"image-trail","version":"1.2.3"}\n');
  writeFileSync(manifestPath, '{\n  "version": "1.2.2"\n}\n');
  writeFileSync(
    packageLockPath,
    '{"name":"image-trail","version":"1.2.2","lockfileVersion":3,"packages":{"":{"name":"image-trail","version":"1.2.2"}}}\n',
  );
  execFileSync(process.execPath, [syncScript], { cwd: directory });
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).version, '1.2.3');
  const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8')) as { version: string; packages: { '': { version: string } } };
  assert.equal(packageLock.version, '1.2.3');
  assert.equal(packageLock.packages[''].version, '1.2.3');

  writeFileSync(join(directory, 'package.json'), '{"name":"image-trail","version":"1.2.3-beta.1"}\n');
  assert.throws(() => execFileSync(process.execPath, [syncScript], { cwd: directory, stdio: 'pipe' }));
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).version, '1.2.3');
  assert.equal(JSON.parse(readFileSync(packageLockPath, 'utf8')).version, '1.2.3');
});
