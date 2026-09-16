/**
 * `gateforge tests discover` command tests (plan 2026-09-13 phase 2):
 * deterministic catalog production against a small TEMP consumer
 * fixture (real playwright `--list` reconciliation, no browsers), the
 * derived catalog written under the run-state dir (never tracked
 * inputs), unresolved entries as data (exit 0), pytest suites listed as
 * registered (collected only with `--pytest`), and usage/config errors
 * at exit 2. `example-e2e` class: CLI process behavior over a real
 * project tree.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The consumer's playwright config (ESM; project pinned to chromium). */
const PW_CONFIG = "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n";

const ACCOUNTS_SPEC = [
  "import { test } from 'playwright/test';",
  'test.describe("Accounts", () => {',
  "  test('creates an account', async ({ page }) => {",
  '    await page.goto("/accounts");',
  '  });',
  '});',
  "test('deletes an account', async ({ page }) => {",
  '  await page.goto("/accounts");',
  '});',
  '',
].join('\n');

const DIAGNOSTICS_SUITE_YML = `\
diagnostics:
  suites:
    - name: backend-pytest
      runner: pytest
      cwd: .
      argv: ['python3', '-c', 'print("tests/test_x.py::test_one")']
      testPaths: ['tests']
      timeoutMs: 15000
`;

/**
 * Installs the consumer fixture: gateforge config + playwright project
 * whose runner resolves through a node_modules link to the engine's
 * pinned playwright (no network, no npx).
 */
function installConsumer(repo: TempRepo, configExtra = ''): void {
  repo.writeFiles({
    '.gateforge.yml': `\
schemaVersion: 1
project:
  languages: [python]
  paths:
    include: ['e2e/**/*.spec.js']
    exclude: []
plugins:
  - id: fixture.plugin
    version: '1.0.0'
    transport: in-process
    module: ./plugin.mjs
policies: .gateforge/policies.yml
classificationPolicy: .gateforge/classification-policy.yml
adapters: .gateforge/adapters
waivers: .gateforge/waivers
baselines: .gateforge/baselines/obligations.json
changed:
  provider: auto
witness:
  maxDurationSeconds: 5
clock:
  mode: fixed
  fixedAt: '2026-01-01T00:00:00.000Z'
${configExtra}`,
    '.gateforge/policies.yml': 'schemaVersion: 1\npolicies: []\n',
    '.gateforge/classification-policy.yml':
      'schemaVersion: 1\nscanRoots: []\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations: {}\nvolatileFields: []\n',
    'plugin.mjs':
      'export default { discover: () => ({ resources: [], unresolved: [], findings: [], classificationSignals: [], scannedPaths: [] }) };\n',
    'package.json': '{ "type": "module", "private": true }\n',
    'playwright.config.js': PW_CONFIG,
    'e2e/accounts.spec.js': ACCOUNTS_SPEC,
  });
  const nm = join(repo.root, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    symlinkSync(join(ROOT, 'node_modules', name), join(nm, name), 'dir');
  }
}

/** Snapshot of every consumer source file (for the no-mutation check). */
function sourceSnapshot(repo: TempRepo): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === 'node_modules' || name === '.gateforge') continue;
      const absolute = join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      if (statSync(absolute).isDirectory()) walk(absolute, relPath);
      else snapshot.set(relPath, readFileSync(absolute, 'utf8'));
    }
  };
  walk(repo.root, '');
  return snapshot;
}

describe('gateforge tests discover', () => {
  it('writes a deterministic catalog under run state and never touches test files', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const before = sourceSnapshot(repo);

      const first = await runCli(repo, ['tests', 'discover', '--json']);
      expect(first.code).toBe(0);
      expect(first.stderr).toBe('');

      const catalog = JSON.parse(first.stdout) as {
        schemaVersion: number;
        entries: Array<{
          logicalKey: string;
          discoveryStatus: string;
          reconciliation: string;
          project: string | null;
          inferredKind: string;
        }>;
        unresolved: unknown[];
        parseErrors: unknown[];
        inventoryComplete: boolean;
      };
      expect(catalog.schemaVersion).toBe(1);
      expect(
        catalog.entries.map((entry) => [entry.logicalKey, entry.discoveryStatus, entry.reconciliation]),
      ).toEqual([
        ['playwright:chromium:e2e/accounts.spec.js:Accounts>creates an account', 'discovered', 'matched'],
        ['playwright:chromium:e2e/accounts.spec.js:deletes an account', 'discovered', 'matched'],
      ]);
      expect(catalog.entries.every((entry) => entry.inferredKind === 'browser-e2e')).toBe(true);
      expect(catalog.unresolved).toEqual([]);
      expect(catalog.parseErrors).toEqual([]);
      expect(catalog.inventoryComplete).toBe(true);

      // Derived artifact lives under the run-state dir, byte-equal to stdout.
      const written = readFileSync(join(repo.root, '.gateforge/test-gates/test-catalog.json'), 'utf8');
      expect(written).toBe(`${first.stdout.trimEnd()}\n`);

      // Deterministic: a second run is byte-identical.
      const second = await runCli(repo, ['tests', 'discover', '--json']);
      expect(second.code).toBe(0);
      expect(second.stdout).toBe(first.stdout);

      // Discovery modified NO application/test file.
      expect(sourceSnapshot(repo)).toEqual(before);
    });
  });

  it('reports unresolved wrappers as data and still exits 0', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      repo.writeFiles({
        'e2e/wrapper.spec.js': [
          "import { makeJourney } from './journey-factory';",
          'const journey = makeJourney();',
          "journey('an unresolvable journey', async () => {});",
          '',
        ].join('\n'),
        'e2e/journey-factory.js': 'export function makeJourney() { return () => {}; }\n',
      });
      const before = sourceSnapshot(repo);

      const result = await runCli(repo, ['tests', 'discover', '--json']);
      expect(result.code).toBe(0); // unresolved entries are DATA, not failures
      const catalog = JSON.parse(result.stdout) as {
        entries: Array<{ discoveryStatus: string; logicalKey: string }>;
        unresolved: Array<{ code: string }>;
        inventoryComplete: boolean;
      };
      const wrapper = catalog.entries.find((entry) => entry.logicalKey.includes('unresolvable journey'));
      expect(wrapper?.discoveryStatus).toBe('unresolved');
      expect(catalog.unresolved.some((gap) => gap.code === 'unresolved-wrapper')).toBe(true);
      expect(catalog.inventoryComplete).toBe(false);
      expect(sourceSnapshot(repo)).toEqual(before);
    });
  });

  it('human output shows counts, kind histogram, and runner summaries', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const result = await runCli(repo, ['tests', 'discover']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('discovered=2 unresolved=0 parseErrors=0 inventoryComplete=true');
      expect(result.stdout).toContain('browser-e2e=2');
      expect(result.stdout).toContain('runner playwright/playwright: discovered');
      expect(result.stdout).toContain('catalog written:');
    });
  });

  it('lists configured pytest suites as registered until --pytest collects them', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo, DIAGNOSTICS_SUITE_YML);
      repo.writeFiles({ 'tests/test_x.py': 'def test_one():\n    pass\n' });

      const registered = await runCli(repo, ['tests', 'discover', '--json']);
      expect(registered.code).toBe(0);
      const registeredCatalog = JSON.parse(registered.stdout) as {
        entries: Array<{ runner: string }>;
        runnerSummaries: Array<{ runner: string; name: string; status: string; detail: string }>;
      };
      expect(registeredCatalog.entries.every((entry) => entry.runner === 'playwright')).toBe(true);
      const registeredSummary = registeredCatalog.runnerSummaries.find(
        (summary) => summary.runner === 'pytest' && summary.name === 'backend-pytest',
      );
      expect(registeredSummary?.status).toBe('registered');
      expect(registeredSummary?.detail).toContain('--pytest');

      const collected = await runCli(repo, ['tests', 'discover', '--json', '--pytest']);
      expect(collected.code).toBe(0);
      const collectedCatalog = JSON.parse(collected.stdout) as {
        entries: Array<{ runner: string; logicalKey: string; parameterIdentity: string | null }>;
        runnerSummaries: Array<{ runner: string; name: string; status: string }>;
      };
      const pytestRow = collectedCatalog.entries.find((entry) => entry.runner === 'pytest');
      expect(pytestRow?.logicalKey).toBe('pytest:backend-pytest:tests/test_x.py:test_one');
      expect(pytestRow?.parameterIdentity).toBe('tests/test_x.py::test_one');
      const collectedSummary = collectedCatalog.runnerSummaries.find(
        (summary) => summary.runner === 'pytest' && summary.name === 'backend-pytest',
      );
      expect(collectedSummary?.status).toBe('discovered');
    });
  });

  it('maps usage and config problems to exit 2', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);

      const noSubcommand = await runCli(repo, ['tests']);
      expect(noSubcommand.code).toBe(2);
      expect(noSubcommand.stdout).toContain('usage: gateforge tests discover');

      const unknownSub = await runCli(repo, ['tests', 'bogus']);
      expect(unknownSub.code).toBe(2);
      expect(unknownSub.stderr).toContain("unknown tests subcommand 'bogus'");

      const unknownFlag = await runCli(repo, ['tests', 'discover', '--nope']);
      expect(unknownFlag.code).toBe(2);

      // Broken config (unknown key) fails at load, exit 2, no clean run.
      repo.writeFiles({ '.gateforge.yml': 'schemaVersion: 1\nbogusKey: true\n' });
      const badConfig = await runCli(repo, ['tests', 'discover']);
      expect(badConfig.code).toBe(2);
      expect(badConfig.stderr).toContain('gateforge:');
    });
  });
});
