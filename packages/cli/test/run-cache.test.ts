/** Regression tests for subprocess detector cache identity. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginCacheIdentity, pluginCacheKey, pytestCacheKey } from '../src/run-cache.js';

const temporaryDirectories: string[] = [];

/** Creates an isolated Python package tree for import-resolution tests. */
function pythonPackageFixture(): { root: string; packageDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-run-cache-'));
  temporaryDirectories.push(root);
  const packageDir = join(root, 'fixture_detector');
  mkdirSync(packageDir);
  writeFileSync(join(packageDir, '__init__.py'), "VALUE = 'first'\n");
  return { root, packageDir };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('subprocess cache identities', () => {
  it('invalidates module bytes, Python import environment, and engine version', () => {
    const fixture = pythonPackageFixture();
    const env = { ...process.env, PYTHONPATH: fixture.root };
    const plugin = {
      id: 'fixture-detector',
      version: '0.1.0',
      transport: 'subprocess',
      command: ['python3', '-m', 'fixture_detector'],
    };
    const first = pluginCacheIdentity(plugin, 'input-digest', fixture.root, env);
    expect(first).not.toBeNull();
    const firstKey = pluginCacheKey(first!);

    writeFileSync(join(fixture.packageDir, '__init__.py'), "VALUE = 'second'\n");
    const changedSource = pluginCacheIdentity(plugin, 'input-digest', fixture.root, env);
    expect(changedSource).not.toBeNull();
    expect(pluginCacheKey(changedSource!)).not.toBe(firstKey);

    const changedEnvironment = pluginCacheIdentity(
      plugin,
      'input-digest',
      fixture.root,
      { ...env, PYTHONPATH: `${fixture.root}:different-path` },
    );
    expect(changedEnvironment).not.toBeNull();
    expect(pluginCacheKey(changedEnvironment!)).not.toBe(pluginCacheKey(changedSource!));

    const changedEngine = pluginCacheIdentity(plugin, 'input-digest', fixture.root, env, 'next-engine');
    expect(changedEngine).not.toBeNull();
    expect(pluginCacheKey(changedEngine!)).not.toBe(pluginCacheKey(changedSource!));
  });

  it('keys pytest collection by collector argv, environment, and engine version', () => {
    const identity = { path: '/python', version: '3.12', packagesDigest: 'packages' };
    const suite = {
      name: 'backend',
      cwd: '/repo/backend',
      argv: ['python3', '-m', 'pytest'],
      collectorArgv: ['python3', '-m', 'pytest', '--collect-only', '-q', 'tests'],
      testPaths: ['tests'],
      timeoutMs: 30000,
    };
    const key = pytestCacheKey(suite, 'python-inputs', identity, 'environment');
    expect(pytestCacheKey(suite, 'python-inputs', identity, 'other-environment')).not.toBe(key);
    expect(pytestCacheKey(suite, 'python-inputs', identity, 'environment', 'next-engine')).not.toBe(key);
  });
});
