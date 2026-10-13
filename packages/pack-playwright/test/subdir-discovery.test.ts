/**
 * Subdirectory playwright project discovery (monorepo/subdirectory
 * layout): a consumer may keep playwright self-contained in ONE
 * subdirectory (`e2e/` with its own `playwright.config.ts` and its own
 * `node_modules/playwright`, at its own version). Covered here:
 *
 * - config discovery: root first, then two directory levels deep
 *   (pruned dirs skipped, alphabetical first match, repo-relative path);
 * - native enumeration runs the way the OWNER runs it: from the config
 *   directory, with the CLI found in THAT directory (subdir candidates,
 *   then repo-root candidates, then the pack's own) and `--config`
 *   naming the config as seen from that cwd (root-level invocations
 *   stay byte-identical: repo-root cwd, auto-discovered config);
 * - instance path normalization: subdirectory-project instances are
 *   repo-relative (`e2e/scenarios/x.spec.js`), so reconciliation binds
 *   against the static scan's repo-relative rows;
 * - root-level repos unchanged (regression lock).
 *
 * The CLI invocation contract is asserted with a FAKE playwright CLI
 * (records cwd + argv, prints a canned JSON-reporter document), and the
 * real installed playwright proves the actual `--list` round trip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type GateforgeConfig } from '@gate-forge/core';
import {
  discoverTestCatalog,
  findPlaywrightConfig,
  findPlaywrightConfigs,
  listNativePlaywrightTests,
  reconciliationKey,
  scanTestFiles,
} from '../src/discovery/index.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Temp dirs to remove after each test. */
const tempDirs: string[] = [];

function makeTempDir(prefix = 'gateforge-subdir-'): string {
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
    project: { languages: ['typescript'], paths: { include, exclude: [] } },
    plugins: [],
    policies: '.gateforge/policies.yml',
    classificationPolicy: '.gateforge/classification-policy.yml',
    adapters: '.gateforge/adapters',
    waivers: '.gateforge/waivers',
    baselines: '.gateforge/baselines/obligations.json',
    // 0.11.0: the REQUIRED `scan:` section (was the answers document's
    // scanner keys). `scanRoots` rides the `include` globs.
    scan: { scanRoots: include, declarations: { internality: 'gateforge:internal' }, volatileFields: [] },
    changed: { provider: 'auto' },
    witness: { maxDurationSeconds: 5 },
    clock: { mode: 'fixed', fixedAt: '2026-01-01T00:00:00.000Z' },
  });
}

/** The static spec file shared by the fixtures below. */
const SPEC = [
  "import { test } from 'playwright/test';",
  "test.describe('Scenarios', () => {",
  "  test('subdir journey', async () => {});",
  '});',
  '',
].join('\n');

/** A canned JSON-reporter `--list` document for SPEC. */
function listDocument(rootDir: string, file: string): Record<string, unknown> {
  return {
    config: { rootDir },
    suites: [
      {
        title: 'chromium',
        suites: [
          {
            title: '',
            file,
            suites: [{ title: 'Scenarios', suites: [], specs: [subdirSpec(file)] }],
            specs: [],
          },
        ],
        specs: [],
      },
    ],
    errors: [],
  };
}

/** The single canned spec node. */
function subdirSpec(file: string): Record<string, unknown> {
  return {
    title: 'subdir journey',
    id: 'x.spec.js#subdir-journey',
    file,
    line: 3,
    column: 9,
    tests: [
      { projectId: 'chromium', projectName: 'chromium', expectedStatus: 'passed', annotations: [] },
    ],
  };
}

/**
 * Writes a FAKE playwright CLI: records `{cwd, argv}` (the runner
 * invocation) into `recordPath`, then prints the canned reporter
 * document on stdout — the exact contract `listNativePlaywrightTests`
 * consumes.
 */
function writeFakeCli(path: string, recordPath: string, document: Record<string, unknown>): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const source = [
    '// Fake playwright CLI (fixture): records the invocation, then emits',
    '// a canned JSON-reporter document (list-mode contract).',
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(1) }));`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(document))});`,
    '',
  ].join('\n');
  writeFileSync(path, source, 'utf8');
}

/** Reads one recorded fake-CLI invocation. */
function readInvocation(recordPath: string): { cwd: string; argv: string[] } {
  return JSON.parse(readFileSync(recordPath, 'utf8')) as { cwd: string; argv: string[] };
}

describe('findPlaywrightConfig (root first, then two levels deep)', () => {
  it('finds a root-level config first and returns its repo-relative path', () => {
    const root = makeTempDir();
    writeTree(root, {
      'playwright.config.ts': 'export default {};\n',
      'e2e/playwright.config.ts': 'export default {};\n', // must NOT win
    });
    expect(findPlaywrightConfig(root)).toBe('playwright.config.ts');
  });

  it('finds a subdirectory config when no root config exists (repo-relative posix path)', () => {
    const root = makeTempDir();
    writeTree(root, { 'e2e/playwright.config.ts': 'export default {};\n' });
    expect(findPlaywrightConfig(root)).toBe('e2e/playwright.config.ts');
  });

  it('takes the alphabetically first subdirectory match', () => {
    const root = makeTempDir();
    writeTree(root, {
      'b-e2e/playwright.config.ts': 'export default {};\n',
      'a-e2e/playwright.config.js': 'export default {};\n',
    });
    expect(findPlaywrightConfig(root)).toBe('a-e2e/playwright.config.js');
  });

  it('skips dependency/build/VCS/runner directories', () => {
    const root = makeTempDir();
    writeTree(root, {
      'node_modules/playwright.config.ts': 'export default {};\n',
      'dist/playwright.config.ts': 'export default {};\n',
      '.git/playwright.config.ts': 'export default {};\n',
      'test-results/playwright.config.ts': 'export default {};\n',
      'coverage/playwright.config.ts': 'export default {};\n',
      'build/playwright.config.ts': 'export default {};\n',
      'scenarios/playwright.config.mts': 'export default {};\n',
    });
    expect(findPlaywrightConfig(root)).toBe('scenarios/playwright.config.mts');
  });

  it('searches two levels breadth-first and reports every eligible config', () => {
    const root = makeTempDir();
    writeTree(root, {
      'apps/web/playwright.config.ts': 'export default {};\n',
      'z/e2e/playwright.config.js': 'export default {};\n',
    });
    expect(findPlaywrightConfig(root)).toBe('apps/web/playwright.config.ts');
    writeTree(root, { 'z/playwright.config.ts': 'export default {};\n' });
    expect(findPlaywrightConfig(root)).toBe('z/playwright.config.ts');
    writeTree(root, { 'playwright.config.ts': 'export default {};\n' });
    expect(findPlaywrightConfigs(root)).toEqual([
      'playwright.config.ts', 'z/playwright.config.ts',
      'apps/web/playwright.config.ts', 'z/e2e/playwright.config.js',
    ]);
  });

  it('prunes dependency, hidden and Python directories at every level', () => {
    const root = makeTempDir();
    const pruned = ['node_modules', 'dist', '.cache', '.venv', 'venv', '__pycache__',
      '.git', 'test-results', 'coverage', 'build'];
    for (const directory of pruned) {
      writeTree(root, {
        [`${directory}/web/playwright.config.ts`]: 'export default {};\n',
        [`apps/${directory}/playwright.config.ts`]: 'export default {};\n',
      });
    }
    writeTree(root, { 'apps/web/playwright.config.ts': 'export default {};\n' });
    expect(findPlaywrightConfigs(root)).toEqual(['apps/web/playwright.config.ts']);
  });

  it('returns null when neither the root nor two levels deep has a config', () => {
    const root = makeTempDir();
    writeTree(root, { 'e2e/scenarios/x.spec.ts': SPEC, 'src/app.ts': 'export const app = 1;\n' });
    expect(findPlaywrightConfig(root)).toBe(null);
  });
});

describe('native enumeration of a subdirectory project (fake CLI contract)', () => {
  it('runs from the config directory with the config-directory CLI and --config', async () => {
    const root = makeTempDir();
    const recordPath = join(root, 'invocation.json');
    const e2eDir = join(root, 'e2e');
    // Fake CLIs in BOTH the config directory and the repo root: the
    // config-directory one must win. The root one emits nothing (a
    // wrong pick would fail the run as unparseable output).
    writeFakeCli(join(e2eDir, 'node_modules/playwright/cli.js'), recordPath, listDocument(e2eDir, join(e2eDir, 'scenarios/x.spec.js')));
    writeFakeCli(join(root, 'node_modules/playwright/cli.js'), join(root, 'wrong.json'), { suites: [] });
    writeTree(root, { 'e2e/playwright.config.ts': 'export default {};\n', 'e2e/scenarios/x.spec.js': SPEC });

    const result = await listNativePlaywrightTests({ cwd: root });

    expect(result.status).toBe('discovered');
    expect(result.instances).toHaveLength(1);
    const invocation = readInvocation(recordPath);
    // The runner ran the way the OWNER runs it: cwd = the config's
    // directory, CLI = the config directory's own install, `--config`
    // naming the config as seen from that cwd.
    expect(invocation.cwd).toBe(e2eDir);
    expect(invocation.argv[0]).toBe(join(e2eDir, 'node_modules', 'playwright', 'cli.js'));
    // The reporter LIST is the enumeration's own business (the json
    // report plus the engine's project-graph reporter); what this test
    // owns is the runner invocation around it.
    expect(invocation.argv.slice(1).filter((arg) => !arg.startsWith('--reporter='))).toEqual([
      'test',
      '--list',
      '--config',
      'playwright.config.ts',
    ]);
    expect(invocation.argv.some((arg) => arg.startsWith('--reporter=json'))).toBe(true);
    // Instance paths are repo-relative (config directory prefixed), so
    // they reconcile against the static scan's rows.
    expect(result.instances[0]?.file).toBe('e2e/scenarios/x.spec.js');
    expect(result.instances[0]?.titlePath).toEqual(['Scenarios', 'subdir journey']);
    expect(result.instances[0]?.project).toBe('chromium');
    expect(result.detail).toContain("over 'e2e/playwright.config.ts' (cwd 'e2e')");
  });

  it('prefers the config directory @playwright/test CLI over its playwright CLI and the root', async () => {
    const root = makeTempDir();
    const recordPath = join(root, 'invocation.json');
    const e2eDir = join(root, 'e2e');
    // Resolution order within the config directory: playwright first,
    // then @playwright/test — here only @playwright/test exists, and it
    // must beat the repo root's playwright CLI.
    writeFakeCli(join(e2eDir, 'node_modules/@playwright/test/cli.js'), recordPath, listDocument(e2eDir, join(e2eDir, 'scenarios/x.spec.js')));
    writeFakeCli(join(root, 'node_modules/playwright/cli.js'), join(root, 'wrong.json'), { suites: [] });
    writeTree(root, { 'e2e/playwright.config.ts': 'export default {};\n', 'e2e/scenarios/x.spec.js': SPEC });

    const result = await listNativePlaywrightTests({ cwd: root });

    expect(result.status).toBe('discovered');
    const invocation = readInvocation(recordPath);
    expect(invocation.argv[0]).toBe(join(e2eDir, 'node_modules', '@playwright', 'test', 'cli.js'));
  });

  it('falls back to the repo-root CLI when the config directory has none', async () => {
    const root = makeTempDir();
    const recordPath = join(root, 'invocation.json');
    const e2eDir = join(root, 'e2e');
    writeFakeCli(join(root, 'node_modules/playwright/cli.js'), recordPath, listDocument(e2eDir, join(e2eDir, 'scenarios/x.spec.js')));
    writeTree(root, { 'e2e/playwright.config.ts': 'export default {};\n', 'e2e/scenarios/x.spec.js': SPEC });

    const result = await listNativePlaywrightTests({ cwd: root });

    expect(result.status).toBe('discovered');
    const invocation = readInvocation(recordPath);
    // Still run from the config directory; only the CLI falls back.
    expect(invocation.cwd).toBe(e2eDir);
    expect(invocation.argv[0]).toBe(join(root, 'node_modules', 'playwright', 'cli.js'));
    expect(result.instances[0]?.file).toBe('e2e/scenarios/x.spec.js');
  });

  it('reconciles the subdirectory project against the static scan (matched, complete)', async () => {
    const root = makeTempDir();
    const recordPath = join(root, 'invocation.json');
    const e2eDir = join(root, 'e2e');
    writeFakeCli(join(e2eDir, 'node_modules/playwright/cli.js'), recordPath, listDocument(e2eDir, join(e2eDir, 'scenarios/x.spec.js')));
    writeTree(root, { 'e2e/playwright.config.ts': 'export default {};\n', 'e2e/scenarios/x.spec.js': SPEC });

    const scan = scanTestFiles({ cwd: root, include: ['e2e/**/*.spec.js'], exclude: [] });
    const { catalog } = await discoverTestCatalog({ cwd: root, config: fixtureConfig(['e2e/**/*.spec.js']) });

    // Match count equals the static playwright entry count — the
    // config-directory prefix normalization binds every row.
    const enumerated = catalog.entries.filter((entry) => entry.runner === 'playwright' && entry.discoveryStatus === 'discovered');
    expect(enumerated).toHaveLength(scan.entries.length);
    expect(
      enumerated.map((entry) => reconciliationKey(entry.file, entry.titlePath)).sort(),
    ).toEqual(scan.entries.map((entry) => reconciliationKey(entry.file, entry.titlePath)).sort());
    expect(enumerated.map((entry) => entry.reconciliation)).toEqual(['matched']);
    expect(catalog.inventoryComplete).toBe(true);
    expect(catalog.entries[0]?.logicalKey).toBe(
      'playwright:chromium:e2e/scenarios/x.spec.js:Scenarios>subdir journey',
    );
  });
});

describe('root-level repos unchanged (regression lock)', () => {
  it('keeps the historical invocation and repo-relative rows for a root config', async () => {
    const root = makeTempDir();
    const recordPath = join(root, 'invocation.json');
    writeFakeCli(join(root, 'node_modules/playwright/cli.js'), recordPath, listDocument(root, join(root, 'e2e/x.spec.js')));
    writeTree(root, {
      'playwright.config.ts': 'export default {};\n',
      // A decoy: even with a subdirectory config present, the root one
      // wins and the invocation is byte-identical to the historical one.
      'e2e/playwright.config.ts': 'export default {};\n',
      'e2e/x.spec.js': SPEC,
    });

    const result = await listNativePlaywrightTests({ cwd: root });

    expect(result.status).toBe('discovered');
    const invocation = readInvocation(recordPath);
    // Repo-root cwd, root CLI, NO --config (auto-discovered config).
    expect(invocation.cwd).toBe(root);
    expect(invocation.argv[0]).toBe(join(root, 'node_modules', 'playwright', 'cli.js'));
    expect(invocation.argv.slice(1).filter((arg) => !arg.startsWith('--reporter='))).toEqual(['test', '--list']);
    expect(invocation.argv.some((arg) => arg.startsWith('--reporter=json'))).toBe(true);
    expect(result.instances[0]?.file).toBe('e2e/x.spec.js');
    expect(result.detail).toContain("over 'playwright.config.ts' enumerated");
    expect(result.detail).not.toContain('(cwd');

    const { catalog } = await discoverTestCatalog({ cwd: root, config: fixtureConfig(['e2e/**/*.spec.js']) });
    expect(catalog.entries.filter((entry) => entry.reconciliation === 'matched')).toHaveLength(1);
    expect(catalog.inventoryComplete).toBe(true);
    expect(catalog.entries[0]?.logicalKey).toBe('playwright:chromium:e2e/x.spec.js:Scenarios>subdir journey');
  });
});

/**
 * A repo may hold several playwright configs; enumeration runs exactly
 * one of them. Narrowing to a subset silently grades less than the
 * suite, so the choice is ALWAYS reported in the same plain line: every
 * discovered config, which one was used, why that one, and which are
 * not inventoried.
 */
describe('several playwright configs are never narrowed silently', () => {
  it('names every config, the one used and the reason (a repo-root config wins)', async () => {
    const root = makeTempDir();
    const recordPath = join(root, 'invocation.json');
    writeFakeCli(join(root, 'node_modules/playwright/cli.js'), recordPath, listDocument(root, join(root, 'e2e/x.spec.js')));
    writeTree(root, {
      'playwright.config.ts': 'export default {};\n',
      'e2e/playwright.config.ts': 'export default {};\n',
      'e2e/x.spec.js': SPEC,
    });

    const result = await listNativePlaywrightTests({ cwd: root });

    expect(result.status).toBe('discovered');
    // The one line the catalog prints must carry the whole choice.
    expect(result.detail).toBe(
      "native playwright --list over 'playwright.config.ts' enumerated 1 instance(s) as untrusted code " +
        '(isolated temporary GATEFORGE_STATE_DIR) — note: 2 playwright configs are present, and only 1 is ' +
        "inventoried: playwright.config.ts (inventoried: a repo-root config always wins, so a root project " +
        "keeps its exact invocation), e2e/playwright.config.ts (not inventoried: its test cases are " +
        'missing from this catalog)',
    );
  });

  it('names every config when a subdirectory config wins (alphabetically first)', async () => {
    const root = makeTempDir();
    const recordPath = join(root, 'invocation.json');
    const aDir = join(root, 'a-e2e');
    writeFakeCli(join(aDir, 'node_modules/playwright/cli.js'), recordPath, listDocument(aDir, join(aDir, 'x.spec.js')));
    writeTree(root, {
      'a-e2e/playwright.config.js': 'export default {};\n',
      'a-e2e/x.spec.js': SPEC,
      'b-e2e/playwright.config.js': 'export default {};\n',
      'b-e2e/y.spec.js': SPEC,
    });

    const result = await listNativePlaywrightTests({ cwd: root });

    expect(result.status).toBe('discovered');
    expect(result.detail).toContain('a-e2e/playwright.config.js (inventoried');
    expect(result.detail).toContain('no repo-root config exists');
    expect(result.detail).toContain('b-e2e/playwright.config.js (not inventoried');
    expect(result.detail.match(/not inventoried/g)).toHaveLength(1);
  });

  it('reports no choice at all for a repo with exactly one config', async () => {
    const root = makeTempDir();
    const recordPath = join(root, 'invocation.json');
    const e2eDir = join(root, 'e2e');
    writeFakeCli(join(e2eDir, 'node_modules/playwright/cli.js'), recordPath, listDocument(e2eDir, join(e2eDir, 'scenarios/x.spec.js')));
    writeTree(root, { 'e2e/playwright.config.ts': 'export default {};\n', 'e2e/scenarios/x.spec.js': SPEC });

    const result = await listNativePlaywrightTests({ cwd: root });

    // A single config is not a decision: the historical line is
    // unchanged (no note, no noise).
    expect(result.detail).toBe(
      "native playwright --list over 'e2e/playwright.config.ts' (cwd 'e2e') enumerated 1 instance(s) as " +
        'untrusted code (isolated temporary GATEFORGE_STATE_DIR)',
    );
  });
});

/**
 * The real installed playwright (pack dependency) proves the actual
 * `--list` round trip from a subdirectory: config loaded from that cwd,
 * specs resolved through the config directory's node_modules, instances
 * reported repo-relative. The repo root's CLI is a broken decoy —
 * exactly the consumer shape (partial root install, healthy e2e
 * install) that makes config-directory CLI resolution load-bearing.
 */
describe('subdirectory project against the real playwright CLI', () => {
  function makeSubdirPlaywrightProject(files: Record<string, string>): string {
    const root = makeTempDir('gateforge-pw-subdir-');
    mkdirSync(join(root, 'e2e/node_modules'), { recursive: true });
    for (const name of ['playwright', 'playwright-core']) {
      symlinkSync(join(ROOT, 'node_modules', name), join(root, 'e2e/node_modules', name), 'dir');
    }
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      // Broken decoy where the ROOT candidates would look: a wrong
      // resolution order dies here instead of enumerating.
      'node_modules/playwright/cli.js': 'process.exit(7);\n',
      'e2e/playwright.config.js': "export default { testDir: '.', projects: [{ name: 'chromium' }] };\n",
      ...files,
    });
    return root;
  }

  it('enumerates from the config directory and normalizes instance paths (repo-relative)', async () => {
    const root = makeSubdirPlaywrightProject({ 'e2e/scenarios/x.spec.js': SPEC });
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('discovered');
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]?.file).toBe('e2e/scenarios/x.spec.js');
    expect(result.instances[0]?.titlePath).toEqual(['Scenarios', 'subdir journey']);
    expect(result.instances[0]?.project).toBe('chromium');

    const { catalog } = await discoverTestCatalog({ cwd: root, config: fixtureConfig(['e2e/**/*.spec.js']) });
    expect(catalog.inventoryComplete).toBe(true);
    expect(catalog.entries.map((entry) => [entry.discoveryStatus, entry.reconciliation])).toEqual([
      ['discovered', 'matched'],
    ]);
    expect(catalog.entries[0]?.file).toBe('e2e/scenarios/x.spec.js');
  });
});

/** Guards the temp-dir budget: discovery fixtures must clean up. */
readdirSync(tmpdir()).filter((name) => name.startsWith('gateforge-'));
