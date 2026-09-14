/**
 * Discovery tests (plan 2026-09-13 phase 2): bounded static scanning
 * (extend chains, wrappers, signals, parse errors, parameterization,
 * budgets), the pure inference rules, native `--list` reconciliation
 * (match / list-only / static-only / unavailable), the pytest adapter's
 * XML parsing + bounded collection, and the adapter capability
 * contract. `engine` class except the reconciliation spec, which runs
 * the installed playwright CLI in list mode against a TEMP project
 * (no browsers launched, no network).
 */
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type GateforgeConfig } from '@gateforge/core';
import {
  collectPytestSuite,
  discoverTestCatalog,
  inferTestKind,
  JunitParseError,
  listNativePlaywrightTests,
  parseJunitXml,
  PlaywrightAdapter,
  pytestCollectArgv,
  pytestExecutionArgv,
  scanTestFiles,
  TestDiscoveryError,
  untrustedEnv,
} from '../src/discovery/index.js';
import { AdapterCapabilityError } from '../src/discovery/adapters.js';
import { buildPack } from './helpers.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Temp dirs to remove after each test. */
const tempDirs: string[] = [];

function makeTempDir(prefix = 'gateforge-discovery-'): string {
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

describe('static discovery', () => {
  it('resolves test.extend chains through the import graph into full titlePaths', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/helpers.ts': [
        "import { test as base } from 'playwright/test';",
        'export const test = base.extend({});',
        '',
      ].join('\n'),
      'e2e/accounts.spec.ts': [
        "import { test } from './helpers';",
        'test.describe("Accounts", () => {',
        '  test.describe("creation", () => {',
        "    test('creates an account', async ({ page }) => {",
        '      await page.goto("/accounts");',
        '    });',
        '  });',
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(result.parseErrors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.file).toBe('e2e/accounts.spec.ts');
    expect(entry?.titlePath).toEqual(['Accounts', 'creation', 'creates an account']);
    expect(entry?.facts.signatureParams).toEqual(['page']);
    expect(result.budgetExceeded).toBe(false);
  });

  it('records an unresolvable wrapper call as an unresolved entry with its location', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/wrapper.spec.ts': [
        "import { makeJourney } from './journey-factory';",
        'const journey = makeJourney();',
        "journey('deletes an account', async ({ page }) => {});",
        '',
      ].join('\n'),
      'e2e/journey-factory.ts': 'export function makeJourney(): unknown { return undefined; }\n',
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(result.entries).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    const gap = result.unresolved[0];
    expect(gap?.code).toBe('unresolved-wrapper');
    expect(gap?.titlePath).toEqual(['deletes an account']);
    expect(gap?.location.file).toBe('e2e/wrapper.spec.ts');
    expect(gap?.location.line).toBe(3);
  });

  it('records calls through names outside the scanned set as unresolved-test-alias', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/aliased.spec.ts': [
        "import { scenario } from './does-not-exist';",
        "scenario('renamed journey', async () => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    // The missing import itself is a gap, and the call through the
    // unresolvable name is a visible row — never an omission.
    expect(result.unresolved.some((gap) => gap.code === 'unresolved-import')).toBe(true);
    expect(result.unresolved.some((gap) => gap.code === 'unresolved-test-alias' && gap.titlePath[0] === 'renamed journey')).toBe(true);
  });

  it('does not record event-listener/interception calls as unprovable test shapes (consumer E22)', () => {
    const root = makeTempDir();
    writeTree(root, {
      // Ordinary product code: listener registrations carry a string
      // first argument + callback — their ordinary shape, never a test.
      'src/graph.jsx': [
        "export function bind(cy, setContextMenu) {",
        "  cy.on('tap', 'node', (evt) => { setContextMenu(evt); });",
        "  cy.on('tap', (evt) => { if (evt.target === cy) setContextMenu(null); });",
        "  cy.once('mouseover', () => {});",
        "  return cy;",
        '}',
        '',
      ].join('\n'),
      'e2e/real.spec.ts': [
        "import { test } from 'playwright/test';",
        "test('real test stays visible', async ({ page }) => {",
        "  page.route('**/api/**', (route) => route.continue());",
        '  await page.goto("/");',
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['src/**/*.jsx', 'e2e/**/*.ts'], exclude: [] });
    // The listener shapes produce NO phantom unresolved rows — a scanned
    // product file full of `.on(...)` calls must not flood (or, via
    // duplicate keys, crash) the catalog.
    expect(result.unresolved).toHaveLength(0);
    expect(result.entries.map((entry) => entry.title)).toEqual(['real test stays visible']);
  });

  it('merges duplicate unresolved rows (same file, same placeholder title) into one typed row', async () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/computed.spec.ts': [
        "import { test } from 'playwright/test';",
        'const a = String(Math.random());',
        'const b = String(Math.random());',
        'test(a, () => {});',
        'test(b, () => {});',
        '',
      ].join('\n'),
    });
    // The RAW scan keeps every computed-title call visible...
    const scan = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(scan.unresolved.filter((gap) => gap.code === 'dynamic-title').length).toBe(2);
    // ...and the catalog MERGES them deterministically (line numbers are
    // not identity, §5.2) instead of crashing the strict schema.
    const { catalog } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['e2e/**/*.ts']),
    });
    const unresolvedRows = catalog.entries.filter((entry) => entry.discoveryStatus === 'unresolved');
    expect(unresolvedRows).toHaveLength(1);
    expect(unresolvedRows[0]?.unresolvedReason?.detail).toContain('further call sites');
    expect(catalog.inventoryComplete).toBe(false);
  });

  it('records skip/only/fixme signals from modifiers, describes, and bodies', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/signals.spec.ts': [
        "import { test } from 'playwright/test';",
        "test.skip('skipped at declaration', () => {});",
        "test.only('focused', () => {});",
        "test.fixme('known broken', () => {});",
        'test.describe.skip("skipped suite", () => {',
        "  test('inherited skip', () => {});",
        '});',
        "test('conditionally skipped', () => {",
        '  test.skip();',
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    const byTitle = new Map(result.entries.map((entry) => [entry.title, entry]));
    expect(byTitle.get('skipped at declaration')?.signals.some((signal) => signal.kind === 'skip')).toBe(true);
    expect(byTitle.get('focused')?.signals.some((signal) => signal.kind === 'only')).toBe(true);
    expect(byTitle.get('known broken')?.signals.some((signal) => signal.kind === 'fixme')).toBe(true);
    expect(byTitle.get('inherited skip')?.signals.some((signal) => signal.kind === 'skip')).toBe(true);
    expect(byTitle.get('conditionally skipped')?.signals.some((signal) => signal.kind === 'skip')).toBe(true);
  });

  it('records parser failures with locations and still scans other files', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/broken.spec.ts': [
        "import { test } from 'playwright/test';",
        'const = ;',
        '',
      ].join('\n'),
      'e2e/fine.spec.ts': [
        "import { test } from 'playwright/test';",
        "test('fine', () => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]?.location.file).toBe('e2e/broken.spec.ts');
    expect(result.parseErrors[0]?.location.line).toBe(2);
    expect(result.entries.map((entry) => entry.title)).toEqual(['fine']);
  });

  it('records parameterized cases via parameterIdentity', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/param.spec.ts': [
        "import { test } from 'playwright/test';",
        'const cases = [1, 2];',
        "test.each(cases)('adds %s', async () => {});",
        'for (const value of cases) {',
        '  test(`adds ${value}`, async () => {});',
        '}',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    const eachEntry = result.entries.find((entry) => entry.title === 'adds %s');
    expect(eachEntry?.parameterIdentity).toBe('each');
    const templateEntry = result.entries.find((entry) => entry.title === 'adds ${}');
    expect(templateEntry?.parameterIdentity).toBe('template');
  });

  it('cuts import traversal at the budget and records traversal-budget-exceeded', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/a.ts': "export { test } from './b';\n",
      'e2e/b.ts': "export { test } from './c';\n",
      'e2e/c.ts': "export { test } from 'playwright/test';\n",
      'e2e/spec.ts': [
        "import { test } from './a';",
        "test('deep chain', () => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({
      cwd: root,
      include: ['e2e/**/*.ts'],
      exclude: [],
      budget: { maxTraversedFiles: 1, maxImportDepth: 2 },
    });
    expect(result.budgetExceeded).toBe(true);
    expect(result.unresolved.some((gap) => gap.code === 'traversal-budget-exceeded')).toBe(true);
  });

  it('honors exclude globs and deterministic ordering', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/zz.spec.ts': "import { test } from 'playwright/test';\ntest('b', () => {});\n",
      'e2e/aa.spec.ts': "import { test } from 'playwright/test';\ntest('a', () => {});\n",
      'e2e/skip-me.spec.ts': "import { test } from 'playwright/test';\ntest('excluded', () => {});\n",
    });
    const result = scanTestFiles({
      cwd: root,
      include: ['e2e/**/*.ts'],
      exclude: ['e2e/skip-me.spec.ts'],
    });
    expect(result.entries.map((entry) => [entry.file, entry.title])).toEqual([
      ['e2e/aa.spec.ts', 'a'],
      ['e2e/zz.spec.ts', 'b'],
    ]);
  });
});

describe('kind/category inference rules', () => {
  const baseFacts = {
    pageRoute: null,
    httpClientCall: null,
    fileHttpClientCall: null,
    fileMockImport: null,
  };

  it('browser fixture fires browser-e2e', () => {
    const result = inferTestKind({
      file: 'e2e/a.spec.ts',
      title: 'opens the app',
      titlePath: ['opens the app'],
      facts: { ...baseFacts, signatureParams: ['page'] },
    });
    expect(result.inferredKind).toBe('browser-e2e');
    expect(result.kindSignals[0]?.ruleId).toBe('browser-fixture');
  });

  it('request fixture fires api-e2e', () => {
    const result = inferTestKind({
      file: 'e2e/api.spec.ts',
      title: 'calls the service',
      titlePath: ['calls the service'],
      facts: { ...baseFacts, signatureParams: ['request'] },
    });
    expect(result.inferredKind).toBe('api-e2e');
    expect(result.kindSignals[0]?.ruleId).toBe('api-request-fixture');
  });

  it('an http client call fires api-e2e even without fixtures', () => {
    const where = { file: 'e2e/a.spec.ts', line: 4, col: 2 };
    const result = inferTestKind({
      file: 'e2e/a.spec.ts',
      title: 'fetches accounts',
      titlePath: ['fetches accounts'],
      facts: { ...baseFacts, signatureParams: [], httpClientCall: where },
    });
    expect(result.inferredKind).toBe('api-e2e');
    expect(result.kindSignals[0]?.ruleId).toBe('http-client-call');
  });

  it('network-less fixture-less tests get the unit hint', () => {
    const result = inferTestKind({
      file: 'src/format.test.ts',
      title: 'formats a date',
      titlePath: ['formats a date'],
      facts: { ...baseFacts, signatureParams: [] },
    });
    expect(result.inferredKind).toBe('unit');
    expect(result.kindSignals[0]?.ruleId).toBe('networkless-unit');
  });

  it('conflicting rules resolve to unknown with the conflict recorded', () => {
    const result = inferTestKind({
      file: 'e2e/mixed.spec.ts',
      title: 'mixed probe',
      titlePath: ['mixed probe'],
      facts: { ...baseFacts, signatureParams: ['page', 'request'] },
    });
    expect(result.inferredKind).toBe('unknown');
    expect(result.rulesFired.some((rule) => rule.ruleId === 'kind-conflict')).toBe(true);
  });

  it('title/folder hints stay weak and never decide the kind', () => {
    const result = inferTestKind({
      file: 'tests/e2e/pure.spec.ts',
      title: 'e2e style pure function',
      titlePath: ['e2e style pure function'],
      facts: { ...baseFacts, signatureParams: [] },
    });
    expect(result.inferredKind).toBe('unit');
    expect(result.weakSignals.length).toBeGreaterThan(0);
    expect(result.kindSignals.map((signal) => signal.ruleId)).toEqual(['networkless-unit']);
  });

  it('page.route and module mocks become mock signals, not kinds', () => {
    const routeAt = { file: 'e2e/mock.spec.ts', line: 3, col: 4 };
    const mockAt = { file: 'e2e/mock.spec.ts', line: 1, col: 0 };
    const result = inferTestKind({
      file: 'e2e/mock.spec.ts',
      title: 'renders with mocks',
      titlePath: ['renders with mocks'],
      facts: { ...baseFacts, signatureParams: ['page'], pageRoute: routeAt, fileMockImport: mockAt },
    });
    expect(result.inferredKind).toBe('browser-e2e');
    expect(result.mockSignals.map((signal) => signal.kind)).toEqual(['mock', 'mock']);
    expect(result.rulesFired.some((rule) => rule.ruleId === 'mock-page-route')).toBe(true);
    expect(result.rulesFired.some((rule) => rule.ruleId === 'mock-module-import')).toBe(true);
  });

  it('category keywords produce hint labels only', () => {
    const result = inferTestKind({
      file: 'e2e/crud.spec.ts',
      title: 'creates then deletes an account',
      titlePath: ['creates then deletes an account'],
      facts: { ...baseFacts, signatureParams: ['page'] },
    });
    expect(result.categorySignals.map((signal) => signal.label).sort()).toEqual([
      'persistence.create',
      'persistence.delete',
    ]);
  });
});

describe('native playwright reconciliation', () => {
  /** Builds a temp playwright project the engine's playwright can list. */
  function makePlaywrightProject(files: Record<string, string>): string {
    const root = makeTempDir('gateforge-pw-list-');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    for (const name of ['playwright', 'playwright-core']) {
      symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
    }
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'playwright.config.js': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
      ...files,
    });
    return root;
  }

  it('enumerates unannotated and skipped tests with projects (official --list)', async () => {
    const root = makePlaywrightProject({
      'e2e/accounts.spec.js': [
        "import { test } from 'playwright/test';",
        'test.describe("Accounts", () => {',
        "  test('creates an account', async () => {});",
        '});',
        "test.skip('skipped journey', async () => {});",
        '',
      ].join('\n'),
    });
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('discovered');
    // Native list order walks the suite tree; compare as a set.
    expect(
      result.instances.map((instance) => instance.titlePath).map((path) => path.join('>')).sort(),
    ).toEqual(['Accounts>creates an account', 'skipped journey']);
    expect(result.instances.every((instance) => instance.project === 'chromium')).toBe(true);
    const skipped = result.instances.find((instance) => instance.title === 'skipped journey');
    expect(skipped?.annotations).toContain('skip');
  });

  it('is unavailable without a playwright config (not an error)', async () => {
    const root = makeTempDir('gateforge-no-pw-');
    writeTree(root, { 'src/app.ts': 'export const app = 1;\n' });
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('reconciliation: unavailable — no playwright config');
    expect(result.instances).toEqual([]);
  });

  it('fails typed when the invocation exceeds its timeout', async () => {
    const root = makePlaywrightProject({
      'e2e/ok.spec.js': "import { test } from 'playwright/test';\ntest('t', () => {});\n",
    });
    await expect(listNativePlaywrightTests({ cwd: root, timeoutMs: 1 })).rejects.toThrow(TestDiscoveryError);
  });

  it('strips every GATEFORGE_* variable for untrusted enumeration', () => {
    const child = untrustedEnv({
      PATH: '/usr/bin',
      GATEFORGE_WITNESS_VERIFIER_KEY: 'secret',
      GATEFORGE_RUN_TOKEN: 'token',
      UNRELATED: 'keep',
    });
    expect(child['GATEFORGE_WITNESS_VERIFIER_KEY']).toBeUndefined();
    expect(child['GATEFORGE_RUN_TOKEN']).toBeUndefined();
    expect(child['UNRELATED']).toBe('keep');
    expect(child['PATH']).toBe('/usr/bin');
  });

  it('reconciles exactly when static and native agree, deterministically', async () => {
    const root = makePlaywrightProject({
      'e2e/accounts.spec.js': [
        "import { test } from 'playwright/test';",
        "test('creates an account', async ({ page }) => {});",
        "test('deletes an account', async ({ page }) => {});",
        '',
      ].join('\n'),
    });
    const config = fixtureConfig(['e2e/**/*.spec.js']);
    const first = await discoverTestCatalog({ cwd: root, config });
    const second = await discoverTestCatalog({ cwd: root, config });
    expect(first.json).toBe(second.json);
    expect(first.catalog.inventoryComplete).toBe(true);
    expect(first.catalog.parseErrors).toEqual([]);
    expect(first.catalog.entries.map((entry) => [entry.discoveryStatus, entry.reconciliation])).toEqual([
      ['discovered', 'matched'],
      ['discovered', 'matched'],
    ]);
    // Instance identity: framework ids distinguish the runtime instance.
    const created = first.catalog.entries[0];
    expect(created?.project).toBe('chromium');
    expect(created?.parameterIdentity).toContain('#');
    // Deterministic logical keys per §5.2 (runner/project/file/titlePath).
    expect(created?.logicalKey).toBe('playwright:chromium:e2e/accounts.spec.js:creates an account');
  });

  it('discovers runner-only cases through the native list fallback (origin native-list)', async () => {
    const root = makePlaywrightProject({
      'e2e/listed.spec.js': "import { test } from 'playwright/test';\ntest('enumerated', () => {});\n",
      'e2e/hidden.spec.js': "import { test } from 'playwright/test';\ntest('outside configured globs', () => {});\n",
    });
    const config = fixtureConfig(['e2e/listed.spec.js']);
    const { catalog } = await discoverTestCatalog({ cwd: root, config });
    // The native runner PROVED the outside-glob case exists and will
    // execute it: the row is DISCOVERED with its resolution origin
    // labeled 'native-list' (weaker classification, never a fabricated
    // kind from absent facts) — visible and enforced, not unresolved.
    const listOnly = catalog.entries.filter((entry) => entry.reconciliation === 'list-only');
    expect(listOnly.map((entry) => entry.title)).toEqual(['outside configured globs']);
    expect(listOnly[0]?.discoveryStatus).toBe('discovered');
    expect(listOnly[0]?.resolutionOrigin).toBe('native-list');
    expect(listOnly[0]?.inferredKind).toBe('unknown');
    expect(listOnly[0]?.kindSignals).toEqual([]);
    expect(listOnly[0]?.weakSignals.some((signal) => signal.ruleId === 'native-list-only')).toBe(true);
    expect(listOnly[0]?.unresolvedReason).toBeUndefined();
    // The statically derived case carries the 'static' origin label.
    const matched = catalog.entries.filter((entry) => entry.reconciliation === 'matched');
    expect(matched.map((entry) => entry.resolutionOrigin)).toEqual(['static']);
    expect(catalog.inventoryComplete).toBe(true);
  });

  it('marks static-only cases the runner ignores as typed rows', async () => {
    const root = makeTempDir('gateforge-pw-staticonly-');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    for (const name of ['playwright', 'playwright-core']) {
      symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
    }
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'playwright.config.js':
        "export default { testDir: 'e2e', testIgnore: '**/ignored.spec.js', projects: [{ name: 'chromium' }] };\n",
      'e2e/listed.spec.js': "import { test } from 'playwright/test';\ntest('enumerated', () => {});\n",
      'e2e/ignored.spec.js': "import { test } from 'playwright/test';\ntest('runner ignores me', () => {});\n",
    });
    const config = fixtureConfig(['e2e/**/*.spec.js']);
    const { catalog } = await discoverTestCatalog({ cwd: root, config });
    const staticOnly = catalog.entries.filter((entry) => entry.reconciliation === 'static-only');
    expect(staticOnly.map((entry) => entry.title)).toEqual(['runner ignores me']);
    expect(staticOnly[0]?.unresolvedReason?.code).toBe('reconciliation-static-only');
    expect(staticOnly[0]?.discoveryStatus).toBe('unresolved');
    expect(staticOnly[0]?.resolutionOrigin).toBe('static');
    expect(catalog.inventoryComplete).toBe(false);
  });

  it('keeps inventory complete for a non-playwright repo with no rows', async () => {
    const root = makeTempDir('gateforge-nopw-repo-');
    writeTree(root, { 'src/app.py': 'x = 1\n' });
    const config = fixtureConfig(['src/**/*.py']);
    const { catalog } = await discoverTestCatalog({ cwd: root, config });
    expect(catalog.entries).toEqual([]);
    expect(catalog.inventoryComplete).toBe(true);
    expect(catalog.runnerSummaries[0]?.status).toBe('unavailable');
  });
});

/**
 * The documented consumer shape (plan 2026-09-13 E22, consumer-migration
 * record §5.1): playwright specs import the pack's exported runner
 * (`import { test as gateforgeTest } from '@gateforge/pack-playwright'`,
 * possibly through a consumer-local re-export module). The static scan
 * must follow those bindings — the supervised receipt-sealed run depends
 * on it — while every OTHER module-external import stays unresolved
 * (fail closed). The reconciliation spec runs the installed playwright
 * CLI against a TEMP project (no browsers, no network) and therefore
 * needs the pack's built dist.
 */
describe('pack-runner consumer binding (E22)', () => {
  beforeAll(() => {
    const build = buildPack();
    expect(build.status, `pack build failed:\n${build.stderr}`).toBe(0);
  });

  /** A playwright project that can also resolve the pack specifier. */
  function makePackConsumerProject(files: Record<string, string>): string {
    const root = makeTempDir('gateforge-pack-consumer-');
    mkdirSync(join(root, 'node_modules/@gateforge'), { recursive: true });
    for (const name of ['playwright', 'playwright-core']) {
      symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
    }
    symlinkSync(
      join(ROOT, 'node_modules', '@gateforge', 'pack-playwright'),
      join(root, 'node_modules', '@gateforge', 'pack-playwright'),
      'dir',
    );
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'playwright.config.js': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
      ...files,
    });
    return root;
  }

  const PACK_SPEC = [
    "import { test as gateforgeTest } from '@gateforge/pack-playwright';",
    "const test = gateforgeTest.extend({});",
    "test('creates an account through the rendered UI', async ({ evidence }) => {});",
    "test('archives the account through the rendered UI', async ({ evidence }) => {});",
    '',
  ].join('\n');

  it('statically binds the pack runner import and extends it into full entries', () => {
    const root = makeTempDir();
    writeTree(root, { 'e2e/accounts.spec.ts': PACK_SPEC });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(result.parseErrors).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.entries.map((entry) => [entry.title, entry.facts.signatureParams])).toEqual([
      ['archives the account through the rendered UI', ['evidence']],
      ['creates an account through the rendered UI', ['evidence']],
    ]);
  });

  it('follows a consumer-local re-export module of the pack runner', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/helpers.ts': "export { test } from '@gateforge/pack-playwright';\n",
      'e2e/accounts.spec.ts': [
        "import { test } from './helpers';",
        "test('journey through the local runner module', async ({ evidence }) => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(result.unresolved).toEqual([]);
    expect(result.entries.map((entry) => entry.title)).toEqual(['journey through the local runner module']);
  });

  it('binds the CJS require form of the pack runner', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/accounts.spec.ts': [
        "const { test } = require('@gateforge/pack-playwright');",
        "test('required runner journey', async ({ evidence }) => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(result.unresolved).toEqual([]);
    expect(result.entries.map((entry) => entry.title)).toEqual(['required runner journey']);
  });

  it('still fails closed on a genuinely unresolvable module-external binding', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/mystery.spec.ts': [
        "import { journey } from 'some-unknown-package';",
        "journey('unprovable journey', async ({ page }) => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(result.entries).toEqual([]);
    expect(result.unresolved.some((gap) => gap.code === 'unresolved-test-alias')).toBe(true);
  });

  it('reconciles the pack-runner consumer to a complete inventory (E22 shape)', async () => {
    const root = makePackConsumerProject({ 'e2e/accounts.spec.js': PACK_SPEC });
    const config = fixtureConfig(['e2e/**/*.spec.js']);
    const { catalog } = await discoverTestCatalog({ cwd: root, config });
    expect(catalog.inventoryComplete).toBe(true);
    expect(catalog.unresolved).toEqual([]);
    expect(catalog.entries.map((entry) => [entry.discoveryStatus, entry.reconciliation, entry.resolutionOrigin])).toEqual([
      ['discovered', 'matched', 'static'],
      ['discovered', 'matched', 'static'],
    ]);
    // The pack's evidence fixture proves a browser journey.
    expect(catalog.entries.every((entry) => entry.inferredKind === 'browser-e2e')).toBe(true);
    expect(catalog.entries[0]?.logicalKey).toBe(
      'playwright:chromium:e2e/accounts.spec.js:archives the account through the rendered UI',
    );
    // Deterministic across runs.
    const first = await discoverTestCatalog({ cwd: root, config });
    const second = await discoverTestCatalog({ cwd: root, config });
    expect(second.json).toBe(first.json);
  });
});

describe('pytest diagnostic adapter', () => {
  const suiteConfig = (overrides: Partial<Parameters<typeof pytestCollectArgv>[0]> = {}) =>
    ({
      name: 'backend-pytest',
      runner: 'pytest' as const,
      cwd: 'backend',
      argv: ['python3', '-m', 'pytest'],
      testPaths: ['tests'],
      timeoutMs: 10_000,
      ...overrides,
    }) as Parameters<typeof pytestCollectArgv>[0];

  it('composes collection and execution argv from the CONFIGURED command only', () => {
    const suite = suiteConfig();
    expect(pytestCollectArgv(suite)).toEqual(['python3', '-m', 'pytest', '--collect-only', '-q', 'tests']);
    const execution = pytestExecutionArgv(suite, '/repo/.gateforge/test-gates');
    expect(execution).toEqual([
      'python3',
      '-m',
      'pytest',
      '--junitxml=/repo/.gateforge/test-gates/diagnostics/backend-pytest.xml',
      'tests',
    ]);
  });

  it('parses junit XML outcomes incl. skips, xfail, and collection errors', () => {
    const xml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<testsuite name="pytest" tests="5" failures="1" errors="1" skipped="2">',
      '  <testcase classname="tests.test_email" name="test_sends_email" time="0.01"/>',
      '  <testcase classname="tests.test_email" name="test_fails" time="0.01">',
      '    <failure message="assert 1 == 2">assert 1 == 2</failure>',
      '  </testcase>',
      '  <testcase classname="tests.test_email" name="test_skipped" time="0.00">',
      '    <skipped type="pytest.skip" message="later">skip</skipped>',
      '  </testcase>',
      '  <testcase classname="tests.test_email" name="test_xfail" time="0.00">',
      '    <skipped type="pytest.xfail" message="known bug">xfail</skipped>',
      '  </testcase>',
      '  <testcase classname="pytest" name="pytest_collection" time="0.01">',
      '    <error message="collection error">ImportError</error>',
      '  </testcase>',
      '</testsuite>',
    ].join('\n');
    const document = parseJunitXml(xml);
    expect(document.suiteName).toBe('pytest');
    expect(document.cases.map((testCase) => testCase.outcome)).toEqual([
      'passed',
      'failed',
      'skipped',
      'skipped',
      'error',
    ]);
    const xfail = document.cases[3];
    expect(xfail?.skipType).toBe('pytest.xfail');
    const collection = document.cases[4];
    expect(collection?.name).toBe('pytest_collection');
    expect(collection?.outcome).toBe('error');
  });

  it('parses an empty self-closing suite as zero tests', () => {
    const document = parseJunitXml('<testsuite name="pytest" tests="0" failures="0" errors="0" skipped="0"/>');
    expect(document.cases).toEqual([]);
    expect(document.tests).toBe(0);
  });

  it('throws typed parse errors on malformed XML (never a fake green)', () => {
    expect(() => parseJunitXml('not xml at all')).toThrow(JunitParseError);
    expect(() =>
      parseJunitXml('<testsuite name="s"><testcase name="x" =broken><failure/></testcase></testsuite>'),
    ).toThrow(JunitParseError);
  });

  it('collects node ids through the configured argv (fake pytest)', async () => {
    const root = makeTempDir('gateforge-pytest-');
    writeTree(root, { 'backend/tests/test_a.py': 'def test_one():\n    pass\n' });
    const suite = suiteConfig({
      argv: [
        'python3',
        '-c',
        'import sys\nprint("backend/tests/test_a.py::test_one")\nprint("backend/tests/test_a.py::TestG::test_two[p-1]")\n',
      ],
    });
    const result = await collectPytestSuite(suite, root);
    expect(result.status).toBe('discovered');
    expect(result.cases.map((testCase) => testCase.nodeId)).toEqual([
      'backend/tests/test_a.py::TestG::test_two[p-1]',
      'backend/tests/test_a.py::test_one',
    ]);
  });

  it('reports collection failure as unavailable with the error (exit 1)', async () => {
    const root = makeTempDir('gateforge-pytest-err-');
    const suite = suiteConfig({
      argv: ['python3', '-c', 'import sys\nsys.stderr.write("ERROR: collect_broken\\n")\nraise SystemExit(2)\n'],
    });
    const result = await collectPytestSuite(suite, root);
    expect(result.status).toBe('unavailable');
    expect(result.collectionErrors.join('\n')).toContain('collect_broken');
    expect(result.exitCode).toBe(2);
  });

  it('enforces the finite timeout (killed, typed unavailable)', async () => {
    const root = makeTempDir('gateforge-pytest-timeout-');
    const suite = suiteConfig({
      argv: ['python3', '-c', 'import time\ntime.sleep(30)\n'],
      timeoutMs: 300,
    });
    const result = await collectPytestSuite(suite, root);
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('timeout');
  });
});

describe('runner adapter contract', () => {
  it('declares playwright execution available (trusted synthesis needs no consumer config)', async () => {
    const root = makeTempDir('gateforge-pw-execute-');
    // No playwright config at this root: trusted-config synthesis does
    // not need one — the run proceeds and fails closed on its own terms
    // (zero specs found here: nonzero exit, incomplete envelope — never
    // a silent green).
    const adapter = new PlaywrightAdapter({ config: fixtureConfig(['e2e/**/*.js']) });
    expect(adapter.capabilities).toEqual({
      inventory: 'available',
      resolveInstances: 'available',
      execute: 'available',
    });
    const envelope = await adapter.execute(
      { logicalKeys: ['k'] },
      { stateDir: join(root, 'state'), runId: 'r', vars: {} },
    );
    expect(envelope.complete).toBe(false);
    expect(envelope.processExit).not.toBe(0);
    expect(envelope.incompleteDetail).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a logical key to its runtime instances', async () => {
    const root = makeTempDir('gateforge-pw-resolve-');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    for (const name of ['playwright', 'playwright-core']) {
      symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
    }
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'playwright.config.js': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }, { name: 'firefox' }] };\n",
      'e2e/a.spec.js': "import { test } from 'playwright/test';\ntest('multi project', () => {});\n",
    });
    const adapter = new PlaywrightAdapter({ config: fixtureConfig(['e2e/**/*.spec.js']) });
    const instances = await adapter.resolveInstances(
      'playwright:chromium:e2e/a.spec.js:multi project',
      root,
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]?.project).toBe('chromium');
    expect(instances[0]?.frameworkId).not.toBe('');
    // Unknown keys resolve to nothing (a visible stale mapping, §5.2).
    expect(await adapter.resolveInstances('playwright:chromium:gone.spec.js:t', root)).toEqual([]);
  });
});

/** Guards the temp-dir budget: discovery fixtures must clean up. */
readdirSync(tmpdir()).filter((name) => name.startsWith('gateforge-'));
