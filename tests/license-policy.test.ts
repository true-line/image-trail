import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Dependency = { name: string; version: string | null; license: string | null; dev: boolean; path?: string };
type Violation = { name: string; version: string | null; license: string | null; dev: boolean; kind: 'disallowed' | 'unknown' };

type LicensePolicyModule = {
  isAllowedLicense(expression: unknown): boolean;
  normalizeLicense(license: unknown): string | null;
  manifestLicense(manifest: Record<string, unknown>): string | null;
  lockfileDependencies(lock: Record<string, unknown>): Dependency[];
  evaluateLicenses(dependencies: Dependency[]): { violations: Violation[]; errors: Violation[]; warnings: Violation[] };
  describeViolation(violation: Violation): string;
  packageDirFromModulePath(modulePath: string): string | null;
  renderAttribution(packages: { name: string; version: string | null; license: string | null; notice?: string | null }[]): string;
};

const policy = (await import(pathToFileURL(join(process.cwd(), 'scripts/license-policy.mjs')).href)) as LicensePolicyModule;

test('permissive licenses and SPDX expressions are allowed; copyleft and unknown are not', () => {
  assert.equal(policy.isAllowedLicense('MIT'), true);
  assert.equal(policy.isAllowedLicense('Apache-2.0'), true);
  assert.equal(policy.isAllowedLicense('(MIT OR Apache-2.0)'), true);
  assert.equal(policy.isAllowedLicense('BSD-3-Clause AND MIT'), true);
  assert.equal(policy.isAllowedLicense('Apache-2.0 WITH LLVM-exception'), false); // WITH is not parsed as allowed
  assert.equal(policy.isAllowedLicense('MIT AND GPL-3.0'), false);
  assert.equal(policy.isAllowedLicense('GPL-3.0'), false);
  assert.equal(policy.isAllowedLicense('MPL-2.0'), false);
  assert.equal(policy.isAllowedLicense('SEE LICENSE IN LICENSE'), false);
  assert.equal(policy.isAllowedLicense(''), false);
  assert.equal(policy.isAllowedLicense(null), false);
});

test('license fields normalize across string, object, and legacy array shapes', () => {
  assert.equal(policy.normalizeLicense('MIT'), 'MIT');
  assert.equal(policy.normalizeLicense('  ISC  '), 'ISC');
  assert.equal(policy.normalizeLicense({ type: 'MIT' }), 'MIT');
  assert.equal(policy.normalizeLicense([{ type: 'MIT' }, { type: 'Apache-2.0' }]), 'MIT AND Apache-2.0');
  assert.equal(policy.normalizeLicense(''), null);
  assert.equal(policy.normalizeLicense(undefined), null);
  assert.equal(policy.manifestLicense({ license: 'MIT' }), 'MIT');
  assert.equal(policy.manifestLicense({ licenses: [{ type: 'BSD-2-Clause' }] }), 'BSD-2-Clause');
  assert.equal(policy.manifestLicense({}), null);
});

test('lockfile dependencies skip the root and links, dedupe to the strictest classification', () => {
  const deps = policy.lockfileDependencies({
    packages: {
      '': { name: 'image-trail', version: '0.0.0' },
      'node_modules/react': { version: '19.2.7', license: 'MIT', dev: false },
      'node_modules/some-tool': { version: '1.0.0', license: 'MIT', dev: true },
      // Same identity resolved once for dev and once for prod: production wins.
      'node_modules/a/node_modules/react': { version: '19.2.7', license: 'MIT', dev: true },
      'node_modules/linked': { link: true },
    },
  });
  const react = deps.find((dep) => dep.name === 'react');
  assert.ok(react);
  assert.equal(react?.dev, false);
  assert.equal(react?.path, 'node_modules/react');
  assert.ok(!deps.some((dep) => dep.name === 'image-trail'));
  assert.ok(!deps.some((dep) => dep.name === 'linked'));
});

test('production violations are errors, dev violations are warnings, tagged by kind', () => {
  const { errors, warnings } = policy.evaluateLicenses([
    { name: 'react', version: '19.2.7', license: 'MIT', dev: false },
    { name: 'copyleft', version: '1.0.0', license: 'GPL-3.0', dev: false },
    { name: 'nolicense', version: '2.0.0', license: null, dev: false },
    { name: 'devtool', version: '3.0.0', license: 'MPL-2.0', dev: true },
  ]);
  assert.deepEqual(
    errors.map((violation) => `${violation.name}:${violation.kind}`),
    ['copyleft:disallowed', 'nolicense:unknown'],
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.name, 'devtool');
  assert.match(policy.describeViolation(errors[0] as Violation), /disallowed license "GPL-3\.0"/u);
  assert.match(policy.describeViolation(errors[1] as Violation), /no license metadata/u);
});

test('package directories resolve from esbuild metafile input paths, including scoped and nested', () => {
  assert.equal(policy.packageDirFromModulePath('node_modules/valibot/dist/index.js'), 'node_modules/valibot');
  assert.equal(policy.packageDirFromModulePath('node_modules/@scope/pkg/lib/a.js'), 'node_modules/@scope/pkg');
  assert.equal(policy.packageDirFromModulePath('node_modules/a/node_modules/valibot/x.js'), 'node_modules/a/node_modules/valibot');
  assert.equal(policy.packageDirFromModulePath('extension/src/core/types.schema.ts'), null);
});

test('attribution renders deterministically, sorted, and embeds full notice text', () => {
  const first = policy.renderAttribution([
    { name: 'scheduler', version: '0.27.0', license: 'MIT', notice: 'SCHEDULER MIT TEXT' },
    { name: 'react', version: '19.2.7', license: 'MIT', notice: 'REACT MIT TEXT' },
  ]);
  const second = policy.renderAttribution([
    { name: 'react', version: '19.2.7', license: 'MIT', notice: 'REACT MIT TEXT' },
    { name: 'scheduler', version: '0.27.0', license: 'MIT', notice: 'SCHEDULER MIT TEXT' },
  ]);
  assert.equal(first, second);
  assert.ok(first.indexOf('react@19.2.7 — MIT') < first.indexOf('scheduler@0.27.0 — MIT'));
  assert.match(first, /REACT MIT TEXT/u);
  assert.match(first, /MIT License; see\s+LICENSE/u);
  // A package with no discoverable notice file still renders with a placeholder.
  assert.match(policy.renderAttribution([{ name: 'x', version: '1.0.0', license: 'MIT', notice: null }]), /No license file was found/u);
});
