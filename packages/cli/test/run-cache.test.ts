/** Regression tests for subprocess detector cache identity. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestPytestInputs, pluginCacheIdentity, pluginCacheKey, pytestCacheKey, resolveCacheControl } from '../src/run-cache.js';
import { execFileSync } from 'node:child_process';

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

describe('pytest input inventory and cache policy', () => {
  it('ignores ignored virtualenv Python files without reading them', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-pytest-inputs-'));
    temporaryDirectories.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), '.venv/\n');
    writeFileSync(join(root, 'app.py'), 'VALUE = 1\n');
    execFileSync('git', ['add', '.gitignore', 'app.py'], { cwd: root });
    mkdirSync(join(root, '.venv'), { recursive: true });
    writeFileSync(join(root, '.venv', 'unreadable.py'), 'ignored\n');
    const firstDigest = digestPytestInputs(root);
    writeFileSync(join(root, '.venv', 'unreadable.py'), 'changed ignored bytes\n');
    expect(digestPytestInputs(root)).toBe(firstDigest);
  });

  it('disables caching only on recognized CI providers, not bare CI=true', () => {
    expect(resolveCacheControl({ CI: 'true' }, '/tmp/cache', false).disabled).toBe(false);
    for (const name of ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD']) {
      expect(resolveCacheControl({ [name]: 'provider-value' }, '/tmp/cache', false).disabled).toBe(true);
    }
  });
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
