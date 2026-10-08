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
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mappingGradingClaims,
  parseConfig,
  resolveTestMappings,
  type GateforgeConfig,
  type TestMap,
} from '@gate-forge/core';
import {
  diffNativePlaywrightTests,
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
  type StaticTestEntry,
  untrustedEnv,
} from '../src/discovery/index.js';
import { AdapterCapabilityError } from '../src/discovery/adapters.js';

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
    // 0.11.0: the scanner settings are a REQUIRED `scan:` section of
    // `.gateforge.yml`; they used to sit at the top of the answers
    // document. `scanRoots` rides the `include` globs, exactly as every
    // repository declared them before the keys moved.
    scan: { scanRoots: include, declarations: { internality: 'gateforge:internal' }, volatileFields: [] },
    changed: { provider: 'auto' },
    witness: { maxDurationSeconds: 5 },
    clock: { mode: 'fixed', fixedAt: '2026-01-01T00:00:00.000Z' },
  });
}

/**
 * The one catalog row for a scanned file, or a thrown error naming the
 * file: a missing row is a scan failure, never a silent `undefined` that
 * would make the assertion below pass for the wrong reason.
 */
function rowFor(entries: readonly StaticTestEntry[], file: string): StaticTestEntry {
  const entry = entries.find((candidate) => candidate.file === file);
  if (entry === undefined) throw new Error(`no catalog row for ${file} (have: ${entries.map((e) => e.file).join(', ')})`);
  return entry;
}

/** Runs inference over one scanned row exactly as the catalog builder does. */
function inferenceOf(entry: StaticTestEntry) {
  return inferTestKind({ file: entry.file, title: entry.title, titlePath: entry.titlePath, facts: entry.facts });
}

describe('static discovery', () => {
  it('resolves local CJS and ESM wrappers over the Gateforge fixture subpath', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/wrapper.cjs': [
        "const { test: base } = require('@gate-forge/pack-playwright/fixture');",
        'const test = base.extend({});',
        'module.exports = { test };',
        '',
      ].join('\n'),
      'e2e/exports-wrapper.cjs': [
        "const { test: base } = require('@gate-forge/pack-playwright/fixture');",
        'exports.test = base.extend({});',
        '',
      ].join('\n'),
      'e2e/module-property-wrapper.cjs': [
        "const { test: base } = require('@gate-forge/pack-playwright/fixture');",
        'module.exports.test = base.extend({});',
        '',
      ].join('\n'),
      'e2e/exports.spec.js': [
        "const { test } = require('./exports-wrapper.cjs');",
        "test('exports property wrapper journey', async ({ page }) => {});",
        '',
      ].join('\n'),
      'e2e/module-property.spec.js': [
        "const { test } = require('./module-property-wrapper.cjs');",
        "test('module exports property wrapper journey', async ({ page }) => {});",
        '',
      ].join('\n'),
      'e2e/wrapper.mjs': [
        "import { test as base } from '@gate-forge/pack-playwright/fixture';",
        'export const test = base.extend({});',
        '',
      ].join('\n'),
      'e2e/cjs.spec.js': [
        "const { test } = require('./wrapper.cjs');",
        "test('CJS wrapper journey', async ({ page }) => {});",
        '',
      ].join('\n'),
      'e2e/esm.spec.mjs': [
        "import { test } from './wrapper.mjs';",
        "test('ESM wrapper journey', async ({ page }) => {});",
        '',
      ].join('\n'),
      'e2e/unrelated.js': [
        "const { test } = require('./unrelated-wrapper.js');",
        "test('not a runner test', () => {});",
        '',
      ].join('\n'),
      'e2e/unrelated-wrapper.js': [
        "const { test } = require('unrelated-test-library');",
        'exports.test = test;',
        '',
      ].join('\n'),
      'e2e/direct.spec.mts': [
        "import { test } from 'playwright/test';",
        "test('direct MTS journey', async ({ page }) => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*'], exclude: [] });
    expect(
      result.entries.map((entry) => entry.title).sort(),
      JSON.stringify(result.unresolved),
    ).toEqual([
      'CJS wrapper journey',
      'ESM wrapper journey',
      'direct MTS journey',
      'exports property wrapper journey',
      'module exports property wrapper journey',
    ]);
    expect(result.unresolved).toMatchObject([
      { file: 'e2e/unrelated.js', code: 'unresolved-test-alias', titlePath: ['not a runner test'] },
    ]);
  });
  it('recognizes npm aliases only when package metadata proves the Gateforge package', () => {
    const alias = '@suite/gateforge-runner';
    const spec = [
      `import { test } from '${alias}';`,
      "test('alias journey', async ({ page }) => {});",
      '',
    ].join('\n');
    const declaredRoot = makeTempDir();
    writeTree(declaredRoot, {
      'package.json': JSON.stringify({
        devDependencies: { [alias]: 'npm:@gate-forge/pack-playwright@0.13.4' },
      }),
      'e2e/alias.spec.ts': spec,
    });
    const declared = scanTestFiles({ cwd: declaredRoot, include: ['e2e/**/*.ts'], exclude: [] });
    expect(declared.entries.map((entry) => entry.title)).toEqual(['alias journey']);
    expect(declared.entries[0]?.facts.gateforgeFixtureImport).toEqual({
      file: 'e2e/alias.spec.ts',
      line: 1,
      col: 0,
    });

    const nearestRoot = makeTempDir();
    writeTree(nearestRoot, {
      'e2e/package.json': JSON.stringify({
        optionalDependencies: { [alias]: 'npm:@gate-forge/pack-playwright@0.13.4' },
      }),
      'e2e/alias.spec.ts': spec,
    });
    const nearest = scanTestFiles({ cwd: nearestRoot, include: ['e2e/**/*.ts'], exclude: [] });
    expect(nearest.entries.map((entry) => entry.title)).toEqual(['alias journey']);

    const undeclaredRoot = makeTempDir();
    writeTree(undeclaredRoot, { 'e2e/alias.spec.ts': spec });
    const undeclared = scanTestFiles({ cwd: undeclaredRoot, include: ['e2e/**/*.ts'], exclude: [] });
    expect(undeclared.entries).toEqual([]);
    expect(undeclared.unresolved).toMatchObject([
      { file: 'e2e/alias.spec.ts', code: 'unresolved-test-alias', titlePath: ['alias journey'] },
    ]);

    const installedRoot = makeTempDir();
    writeTree(installedRoot, {
      'node_modules/@suite/gateforge-runner/package.json': JSON.stringify({ name: '@gate-forge/pack-playwright' }),
      'e2e/alias.spec.ts': spec,
    });
    const installed = scanTestFiles({ cwd: installedRoot, include: ['e2e/**/*.ts'], exclude: [] });
    expect(installed.entries.map((entry) => entry.title)).toEqual(['alias journey']);
  });
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

  it('records the gateforge pack import on entries that use the evidence fixture', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/overlay.spec.ts': [
        "import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';",
        "import { accountsSurface } from './accounts-surface.js';",
        'const test = gateforgeTest.extend({ surface: accountsSurface });',
        "test('creates an account', async ({ evidence }) => {",
        '  await evidence.finalize();',
        '});',
        '',
      ].join('\n'),
      'e2e/plain.spec.ts': [
        "import { test, expect } from 'playwright/test';",
        "test('creates an account', async ({ page }) => {",
        '  await page.goto("/accounts");',
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    expect(result.parseErrors).toEqual([]);
    expect(result.entries).toHaveLength(2);
    const byFile = new Map(result.entries.map((entry) => [entry.file, entry]));
    expect(byFile.get('e2e/overlay.spec.ts')?.facts.gateforgeFixtureImport).toEqual({
      file: 'e2e/overlay.spec.ts',
      line: 1,
      col: 0,
    });
    expect(byFile.get('e2e/plain.spec.ts')?.facts.gateforgeFixtureImport).toBe(null);
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
    expect(result.entries[0]?.facts.pageRouteTargets).toEqual(['**/api/**']);
  });

  it('a file-scope route helper mocks every test in the file (0.9.2)', () => {
    // The real-world shape the body-scoped scan missed: interception
    // lives in a helper the tests CALL, so `page.route` never appears
    // inside a test body.
    const root = makeTempDir();
    writeTree(root, {
      'tests/e2e/mocked/notification_foundation.spec.js': [
        "import { test } from 'playwright/test';",
        'async function stubNotifications(page) {',
        "  await page.route('**/api/v1/notifications*', async (route) => {",
        "    await route.fulfill({ status: 200, body: '[]' });",
        '  });',
        '}',
        "test('notification foundation lists the inbox', async ({ page }) => {",
        '  await stubNotifications(page);',
        '  await page.goto("/notifications");',
        '});',
        '',
      ].join('\n'),
      'tests/e2e/real/notification_foundation.spec.js': [
        "import { test } from 'playwright/test';",
        "test('notification foundation lists the inbox against the server', async ({ page }) => {",
        '  await page.goto("/notifications");',
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['tests/e2e/**/*.spec.js'], exclude: [] });
    const mocked = rowFor(result.entries, 'tests/e2e/mocked/notification_foundation.spec.js');
    const real = rowFor(result.entries, 'tests/e2e/real/notification_foundation.spec.js');
    // The helper's interception is a FILE-level fact, so the row carries
    // it even though the test body never calls `page.route` itself.
    expect(mocked.facts.pageRoute).toBeNull();
    expect(mocked.facts.fileRouteInterception).not.toBeNull();
    expect(inferenceOf(mocked).mockSignals.some((signal) => signal.kind === 'mock')).toBe(true);
    expect(inferenceOf(mocked).rulesFired.some((rule) => rule.ruleId === 'mock-file-route-interception')).toBe(true);
    // A genuinely unmocked spec under `real/` carries none of it.
    expect(real.facts.fileRouteInterception).toBeNull();
    expect(inferenceOf(real).mockSignals.some((signal) => signal.kind === 'mock')).toBe(false);
  });

  it('flags page-observation tampering APIs in specs and imported helpers with exact locations', () => {
    const calls = [
      'page.evaluate("document.body.innerText")',
      'page.addInitScript(() => {})',
      'page.exposeFunction("host", () => {})',
      'page.route("**/*", route => route.continue())',
      'context.route("**/*", route => route.continue())',
      'route.fulfill({ status: 200 })',
      'page.setContent("<main></main>")',
      'context.newCDPSession(page)',
    ];
    for (const call of calls) {
      const root = makeTempDir();
      writeTree(root, {
        'e2e/helper.js': `export function tamper(page, context, route) { ${call}; }`,
        'e2e/page.spec.ts': [
          "import { test } from 'playwright/test';",
          "import { tamper } from './helper.js';",
          "test('opens orders', async ({ page }) => { tamper(page); });",
          '',
        ].join('\n'),
      });
      const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
      const test = rowFor(result.entries, 'e2e/page.spec.ts');
      expect(test.facts.fileRouteInterception?.file).toBe('e2e/helper.js');
      expect(inferenceOf(test).mockSignals.some((signal) =>
        signal.detail.startsWith('PAGE_OBSERVATION_TAMPER_RISK:'),
      )).toBe(true);
    }
    const root = makeTempDir();
    writeTree(root, {
      'e2e/page.spec.ts': [
        "import { test } from 'playwright/test';",
        "test('opens orders', async ({ page }) => {",
        "  await page.route('**/*', route => route.fulfill({ status: 200 }));",
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    const test = rowFor(result.entries, 'e2e/page.spec.ts');
    expect(test.facts.fileRouteInterception).toMatchObject({ file: 'e2e/page.spec.ts', line: 3 });
    const tamperRisk = inferenceOf(test).mockSignals.find((signal) =>
      signal.detail.startsWith('PAGE_OBSERVATION_TAMPER_RISK:'),
    );
    expect(tamperRisk?.detail).toContain('e2e/page.spec.ts:3');
  });

  it('a storage-only init script is not a tamper, and a later tamper is still found', () => {
    const safeCalls = [
      "page.addInitScript(() => localStorage.setItem('lang', 'en'))",
      "page.addInitScript(() => { localStorage.setItem('lang', 'en'); sessionStorage.removeItem('tour_done'); })",
      "context.addInitScript(() => { window.localStorage.setItem('lang', 'en'); window.sessionStorage.clear(); })",
    ];
    for (const call of safeCalls) {
      const root = makeTempDir();
      writeTree(root, {
        'e2e/page.spec.ts': [
          "import { test } from 'playwright/test';",
          "test('opens orders', async ({ page }) => {",
          `  ${call};`,
          "  await page.goto('/orders');",
          '});',
          '',
        ].join('\n'),
      });
      const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
      const test = rowFor(result.entries, 'e2e/page.spec.ts');
      expect(test.facts.fileRouteInterception, call).toBeNull();
      expect(
        inferenceOf(test).mockSignals.some((signal) =>
          signal.detail.startsWith('PAGE_OBSERVATION_TAMPER_RISK:'),
        ),
        call,
      ).toBe(false);
    }

    const unsafeCalls = [
      "page.addInitScript(() => localStorage.setItem('lang', lang))",
      "page.addInitScript(() => localStorage.setItem(`lang`, 'en'))",
      "page.addInitScript(() => { window.fetch = () => {}; })",
      "page.addInitScript(() => { localStorage.setItem('lang', 'en'); page.route('**/*', route => route.continue()); })",
      "page.addInitScript(() => localStorage.setItem('lang', 'en'), 5)",
      "context.addInitScript('/scripts/bootstrap.js')",
    ];
    for (const call of unsafeCalls) {
      const root = makeTempDir();
      writeTree(root, {
        'e2e/page.spec.ts': [
          "import { test } from 'playwright/test';",
          "test('opens orders', async ({ page }) => {",
          `  ${call};`,
          "  await page.goto('/orders');",
          '});',
          '',
        ].join('\n'),
      });
      const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
      const test = rowFor(result.entries, 'e2e/page.spec.ts');
      expect(test.facts.fileRouteInterception, call).not.toBeNull();
      expect(
        inferenceOf(test).mockSignals.some((signal) =>
          signal.detail.startsWith('PAGE_OBSERVATION_TAMPER_RISK:'),
        ),
        call,
      ).toBe(true);
    }

    // A safe init script does not stop the search: a real tamper after
    // it is still reported, at its own line.
    const root = makeTempDir();
    writeTree(root, {
      'e2e/page.spec.ts': [
        "import { test } from 'playwright/test';",
        "test('opens orders', async ({ page }) => {",
        "  page.addInitScript(() => localStorage.setItem('lang', 'en'));",
        "  await page.route('**/*', route => route.fulfill({ status: 200 }));",
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    const test = rowFor(result.entries, 'e2e/page.spec.ts');
    expect(test.facts.fileRouteInterception).toMatchObject({ file: 'e2e/page.spec.ts', line: 4 });
    const tamperRisk = inferenceOf(test).mockSignals.find((signal) =>
      signal.detail.startsWith('PAGE_OBSERVATION_TAMPER_RISK:'),
    );
    expect(tamperRisk?.detail).toContain('e2e/page.spec.ts:4');
  });

  it("a mocked/mock/mocks FOLDER segment mocks its specs (0.9.2)", () => {
    const root = makeTempDir();
    writeTree(root, {
      'tests/e2e/mocks/plain_request.spec.js': [
        "import { test } from 'playwright/test';",
        "test('reads the plain page', async ({ page }) => {",
        '  await page.goto("/");',
        '});',
        '',
      ].join('\n'),
      // `mockery` merely CONTAINS "mock": a helper folder, not a
      // declaration that its specs intercept the network.
      'tests/e2e/mockery/helper.spec.js': [
        "import { test } from 'playwright/test';",
        "test('uses a helper named mock', async ({ page }) => {",
        '  await page.goto("/");',
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['tests/e2e/**/*.spec.js'], exclude: [] });
    const infer = (file: string) => inferenceOf(rowFor(result.entries, file));
    expect(infer('tests/e2e/mocks/plain_request.spec.js').mockSignals.some((signal) => signal.kind === 'mock')).toBe(true);
    expect(infer('tests/e2e/mockery/helper.spec.js').mockSignals.some((signal) => signal.kind === 'mock')).toBe(false);
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
  it('reports registration conditions that branch on GATEFORGE environment state', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/env.spec.ts': [
        "import { test } from 'playwright/test';",
        "if (process.env.GATEFORGE_STATE_DIR) test('witness branch', () => {});",
        '',
      ].join('\n'),
      'e2e/body.spec.ts': [
        "import { test } from 'playwright/test';",
        "test('reads runner env at runtime', async () => {",
        '  if (process.env.GATEFORGE_RUN_TOKEN) {}',
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({
      cwd: root,
      include: ['e2e/**/*.ts'],
      exclude: [],
    });
    const warnings =
      'registrationWarnings' in result && Array.isArray(result.registrationWarnings)
        ? result.registrationWarnings
        : [];
    expect(warnings).toEqual([
      expect.objectContaining({
        file: 'e2e/env.spec.ts',
        titlePath: ['witness branch'],
        environmentVariable: 'GATEFORGE_STATE_DIR',
      }),
    ]);
  });
});

describe('non-test call shapes stay out of the inventory (consumer E22)', () => {
  it('ignores vitest/jest module-mock and slowness-modifier calls', () => {
    const root = makeTempDir();
    writeTree(root, {
      'src/setup.js': [
        "vi.mock('react-router-dom', async () => {",
        '  return {};',
        '});',
        "vi.mock('axios', () => ({ default: {} }));",
        '',
      ].join('\n'),
      'e2e/modifiers.spec.ts': [
        "import { test } from 'playwright/test';",
        'test.slow(true);',
        "test('real journey', async () => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['src/**/*.js', 'e2e/**/*.ts'], exclude: [] });
    // The mock registrations are file-level mock signals, never test
    // rows; the slowness modifier is runner control, never a case.
    expect(result.unresolved).toEqual([]);
    expect(result.entries.map((entry) => entry.title)).toEqual(['real journey']);
  });

  it('ignores same-file plain helper functions with test-like call shapes', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/helpers.js': [
        'async function withStepTimeout(label, fn) {',
        '  return await fn();',
        '}',
        'async function seed() {',
        "  await withStepTimeout('seed target', async () => {});",
        '}',
        'module.exports = { seed };',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.js'], exclude: [] });
    expect(result.unresolved).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  it('resolves CJS helper requires and ignores their step calls', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/support/runStep.js': [
        'async function runStep(label, fn) {',
        '  return await fn();',
        '}',
        'module.exports = { runStep };',
        '',
      ].join('\n'),
      'e2e/support/seed.js': [
        "const { runStep } = require('./runStep');",
        'async function seedAll() {',
        "  return runStep('seed tracked hierarchy', async () => {});",
        '}',
        'module.exports = { seedAll };',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.js'], exclude: [] });
    expect(result.unresolved).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  it('keeps unbound test/it/describe names visible while skipping other bare identifiers', () => {
    const root = makeTempDir();
    writeTree(root, {
      'src/component.jsx': [
        'export function Toolbar({ onExport }) {',
        '  const handleAction = async (actionName, callback) => {',
        '    await callback();',
        '  };',
        "  return handleAction('export-csv', () => onExport('csv'));",
        '}',
        '',
      ].join('\n'),
      'e2e/mixed.spec.ts': [
        "import { test } from 'playwright/test';",
        "test('real journey', async () => {});",
        "it('import-less global registration stays visible', async () => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['src/**/*.jsx', 'e2e/**/*.ts'], exclude: [] });
    // The function-scope UI callback is an ordinary call, never a row.
    expect(result.unresolved.map((gap) => gap.code)).toEqual(['unresolved-test-alias']);
    expect(result.unresolved[0]?.titlePath).toEqual(['import-less global registration stays visible']);
    expect(result.entries.map((entry) => entry.title)).toEqual(['real journey']);
  });

  it('keeps test-referencing wrapper factories visible (possible registration)', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/factory.spec.ts': [
        'const wrap = (title, fn) => test(title, fn);',
        "wrap('possible registration', async () => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    // The factory body mentions `test`, so calls through it cannot be
    // proven ordinary — the row stays (fail-visible).
    expect(result.entries).toEqual([]);
    expect(result.unresolved.map((gap) => gap.code)).toEqual(['unresolved-wrapper']);
  });

  it('follows CJS base.test.extend harness chains into test entries', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/support/fixtures.js': [
        "const base = require('@playwright/test');",
        'const test = base.test.extend({});',
        'module.exports = { test };',
        '',
      ].join('\n'),
      'e2e/router.spec.js': [
        "const { test } = require('./support/fixtures');",
        "test('navigates', async ({ page }) => {});",
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.js'], exclude: [] });
    expect(result.parseErrors).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.entries.map((entry) => [entry.title, entry.facts.signatureParams])).toEqual([
      ['navigates', ['page']],
    ]);
  });

  it('never turns suppression control calls into dynamic-title gaps', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/guarded.spec.ts': [
        "import { test } from 'playwright/test';",
        'async function guard(page, reasonPrefix) {',
        '  const ok = await page.goto("/");',
        '  if (!ok) test.skip(true, `${reasonPrefix}: never rendered`);',
        '}',
        "test('real journey', async ({ page }) => {",
        "  await guard(page, 'setup');",
        '});',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    // The helper's conditional skip is runner control, not a case; the
    // declaration form with a title+callback still registers (see the
    // signals spec above).
    expect(result.unresolved).toEqual([]);
    expect(result.entries.map((entry) => entry.title)).toEqual(['real journey']);
  });

  it('keeps parameterized skip/only/fixme declarations visible (never dropped)', () => {
    const root = makeTempDir();
    writeTree(root, {
      'e2e/skipped-param.spec.ts': [
        "import { test } from 'playwright/test';",
        'const KINDS = ["a", "b"];',
        'for (const kind of KINDS) {',
        '  test.skip(`skips ${kind}`, async ({ page }) => {});',
        '  test.only(`focuses ${kind}`, async ({ page }) => {});',
        '  test.fixme(`known broken ${kind}`, async ({ page }) => {});',
        '}',
        // Genuine conditional controls declare no case and stay silent.
        'async function guard(cond) {',
        "  if (cond) test.skip(true, 'static reason');",
        '  if (cond) test.skip(true, `dynamic ${cond} reason`);',
        '}',
        '',
      ].join('\n'),
    });
    const result = scanTestFiles({ cwd: root, include: ['e2e/**/*.ts'], exclude: [] });
    // Adding `.skip` (or only/fixme) to a parameterized template must not
    // complete the inventory by dropping the case: all three templates
    // register as entries carrying their suppression signal.
    expect(result.unresolved).toEqual([]);
    const byTitle = new Map(result.entries.map((entry) => [entry.title, entry]));
    expect([...byTitle.keys()].sort()).toEqual(['focuses ${}', 'known broken ${}', 'skips ${}']);
    for (const entry of byTitle.values()) {
      expect(entry.parameterIdentity).toBe('template');
    }
    expect(byTitle.get('skips ${}')?.signals.some((signal) => signal.kind === 'skip')).toBe(true);
    expect(byTitle.get('focuses ${}')?.signals.some((signal) => signal.kind === 'only')).toBe(true);
    expect(byTitle.get('known broken ${}')?.signals.some((signal) => signal.kind === 'fixme')).toBe(true);
  });
});

describe('kind/category inference rules', () => {
  const baseFacts = {
    pageRoute: null,
    httpClientCall: null,
    fileHttpClientCall: null,
    fileMockImport: null,
    fileRouteInterception: null,
    gateforgeFixtureImport: null,
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

  it('a gateforge-pack request fixture still infers api-e2e', () => {
    const result = inferTestKind({
      file: 'e2e/api.spec.ts',
      title: 'calls the service',
      titlePath: ['calls the service'],
      facts: {
        ...baseFacts,
        signatureParams: ['request'],
        gateforgeFixtureImport: { file: 'e2e/api.spec.ts', line: 1, col: 0 },
      },
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

  it('a gateforge-pack import is never networkless: its channels are static-analysis-invisible', () => {
    // The imported `request.newContext()` pattern has no fixture params,
    // but its calls ride the witnessed API channel — a 'unit' proposal
    // here would block the observed-e2e marking.
    const result = inferTestKind({
      file: 'e2e/api.spec.ts',
      title: 'calls the service',
      titlePath: ['calls the service'],
      facts: {
        ...baseFacts,
        signatureParams: [],
        gateforgeFixtureImport: { file: 'e2e/api.spec.ts', line: 1, col: 0 },
      },
    });
    expect(result.inferredKind).toBe('unknown');
    expect(result.kindSignals).toEqual([]);
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

  it('gateforge fixture import + evidence param agrees with browser-e2e (no conflict)', () => {
    const importAt = { file: 'e2e/overlay.spec.ts', line: 1, col: 0 };
    const result = inferTestKind({
      file: 'e2e/overlay.spec.ts',
      title: 'creates an account',
      titlePath: ['creates an account'],
      facts: { ...baseFacts, signatureParams: ['evidence'], gateforgeFixtureImport: importAt },
    });
    expect(result.inferredKind).toBe('browser-e2e');
    expect(result.kindSignals.map((signal) => signal.ruleId).sort()).toEqual([
      'browser-fixture',
      'gateforge-fixture',
    ]);
  });

  it('gateforge pack import without the evidence param fires no fixture signal', () => {
    const importAt = { file: 'e2e/plain.spec.ts', line: 1, col: 0 };
    const result = inferTestKind({
      file: 'e2e/plain.spec.ts',
      title: 'creates an account',
      titlePath: ['creates an account'],
      facts: { ...baseFacts, signatureParams: ['page'], gateforgeFixtureImport: importAt },
    });
    expect(result.inferredKind).toBe('browser-e2e');
    expect(result.kindSignals.map((signal) => signal.ruleId)).toEqual(['browser-fixture']);
  });
});

describe('native playwright reconciliation', () => {
  it('reports project-qualified tests that differ between scrubbed and wired registration', () => {
    const base = {
      file: 'e2e/accounts.spec.ts',
      titlePath: ['accounts', 'creates an account'],
      title: 'creates an account',
      project: 'chromium',
      frameworkId: 'spec-1#chromium',
      location: { file: 'e2e/accounts.spec.ts', line: 1, col: 0 },
      expectedStatus: 'passed',
      annotations: [],
      claims: [],
    };
    const wiredTwin = {
      ...base,
      titlePath: ['accounts', 'creates an account (unwired twin)'],
      title: 'creates an account (unwired twin)',
      frameworkId: 'spec-2#chromium',
    };

    const diff = diffNativePlaywrightTests([base], [base, wiredTwin]);

    expect(diff.scrubbedOnly).toEqual([]);
    expect(diff.wiredOnly).toMatchObject([
      {
        file: 'e2e/accounts.spec.ts',
        titlePath: ['accounts', 'creates an account (unwired twin)'],
        project: 'chromium',
      },
    ]);
  });
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

  it('waits for the complete reporter stream before parsing large inventories', async () => {
    const root = makePlaywrightProject({
      'e2e/large.spec.js': [
        "import { test } from 'playwright/test';",
        ...Array.from({ length: 500 }, (_, index) => `test('case ${index}', async () => {});`),
        '',
      ].join('\n'),
    });
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('discovered');
    expect(result.instances).toHaveLength(500);
  });

  it('is unavailable without a playwright config (not an error)', async () => {
    const root = makeTempDir('gateforge-no-pw-');
    writeTree(root, { 'src/app.ts': 'export const app = 1;\n' });
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('unavailable');
    expect(result.detail).toContain('reconciliation: unavailable — no playwright config');
    expect(result.instances).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('fails typed when the invocation exceeds its timeout', async () => {
    const root = makePlaywrightProject({
      'e2e/ok.spec.js': "import { test } from 'playwright/test';\ntest('t', () => {});\n",
    });
    await expect(listNativePlaywrightTests({ cwd: root, timeoutMs: 1 })).rejects.toThrow(TestDiscoveryError);
  });

  it('enumerates current claim annotations in an isolated gate context', async () => {
    const root = makePlaywrightProject({
      'e2e/conditional.spec.js': [
        "import { writeFileSync } from 'node:fs';",
        "import { test } from 'playwright/test';",
        "writeFileSync('discovery-state.json', JSON.stringify({",
        "  stateDir: process.env.GATEFORGE_STATE_DIR ?? null,",
        "  verifierKey: process.env.GATEFORGE_WITNESS_VERIFIER_KEY ?? null,",
        "  runToken: process.env.GATEFORGE_RUN_TOKEN ?? null,",
        "}));",
        "test('raw journey', () => {});",
        'if (process.env.GATEFORGE_STATE_DIR) {',
        "  test('witnessed journey', { annotation: { type: 'gateforge', description: 'tenant.accounts:crud:read' } }, () => {});",
        '}',
        '',
      ].join('\n'),
    });
    const saved = {
      stateDir: process.env['GATEFORGE_STATE_DIR'],
      verifierKey: process.env['GATEFORGE_WITNESS_VERIFIER_KEY'],
      runToken: process.env['GATEFORGE_RUN_TOKEN'],
    };
    process.env['GATEFORGE_STATE_DIR'] = '/authoritative/state';
    process.env['GATEFORGE_WITNESS_VERIFIER_KEY'] = 'must-not-reach-discovery';
    process.env['GATEFORGE_RUN_TOKEN'] = 'must-not-reach-discovery';
    try {
      const discovered = await discoverTestCatalog({
        cwd: root,
        config: fixtureConfig(['e2e/**/*.spec.js']),
      });
      expect(discovered.catalog.entries.map((entry) => entry.title)).toEqual([
        'raw journey',
        'witnessed journey',
      ]);
      expect(discovered.nativeClaims.map((claim) => [claim.obligationId, claim.testFile])).toEqual([
        ['tenant.accounts:crud:read', 'e2e/conditional.spec.js'],
      ]);
      const childEnvironment = JSON.parse(readFileSync(join(root, 'discovery-state.json'), 'utf8')) as {
        stateDir: string | null;
        verifierKey: string | null;
        runToken: string | null;
      };
      expect(childEnvironment.stateDir).not.toBe('/authoritative/state');
      expect(childEnvironment.verifierKey).toBeNull();
      expect(childEnvironment.runToken).toBeNull();
      expect(childEnvironment.stateDir).not.toBeNull();
      expect(existsSync(childEnvironment.stateDir as string)).toBe(false);
    } finally {
      if (saved.stateDir === undefined) delete process.env['GATEFORGE_STATE_DIR'];
      else process.env['GATEFORGE_STATE_DIR'] = saved.stateDir;
      if (saved.verifierKey === undefined) delete process.env['GATEFORGE_WITNESS_VERIFIER_KEY'];
      else process.env['GATEFORGE_WITNESS_VERIFIER_KEY'] = saved.verifierKey;
      if (saved.runToken === undefined) delete process.env['GATEFORGE_RUN_TOKEN'];
      else process.env['GATEFORGE_RUN_TOKEN'] = saved.runToken;
    }
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
  it('joins fixture wrappers and runner-selected MTS files omitted from source globs', async () => {
    const root = makePlaywrightProject({
      'e2e/wrapper.cjs': [
        "const { test: base } = require('@gate-forge/pack-playwright/fixture');",
        'const test = base.extend({});',
        'module.exports = { test };',
      ].join('\n'),
      'e2e/wrapped.spec.js': [
        "const { test } = require('./wrapper.cjs');",
        "test('wrapped journey', async ({ page }) => {});",
        '',
      ].join('\n'),
      'e2e/direct.spec.mts': [
        "import { test } from 'playwright/test';",
        "test('direct MTS journey', async ({ page }) => {});",
        '',
      ].join('\n'),
      'e2e/esm-wrapper.mjs': [
        "import { test as base } from '@gate-forge/pack-playwright/fixture';",
        'export const test = base.extend({});',
        '',
      ].join('\n'),
      'e2e/esm-wrapped.spec.mjs': [
        "import { test } from './esm-wrapper.mjs';",
        "test('ESM wrapped journey', async ({ page }) => {});",
        '',
      ].join('\n'),
    });
    writeFileSync(join(root, 'package.json'), '{ "private": true }\n', 'utf8');
    mkdirSync(join(root, 'node_modules', '@gate-forge'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'pack-playwright'), join(root, 'node_modules', '@gate-forge', 'pack-playwright'), 'dir');
    const { catalog } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['e2e/**/*.spec.js']),
    });
    expect(
      catalog.entries
        .map((entry) => [entry.title, entry.reconciliation, entry.inferredKind])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      JSON.stringify({ runnerSummaries: catalog.runnerSummaries, unresolved: catalog.unresolved }),
    ).toEqual([
      ['direct MTS journey', 'matched', 'browser-e2e'],
      ['ESM wrapped journey', 'matched', 'browser-e2e'],
      ['wrapped journey', 'matched', 'browser-e2e'],
    ]);
  });
  it('refuses an E2E mapping until a runner-listed spec is statically readable', async () => {
    const root = makePlaywrightProject({
      'e2e/opaque-wrapper.mjs': [
        "import { test } from 'unrelated-runner';",
        'export { test };',
        '',
      ].join('\n'),
      'e2e/opaque.spec.mjs': [
        "import { test } from './opaque-wrapper.mjs';",
        "test('opaque journey', async ({ page }) => {});",
        '',
      ].join('\n'),
      'node_modules/unrelated-runner/package.json': JSON.stringify({
        name: 'unrelated-runner',
        type: 'module',
        exports: './index.js',
      }),
      'node_modules/unrelated-runner/index.js': "export { test } from 'playwright/test';\n",
    });
    const config = fixtureConfig(['e2e/**/*.spec.mjs']);
    const claimId = 'tenant.accounts:persistence:read';
    const sidecar: TestMap = {
      schemaVersion: 1,
      tests: [
        {
          key: 'playwright:chromium:e2e/opaque.spec.mjs:opaque journey',
          selector: {
            runner: 'playwright',
            project: 'chromium',
            file: 'e2e/opaque.spec.mjs',
            titlePath: ['opaque journey'],
          },
          claims: [claimId],
          kind: 'observed-e2e',
          reason: 'An existing UI journey proves the account operation.',
        },
      ],
    };
    const unreadable = await discoverTestCatalog({ cwd: root, config });
    const unreadableEntry = unreadable.catalog.entries.find((entry) => entry.title === 'opaque journey');
    expect(unreadableEntry).toMatchObject({ reconciliation: 'list-only', inferredKind: 'unknown' });
    const refused = resolveTestMappings({
      catalog: unreadable.catalog,
      nativeClaims: [],
      sidecar,
      obligationIds: [claimId],
    });
    const refusal = refused.problems.find((problem) => problem.obligationId === claimId);
    expect(refusal?.detail).toContain(
      `'${claimId}': Gateforge could not read the code of test 'playwright:chromium:e2e/opaque.spec.mjs:opaque journey'`,
    );
    expect(refusal?.detail).toContain('really is observed-e2e');
    // The mapping resolver sees the unreadable catalog row, not the wrapper's external specifier.
    expect(refusal?.detail).toContain('unresolved test-wrapper import');
    expect(mappingGradingClaims(refused, [])).toEqual([]);

    mkdirSync(join(root, 'node_modules', '@gate-forge'), { recursive: true });
    symlinkSync(join(ROOT, 'packages', 'pack-playwright'), join(root, 'node_modules', '@gate-forge', 'pack-playwright'), 'dir');
    writeTree(root, {
      'e2e/opaque-wrapper.mjs': [
        "import { test as base } from '@gate-forge/pack-playwright/fixture';",
        'export const test = base.extend({});',
        '',
      ].join('\n'),
    });
    const readable = await discoverTestCatalog({ cwd: root, config });
    expect(readable.catalog.entries.find((entry) => entry.title === 'opaque journey')).toMatchObject({
      reconciliation: 'matched',
      inferredKind: 'browser-e2e',
    });
    const accepted = resolveTestMappings({
      catalog: readable.catalog,
      nativeClaims: [],
      sidecar,
      obligationIds: [claimId],
    });
    expect(accepted.problems).toEqual([]);
    expect(mappingGradingClaims(accepted, [])).toHaveLength(1);
  });
  it('accepts E2E mappings through a proven npm alias and refuses an unproven alias', async () => {
    const alias = '@suite/gateforge-runner';
    const claimId = 'tenant.accounts:persistence:read';
    const testSource = [
      `import { test } from '${alias}/fixture';`,
      "test('alias journey', async ({ page }) => {});",
      '',
    ].join('\n');
    const aliasedRoot = makePlaywrightProject({
      'package.json': JSON.stringify({
        type: 'module',
        private: true,
        dependencies: { [alias]: 'npm:@gate-forge/pack-playwright@0.13.4' },
      }),
      'e2e/alias.spec.js': testSource,
    });
    mkdirSync(join(aliasedRoot, 'node_modules', '@suite'), { recursive: true });
    symlinkSync(
      join(ROOT, 'packages', 'pack-playwright'),
      join(aliasedRoot, 'node_modules', '@suite', 'gateforge-runner'),
      'dir',
    );
    const config = fixtureConfig(['e2e/**/*.spec.js']);
    const sidecar: TestMap = {
      schemaVersion: 1,
      tests: [
        {
          key: 'playwright:chromium:e2e/alias.spec.js:alias journey',
          selector: {
            runner: 'playwright',
            project: 'chromium',
            file: 'e2e/alias.spec.js',
            titlePath: ['alias journey'],
          },
          claims: [claimId],
          kind: 'observed-e2e',
          reason: 'The existing UI journey proves the account operation.',
        },
      ],
    };
    const aliased = await discoverTestCatalog({ cwd: aliasedRoot, config });
    expect(aliased.catalog.entries.find((entry) => entry.title === 'alias journey')).toMatchObject({
      reconciliation: 'matched',
      inferredKind: 'browser-e2e',
    });
    const accepted = resolveTestMappings({
      catalog: aliased.catalog,
      nativeClaims: [],
      sidecar,
      obligationIds: [claimId],
    });
    expect(accepted.problems).toEqual([]);
    expect(mappingGradingClaims(accepted, [])).toHaveLength(1);

    const opaqueRoot = makePlaywrightProject({
      'e2e/alias.spec.js': testSource,
      'node_modules/@suite/gateforge-runner/package.json': JSON.stringify({
        name: 'unrelated-runner',
        type: 'module',
        exports: { './fixture': './fixture.js' },
      }),
      'node_modules/@suite/gateforge-runner/fixture.js': "export { test } from 'playwright/test';\n",
    });
    const opaque = await discoverTestCatalog({ cwd: opaqueRoot, config });
    expect(opaque.catalog.entries.find((entry) => entry.title === 'alias journey')).toMatchObject({
      reconciliation: 'list-only',
      inferredKind: 'unknown',
    });
    const refused = resolveTestMappings({
      catalog: opaque.catalog,
      nativeClaims: [],
      sidecar,
      obligationIds: [claimId],
    });
    expect(refused.problems.some((problem) => problem.obligationId === claimId)).toBe(true);
    expect(mappingGradingClaims(refused, [])).toEqual([]);
  });
  it('joins data-driven test instances to their dynamic-title call site', async () => {
    const root = makePlaywrightProject({
      'e2e/data-driven.spec.js': [
        "import { test } from 'playwright/test';",
        "const SPECS = [{ title: 'setup flow', target: '/setup' }, { title: 'posting flow', target: '/periods' }];",
        'for (const spec of SPECS) {',
        '  test(spec.title, async ({ page }) => {',
        '    await page.goto(spec.target);',
        '  });',
        '}',
        '',
      ].join('\n'),
    });
    const { catalog } = await discoverTestCatalog({
      cwd: root,
      config: fixtureConfig(['e2e/**/*.spec.js']),
    });
    expect(
      catalog.entries
        .map((entry) => [entry.title, entry.reconciliation, entry.inferredKind, entry.resolutionOrigin])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    ).toEqual([
      ['posting flow', 'matched', 'browser-e2e', 'static'],
      ['setup flow', 'matched', 'browser-e2e', 'static'],
    ]);
  });

  it('discovers runner-only cases through the native list fallback (origin native-list)', async () => {
    const root = makePlaywrightProject({
      'e2e/listed.spec.js':
        "import { test } from 'playwright/test';\ntest('enumerated', async ({ page }) => { await page.goto('/'); });\n",
      'e2e/hidden.spec.js':
        "import { test } from 'playwright/test';\ntest('excluded from scanning', async ({ page }) => { await page.goto('/'); });\n",
      'e2e/outside.spec.js':
        "import { test } from 'playwright/test';\ntest('outside configured globs', async ({ page }) => { await page.goto('/'); });\n",
    });
    const config = fixtureConfig(['e2e/listed.spec.js']);
    config.project.paths.exclude.push('e2e/hidden.spec.js');
    const { catalog } = await discoverTestCatalog({ cwd: root, config });
    const listOnly = catalog.entries.filter((entry) => entry.reconciliation === 'list-only');
    expect(listOnly.map((entry) => entry.title)).toEqual(['excluded from scanning']);
    expect(listOnly[0]?.discoveryStatus).toBe('discovered');
    expect(listOnly[0]?.resolutionOrigin).toBe('native-list');
    expect(listOnly[0]?.inferredKind).toBe('unknown');
    expect(listOnly[0]?.kindSignals).toEqual([]);
    expect(listOnly[0]?.weakSignals.some((signal) => signal.ruleId === 'native-list-only')).toBe(true);
    expect(listOnly[0]?.unresolvedReason).toBeUndefined();
    const matched = catalog.entries.filter((entry) => entry.reconciliation === 'matched');
    expect(matched.map((entry) => [entry.title, entry.inferredKind, entry.resolutionOrigin]).sort()).toEqual([
      ['enumerated', 'browser-e2e', 'static'],
      ['outside configured globs', 'browser-e2e', 'static'],
    ]);
    expect(catalog.inventoryComplete).toBe(true);
  });

  it('leaves files the runner config ignores out of the catalog', async () => {
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
    // The catalog follows the runner's own testDir/testIgnore: a file the
    // runner never selects is not a test of this repository, so it is
    // neither an entry nor a blocking static-only gap.
    expect(catalog.entries.map((entry) => entry.title)).toEqual(['enumerated']);
    expect(catalog.entries.some((entry) => entry.reconciliation === 'static-only')).toBe(false);
    expect(catalog.inventoryComplete).toBe(true);
  });

  it('merges parameterized template rows into their enumerated instances (consumer E22)', async () => {
    const root = makePlaywrightProject({
      'e2e/matrix.spec.js': [
        "import { test } from 'playwright/test';",
        "const ROUTES = ['/a', '/b'];",
        "test.describe('nav', () => {",
        '  for (const route of ROUTES) {',
        '    test(`opens ${route}`, async ({ page }) => {});',
        '  }',
        '});',
        '',
      ].join('\n'),
    });
    const config = fixtureConfig(['e2e/**/*.spec.js']);
    const { catalog } = await discoverTestCatalog({ cwd: root, config });
    // No blocking template gap: the two concrete instances ARE the
    // runnable identities, carrying the loop body's static facts.
    expect(catalog.unresolved).toEqual([]);
    expect(catalog.inventoryComplete).toBe(true);
    const matched = catalog.entries.filter((entry) => entry.reconciliation === 'matched');
    expect(matched.map((entry) => entry.title).sort()).toEqual(['opens /a', 'opens /b']);
    expect(matched.every((entry) => entry.resolutionOrigin === 'static')).toBe(true);
    expect(matched.every((entry) => entry.inferredKind === 'browser-e2e')).toBe(true);
    expect(
      matched.every((entry) => entry.weakSignals.some((signal) => signal.ruleId === 'template-expansion')),
    ).toBe(true);
  });

  it('keeps zero-instance templates static-only and blocking', async () => {
    const root = makePlaywrightProject({
      'e2e/probe.spec.js': [
        "import { test } from 'playwright/test';",
        "for (const kind of (process.env.PROBE_KINDS || '').split(',').filter(Boolean)) {",
        '  test(`probes ${kind}`, async ({ page }) => {});',
        '}',
        '',
      ].join('\n'),
    });
    const config = fixtureConfig(['e2e/**/*.spec.js']);
    const { catalog } = await discoverTestCatalog({ cwd: root, config });
    // Nothing enumerates this template in any configuration: the owner
    // wires PROBE_KINDS into a project or removes the probe — the gate
    // must not silently complete over it.
    const staticOnly = catalog.entries.filter((entry) => entry.reconciliation === 'static-only');
    expect(staticOnly.map((entry) => entry.title)).toEqual(['probes ${}']);
    expect(staticOnly[0]?.discoveryStatus).toBe('unresolved');
    expect(catalog.inventoryComplete).toBe(false);
  });

  it('keeps zero-instance skipped templates static-only and blocking (no skip bypass)', async () => {
    const root = makePlaywrightProject({
      'e2e/skipped-probe.spec.js': [
        "import { test } from 'playwright/test';",
        "for (const kind of (process.env.PROBE_KINDS || '').split(',').filter(Boolean)) {",
        '  test.skip(`skips ${kind}`, async ({ page }) => {});',
        '}',
        '',
      ].join('\n'),
    });
    const config = fixtureConfig(['e2e/**/*.spec.js']);
    const { catalog } = await discoverTestCatalog({ cwd: root, config });
    // Adding `.skip` to a parameterized template with zero enumerated
    // instances must not complete the inventory: the skipped template is
    // a visible blocking row carrying its skip signal, not a dropped case.
    const staticOnly = catalog.entries.filter((entry) => entry.reconciliation === 'static-only');
    expect(staticOnly.map((entry) => entry.title)).toEqual(['skips ${}']);
    expect(staticOnly[0]?.discoveryStatus).toBe('unresolved');
    expect(staticOnly[0]?.unresolvedReason?.code).toBe('reconciliation-static-only');
    expect(staticOnly[0]?.suppressionSignals.some((signal) => signal.kind === 'skip')).toBe(true);
    expect(catalog.unresolved).toHaveLength(1);
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
 * (`import { test as gateforgeTest } from '@gate-forge/pack-playwright'`,
 * possibly through a consumer-local re-export module). The static scan
 * must follow those bindings — the supervised receipt-sealed run depends
 * on it — while every OTHER module-external import stays unresolved
 * (fail closed). The reconciliation spec runs the installed playwright
 * CLI against a TEMP project (no browsers, no network) and therefore
 * needs the pack's built dist (built once by test/global-setup.ts).
 */
describe('pack-runner consumer binding (E22)', () => {
  /** A playwright project that can also resolve the pack specifier. */
  function makePackConsumerProject(files: Record<string, string>): string {
    const root = makeTempDir('gateforge-pack-consumer-');
    mkdirSync(join(root, 'node_modules/@gate-forge'), { recursive: true });
    for (const name of ['playwright', 'playwright-core']) {
      symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
    }
    symlinkSync(
      join(ROOT, 'node_modules', '@gate-forge', 'pack-playwright'),
      join(root, 'node_modules', '@gate-forge', 'pack-playwright'),
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
    "import { test as gateforgeTest } from '@gate-forge/pack-playwright';",
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
      'e2e/helpers.ts': "export { test } from '@gate-forge/pack-playwright';\n",
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
        "const { test } = require('@gate-forge/pack-playwright');",
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
  it('collects pytest tests without writing Python bytecode into the repo', async () => {
    const root = makeTempDir('gateforge-pytest-bytecode-');
    writeTree(root, { 'backend/helper.py': 'VALUE = 1\n' });
    const previousBytecodeSetting = process.env['PYTHONDONTWRITEBYTECODE'];
    delete process.env['PYTHONDONTWRITEBYTECODE'];
    try {
      const suite = suiteConfig({
        argv: ['python3', '-c', 'import backend.helper\nprint("tests/test_a.py::test_one")\n'],
      });
      const result = await collectPytestSuite(suite, root);
      expect(result.status).toBe('discovered');
      expect(existsSync(join(root, 'backend', '__pycache__'))).toBe(false);
    } finally {
      if (previousBytecodeSetting === undefined) delete process.env['PYTHONDONTWRITEBYTECODE'];
      else process.env['PYTHONDONTWRITEBYTECODE'] = previousBytecodeSetting;
    }
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
