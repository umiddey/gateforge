/**
 * The test-infrastructure import graph also roots at the RUNNER
 * CONFIGURATIONS (0.10.2).
 *
 * What the bug was: the graph started at the catalog's own test files, so
 * a file a runner configuration NAMES — the reporter, the global setup,
 * the global teardown — was structurally unattributable when no test
 * imports it. On a real first adoption commit that produced
 * `CHANGE_UNMAPPED` for `tests/e2e/fixtures/<reporter>.js`, a file the
 * repository's own `playwright.config` runs.
 *
 * What the rule is now, and its edges:
 * - a relative string literal in a runner configuration that resolves to
 *   an EXISTING repository file is an attribution (reporter, global
 *   setup/teardown, setup/teardown projects, `require.resolve('./…')`);
 * - that file's own import closure follows, through the SAME scanner and
 *   the SAME import resolution every other graph edge uses;
 * - a string that resolves to nothing contributes nothing — a declaration
 *   is read as a fact, never as a candidate-supplied string;
 * - the configuration files themselves stay attributed as runner
 *   configurations (the caller's own list), so this list adds only what
 *   they reach.
 *
 * `engine` class: the static scanner, no browsers, no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type GateforgeConfig } from '@gate-forge/core';
import { discoverTestCatalog } from '../src/discovery/index.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Temp projects to remove after each test. */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes a file tree (repo-relative posix keys) into a temp project. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [key, content] of Object.entries(files)) {
    const absolute = join(root, key);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

/** A minimal valid gateforge config for discovery runs. */
function fixtureConfig(include: string[]): GateforgeConfig {
  return parseConfig({
    schemaVersion: 1,
    project: { languages: ['python'], paths: { include, exclude: [] } },
    plugins: [],
    policies: '.gateforge/policies.yml',
    classificationPolicy: '.gateforge/classification-policy.yml',
    adapters: '.gateforge/adapters',
    waivers: '.gateforge/waivers',
    baselines: '.gateforge/baselines/obligations.json',
    changed: { provider: 'auto' },
    witness: { maxDurationSeconds: 5 },
    clock: { mode: 'fixed', fixedAt: '2026-01-01T00:00:00.000Z' },
  });
}

/** A project whose runner configuration is loadable ESM. */
function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-runner-config-infra-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
  }
  writeTree(root, { 'package.json': '{ "type": "module", "private": true }\n', ...files });
  return root;
}

/** A configuration that names the reporter, setup and teardown it runs. */
const NAMING_CONFIG = [
  "import { prepare } from './e2e/global-setup.js';",
  'void prepare;',
  'export default {',
  "  testDir: 'e2e',",
  "  projects: [{ name: 'chromium' }],",
  "  globalSetup: './tests/e2e/setup/global.js',",
  "  globalTeardown: './tests/e2e/teardown/global.js',",
  "  reporter: [['./tests/e2e/fixtures/claims-reporter.js']],",
  '};',
  '',
].join('\n');

describe('the test-infrastructure graph roots at the runner configurations', () => {
  it('attributes a named reporter, its imports, and the setup/teardown it runs', async () => {
    const root = makeProject({
      'playwright.config.js': NAMING_CONFIG,
      'e2e/accounts.spec.js': [
        "import { test } from 'playwright/test';",
        "test('creates an account', async () => {});",
        '',
      ].join('\n'),
      'e2e/global-setup.js': 'export const prepare = () => {};\n',
      'tests/e2e/setup/global.js': 'export default async function () {}\n',
      'tests/e2e/teardown/global.js': 'export default async function () {}\n',
      // The reporter is named by the configuration and NOTHING imports
      // it: the fixture of the real adoption commit.
      'tests/e2e/fixtures/claims-reporter.js': [
        "import { claims } from './claims.js';",
        'export default (result) => claims(result);',
        '',
      ].join('\n'),
      'tests/e2e/fixtures/claims.js': 'export const claims = (result) => result;\n',
    });

    const { testInfrastructureFiles } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['e2e/**/*.spec.js']),
    });

    // Every file the configuration reaches, and the reporter's own
    // import closure. `absent-reporter.js` names a file that does not
    // exist, so it contributes nothing — a string is read as a fact.
    expect(testInfrastructureFiles).toEqual([
      'e2e/global-setup.js',
      'tests/e2e/fixtures/claims-reporter.js',
      'tests/e2e/fixtures/claims.js',
      'tests/e2e/setup/global.js',
      'tests/e2e/teardown/global.js',
    ]);
  });

  it('attributes the same files with no catalog test file at all', async () => {
    // The graph does not depend on the suite: a repository whose config
    // names a reporter, before its first spec exists, gets the same
    // attribution.
    const root = makeProject({
      'playwright.config.js': NAMING_CONFIG,
      'e2e/global-setup.js': 'export const prepare = () => {};\n',
      'tests/e2e/setup/global.js': 'export default async function () {}\n',
      'tests/e2e/teardown/global.js': 'export default async function () {}\n',
      'tests/e2e/fixtures/claims-reporter.js': 'export default (result) => result;\n',
    });

    const { testInfrastructureFiles, catalog } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['e2e/**/*.spec.js']),
    });

    expect(catalog.entries).toEqual([]);
    expect(testInfrastructureFiles).toEqual([
      'e2e/global-setup.js',
      'tests/e2e/fixtures/claims-reporter.js',
      'tests/e2e/setup/global.js',
      'tests/e2e/teardown/global.js',
    ]);
  });

  it('attributes nothing when the runner configuration names nothing', async () => {
    const root = makeProject({
      'playwright.config.js': [
        "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };",
        '',
      ].join('\n'),
      'e2e/accounts.spec.js': [
        "import { test } from 'playwright/test';",
        "test('creates an account', async () => {});",
        '',
      ].join('\n'),
      'tests/e2e/fixtures/claims-reporter.js': 'export default (result) => result;\n',
    });

    const { testInfrastructureFiles } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['e2e/**/*.spec.js']),
    });

    expect(testInfrastructureFiles).toEqual([]);
  });

  it('keeps every runner configuration the caller can point the runner at', async () => {
    // The suffixed WRAPPER configs are roots too: the runner can be
    // pointed at any of them, so what they name is equally attributable.
    const root = makeProject({
      'playwright.config.js': 'export default { testDir: "e2e", projects: [{ name: "chromium" }] };\n',
      'playwright.config.dev-stack.ts': [
        'export default {',
        "  globalSetup: './tests/e2e/setup/dev-stack.js',",
        // The other spelling a repository uses: the literal is the path
        // the runner resolves, whatever expression carries it.
        "  globalTeardown: require.resolve('./tests/e2e/teardown/dev-stack.js'),",
        // A string that resolves to nothing contributes nothing: the
        // assertion below expects exactly two files, not three.
        "  metadata: './tests/e2e/setup/absent.js',",
        '};',
        '',
      ].join('\n'),
      'tests/e2e/teardown/dev-stack.js': 'export default async function () {}\n',
      'tests/e2e/setup/dev-stack.js': 'export default async function () {}\n',
      'e2e/accounts.spec.js': [
        "import { test } from 'playwright/test';",
        "test('creates an account', async () => {});",
        '',
      ].join('\n'),
    });

    const { testInfrastructureFiles } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['e2e/**/*.spec.js']),
    });

    expect(testInfrastructureFiles).toEqual([
      'tests/e2e/setup/dev-stack.js',
      'tests/e2e/teardown/dev-stack.js',
    ]);
  });
});