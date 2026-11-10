// Pure license-compliance policy: which SPDX identifiers are acceptable for
// dependencies we ship or build with, and how to read them out of an npm
// lockfile. No filesystem or process access lives here so it stays unit-testable.

// Permissive licenses for the extension's MIT-licensed dependencies. Add an
// identifier here only after confirming it imposes no copyleft or
// source-disclosure obligation on the bundled artifact.
export const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

// The lockfile marks our own root package; it is not a third-party dependency.
const ROOT_PACKAGE_KEY = '';

// Normalize the many shapes a license field takes across the lockfile and
// installed package.json manifests: a plain SPDX string, the deprecated
// `{ type }` object, or a legacy array of such objects (`licenses`).
export function normalizeLicense(license) {
  if (typeof license === 'string' && license.trim() !== '') return license.trim();
  if (license && typeof license === 'object') {
    const list = Array.isArray(license) ? license : [license];
    const types = list.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter((type) => typeof type === 'string');
    if (types.length > 0) return types.join(' AND ');
  }
  return null;
}

// Resolve a package's authoritative license from its installed manifest, using
// either the modern `license` or legacy `licenses` field.
export function manifestLicense(manifest) {
  return normalizeLicense(manifest?.license ?? manifest?.licenses);
}

// Evaluate a (possibly compound) SPDX expression against the allowlist.
// An `OR` is satisfied if any operand is allowed (we can pick that license);
// an `AND` requires every operand. Unparseable/empty expressions are not allowed.
export function isAllowedLicense(expression) {
  if (typeof expression !== 'string') return false;
  const cleaned = expression.replace(/[()]/gu, ' ').trim();
  if (cleaned === '') return false;
  if (/\bOR\b/u.test(cleaned)) return cleaned.split(/\bOR\b/u).some((part) => isAllowedLicense(part));
  if (/\bAND\b/u.test(cleaned)) return cleaned.split(/\bAND\b/u).every((part) => isAllowedLicense(part));
  return ALLOWED_LICENSES.has(cleaned.replace(/\+$/u, '').trim());
}

function dependencyNameFromKey(key) {
  const marker = 'node_modules/';
  const index = key.lastIndexOf(marker);
  return index === -1 ? key : key.slice(index + marker.length);
}

// Given an esbuild metafile input path (e.g. "node_modules/valibot/dist/index.js"
// or a nested "node_modules/a/node_modules/valibot/..."), return the installed
// package directory ("node_modules/.../valibot"). Returns null for first-party
// source that is not inside node_modules. Scoped packages keep both segments.
export function packageDirFromModulePath(modulePath) {
  const marker = 'node_modules/';
  const index = modulePath.lastIndexOf(marker);
  if (index === -1) return null;
  const rest = modulePath.slice(index + marker.length);
  const segments = rest.split('/');
  const packageName = segments[0]?.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  if (!packageName) return null;
  return `${modulePath.slice(0, index)}${marker}${packageName}`;
}

// Read the installed dependency tree out of a parsed package-lock.json (lockfile
// v2/v3 `packages` map). Skips the root package and workspace links; `dev`
// reflects whether npm resolved the package solely for devDependencies.
export function lockfileDependencies(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') return [];
  const entries = [];
  for (const [key, value] of Object.entries(packages)) {
    if (key === ROOT_PACKAGE_KEY || !key.startsWith('node_modules/')) continue;
    if (value?.link) continue;
    entries.push({
      name: dependencyNameFromKey(key),
      version: typeof value?.version === 'string' ? value.version : null,
      license: normalizeLicense(value?.license),
      dev: value?.dev === true,
      path: key,
    });
  }
  return dedupeByIdentity(entries);
}

function dedupeByIdentity(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const identity = `${entry.name}@${entry.version ?? ''}`;
    // Prefer a production classification: a package required by both prod and
    // dev trees ships, so hold it to the stricter (dev === false) standard.
    const existing = seen.get(identity);
    if (!existing || (existing.dev && !entry.dev)) seen.set(identity, entry);
  }
  return [...seen.values()].sort((a, b) =>
    a.name === b.name ? String(a.version).localeCompare(String(b.version)) : a.name.localeCompare(b.name),
  );
}

// Classify dependencies against the allowlist. `kind` is 'allowed', 'disallowed'
// (a recognized but non-permissive license), or 'unknown' (no resolvable
// license metadata). Production (bundled/shipped) violations are hard failures;
// devDependency violations are advisory — build-time only, never shipped.
export function evaluateLicenses(dependencies) {
  const violations = [];
  for (const dependency of dependencies) {
    if (isAllowedLicense(dependency.license)) continue;
    violations.push({
      name: dependency.name,
      version: dependency.version,
      license: dependency.license,
      dev: dependency.dev === true,
      kind: dependency.license === null ? 'unknown' : 'disallowed',
    });
  }
  const errors = violations.filter((violation) => !violation.dev);
  const warnings = violations.filter((violation) => violation.dev);
  return { violations, errors, warnings };
}

export function describeViolation(violation) {
  const reason = violation.kind === 'unknown' ? 'no license metadata' : `disallowed license "${violation.license}"`;
  return `${violation.name}@${violation.version ?? '?'} — ${reason}`;
}

const ATTRIBUTION_SEPARATOR = '='.repeat(78);

// Deterministic full-text attribution for the packages bundled into shipped
// artifacts. Each entry carries its declared license plus the verbatim text of
// the package's own license/notice file, satisfying permissive-license notice
// requirements (MIT/BSD/etc. require the copyright and permission notice to
// travel with distributed copies). No timestamps or host state, so the output
// is byte-stable and can be committed and freshness-checked in CI.
export function renderAttribution(bundledPackages) {
  const header = [
    'Image Trail — Third-Party Software Notices',
    '',
    'Image Trail is licensed under the MIT License; see',
    'LICENSE. It bundles the third-party packages listed below. Each is',
    "distributed under its own license, and the full text of each package's",
    'license/copyright notice follows its entry.',
    '',
  ];
  const sorted = [...bundledPackages].sort((a, b) =>
    a.name === b.name ? String(a.version).localeCompare(String(b.version)) : a.name.localeCompare(b.name),
  );
  const sections = sorted.map((entry) => {
    const notice =
      typeof entry.notice === 'string' && entry.notice.trim() !== ''
        ? entry.notice.trimEnd()
        : 'No license file was found in the package; see the declared license identifier above.';
    return [
      ATTRIBUTION_SEPARATOR,
      `${entry.name}@${entry.version ?? '?'} — ${entry.license ?? 'UNKNOWN'}`,
      ATTRIBUTION_SEPARATOR,
      '',
      notice,
      '',
    ].join('\n');
  });
  return `${header.join('\n')}\n${sections.join('\n')}`;
}
