/**
 * Runner file-scope tests (0.9.0 adoption fix, finding 9): which files a
 * runner's OWN configuration collects decides a statically found file's
 * row. A vitest suite inside a playwright-configured repository is a
 * vitest test, never a phantom playwright case; with `globals: true` its
 * import-less `describe`/`it` are registrations the runner owns, not
 * `unresolved-test-alias` gaps. Every unreadable selection stays fail-open
 * (today's behaviour) and says so.
 *
 * `engine` class: the scope reads are pure AST/glob work; the end-to-end
 * case runs the installed playwright CLI in list mode against a TEMP
 * project (no browsers launched, no network).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type GateforgeConfig } from '@gate-forge/core';
import {
  discoverTestCatalog,
  playwrightFileScopes,
  scopeSelectsFile,
  vitestFileScopes,
  type RunnerFileScope,
} from '../src/discovery/index.js';
import {
  PROJECT_GRAPH_PATH_ENV,
  ProjectGraphReporter,
  type ProjectGraphDocument,
} from '../src/reporter/project-graph-reporter.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Temp dirs to remove after each test. */
const tempDirs: string[] = [];

function makeTempDir(prefix = 'gateforge-scope-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes a file tree (repo-relative posix keys) into a temp project. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [key, content] of Object.entries(files)) {
    const absolute = join(root, key);
    mkdirSync(join(absolute, '..'), { recursive: true });
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

/** The single scope a fixture produced (loudly fails when it produced none). */
function onlyScope(scopes: RunnerFileScope[]): RunnerFileScope {
  expect(scopes).toHaveLength(1);
  return scopes[0] as RunnerFileScope;
}

/** The vitest config a monorepo frontend declares (globals, no imports). */
const VITEST_CONFIG = [
  "import { defineConfig } from 'vitest/config';",
  '',
  'export default defineConfig({',
  "  test: { globals: true, environment: 'jsdom', include: ['src/**/*.test.js'] },",
  '});',
  '',
].join('\n');

/** Vitest's documented default `test.include`, as the source holds it. */
const VITEST_DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];

/** Vitest's documented default `test.exclude`, as the source holds it. */
const VITEST_DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
];

/** The frontend config: the documented defaults-spread idiom. */
const VITEST_DEFAULTS_CONFIG = [
  "import { defineConfig, configDefaults } from 'vitest/config';",
  '',
  'export default defineConfig({',
  '  test: {',
  '    globals: true,',
  "    exclude: [...configDefaults.exclude, '**/tests/e2e/**'],",
  '  },',
  '});',
  '',
].join('\n');

/** A vitest suite that relies on the injected globals entirely. */
const VITEST_SUITE = [
  "describe('widgets', () => {",
  "  it('renders a widget', () => {",
  '    expect(true).toBe(true);',
  '  });',
  '});',
  '',
].join('\n');

describe('playwright file scopes — the runner’s own selection', () => {
  it('collects only what the resolved testDir/testMatch selects', () => {
    const scopes = playwrightFileScopes([
      { name: 'chromium', testDir: '/repo', testMatch: ['tests/e2e/**/*.spec.js'], testIgnore: ['tests/e2e/**/probe.spec.js'] },
    ]);
    expect(scopes[0]?.authoritative).toBe(true);
    expect(scopeSelectsFile(onlyScope(scopes), '/repo', 'tests/e2e/accounts.spec.js')).toBe(true);
    expect(scopeSelectsFile(onlyScope(scopes), '/repo', 'frontend/src/widget.test.js')).toBe(false);
    expect(scopeSelectsFile(onlyScope(scopes), '/repo', 'tests/e2e/probe.spec.js')).toBe(false);
  });

  it('keeps every file when a selection pattern cannot be translated, and says so', () => {
    const scopes = playwrightFileScopes([
      { name: 'chromium', testDir: '/repo', testMatch: ['**/*.spec.js', '!(legacy)/**/*.spec.js'], testIgnore: [] },
    ]);
    expect(scopes[0]?.authoritative).toBe(false);
    expect(scopeSelectsFile(onlyScope(scopes), '/repo', 'frontend/src/widget.test.js')).toBe(true);
    expect(scopes[0]?.note).toContain('not a translatable glob');
    expect(scopes[0]?.note).toContain('collects every file');
  });

  it('is empty when the runner resolved no selection (today’s behaviour)', () => {
    expect(playwrightFileScopes([])).toEqual([]);
  });
});

describe('vitest file scopes — read from the repository config, never executed', () => {
  it('reads include and globals from a nested vitest config', () => {
    const root = makeTempDir();
    writeTree(root, { 'frontend/vitest.config.js': VITEST_CONFIG });
    const scopes = vitestFileScopes(root);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.runner).toBe('vitest');
    expect(scopes[0]?.globals).toBe(true);
    expect(scopeSelectsFile(onlyScope(scopes), root, 'frontend/src/widgets/widget.test.js')).toBe(true);
    expect(scopeSelectsFile(onlyScope(scopes), root, 'e2e/accounts.spec.js')).toBe(false);
  });

  it('claims nothing for a vite config that configures no test runner', () => {
    const root = makeTempDir();
    writeTree(root, {
      'vite.config.js': "export default { build: { outDir: 'dist' } };\n",
    });
    expect(vitestFileScopes(root)).toEqual([]);
  });

  it('claims nothing when the config computes its selection', () => {
    const root = makeTempDir();
    writeTree(root, {
      'vitest.config.ts': [
        'const globs = process.env.SUITES ? ["a"] : ["b"];',
        'export default { test: { include: globs, globals: true } };',
        '',
      ].join('\n'),
    });
    expect(vitestFileScopes(root)).toEqual([]);
  });

  it('expands a spread of the vitest defaults the config imports', () => {
    const root = makeTempDir();
    writeTree(root, {
      'frontend/vitest.config.js': VITEST_DEFAULTS_CONFIG,
      'frontend/src/a.test.js': VITEST_SUITE,
      'frontend/tests/e2e/x.spec.js': VITEST_SUITE,
    });
    const scope = onlyScope(vitestFileScopes(root));
    expect(scope.runner).toBe('vitest');
    expect(scope.authoritative).toBe(true);
    expect(scope.globals).toBe(true);
    expect(scope.include).toEqual([...VITEST_DEFAULT_INCLUDE]);
    expect(scope.exclude).toEqual([...VITEST_DEFAULT_EXCLUDE, '**/tests/e2e/**']);
    expect(scopeSelectsFile(scope, root, 'frontend/src/a.test.js')).toBe(true);
    expect(scopeSelectsFile(scope, root, 'frontend/tests/e2e/x.spec.js')).toBe(false);
  });

  it('reads a bare configDefaults selection without an array', () => {
    const root = makeTempDir();
    writeTree(root, {
      'frontend/vitest.config.js': [
        "import { defineConfig, configDefaults } from 'vitest/config';",
        '',
        'export default defineConfig({',
        '  test: {',
        '    globals: true,',
        '    include: configDefaults.include,',
        '    exclude: configDefaults.exclude,',
        '  },',
        '});',
        '',
      ].join('\n'),
    });
    const scope = onlyScope(vitestFileScopes(root));
    expect(scope.include).toEqual([...VITEST_DEFAULT_INCLUDE]);
    expect(scope.exclude).toEqual([...VITEST_DEFAULT_EXCLUDE]);
    expect(scopeSelectsFile(scope, root, 'frontend/src/a.test.js')).toBe(true);
    // The bare defaults exclude nothing extra: an e2e spec
    // stays selected until a config adds it beside the spread.
    expect(scopeSelectsFile(scope, root, 'frontend/tests/e2e/x.spec.js')).toBe(true);
  });

  it('expands defaults imported by their own names', () => {
    const root = makeTempDir();
    writeTree(root, {
      'frontend/vitest.config.js': [
        "import { defineConfig, defaultInclude, defaultExclude } from 'vitest/config';",
        '',
        'export default defineConfig({',
        '  test: {',
        '    globals: true,',
        '    include: [...defaultInclude],',
        "    exclude: [...defaultExclude, '**/tests/e2e/**'],",
        '  },',
        '});',
        '',
      ].join('\n'),
    });
    const scope = onlyScope(vitestFileScopes(root));
    expect(scope.include).toEqual([...VITEST_DEFAULT_INCLUDE]);
    expect(scope.exclude).toEqual([...VITEST_DEFAULT_EXCLUDE, '**/tests/e2e/**']);
  });

  it('claims nothing when configDefaults is a local, not imported from vitest', () => {
    const root = makeTempDir();
    writeTree(root, {
      'frontend/vitest.config.js': [
        'const configDefaults = { exclude: [] };',
        '',
        'export default {',
        "  test: { globals: true, exclude: [...configDefaults.exclude, '**/tests/e2e/**'] },",
        '};',
        '',
      ].join('\n'),
    });
    expect(vitestFileScopes(root)).toEqual([]);
  });

  it('claims nothing when configDefaults comes from another module', () => {
    const root = makeTempDir();
    writeTree(root, {
      'frontend/vitest.config.js': [
        "import { configDefaults } from './defaults.js';",
        '',
        'export default {',
        "  test: { globals: true, exclude: [...configDefaults.exclude, '**/tests/e2e/**'] },",
        '};',
        '',
      ].join('\n'),
    });
    expect(vitestFileScopes(root)).toEqual([]);
  });
});

describe('discovery — a runner’s own file scope decides the row', () => {
  /** A playwright project whose selection excludes the frontend subtree. */
  function makeMixedProject(files: Record<string, string>): string {
    const root = makeTempDir('gateforge-scope-e2e-');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    for (const name of ['playwright', 'playwright-core']) {
      symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
    }
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'playwright.config.js': [
        'export default {',
        "  testDir: '.',",
        "  testMatch: ['tests/e2e/**/*.spec.js'],",
        "  projects: [{ name: 'chromium' }],",
        '};',
        '',
      ].join('\n'),
      'frontend/vitest.config.js': VITEST_CONFIG,
      'tests/e2e/accounts.spec.js': [
        "import { test } from 'playwright/test';",
        "test('creates an account', async ({ page }) => {});",
        '',
      ].join('\n'),
      ...files,
    });
    return root;
  }

  it('catalogues a vitest suite as vitest, never as a playwright test', async () => {
    const root = makeMixedProject({
      'frontend/src/widgets/widget.test.js': VITEST_SUITE,
    });
    const { catalog } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['tests/e2e/**/*.spec.js', 'frontend/src/**/*.test.js']),
    });

    const vitestRow = catalog.entries.find((entry) => entry.file === 'frontend/src/widgets/widget.test.js');
    expect(vitestRow?.runner).toBe('vitest');
    expect(vitestRow?.titlePath).toEqual(['widgets', 'renders a widget']);
    // The vitest selection is data, not a guess — and no vitest
    // enumeration ran, so the row never claims a reconciliation verdict.
    expect(vitestRow?.discoveryStatus).toBe('discovered');
    expect(vitestRow?.reconciliation).toBe('unavailable');
    expect(vitestRow?.weakSignals.some((signal) => signal.ruleId === 'runner-file-scope')).toBe(true);
    // No playwright row for that file: the configured runner never
    // collects it, so it is not one of its tests.
    expect(
      catalog.entries.some(
        (entry) => entry.file === 'frontend/src/widgets/widget.test.js' && entry.runner === 'playwright',
      ),
    ).toBe(false);

    // Import-less describe/it under `globals: true` are registrations.
    expect(catalog.unresolved.some((gap) => gap.code === 'unresolved-test-alias')).toBe(false);
    // The playwright inventory itself is complete again.
    expect(catalog.inventoryComplete).toBe(true);
  });

  it('attributes a vitest suite to vitest when the config spreads the defaults', async () => {
    const root = makeMixedProject({
      'frontend/vitest.config.js': VITEST_DEFAULTS_CONFIG,
      'frontend/src/a.test.js': VITEST_SUITE,
    });
    const { catalog } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['tests/e2e/**/*.spec.js', 'frontend/src/**/*.test.js']),
    });

    const vitestRow = catalog.entries.find((entry) => entry.file === 'frontend/src/a.test.js');
    expect(vitestRow?.runner).toBe('vitest');
    expect(vitestRow?.titlePath).toEqual(['widgets', 'renders a widget']);
    expect(vitestRow?.discoveryStatus).toBe('discovered');
    expect(vitestRow?.reconciliation).toBe('unavailable');
    expect(vitestRow?.weakSignals.some((signal) => signal.ruleId === 'runner-file-scope')).toBe(true);
    // No playwright row for that file: the configured runner never
    // collects it, so it is not one of its tests.
    expect(
      catalog.entries.some(
        (entry) => entry.file === 'frontend/src/a.test.js' && entry.runner === 'playwright',
      ),
    ).toBe(false);

    // Import-less describe/it under `globals: true` are registrations,
    // so the spread config leaves no unresolved alias and the inventory
    // can seal again.
    expect(catalog.unresolved.some((gap) => gap.code === 'unresolved-test-alias')).toBe(false);
    expect(catalog.inventoryComplete).toBe(true);
  });

  it('keeps a file no runner claims as a blocking gap on the configured runner', async () => {
    const root = makeMixedProject({
      'frontend/src/stray.spec.js': [
        "import { test } from 'playwright/test';",
        "test('stray journey', async ({ page }) => {});",
        '',
      ].join('\n'),
    });
    const { catalog } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['tests/e2e/**/*.spec.js', 'frontend/src/**/*.spec.js']),
    });
    const stray = catalog.entries.find((entry) => entry.file === 'frontend/src/stray.spec.js');
    expect(stray?.runner).toBe('playwright');
    expect(stray?.discoveryStatus).toBe('unresolved');
    expect(stray?.unresolvedReason?.code).toBe('reconciliation-static-only');
    expect(stray?.weakSignals.some((signal) => signal.ruleId === 'no-runner-claims-file')).toBe(true);
    expect(catalog.inventoryComplete).toBe(false);
    expect(
      catalog.runnerSummaries.find((summary) => summary.runner === 'playwright')?.detail,
    ).toContain('claimed by no runner');
  });
});

describe('the project-graph reporter carries the IMPLICIT project selection', () => {
  it('records a project-less config selection under the ids placeholder', () => {
    // A config with a top-level `testMatch` and no `projects` array gets
    // the runner's implicit project, which the reporter used to skip: no
    // testFileScope reached the catalog, so a static row outside the
    // runner's own selection still looked like the runner's test.
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-graph-'));
    tempDirs.push(dir);
    const graphPath = join(dir, 'graph.json');
    process.env[PROJECT_GRAPH_PATH_ENV] = graphPath;
    new ProjectGraphReporter().onConfigure({
      projects: [
        { name: '', testDir: dir, testMatch: ['tests/e2e/**/*.spec.js'], testIgnore: [] },
      ],
    } as never);
    delete process.env[PROJECT_GRAPH_PATH_ENV];

    const implicit = JSON.parse(readFileSync(graphPath, 'utf8')) as ProjectGraphDocument;
    expect(implicit.testFileScope).toEqual([
      { name: '-', testDir: dir, testMatch: ['tests/e2e/**/*.spec.js'], testIgnore: [] },
    ]);
    // The implicit project adds no node to the dependency graph: it is not
    // a plannable project, only a selection to honor.
    expect(implicit.projectDependencies).toEqual({});

    const namedPath = join(dir, 'graph-named.json');
    process.env[PROJECT_GRAPH_PATH_ENV] = namedPath;
    new ProjectGraphReporter().onConfigure({
      projects: [
        { name: 'chromium', testDir: dir, testMatch: ['**/*.spec.js'], testIgnore: ['**/skip/**'] },
      ],
    } as never);
    delete process.env[PROJECT_GRAPH_PATH_ENV];
    const named = JSON.parse(readFileSync(namedPath, 'utf8')) as ProjectGraphDocument;
    expect(named.testFileScope).toEqual([
      { name: 'chromium', testDir: dir, testMatch: ['**/*.spec.js'], testIgnore: ['**/skip/**'] },
    ]);
  });
});