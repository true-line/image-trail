import { build, transform } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packageDirFromModulePath } from './license-policy.mjs';

const MINIFICATION_CHECK_BYTES = 1_024;
const MAX_UNIMPROVED_RATIO = 0.98;
const INJECTED_STYLESHEET = 'extension/src/ui/styles/panel-entry.css';
const E2E_TEST_BUILD_ATTRIBUTE = 'data-image-trail-e2e-test-build';
const MPEG_TS_PLAYER_SOURCE_FILTER =
  /[\\/]node_modules[\\/]mpegts\.js[\\/]src[\\/]player[\\/]player-engine-(main-thread|dedicated-thread)\.ts$/;
const MPEG_TS_LOGGER_SOURCE_FILTER = /[\\/]node_modules[\\/]mpegts\.js[\\/]src[\\/]utils[\\/]logger\.js$/;

function mpegTsSourceInteropPlugin() {
  return {
    name: 'mpegts-source-interop',
    setup(buildContext) {
      buildContext.onLoad({ filter: MPEG_TS_PLAYER_SOURCE_FILTER }, async (arguments_) => {
        const source = await readFile(arguments_.path, 'utf8');
        const contents = source
          .replace("import * as EventEmitter from 'events';", "import EventEmitter from 'events';")
          .replace("import * as work from 'webworkify-webpack';", "import work from 'webworkify-webpack';");
        if (contents === source) {
          throw new Error(`Expected mpegts.js source imports were not found in ${arguments_.path}`);
        }
        return { contents, loader: 'ts', resolveDir: path.dirname(arguments_.path) };
      });
      buildContext.onLoad({ filter: MPEG_TS_LOGGER_SOURCE_FILTER }, async (arguments_) => {
        const source = await readFile(arguments_.path, 'utf8');
        const contents = source
          .replace(/ {4}static d\(tag, msg\) \{[\s\S]*?\n {4}\}\n\n {4}static v/u, '    static d() {}\n\n    static v')
          .replace(/ {4}static v\(tag, msg\) \{[\s\S]*?\n {4}\}\n\n\}/u, '    static v() {}\n\n}')
          .replace('Log.ENABLE_DEBUG = true;', 'Log.ENABLE_DEBUG = false;')
          .replace('Log.ENABLE_VERBOSE = true;', 'Log.ENABLE_VERBOSE = false;');
        if (contents === source || contents.includes('console.debug')) {
          throw new Error(`Expected mpegts.js debug logger source was not isolated in ${arguments_.path}`);
        }
        return { contents, loader: 'js', resolveDir: path.dirname(arguments_.path) };
      });
    },
  };
}

// Single source of truth for the bundled extension entry points. The per-entry
// build scripts and the license scan both read this so a new bundle can never
// ship code whose dependencies escape the license gate.
export const EXTENSION_ENTRY_POINTS = {
  content: {
    entryPoint: 'extension/src/content/content-script.ts',
    outfile: 'extension/dist/src/content/content-script.js',
    format: 'iife',
  },
  serviceWorker: {
    entryPoint: 'extension/src/background/service-worker.ts',
    outfile: 'extension/dist/src/background/service-worker.js',
    format: 'esm',
  },
  gallery: {
    entryPoint: 'extension/src/gallery/gallery.ts',
    outfile: 'extension/dist/src/gallery/gallery.js',
    format: 'esm',
    jsx: 'automatic',
  },
  destination: {
    entryPoint: 'extension/src/destinations/destination-page.tsx',
    outfile: 'extension/dist/src/destinations/destination-page.js',
    format: 'esm',
    jsx: 'automatic',
  },
  interopPairingImport: {
    entryPoint: 'extension/src/interop-pairing/import.ts',
    outfile: 'extension/dist/src/interop-pairing/import.js',
    format: 'esm',
  },
  panelInputFrame: {
    entryPoint: 'extension/src/password-field/field.ts',
    outfile: 'extension/dist/src/password-field/field.js',
    format: 'esm',
  },
  preview: {
    entryPoint: 'extension/src/preview/preview.js',
    outfile: 'extension/dist/src/preview/preview.js',
    format: 'iife',
    alias: { 'webworkify-webpack': './extension/src/preview/disabled-mpegts-worker.ts' },
    define: { __VERSION__: '"1.8.0"' },
    plugins: [mpegTsSourceInteropPlugin()],
  },
};

export function isReleaseBuild(environment = process.env) {
  return environment.IMAGE_TRAIL_RELEASE_BUILD === '1';
}

export function isExperimentalBuild(environment = process.env) {
  return environment.IMAGE_TRAIL_EXPERIMENTAL_BUILD === '1';
}

export function isHardenedBuild(environment = process.env) {
  return isReleaseBuild(environment) || isExperimentalBuild(environment);
}

export function isInteropFeatureEnabled(environment = process.env) {
  return environment.IMAGE_TRAIL_ENABLE_INTEROP === '1';
}

export function isE2ETestBuild(environment = process.env) {
  return environment.IMAGE_TRAIL_E2E_TEST_BUILD === '1';
}

export function isPageContextSwitcherFeatureEnabled(environment = process.env, e2eTestBuild = isE2ETestBuild(environment)) {
  const configured = environment.IMAGE_TRAIL_ENABLE_PAGE_CONTEXT_SWITCHER;
  return configured === undefined ? e2eTestBuild : configured === '1';
}

export function pcloudClientIdFromEnvironment(environment = process.env) {
  const clientId = environment.PCLOUD_CLIENT_ID?.trim() ?? '';
  if (!clientId) return null;
  if (!/^[A-Za-z0-9_-]{3,128}$/u.test(clientId)) {
    throw new Error('PCLOUD_CLIENT_ID must be a 3-128 character pCloud client identifier.');
  }
  return clientId;
}

export function isPCloudBackupFeatureEnabled(environment = process.env) {
  return pcloudClientIdFromEnvironment(environment) !== null;
}

export function extensionOutputPath(sourcePath, pathApi = path) {
  const sourceRoot = pathApi.join('extension', 'src');
  const relativePath = pathApi.relative(sourceRoot, sourcePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relativePath)) {
    throw new Error(`Extension source path must be inside ${sourceRoot}: ${sourcePath}`);
  }
  return pathApi.join('extension', 'dist', 'src', relativePath);
}

export function isInjectedStylesheet(sourcePath, pathApi = path) {
  return sourcePath.split(pathApi.sep).join('/') === INJECTED_STYLESHEET;
}

export function extensionBuildOptions({
  entryPoint,
  outfile,
  format,
  jsx = null,
  release = isHardenedBuild(),
  interopEnabled = isInteropFeatureEnabled(),
  e2eTestBuild = isE2ETestBuild(),
  pageContextSwitcherEnabled = isPageContextSwitcherFeatureEnabled(process.env, e2eTestBuild),
  pcloudClientId = pcloudClientIdFromEnvironment(),
  alias = null,
  define = {},
  plugins = [],
}) {
  if (release && !pcloudClientId) throw new Error('Release builds require PCLOUD_CLIENT_ID for regular pCloud backup.');

  return {
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format,
    platform: 'browser',
    target: 'es2022',
    ...(jsx ? { jsx } : {}),
    define: {
      'process.env.NODE_ENV': '"production"',
      __IMAGE_TRAIL_E2E_TEST_BUILD_ATTRIBUTE__: e2eTestBuild ? JSON.stringify(E2E_TEST_BUILD_ATTRIBUTE) : 'undefined',
      __IMAGE_TRAIL_E2E_TEST_BUILD__: e2eTestBuild ? 'true' : 'false',
      __IMAGE_TRAIL_INTEROP_ENABLED__: interopEnabled ? 'true' : 'false',
      __IMAGE_TRAIL_PAGE_CONTEXT_SWITCHER_ENABLED__: pageContextSwitcherEnabled ? 'true' : 'false',
      __IMAGE_TRAIL_PCLOUD_CLIENT_ID__: pcloudClientId ? JSON.stringify(pcloudClientId) : 'undefined',
      __IMAGE_TRAIL_PCLOUD_ENABLED__: pcloudClientId ? 'true' : 'false',
      ...define,
    },
    ...(alias ? { alias } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    minify: release,
    legalComments: release ? 'eof' : 'inline',
    ...(release ? { drop: ['debugger'], pure: ['console.debug'] } : {}),
    logLevel: 'info',
  };
}

export async function buildExtensionEntry(configuration) {
  const release = configuration.release ?? isHardenedBuild();
  const options = extensionBuildOptions({ ...configuration, release });
  let unminifiedBytes = null;

  if (release) {
    const reference = await build({ ...options, minify: false, write: false, logLevel: 'silent' });
    unminifiedBytes = reference.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
  }

  const result = await build({ ...options, metafile: true });
  const outputBytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
  if (unminifiedBytes !== null) reportMinification(configuration.outfile, unminifiedBytes, outputBytes);
}

// Resolve the set of installed package directories whose code esbuild actually
// bundles into the shipped extension, across every entry point. This is the
// authoritative "what ships" list — it captures dependencies regardless of
// whether npm classified them as prod or dev (e.g. valibot).
export async function bundledPackageDirectories(entryPoints = Object.values(EXTENSION_ENTRY_POINTS)) {
  const directories = new Set();
  for (const entry of entryPoints) {
    const options = extensionBuildOptions({ ...entry, release: false });
    const result = await build({ ...options, write: false, metafile: true, logLevel: 'silent' });
    for (const input of Object.keys(result.metafile.inputs)) {
      const directory = packageDirFromModulePath(input);
      if (directory) directories.add(directory);
    }
  }
  return [...directories].sort();
}

export async function writeStylesheet(sourcePath, outputPath, { release = isHardenedBuild() } = {}) {
  const source = await readFile(sourcePath, 'utf8');
  const output = release
    ? (
        await transform(source, {
          loader: 'css',
          minify: true,
          legalComments: 'eof',
          sourcefile: sourcePath,
        })
      ).code
    : source;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  if (release) reportMinification(outputPath, Buffer.byteLength(source), Buffer.byteLength(output));
}

export async function bundleStylesheet(sourcePath, outputPath, { release = isHardenedBuild() } = {}) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const options = {
    entryPoints: [sourcePath],
    outfile: outputPath,
    bundle: true,
    minify: release,
    legalComments: release ? 'eof' : 'inline',
    logLevel: 'info',
  };
  let unminifiedBytes = null;

  if (release) {
    const reference = await build({ ...options, minify: false, write: false, logLevel: 'silent' });
    unminifiedBytes = reference.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
  }

  const result = await build({ ...options, metafile: true });
  if (unminifiedBytes !== null) {
    const outputBytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
    reportMinification(outputPath, unminifiedBytes, outputBytes);
  }
}

export function minificationImproved(unminifiedBytes, minifiedBytes) {
  return unminifiedBytes < MINIFICATION_CHECK_BYTES || minifiedBytes < unminifiedBytes * MAX_UNIMPROVED_RATIO;
}

function reportMinification(label, unminifiedBytes, minifiedBytes) {
  if (!minificationImproved(unminifiedBytes, minifiedBytes)) {
    throw new Error(`Release minification did not materially reduce ${label}: ${unminifiedBytes} -> ${minifiedBytes} bytes`);
  }
  const reduction = unminifiedBytes === 0 ? 0 : Math.round((1 - minifiedBytes / unminifiedBytes) * 100);
  console.log(`Release minification: ${label} ${unminifiedBytes} -> ${minifiedBytes} bytes (${reduction}% smaller)`);
}
