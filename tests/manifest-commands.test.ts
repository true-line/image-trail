import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { BROWSER_COMMAND_SHORTCUTS } from '../extension/src/core/keyboard-shortcuts.js';

interface ExtensionCommandManifest {
  readonly icons?: Record<string, string>;
  readonly action?: {
    readonly default_icon?: Record<string, string>;
  };
  readonly incognito?: string;
  readonly permissions?: readonly string[];
  readonly host_permissions?: readonly string[];
  readonly optional_host_permissions?: readonly string[];
  readonly content_scripts?: readonly unknown[];
  readonly commands?: Record<
    string,
    {
      readonly description?: string;
      readonly suggested_key?: {
        readonly default?: string;
        readonly mac?: string;
      };
    }
  >;
  readonly web_accessible_resources?: readonly {
    readonly resources?: readonly string[];
    readonly matches?: readonly string[];
    readonly use_dynamic_url?: boolean;
  }[];
}

test('manifest uses activeTab injection and optional per-origin host grants', () => {
  const manifest = loadManifest();

  assert.ok(manifest.permissions?.includes('activeTab'));
  assert.ok(manifest.permissions?.includes('scripting'));
  assert.equal(manifest.permissions?.includes('nativeMessaging'), false);
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.content_scripts ?? [], []);
});

function loadManifest(): ExtensionCommandManifest {
  return JSON.parse(readFileSync('extension/manifest.json', 'utf8')) as ExtensionCommandManifest;
}

function stylesheetDependencyClosure(entry: string): readonly string[] {
  const pending = [entry];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const resource = pending.pop();
    if (!resource || seen.has(resource)) continue;
    seen.add(resource);
    const css = readFileSync(join('extension', resource), 'utf8');
    for (const match of css.matchAll(/@import ['"](?<path>[^'"]+)['"];/gu)) {
      const importPath = match.groups?.['path'];
      if (importPath) pending.push(posix.join(posix.dirname(resource), importPath));
    }
  }
  return [...seen];
}

test('manifest registers correctly sized PNG icons for the extension and browser action', () => {
  const manifest = loadManifest();
  const expectedIcons = {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  };

  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action?.default_icon, expectedIcons);

  for (const [declaredSize, iconPath] of Object.entries(expectedIcons)) {
    const expectedSize = Number(declaredSize);
    const icon = readFileSync(join('extension', iconPath));

    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${iconPath} should be a PNG`);
    assert.equal(icon.readUInt32BE(16), expectedSize, `${iconPath} should have the declared width`);
    assert.equal(icon.readUInt32BE(20), expectedSize, `${iconPath} should have the declared height`);
  }
});

test('manifest exposes the build-info overlay toggle in Chromium keyboard shortcuts', () => {
  const command = loadManifest().commands?.['toggle-build-info-overlay'];

  assert.ok(command, 'build-info overlay toggle command should be registered');
  assert.equal(command.description, 'Toggle build info overlay');
  assert.deepEqual(command.suggested_key, {
    default: 'Alt+Shift+B',
    mac: 'Alt+Shift+B',
  });
});

test('manifest exposes the browser action in Chromium keyboard shortcuts', () => {
  const command = loadManifest().commands?.['_execute_action'];

  assert.ok(command, 'browser action command should be registered');
  assert.equal(command.description, 'Open or hide Image Trail panel');
  assert.equal(command.suggested_key, undefined);
});

test('manifest exposes assignable Image Trail action commands in Chromium keyboard shortcuts', () => {
  const commands = loadManifest().commands ?? {};
  for (const shortcut of BROWSER_COMMAND_SHORTCUTS) {
    assert.equal(commands[shortcut.command]?.description, shortcut.manifestDescription);
    assert.equal(commands[shortcut.command]?.suggested_key, undefined);
  }
});

test('manifest exposes panel stylesheet imports only through session-scoped URLs', () => {
  const resourceGroups = loadManifest().web_accessible_resources ?? [];
  assert.equal(resourceGroups.length, 1);
  assert.deepEqual(resourceGroups[0]?.matches, ['http://*/*', 'https://*/*']);
  assert.equal(resourceGroups[0]?.use_dynamic_url, true);

  const resources = resourceGroups.flatMap((entry) => entry.resources ?? []);

  for (const stylesheet of stylesheetDependencyClosure('src/ui/styles/panel-entry.css')) {
    assert.ok(resources.includes(stylesheet), `${stylesheet} should be web-accessible`);
  }
});

test('manifest isolates incognito windows in their own extension instance', () => {
  assert.equal(loadManifest().incognito, 'split', 'incognito activity must not share Recents, caches, or keys with regular windows');
});
