import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

type ArtifactPolicyModule = {
  auditExtensionArtifacts(options: {
    directory: string;
    rootDirectory: string;
    requireExperimental?: boolean;
    requireRelease?: boolean;
  }): Promise<{ errors: string[] }>;
  expectedExtensionArtifacts(manifest: Record<string, unknown>): string[];
  validateArtifactPaths(files: string[], manifest: Record<string, unknown>): string[];
  validateReleaseArtifactText(file: string, content: string, rootDirectory: string, options?: { allowE2ETestBuild?: boolean }): string[];
  validateReleaseBuildInfo(buildInfo: Record<string, unknown>): string[];
  validateReleaseManifest(manifest: Record<string, unknown>): string[];
  validateExperimentalBuildInfo(buildInfo: Record<string, unknown>): string[];
  validateExperimentalManifest(manifest: Record<string, unknown>): string[];
};

type BuildPolicyModule = {
  bundleStylesheet(sourcePath: string, outputPath: string, options?: { release?: boolean }): Promise<void>;
  extensionOutputPath(sourcePath: string, pathApi?: typeof win32): string;
  isInjectedStylesheet(sourcePath: string, pathApi?: typeof win32): boolean;
  extensionBuildOptions(input: {
    entryPoint: string;
    outfile: string;
    format: string;
    jsx?: string | null;
    release?: boolean;
    interopEnabled?: boolean;
    e2eTestBuild?: boolean;
    pageContextSwitcherEnabled?: boolean;
    pcloudClientId?: string | null;
  }): Record<string, unknown>;
  isInteropFeatureEnabled(environment?: Record<string, string | undefined>): boolean;
  isExperimentalBuild(environment?: Record<string, string | undefined>): boolean;
  isReleaseBuild(environment?: Record<string, string | undefined>): boolean;
  isE2ETestBuild(environment?: Record<string, string | undefined>): boolean;
  isPageContextSwitcherFeatureEnabled(environment?: Record<string, string | undefined>, e2eTestBuild?: boolean): boolean;
  isPCloudBackupFeatureEnabled(environment?: Record<string, string | undefined>): boolean;
  pcloudClientIdFromEnvironment(environment?: Record<string, string | undefined>): string | null;
  minificationImproved(unminifiedBytes: number, minifiedBytes: number): boolean;
};

type ManifestPolicyModule = {
  RELEASED_IMAGE_TRAIL_EXTENSION_ID: string;
  RELEASED_IMAGE_TRAIL_PUBLIC_KEY: string;
  chromeExtensionIdFromPublicKey(publicKey: string): string;
  extensionManifestForBuild(
    manifest: Record<string, unknown>,
    options?: { interopEnabled?: boolean; experimentalBuild?: boolean },
  ): Record<string, unknown> & { key?: string; permissions: string[] };
};

const artifacts = (await import(pathToFileURL(join(process.cwd(), 'scripts/extension-artifact-policy.mjs')).href)) as ArtifactPolicyModule;
const builds = (await import(pathToFileURL(join(process.cwd(), 'scripts/extension-build-policy.mjs')).href)) as BuildPolicyModule;
const manifests = (await import(pathToFileURL(join(process.cwd(), 'scripts/extension-manifest-policy.mjs')).href)) as ManifestPolicyModule;

function manifestFixture() {
  return {
    background: { service_worker: 'src/background/service-worker.js' },
    icons: { 16: 'icons/icon16.png' },
    action: { default_icon: { 16: 'icons/icon16.png' } },
    web_accessible_resources: [{ resources: ['src/ui/styles/panel.css'] }],
  };
}

function releaseBuildInfo(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version: '0.10.1',
    builtAt: '2026-07-15T03:00:00.000Z',
    commit: 'abc123def456',
    branch: '558-minify-harden-release-artifacts',
    worktree: null,
    timezone: 'America/Chicago',
    mode: 'release',
    ...overrides,
  };
}

function writeArtifactFixture(directory: string, manifest: Record<string, unknown>, buildInfo: Record<string, unknown>) {
  for (const file of artifacts.expectedExtensionArtifacts(manifest)) {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    const content = file === 'manifest.json' ? manifest : file === 'build-info.json' ? buildInfo : '';
    writeFileSync(target, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  }
}

test('central release build policy minifies and removes development-only debugging', () => {
  const local = builds.extensionBuildOptions({
    entryPoint: 'source.ts',
    outfile: 'output.js',
    format: 'esm',
    release: false,
    pcloudClientId: null,
  });
  assert.equal(local['minify'], false);
  assert.equal(local['legalComments'], 'inline');
  assert.equal(local['drop'], undefined);
  assert.equal(local['pure'], undefined);

  const release = builds.extensionBuildOptions({
    entryPoint: 'source.ts',
    outfile: 'output.js',
    format: 'esm',
    release: true,
    pcloudClientId: 'release-client-id',
  });
  assert.equal(release['minify'], true);
  assert.equal(release['legalComments'], 'eof');
  assert.deepEqual(release['drop'], ['debugger']);
  assert.deepEqual(release['pure'], ['console.debug']);
  assert.deepEqual(release['define'], {
    'process.env.NODE_ENV': '"production"',
    __IMAGE_TRAIL_E2E_TEST_BUILD_ATTRIBUTE__: 'undefined',
    __IMAGE_TRAIL_E2E_TEST_BUILD__: 'false',
    __IMAGE_TRAIL_INTEROP_ENABLED__: 'false',
    __IMAGE_TRAIL_PAGE_CONTEXT_SWITCHER_ENABLED__: 'false',
    __IMAGE_TRAIL_PCLOUD_CLIENT_ID__: '"release-client-id"',
    __IMAGE_TRAIL_PCLOUD_ENABLED__: 'true',
  });

  assert.equal((local['define'] as Record<string, string>)['__IMAGE_TRAIL_PCLOUD_CLIENT_ID__'], 'undefined');
  assert.equal((local['define'] as Record<string, string>)['__IMAGE_TRAIL_PCLOUD_ENABLED__'], 'false');
  assert.throws(
    () =>
      builds.extensionBuildOptions({ entryPoint: 'source.ts', outfile: 'output.js', format: 'esm', release: true, pcloudClientId: null }),
    /Release builds require PCLOUD_CLIENT_ID/u,
  );

  const e2e = builds.extensionBuildOptions({
    entryPoint: 'source.ts',
    outfile: 'output.js',
    format: 'esm',
    e2eTestBuild: true,
    pcloudClientId: null,
  });
  assert.equal((e2e['define'] as Record<string, string>)['__IMAGE_TRAIL_E2E_TEST_BUILD__'], 'true');
  assert.equal((e2e['define'] as Record<string, string>)['__IMAGE_TRAIL_E2E_TEST_BUILD_ATTRIBUTE__'], '"data-image-trail-e2e-test-build"');
  assert.equal((e2e['define'] as Record<string, string>)['__IMAGE_TRAIL_PAGE_CONTEXT_SWITCHER_ENABLED__'], 'true');

  const releaseE2E = builds.extensionBuildOptions({
    entryPoint: 'source.ts',
    outfile: 'output.js',
    format: 'esm',
    release: true,
    e2eTestBuild: true,
    pcloudClientId: 'release-client-id',
  });
  assert.equal((releaseE2E['define'] as Record<string, string>)['__IMAGE_TRAIL_E2E_TEST_BUILD__'], 'true');
  assert.equal(
    (releaseE2E['define'] as Record<string, string>)['__IMAGE_TRAIL_E2E_TEST_BUILD_ATTRIBUTE__'],
    '"data-image-trail-e2e-test-build"',
  );
  assert.equal((releaseE2E['define'] as Record<string, string>)['__IMAGE_TRAIL_PAGE_CONTEXT_SWITCHER_ENABLED__'], 'true');

  const interop = builds.extensionBuildOptions({
    entryPoint: 'source.ts',
    outfile: 'output.js',
    format: 'esm',
    interopEnabled: true,
    pcloudClientId: null,
  });
  assert.equal((interop['define'] as Record<string, string>)['__IMAGE_TRAIL_INTEROP_ENABLED__'], 'true');
});

test('release-mode detection and minification regression threshold are explicit', () => {
  assert.equal(builds.isReleaseBuild({ IMAGE_TRAIL_RELEASE_BUILD: '1' }), true);
  assert.equal(builds.isReleaseBuild({ IMAGE_TRAIL_RELEASE_BUILD: '0' }), false);
  assert.equal(builds.isExperimentalBuild({ IMAGE_TRAIL_EXPERIMENTAL_BUILD: '1' }), true);
  assert.equal(builds.isExperimentalBuild({ IMAGE_TRAIL_EXPERIMENTAL_BUILD: '0' }), false);
  assert.equal(builds.isInteropFeatureEnabled({ IMAGE_TRAIL_ENABLE_INTEROP: '1' }), true);
  assert.equal(builds.isInteropFeatureEnabled({ IMAGE_TRAIL_ENABLE_INTEROP: '0' }), false);
  assert.equal(builds.isE2ETestBuild({ IMAGE_TRAIL_E2E_TEST_BUILD: '1' }), true);
  assert.equal(builds.isE2ETestBuild({ IMAGE_TRAIL_E2E_TEST_BUILD: '0' }), false);
  assert.equal(builds.isPageContextSwitcherFeatureEnabled({}, false), false);
  assert.equal(builds.isPageContextSwitcherFeatureEnabled({}, true), true);
  assert.equal(builds.isPageContextSwitcherFeatureEnabled({ IMAGE_TRAIL_ENABLE_PAGE_CONTEXT_SWITCHER: '1' }, false), true);
  assert.equal(builds.isPageContextSwitcherFeatureEnabled({ IMAGE_TRAIL_ENABLE_PAGE_CONTEXT_SWITCHER: '0' }, true), false);
  assert.equal(builds.isPCloudBackupFeatureEnabled({ PCLOUD_CLIENT_ID: ' repo-client-id ' }), true);
  assert.equal(builds.isPCloudBackupFeatureEnabled({}), false);
  assert.equal(builds.pcloudClientIdFromEnvironment({ PCLOUD_CLIENT_ID: ' repo-client-id ' }), 'repo-client-id');
  assert.throws(() => builds.pcloudClientIdFromEnvironment({ PCLOUD_CLIENT_ID: 'not a client id' }), /PCLOUD_CLIENT_ID/u);
  assert.equal(builds.minificationImproved(1_000, 1_000), true);
  assert.equal(builds.minificationImproved(10_000, 9_900), false);
  assert.equal(builds.minificationImproved(10_000, 8_000), true);
});

test('baseline manifests omit native messaging and experimental interop builds opt in', () => {
  const source = {
    name: 'Image Trail',
    permissions: ['activeTab', 'nativeMessaging', 'storage'],
  };

  assert.deepEqual(manifests.extensionManifestForBuild(source, { interopEnabled: false }).permissions, ['activeTab', 'storage']);
  assert.deepEqual(manifests.extensionManifestForBuild(source, { interopEnabled: true }).permissions, [
    'activeTab',
    'storage',
    'nativeMessaging',
  ]);
  const experimental = manifests.extensionManifestForBuild(source, { experimentalBuild: true, interopEnabled: true });
  assert.equal(experimental.key, manifests.RELEASED_IMAGE_TRAIL_PUBLIC_KEY);
  assert.equal(manifests.chromeExtensionIdFromPublicKey(experimental.key ?? ''), manifests.RELEASED_IMAGE_TRAIL_EXTENSION_ID);
  assert.equal(manifests.RELEASED_IMAGE_TRAIL_EXTENSION_ID, 'kopcjofaojfpgdoianeddagpenhijphi');
  assert.throws(
    () => manifests.extensionManifestForBuild(source, { experimentalBuild: true, interopEnabled: false }),
    /Experimental builds require interoperability/u,
  );
  assert.deepEqual(source.permissions, ['activeTab', 'nativeMessaging', 'storage']);
});

test('artifact allowlist is derived from the manifest plus explicit application entrypoints', () => {
  const manifest = manifestFixture();
  const expected = artifacts.expectedExtensionArtifacts(manifest);
  assert.ok(expected.includes('manifest.json'));
  // The first-party MIT notice must ship inside the packaged extension so
  // distributed copies carry the copyright and permission text.
  assert.ok(expected.includes('LICENSE'));
  // Third-party attribution must ship inside the packaged extension.
  assert.ok(expected.includes('THIRD-PARTY-LICENSES.txt'));
  assert.ok(expected.includes('src/background/service-worker.js'));
  assert.ok(expected.includes('src/content/content-script.js'));
  assert.ok(expected.includes('src/preview/preview.css'));
  assert.equal(expected.includes('src/interop-pairing/import.html'), false);
  assert.equal(expected.includes('src/interop-pairing/import.js'), false);
  assert.ok(expected.includes('src/gallery/gallery-filters.css'));
  assert.ok(expected.includes('src/ui/styles/panel.css'));
  assert.ok(expected.includes('icons/icon16.png'));
  assert.deepEqual(artifacts.validateArtifactPaths(expected, manifest), []);
  assert.match(artifacts.validateArtifactPaths([...expected, 'src/core/source.js'], manifest).join(' '), /unexpected release artifact/u);
  assert.match(
    artifacts
      .validateArtifactPaths(
        expected.filter((file) => file !== 'manifest.json'),
        manifest,
      )
      .join(' '),
    /missing required release artifact/u,
  );
});

test('experimental interop artifacts are allowlisted only when native messaging is enabled', () => {
  const baseline = manifestFixture();
  const enabled = { ...manifestFixture(), permissions: ['nativeMessaging'] };
  assert.equal(artifacts.expectedExtensionArtifacts(baseline).includes('src/interop-pairing/import.html'), false);
  assert.equal(artifacts.expectedExtensionArtifacts(baseline).includes('src/interop-pairing/import.js'), false);
  assert.ok(artifacts.expectedExtensionArtifacts(enabled).includes('src/interop-pairing/import.html'));
  assert.ok(artifacts.expectedExtensionArtifacts(enabled).includes('src/interop-pairing/import.js'));
});

test('release text audit rejects debug metadata, secrets, and build-machine paths', () => {
  const cases = [
    ['bundle.js', 'debugger;'],
    ['bundle.js', 'console.debug("private URL")'],
    ['bundle.js', 'process.env.NODE_ENV'],
    ['bundle.js', "process.env['NODE_ENV']"],
    ['bundle.js', 'process.env[key]'],
    ['bundle.js', '//# sourceMappingURL=bundle.js.map'],
    ['bundle.js', '//#sourceMappingURL=bundle.js.map'],
    ['bundle.css', '/*# sourceMappingURL=bundle.css.map */'],
    ['bundle.js', '-----BEGIN PRIVATE KEY-----'],
    ['bundle.js', 'AKIA1234567890ABCDEF'],
    ['bundle.js', 'const source = "/Users/example/image-trail"'],
    ['bundle.js', 'const source = "/workspace/image-trail"'],
  ] as const;

  for (const [file, content] of cases) {
    assert.notDeepEqual(artifacts.validateReleaseArtifactText(file, content, '/workspace/image-trail'), []);
  }
  assert.deepEqual(
    artifacts.validateReleaseArtifactText('bundle.js', 'console.warn("bounded failure");console.error("fatal failure")', '/workspace'),
    [],
  );
  assert.match(
    artifacts.validateReleaseArtifactText('bundle.js', 'data-image-trail-e2e-test-build', '/workspace').join(' '),
    /disposable E2E open-shadow marker/u,
  );
  assert.deepEqual(
    artifacts.validateReleaseArtifactText('bundle.js', 'data-image-trail-e2e-test-build', '/workspace', {
      allowE2ETestBuild: true,
    }),
    [],
  );
});

test('extension stylesheet output paths remain inside dist on Windows', () => {
  const source = win32.join('extension', 'src', 'ui', 'styles', 'panel.css');
  assert.equal(builds.extensionOutputPath(source, win32), win32.join('extension', 'dist', 'src', 'ui', 'styles', 'panel.css'));
  assert.throws(() => builds.extensionOutputPath(win32.join('extension', 'outside.css'), win32), /must be inside/u);
});

test('injected stylesheet detection accepts native Windows separators', () => {
  assert.equal(builds.isInjectedStylesheet('extension/src/ui/styles/panel-entry.css'), true);
  assert.equal(builds.isInjectedStylesheet(win32.join('extension', 'src', 'ui', 'styles', 'panel-entry.css'), win32), true);
  assert.equal(builds.isInjectedStylesheet(win32.join('extension', 'src', 'ui', 'styles', 'panel.css'), win32), false);
});

test('dynamic injected stylesheet packaging flattens relative imports into one resource', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'image-trail-css-bundle-'));
  const sourceDirectory = join(directory, 'source');
  const entry = join(sourceDirectory, 'entry.css');
  const output = join(directory, 'dist', 'entry.css');
  mkdirSync(sourceDirectory);
  writeFileSync(join(sourceDirectory, 'tokens.css'), ':root { --accent: #abc; }\n');
  writeFileSync(entry, "@import './tokens.css';\n.panel { color: var(--accent); }\n");

  try {
    await builds.bundleStylesheet(entry, output, { release: false });
    const bundled = readFileSync(output, 'utf8');
    assert.doesNotMatch(bundled, /@import/u);
    assert.match(bundled, /--accent:\s*#abc/u);
    assert.match(bundled, /\.panel\s*\{/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release build identity rejects extra metadata and local build markers', () => {
  assert.deepEqual(artifacts.validateReleaseBuildInfo(releaseBuildInfo()), []);
  assert.match(artifacts.validateReleaseBuildInfo(releaseBuildInfo({ sourceRoot: '/tmp/repo' })).join(' '), /keys must be exactly/u);
  assert.match(
    artifacts.validateReleaseBuildInfo(releaseBuildInfo({ mode: 'local', worktree: 'image-trail' })).join(' '),
    /release mode.*worktree/u,
  );
});

test('experimental build identity is hardened and distinct from release', () => {
  const experimental = releaseBuildInfo({ mode: 'experimental' });
  assert.deepEqual(artifacts.validateExperimentalBuildInfo(experimental), []);
  assert.match(artifacts.validateExperimentalBuildInfo(releaseBuildInfo()).join(' '), /experimental mode/u);
  assert.match(artifacts.validateExperimentalBuildInfo({ ...experimental, worktree: 'image-trail' }).join(' '), /worktree/u);
});

test('an explicit experimental audit rejects a release-mode artifact', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'image-trail-experimental-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = {
    ...manifestFixture(),
    web_accessible_resources: [{ resources: ['src/ui/styles/panel.css'], matches: ['https://*/*'], use_dynamic_url: true }],
  };
  writeArtifactFixture(directory, manifest, releaseBuildInfo());

  const result = await artifacts.auditExtensionArtifacts({
    directory,
    rootDirectory: directory,
    requireExperimental: true,
  });
  assert.match(result.errors.join(' '), /experimental mode/u);
});

test('release manifests reject the feature-gated native messaging permission', () => {
  assert.deepEqual(artifacts.validateReleaseManifest({ permissions: ['activeTab', 'storage'] }), []);
  assert.match(artifacts.validateReleaseManifest({ permissions: ['nativeMessaging'] }).join(' '), /must not request nativeMessaging/u);
});

test('experimental manifests require native messaging and the released extension identity', () => {
  const manifest = manifests.extensionManifestForBuild({ permissions: ['activeTab'] }, { experimentalBuild: true, interopEnabled: true });
  assert.deepEqual(artifacts.validateExperimentalManifest(manifest), []);
  assert.match(artifacts.validateExperimentalManifest({ permissions: [] }).join(' '), /requires nativeMessaging/u);
  assert.match(artifacts.validateExperimentalManifest({ ...manifest, key: undefined }).join(' '), /released extension public key/u);
});

test('release manifests require dynamic URLs for every web-accessible-resource group', () => {
  const resources = ['src/ui/styles/panel-entry.css'];
  assert.deepEqual(
    artifacts.validateReleaseManifest({
      web_accessible_resources: [{ resources, matches: ['https://*/*'], use_dynamic_url: true }],
    }),
    [],
  );
  assert.match(
    artifacts.validateReleaseManifest({ web_accessible_resources: [{ resources, matches: ['https://*/*'] }] }).join(' '),
    /group 0 must use a dynamic URL/u,
  );
});

test('build pipeline typechecks without emitting source-shaped modules and audits every build', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.match(packageJson.scripts['build'] ?? '', /tsc --noEmit -p tsconfig\.json/u);
  assert.match(packageJson.scripts['build'] ?? '', /build-preview-page\.mjs/u);
  assert.match(packageJson.scripts['build'] ?? '', /npm run check:artifacts/u);
  assert.match(packageJson.scripts['build:release'] ?? '', /IMAGE_TRAIL_ENABLE_INTEROP=0/u);
  assert.match(packageJson.scripts['build:release'] ?? '', /IMAGE_TRAIL_ENABLE_PAGE_CONTEXT_SWITCHER=0/u);
  assert.match(packageJson.scripts['build:release'] ?? '', /IMAGE_TRAIL_EXPERIMENTAL_BUILD=0/u);
  assert.match(packageJson.scripts['build:release'] ?? '', /IMAGE_TRAIL_E2E_TEST_BUILD=0/u);
  assert.match(packageJson.scripts['build:release'] ?? '', /audit-extension-artifacts\.mjs --require-release/u);
  assert.match(packageJson.scripts['build:experimental'] ?? '', /IMAGE_TRAIL_ENABLE_INTEROP=1/u);
  assert.match(packageJson.scripts['build:experimental'] ?? '', /IMAGE_TRAIL_EXPERIMENTAL_BUILD=1/u);
  assert.match(packageJson.scripts['build:experimental'] ?? '', /IMAGE_TRAIL_RELEASE_BUILD=0/u);
  assert.match(packageJson.scripts['build:experimental'] ?? '', /audit-extension-artifacts\.mjs --require-experimental/u);
  assert.match(packageJson.scripts['package:experimental'] ?? '', /package-extension-release\.mjs --experimental/u);
  assert.match(packageJson.scripts['test:e2e:release'] ?? '', /IMAGE_TRAIL_ENABLE_INTEROP=0/u);
  assert.match(packageJson.scripts['test:e2e:release'] ?? '', /IMAGE_TRAIL_EXPERIMENTAL_BUILD=0/u);
  assert.match(packageJson.scripts['test:e2e:experimental'] ?? '', /IMAGE_TRAIL_ENABLE_INTEROP=1/u);
  assert.match(packageJson.scripts['test:e2e:experimental'] ?? '', /IMAGE_TRAIL_ENABLE_PAGE_CONTEXT_SWITCHER=0/u);
  assert.match(packageJson.scripts['test:e2e:experimental'] ?? '', /IMAGE_TRAIL_EXPERIMENTAL_BUILD=1/u);
  assert.match(packageJson.scripts['test:e2e:release'] ?? '', /IMAGE_TRAIL_ENABLE_PAGE_CONTEXT_SWITCHER=0/u);
  assert.match(packageJson.scripts['test:e2e:release'] ?? '', /IMAGE_TRAIL_RELEASE_BUILD=1 npm run test:e2e/u);
  assert.match(readFileSync('tests/e2e/global-setup.ts', 'utf8'), /IMAGE_TRAIL_E2E_TEST_BUILD: '1'/u);
});
