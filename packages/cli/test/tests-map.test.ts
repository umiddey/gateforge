/**
 * Phase 3 `tests suggest|mark|explain` + grading-seam tests (plan
 * 2026-09-13 §5.3/§4): marking is validated against the current catalog
 * and obligation registry, writes the sidecar atomically and
 * idempotently (byte-identical re-runs), refuses contradictions,
 * explain follows the §4 output block, suggest reports
 * TEST_MAPPING_MISSING and resolves after a real mark, and a mapped
 * existing test with no witnessed evidence grades EVIDENCE_NOT_COLLECTED
 * (blocking, never satisfied) on the SAME authoritative check path.
 * `example-e2e` class: CLI process behavior over a real project tree.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAUSE_NEXT_ACTIONS, loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  configYml,
  installFixture,
  OBLIGATION_ACCOUNTS,
  OBLIGATION_ORDERS,
  runCli,
} from './helpers.js';
import { discoverTestCatalog } from '@gate-forge/pack-playwright';

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
  "test('accounts and orders share a journey', async ({ page }) => {",
  '  await page.goto("/accounts");',
  '  await page.goto("/orders");',
  '});',
  '',
].join('\n');

const DELETE_KEY = 'playwright:chromium:e2e/accounts.spec.js:deletes an account';
const CREATE_KEY = 'playwright:chromium:e2e/accounts.spec.js:Accounts>creates an account';
const SHARED_KEY = 'playwright:chromium:e2e/accounts.spec.js:accounts and orders share a journey';

/**
 * Installs the standard gateforge fixture (plugin + policies generating
 * the two persistence:read obligations) PLUS a real playwright project
 * whose runner resolves through node_modules links (no browsers needed
 * for `--list`).
 */
function installConsumer(repo: TempRepo): void {
  installFixture(repo, { include: "['src/**/*.txt', 'e2e/**/*.spec.js']" });
  repo.writeFiles({
    'playwright.config.js': PW_CONFIG,
    'e2e/accounts.spec.js': ACCOUNTS_SPEC,
    // Real consumers ignore node_modules — and the input snapshot must
    // not traverse the (escaping) playwright links check's discovery
    // resolves through.
    '.gitignore': 'node_modules\n',
  });
  const nm = join(repo.root, 'node_modules');
  mkdirSync(nm, { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    const target = join(nm, name);
    if (!existsSync(target)) {
      symlinkSync(join(ROOT, 'node_modules', name), target, 'dir');
    }
  }
}

interface VerdictJson {
  obligationId: string;
  verdict: string;
  cause: string | null;
  nextAction: string | null;
}

interface SuggestJson {
  scope: { mode: string; obligationsInScope: number };
  problems: Array<{ cause: string; obligationId: string | null; detail: string; locations: unknown[] }>;
  suggestions: Array<{
    obligationId: string;
    cause: string;
    candidates: Array<{ logicalKey: string; file: string; why: string[]; overlaps: string[]; score: number; rank: number }>;
    newTestNeeded: boolean;
  }>;
}

/**
 * Builds argv for declaring one obligation against an existing journey.
 *
 * Args:
 *   obligation: obligation id to declare.
 *   extra: additional flags passed to the mark command.
 *   testKey: catalog key of the journey to mark.
 *
 * Returns:
 *   string[]: CLI arguments for `tests mark`.
 */
function markArgv(obligation: string, extra: string[] = [], testKey: string = DELETE_KEY): string[] {
  return [
    'tests', 'mark',
    '--test', testKey,
    '--kind', 'browser-e2e',
    '--category', 'persistence.delete',
    '--obligation', obligation,
    '--reason', 'The existing journey exercises the declared operation.',
    ...extra,
  ];
}

describe('gateforge tests mark', () => {
  it('writes the sidecar atomically, prints the exact diff, and is idempotent byte-for-byte', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const first = await runCli(repo, markArgv(OBLIGATION_ACCOUNTS));
      expect(first.code).toBe(0);
      expect(first.stderr).toBe('');
      expect(first.stdout).toContain(`mark: wrote .gateforge/test-map.yml`);
      expect(first.stdout).toContain(`+++ .gateforge/test-map.yml`);
      expect(first.stdout).toContain(`- key: ${DELETE_KEY}`);
      expect(first.stdout).toContain('claims:');
      expect(first.stdout).toContain(`- ${OBLIGATION_ACCOUNTS}`);
      expect(first.stdout).toContain('reason: The existing journey exercises the declared operation.');

      const sidecarPath = join(repo.root, '.gateforge/test-map.yml');
      expect(existsSync(sidecarPath)).toBe(true);
      const afterFirst = readFileSync(sidecarPath, 'utf8');
      // The document shape (plan §5.3): selector, kind, categories, claims, reason.
      expect(afterFirst).toContain('schemaVersion: 1');
      expect(afterFirst).toContain('runner: playwright');
      expect(afterFirst).toContain('project: chromium');
      expect(afterFirst).toContain('titlePath:');

      // Second identical run: no change at all — byte-identical file.
      const second = await runCli(repo, markArgv(OBLIGATION_ACCOUNTS));
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('no changes');
      expect(readFileSync(sidecarPath, 'utf8')).toBe(afterFirst);
      // Repeated marking never touched the test file itself.
      expect(readFileSync(join(repo.root, 'e2e/accounts.spec.js'), 'utf8')).toBe(ACCOUNTS_SPEC);
    });
  }, 120_000);

  it('json output reports the change and the no-change idempotent run', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const first = await runCli(repo, [...markArgv(OBLIGATION_ACCOUNTS), '--json']);
      expect(first.code).toBe(0);
      const parsed = JSON.parse(first.stdout) as { path: string; changed: boolean; diff: string[] };
      expect(parsed.path).toBe('.gateforge/test-map.yml');
      expect(parsed.changed).toBe(true);
      expect(parsed.diff.some((line) => line.startsWith('+'))).toBe(true);

      const second = await runCli(repo, [...markArgv(OBLIGATION_ACCOUNTS), '--json']);
      const parsedSecond = JSON.parse(second.stdout) as { changed: boolean };
      expect(parsedSecond.changed).toBe(false);
    });
  }, 120_000);

  it('fails with precise errors on unknown key, unknown obligation, and bad kind', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const unknownKey = await runCli(repo, [
        'tests', 'mark', '--test', 'ghost-key', '--kind', 'browser-e2e',
        '--obligation', OBLIGATION_ACCOUNTS, '--reason', 'A reason long enough to pass validation.',
      ]);
      expect(unknownKey.code).toBe(2);
      expect(unknownKey.stderr).toContain("unknown test key 'ghost-key'");
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);

      const unknownObligation = await runCli(repo, markArgv('tenant.ghost:persistence:read'));
      expect(unknownObligation.code).toBe(2);
      expect(unknownObligation.stderr).toContain("unknown obligation id 'tenant.ghost:persistence:read'");
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);

      const badKind = await runCli(repo, [
        'tests', 'mark', '--test', DELETE_KEY, '--kind', 'e2e',
        '--obligation', OBLIGATION_ACCOUNTS, '--reason', 'A reason long enough to pass validation.',
      ]);
      expect(badKind.code).toBe(2);
      expect(badKind.stderr).toContain('--kind must be one of');
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);

      const missingReason = await runCli(repo, [
        'tests', 'mark', '--test', DELETE_KEY, '--kind', 'browser-e2e', '--obligation', OBLIGATION_ACCOUNTS,
      ]);
      expect(missingReason.code).toBe(2);
      expect(missingReason.stderr).toContain('--reason');
    });
  }, 120_000);

  it('refuses a declaration contradicting the catalog evidence (both locations)', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      // The page-fixture journey is strongly inferred browser-e2e;
      // declaring it a unit test is a contradiction (§5.3).
      const contradictory = await runCli(repo, [
        'tests', 'mark', '--test', DELETE_KEY, '--kind', 'unit',
        '--obligation', OBLIGATION_ACCOUNTS, '--reason', 'Deliberately wrong kind for the probe.',
      ]);
      expect(contradictory.code).toBe(2);
      expect(contradictory.stderr).toContain("cannot mark");
      expect(contradictory.stderr).toContain("'browser-e2e' from strong code signals");
      expect(contradictory.stderr).toContain('e2e/accounts.spec.js:');
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);
    });
  }, 120_000);

  it('accepts an observed-e2e mark on a suite-driven browser journey (Observe refinement)', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      // The page-fixture journey is strongly inferred browser-e2e;
      // declaring it observed-e2e REFINES (suite-driven, witness-watched)
      // rather than contradicting — the mark succeeds.
      const marked = await runCli(repo, [
        'tests', 'mark', '--test', DELETE_KEY, '--kind', 'observed-e2e',
        '--category', 'persistence.delete',
        '--obligation', OBLIGATION_ACCOUNTS,
        '--reason', 'The existing journey deletes an account; the witness observes it.',
      ]);
      expect(marked.code).toBe(0);
      const sidecarPath = join(repo.root, '.gateforge/test-map.yml');
      expect(existsSync(sidecarPath)).toBe(true);
      expect(readFileSync(sidecarPath, 'utf8')).toContain('observed-e2e');
    });
  }, 120_000);

  it('refuses an observed-e2e mark over a non-browser inference (api-e2e stays contradictory)', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      // A pure unit test resolves the strong 'unit' kind; observed-e2e
      // (a browser-channel kind) contradicts it like any other mismatch.
      repo.writeFiles({
        'e2e/math.spec.js': [
          "import { test } from 'playwright/test';",
          "test('adds two numbers', () => {",
          '  const sum = 1 + 1;',
          '  if (sum !== 2) throw new Error("wrong");',
          '});',
          '',
        ].join('\n'),
      });
      const unitKey = 'playwright:chromium:e2e/math.spec.js:adds two numbers';
      const mislabeled = await runCli(repo, [
        'tests', 'mark', '--test', unitKey, '--kind', 'observed-e2e',
        '--category', 'persistence.delete',
        '--obligation', OBLIGATION_ACCOUNTS,
        '--reason', 'Deliberately mislabeled unit test for the observe probe.',
      ]);
      expect(mislabeled.code).toBe(2);
      expect(mislabeled.stderr).toContain(`cannot mark '${unitKey}'`);
      expect(mislabeled.stderr).toContain("inference resolved 'unit' from strong code signals");
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);
    });
  }, 120_000);

  it('refuses an observed-e2e mark on a test with observed mocking', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      repo.writeFiles({
        'e2e/mocked.spec.js': [
          "import { test } from 'playwright/test';",
          "test('renders accounts through a mocked boundary', async ({ page }) => {",
          "  await page.route('**/api/accounts', (route) => route.fulfill({ body: '[]' }));",
          "  await page.goto('/accounts');",
          '});',
          '',
        ].join('\n'),
      });
      const mockedKey = 'playwright:chromium:e2e/mocked.spec.js:renders accounts through a mocked boundary';
      const mislabeled = await runCli(repo, [
        'tests', 'mark', '--test', mockedKey, '--kind', 'observed-e2e',
        '--category', 'persistence.read',
        '--obligation', OBLIGATION_ACCOUNTS,
        '--reason', 'Deliberately mislabeled mocked test for the observe probe.',
      ]);
      expect(mislabeled.code).toBe(2);
      expect(mislabeled.stderr).toContain(`cannot mark '${mockedKey}'`);
      expect(mislabeled.stderr).toContain('cannot override observed mocking');
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);
    });
  }, 120_000);

  it('E03: refuses a browser-e2e mark on a networkless unit test (declaration-time refusal)', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      // A pure unit test: no fixtures, no application-boundary call —
      // static inference resolves the strong 'unit' kind
      // (networkless-unit); declaring it browser-e2e is REFUSED.
      repo.writeFiles({
        'e2e/math.spec.js': [
          "import { test } from 'playwright/test';",
          "test('adds two numbers', () => {",
          '  const sum = 1 + 1;',
          '  if (sum !== 2) throw new Error("wrong");',
          '});',
          '',
        ].join('\n'),
      });
      const unitKey = 'playwright:chromium:e2e/math.spec.js:adds two numbers';
      const mislabeled = await runCli(repo, [
        'tests', 'mark', '--test', unitKey, '--kind', 'browser-e2e',
        '--category', 'persistence.delete',
        '--obligation', OBLIGATION_ACCOUNTS,
        '--reason', 'Deliberately mislabeled unit test for the E03 probe.',
      ]);
      expect(mislabeled.code).toBe(2);
      expect(mislabeled.stderr).toContain(`cannot mark '${unitKey}'`);
      expect(mislabeled.stderr).toContain("inference resolved 'unit' from strong code signals");
      expect(mislabeled.stderr).toContain('networkless-unit');
      expect(mislabeled.stderr).toContain('e2e/math.spec.js:');
      // Nothing was written: the mislabel never reaches the sidecar.
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);

      // The browser obligation REMAINS blocking with its precise reason —
      // the refused declaration did not silently downgrade anything.
      const check = await runCli(repo, ['check', '--format', 'json']);
      expect(check.code).toBe(1);
      const report = JSON.parse(check.stdout) as { verdicts: VerdictJson[] };
      const accounts = report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS);
      expect(accounts?.verdict).toBe('missing');
      expect(accounts?.cause).toBe('TEST_MAPPING_MISSING');
      expect(report.verdicts.every((v) => v.verdict !== 'satisfied')).toBe(true);
    });
  }, 120_000);

  it('E03: refuses a browser-e2e mark on a test with observed mocking', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      // The test drives the browser but MOCKS the application boundary
      // (page.route) — an explicit kind cannot override observed mocking
      // (§5.3/§3.2: mocking the proved boundary disqualifies proof).
      repo.writeFiles({
        'e2e/mocked.spec.js': [
          "import { test } from 'playwright/test';",
          "test('renders accounts through a mocked boundary', async ({ page }) => {",
          "  await page.route('**/api/accounts', (route) => route.fulfill({ body: '[]' }));",
          "  await page.goto('/accounts');",
          '});',
          '',
        ].join('\n'),
      });
      const mockedKey = 'playwright:chromium:e2e/mocked.spec.js:renders accounts through a mocked boundary';
      const mislabeled = await runCli(repo, [
        'tests', 'mark', '--test', mockedKey, '--kind', 'browser-e2e',
        '--category', 'persistence.read',
        '--obligation', OBLIGATION_ACCOUNTS,
        '--reason', 'Deliberately mislabeled mocked test for the E03 probe.',
      ]);
      expect(mislabeled.code).toBe(2);
      expect(mislabeled.stderr).toContain(`cannot mark '${mockedKey}'`);
      expect(mislabeled.stderr).toContain('the catalog observed mocking');
      expect(mislabeled.stderr).toContain('page.route');
      expect(mislabeled.stderr).toContain('cannot override observed mocking');
      expect(existsSync(join(repo.root, '.gateforge/test-map.yml'))).toBe(false);

      // Still blocking, precise cause, nothing satisfied.
      const check = await runCli(repo, ['check', '--format', 'json']);
      expect(check.code).toBe(1);
      const report = JSON.parse(check.stdout) as { verdicts: VerdictJson[] };
      expect(report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS)?.verdict).toBe('missing');
      expect(report.verdicts.every((v) => v.verdict !== 'satisfied')).toBe(true);
    });
  }, 120_000);
});

describe('gateforge tests explain', () => {
  it('prints the §4 block for a marked test and exits 2 for an unknown key', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      expect((await runCli(repo, ['tests', 'mark', ...markArgv(OBLIGATION_ACCOUNTS).slice(2)])).code).toBe(0);

      const explained = await runCli(repo, ['tests', 'explain', '--test', DELETE_KEY]);
      expect(explained.code).toBe(0);
      expect(explained.stdout).toContain(`Requirement: ${OBLIGATION_ACCOUNTS}`);
      expect(explained.stdout).toContain(`Existing test: ${DELETE_KEY} (e2e/accounts.spec.js)`);
      expect(explained.stdout).toContain('Mapping: declared in test-map.yml');
      expect(explained.stdout).toContain('Execution: not run for this change');
      expect(explained.stdout).toContain('Next action: run the existing test with the witness');
      expect(explained.stdout).toContain('New test needed: no');

      // Deterministic: identical output on a second run.
      const again = await runCli(repo, ['tests', 'explain', '--test', DELETE_KEY]);
      expect(again.stdout).toBe(explained.stdout);

      const unknown = await runCli(repo, ['tests', 'explain', '--test', 'ghost-key']);
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain("unknown test key 'ghost-key'");
    });
  }, 180_000);

  it('json output carries the machine-readable report; unmarked tests show unmapped', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const unmarked = await runCli(repo, ['tests', 'explain', '--test', CREATE_KEY, '--json']);
      expect(unmarked.code).toBe(0);
      const unmarkedReport = JSON.parse(unmarked.stdout) as {
        existingTest: { key: string; file: string };
        execution: string;
        blocks: Array<{ mapping: string; requirement: string }>;
      };
      expect(unmarkedReport.existingTest.key).toBe(CREATE_KEY);
      expect(unmarkedReport.execution).toContain('not run for this change');
      // No declaration exists for the create journey: inference may hint
      // at it, and explain says so honestly (a suggestion, not a mapping).
      expect(unmarkedReport.blocks[0]?.mapping).toContain('inferred');
      expect(unmarkedReport.blocks[0]?.mapping).toContain('never auto-declared');

      await runCli(repo, markArgv(OBLIGATION_ACCOUNTS));
      const marked = await runCli(repo, ['tests', 'explain', '--test', DELETE_KEY, '--json']);
      const markedReport = JSON.parse(marked.stdout) as {
        blocks: Array<{ mapping: string; newTestNeeded: string; requirement: string }>;
      };
      expect(markedReport.blocks).toHaveLength(1);
      expect(markedReport.blocks[0]?.requirement).toBe(OBLIGATION_ACCOUNTS);
      expect(markedReport.blocks[0]?.mapping).toBe('declared in test-map.yml');
      expect(markedReport.blocks[0]?.newTestNeeded).toBe('no');
    });
  }, 180_000);
});

describe('gateforge tests suggest', () => {
  it('reports TEST_MAPPING_MISSING before a mark and resolves after a real mark', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const before = await runCli(repo, ['tests', 'suggest', '--json']);
      expect(before.code).toBe(0);
      const beforeJson = JSON.parse(before.stdout) as SuggestJson;
      expect(beforeJson.scope.mode).toBe('all');
      const missing = beforeJson.suggestions.find(
        (suggestion) => suggestion.obligationId === OBLIGATION_ACCOUNTS,
      );
      expect(missing?.cause).toBe('TEST_MAPPING_MISSING');
      expect(missing?.newTestNeeded).toBe(false); // the delete journey is a candidate
      expect(missing?.candidates.some((candidate) => candidate.logicalKey === DELETE_KEY)).toBe(true);

      // Mark the existing journey — the mapping suggestion resolves.
      expect((await runCli(repo, markArgv(OBLIGATION_ACCOUNTS, [], SHARED_KEY))).code).toBe(0);
      const after = await runCli(repo, ['tests', 'suggest', '--json']);
      expect(after.code).toBe(0);
      const afterJson = JSON.parse(after.stdout) as SuggestJson;
      expect(
        afterJson.suggestions.some(
          (suggestion) =>
            suggestion.obligationId === OBLIGATION_ACCOUNTS &&
            suggestion.cause === 'TEST_MAPPING_MISSING',
        ),
      ).toBe(false);
      // The never-marked orders obligation still reports missing.
      expect(
        afterJson.suggestions.find((suggestion) => suggestion.obligationId === OBLIGATION_ORDERS)?.cause,
      ).toBe('TEST_MAPPING_MISSING');
      const overlappingCandidate = afterJson.suggestions
        .find((suggestion) => suggestion.obligationId === OBLIGATION_ORDERS)
        ?.candidates.find((candidate) => candidate.logicalKey === SHARED_KEY);
      expect(overlappingCandidate?.overlaps).toContain(OBLIGATION_ACCOUNTS);

      // Deterministic ordering + human surface.
      const repeat = await runCli(repo, ['tests', 'suggest', '--json']);
      expect(repeat.stdout).toBe(after.stdout);
      const human = await runCli(repo, ['tests', 'suggest']);
      expect(human.stdout).toContain(`[${'TEST_MAPPING_MISSING'}] ${OBLIGATION_ORDERS}`);
      expect(human.stdout).toContain('new test needed:');
    });
  }, 180_000);

  it('surfaces sidecar problems as typed suggestion causes', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      // A hand-edited stale sidecar (key matches nothing) — both paths
      // (hand edit, mark) receive identical validation per §5.3.
      repo.writeFiles({
        '.gateforge/test-map.yml': [
          'schemaVersion: 1',
          'tests:',
          '  - key: deleted-journey',
          '    selector:',
          '      runner: playwright',
          '      file: e2e/vanished.spec.js',
          '      titlePath: [gone]',
          '    kind: browser-e2e',
          `    claims: [${OBLIGATION_ACCOUNTS}]`,
          '    reason: A declaration left behind by a deleted test.',
          '',
        ].join('\n'),
      });
      const result = await runCli(repo, ['tests', 'suggest', '--json']);
      expect(result.code).toBe(0); // inspection surface, never a gate
      const parsed = JSON.parse(result.stdout) as SuggestJson;
      expect(parsed.problems.some((problem) => problem.cause === 'TEST_MAPPING_STALE')).toBe(true);
      const stale = parsed.suggestions.find(
        (suggestion) => suggestion.obligationId === OBLIGATION_ACCOUNTS,
      );
      expect(stale?.cause).toBe('TEST_MAPPING_STALE');
    });
  }, 180_000);
  it('keeps static rows unknown when native enumeration reports load errors', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      repo.writeFiles({
        'e2e/accounts.spec.js': [
          "import { test } from 'playwright/test';",
          "import 'gateforge-missing-load-dependency';",
          "test('statically present account journey', async () => {});",
          '',
        ].join('\n'),
        '.gateforge/test-map.yml': [
          'schemaVersion: 1',
          'tests:',
          '  - key: first-mapping',
          '    selector: { runner: playwright, file: e2e/accounts.spec.js, titlePath: [first] }',
          '    kind: browser-e2e',
          `    claims: [${OBLIGATION_ACCOUNTS}]`,
          '    reason: Existing declaration one.',
          '  - key: second-mapping',
          '    selector: { runner: playwright, file: e2e/accounts.spec.js, titlePath: [second] }',
          '    kind: browser-e2e',
          `    claims: [${OBLIGATION_ORDERS}]`,
          '    reason: Existing declaration two.',
          '',
        ].join('\n'),
      });

      const config = loadConfig(repo.path('.gateforge.yml'));
      const discovered = await discoverTestCatalog({ cwd: repo.root, config });
      expect(discovered.nativeErrors.length).toBeGreaterThan(0);
      expect(
        discovered.catalog.entries.some(
          (entry) => entry.file === 'e2e/accounts.spec.js' && entry.reconciliation === 'static-only',
        ),
      ).toBe(true);

      const suggestion = await runCli(repo, ['tests', 'suggest', '--json']);
      expect(suggestion.code).toBe(0);
      const suggestionReport = JSON.parse(suggestion.stdout) as {
        problems: Array<{ cause: string; detail: string }>;
      };
      expect(
        suggestionReport.problems.filter((problem) => problem.cause === 'TEST_INVENTORY_INCOMPLETE'),
      ).toHaveLength(1);
      expect(
        suggestionReport.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE'),
      ).toHaveLength(0);

      const check = await runCli(repo, ['check', '--format', 'json']);
      const checkReport = JSON.parse(check.stdout) as {
        blocking: Array<{ cause?: string; detail?: string }>;
      };
      expect(
        checkReport.blocking.filter((entry) => entry.cause === 'TEST_INVENTORY_INCOMPLETE'),
      ).toHaveLength(1);
      expect(
        checkReport.blocking.filter((entry) => entry.cause === 'TEST_MAPPING_STALE'),
      ).toHaveLength(0);
    });
  }, 180_000);


  it('reports failed native enumeration once instead of fanning out stale sidecar mappings', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      repo.writeFiles({
        '.gateforge.yml': configYml(),
        'e2e/accounts.spec.js': "import 'gateforge-missing-load-dependency';\n",
        '.gateforge/test-map.yml': [
          'schemaVersion: 1',
          'tests:',
          '  - key: first-mapping',
          '    selector: { runner: playwright, file: e2e/accounts.spec.js, titlePath: [first] }',
          '    kind: browser-e2e',
          `    claims: [${OBLIGATION_ACCOUNTS}]`,
          '    reason: Existing declaration one.',
          '  - key: second-mapping',
          '    selector: { runner: playwright, file: e2e/accounts.spec.js, titlePath: [second] }',
          '    kind: browser-e2e',
          `    claims: [${OBLIGATION_ORDERS}]`,
          '    reason: Existing declaration two.',
          '',
        ].join('\n'),
      });

      const config = loadConfig(repo.path('.gateforge.yml'));
      const nativeErrors = (await discoverTestCatalog({ cwd: repo.root, config })).nativeErrors;
      expect(nativeErrors.length).toBeGreaterThan(0);

      const suggestion = await runCli(repo, ['tests', 'suggest', '--json']);
      expect(suggestion.code).toBe(0);
      const suggestionReport = JSON.parse(suggestion.stdout) as {
        problems: Array<{ cause: string; detail: string; nextAction?: string }>;
        suggestions: unknown[];
      };
      const inventoryProblems = suggestionReport.problems.filter(
        (problem) => problem.cause === 'TEST_INVENTORY_INCOMPLETE',
      );
      expect(inventoryProblems).toHaveLength(1);
      expect(inventoryProblems[0]?.detail).toContain(`${nativeErrors.length} load error(s)`);
      expect(inventoryProblems[0]?.detail.endsWith(nativeErrors[0] ?? '')).toBe(true);
      expect(inventoryProblems[0]?.nextAction).toContain('Install');
      expect(suggestionReport.problems.filter((problem) => problem.cause === 'TEST_MAPPING_STALE')).toHaveLength(0);
      expect(suggestionReport.suggestions).toEqual([]);

      const check = await runCli(repo, ['check', '--format', 'json']);
      const checkReport = JSON.parse(check.stdout) as {
        blocking: Array<{ cause?: string; detail?: string; nextAction?: string }>;
      };
      const checkInventory = checkReport.blocking.filter((entry) => entry.cause === 'TEST_INVENTORY_INCOMPLETE');
      expect(checkInventory).toHaveLength(1);
      expect(checkInventory[0]?.detail?.endsWith(nativeErrors[0] ?? '')).toBe(true);
      expect(checkInventory[0]?.nextAction).toContain('Install');
      expect(checkReport.blocking.filter((entry) => entry.cause === 'TEST_MAPPING_STALE')).toHaveLength(0);

      const next = await runCli(repo, ['next', '--json']);
      const nextReport = JSON.parse(next.stdout) as { cause: string; why: string; do: string };
      expect(nextReport.cause).toBe('TEST_INVENTORY_INCOMPLETE');
      expect(nextReport.why.endsWith(nativeErrors[0] ?? '')).toBe(true);
      expect(nextReport.do).toContain('Install');

      const supervised = await runCli(repo, [
        'test-gates',
        '--changed',
        '--scope',
        'changed',
        '--result-only',
        '--format',
        'json',
      ]);
      const supervisedReport = JSON.parse(supervised.stdout) as {
        blocking: Array<{ cause?: string; detail?: string; nextAction?: string }>;
      };
      const supervisedInventory = supervisedReport.blocking.filter(
        (entry) => entry.cause === 'TEST_INVENTORY_INCOMPLETE',
      );
      expect(supervisedInventory, supervised.stdout).toHaveLength(1);
      expect(supervisedInventory[0]?.detail?.endsWith(nativeErrors[0] ?? '')).toBe(true);
      expect(supervisedInventory[0]?.nextAction).toContain('Install');
      expect(supervisedReport.blocking.filter((entry) => entry.cause === 'TEST_MAPPING_STALE')).toHaveLength(0);
    });
  }, 180_000);

  it('ranks candidates, never calls an inference a declaration, and gives one instruction', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      const human = await runCli(repo, ['tests', 'suggest']);
      expect(human.code).toBe(0);

      // No declaration exists in this repo, so no candidate may claim one:
      // an inferred binding is a suggestion, never a declaration. On
      // 0.8.x this printed for hundreds of rows with nothing declared.
      expect(human.stdout).not.toContain('already declared for:');

      // Ranked: every printed candidate carries its 1-based rank.
      expect(human.stdout).toContain('candidates (ranked by evidence):');
      expect(human.stdout).toMatch(/ {2}- #1 playwright:chromium:e2e\/accounts\.spec\.js:/);
      const candidateLines = human.stdout.split('\n').filter((line) => line.startsWith('  - '));
      expect(candidateLines.length).toBeGreaterThan(0);
      for (const line of candidateLines) {
        expect(line).toMatch(/^ {2}- #\d+ playwright:/);
      }
      const json = JSON.parse((await runCli(repo, ['tests', 'suggest', '--json'])).stdout) as SuggestJson;
      const orders = json.suggestions.find((s) => s.obligationId === OBLIGATION_ORDERS);
      expect(orders?.candidates.length).toBeGreaterThan(0);
      for (const candidate of orders?.candidates ?? []) {
        expect(candidate.overlaps).toEqual([]);
        expect(candidate.rank).toBeGreaterThan(0);
      }
      expect(orders?.candidates.map((candidate) => candidate.rank)).toEqual(
        orders?.candidates.map((_, index) => index + 1),
      );

      // One instruction: reuse what exists. The overlay advice is for an
      // obligation NO existing test fits, and must not contradict this one.
      const start = human.stdout.indexOf(`[TEST_MAPPING_MISSING] ${OBLIGATION_ORDERS}`);
      expect(start).toBeGreaterThan(-1);
      const block = human.stdout.slice(start);
      expect(block).not.toContain('Overlay: write');
      expect(block).not.toContain('Do not `tests mark`');
      expect(block).toContain('observed-e2e');
    });
  }, 180_000);

  it('never prints stale roadmap text from `tests explain`', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      expect((await runCli(repo, markArgv(OBLIGATION_ACCOUNTS, [], DELETE_KEY))).code).toBe(0);
      const explained = await runCli(repo, ['tests', 'explain', '--test', DELETE_KEY]);
      expect(explained.code).toBe(0);
      expect(explained.stdout).not.toContain('Phase 4');
      expect(explained.stdout).not.toContain('declared by agent');
      expect(explained.stdout).toContain('declared in test-map.yml');
      expect(explained.stdout).toContain('gateforge test-gates --changed');
    });
  }, 180_000);
});

describe('grading seam (plan §5.3: a mapping declares intent, supplies no result)', () => {
  it('a mapped-but-not-executed obligation blocks with EVIDENCE_NOT_COLLECTED, never satisfied', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);

      // Control: without a sidecar the obligation has NO connected test.
      const unmapped = await runCli(repo, ['check', '--format', 'json']);
      expect(unmapped.code).toBe(1);
      const unmappedVerdicts = JSON.parse(unmapped.stdout) as { verdicts: VerdictJson[] };
      const unmappedAccounts = unmappedVerdicts.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS);
      expect(unmappedAccounts?.cause).toBe('TEST_MAPPING_MISSING');
      expect(unmappedAccounts?.verdict).toBe('missing');

      // Mark the existing journey — the declaration reaches the SAME
      // authoritative check path as a declared claim...
      expect((await runCli(repo, markArgv(OBLIGATION_ACCOUNTS))).code).toBe(0);
      const mapped = await runCli(repo, ['check', '--format', 'json']);
      expect(mapped.code).toBe(1); // ...and STILL blocks: no witnessed evidence exists
      const mappedVerdicts = JSON.parse(mapped.stdout) as { verdicts: VerdictJson[] };
      const accounts = mappedVerdicts.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS);
      expect(accounts?.verdict).toBe('missing');
      expect(accounts?.cause).toBe('EVIDENCE_NOT_COLLECTED');
      expect(accounts?.nextAction).toBe(CAUSE_NEXT_ACTIONS['EVIDENCE_NOT_COLLECTED']);
      // The unmarked obligation keeps its honest missing-mapping cause.
      const orders = mappedVerdicts.verdicts.find((v) => v.obligationId === OBLIGATION_ORDERS);
      expect(orders?.cause).toBe('TEST_MAPPING_MISSING');
      // Nothing got a free pass.
      expect(mappedVerdicts.verdicts.every((v) => v.verdict !== 'satisfied' && v.verdict !== 'waived')).toBe(true);
    });
  }, 180_000);
});
describe('gateforge tests sync', () => {
  it('adds static annotation claims and leaves hand-written entries intact', async () => {
    await withTempRepo({}, async (repo) => {
      installConsumer(repo);
      repo.writeFiles({
        'e2e/accounts.spec.js': [
          "import { test } from 'playwright/test';",
          "function httpClaims(id) { return { annotation: { type: 'gateforge', description: id } }; }",
          "test('creates an account', { annotation: { type: 'gateforge', description: 'tenant.accounts:persistence:read' } }, async ({ page }) => { await page.goto('/accounts'); });",
          "test('reads an account', httpClaims('tenant.orders:persistence:read'), async ({ page }) => { await page.goto('/orders'); });",
          "test('deletes an account', async ({ page }) => { await page.goto('/accounts'); });",
          '',
        ].join('\n'),
        '.gateforge/test-map.yml': [
          'schemaVersion: 1',
          'tests:',
          `  - key: ${DELETE_KEY}`,
          '    selector:',
          '      runner: playwright',
          '      project: chromium',
          '      file: e2e/accounts.spec.js',
          '      titlePath: [deletes an account]',
          '    kind: browser-e2e',
          '    categories: [persistence.delete]',
          `    claims: [${OBLIGATION_ORDERS}]`,
          '    reason: Existing deletion journey remains owner-mapped.',
          '',
        ].join('\n'),
      });
      const before = parseYaml(readFileSync(repo.path('.gateforge/test-map.yml'), 'utf8')) as {
        tests: Array<Record<string, unknown>>;
      };
      const handwritten = before.tests[0];
      const result = await runCli(repo, ['tests', 'sync']);
      expect(result.code).toBe(0);
      const after = parseYaml(readFileSync(repo.path('.gateforge/test-map.yml'), 'utf8')) as {
        tests: Array<Record<string, unknown>>;
      };
      expect(after.tests.find((entry) => entry['key'] === DELETE_KEY)).toEqual(handwritten);
      const generated = after.tests.filter((entry) => entry['source'] === 'annotation');
      expect(generated).toHaveLength(2);
      expect(generated).toContainEqual(
        expect.objectContaining({
          source: 'annotation',
          selector: {
            runner: 'playwright',
            file: 'e2e/accounts.spec.js',
            titlePath: ['creates an account'],
          },
          claims: [OBLIGATION_ACCOUNTS],
        }),
      );
      expect(generated).toContainEqual(
        expect.objectContaining({
          source: 'annotation',
          selector: {
            runner: 'playwright',
            file: 'e2e/accounts.spec.js',
            titlePath: ['reads an account'],
          },
          claims: [OBLIGATION_ORDERS],
        }),
      );
      const bytesAfterSync = readFileSync(repo.path('.gateforge/test-map.yml'), 'utf8');
      expect((await runCli(repo, ['tests', 'sync'])).code).toBe(0);
      expect(readFileSync(repo.path('.gateforge/test-map.yml'), 'utf8')).toBe(bytesAfterSync);
    });
  }, 120_000);
  it('reports unresolved static annotation helpers instead of dropping them', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { include: "['src/**/*.txt', 'e2e/**/*.spec.js']" });
      repo.writeFiles({
        'e2e/unresolved.spec.js': [
          "import { test } from 'playwright/test';",
          "function claims() { return { annotation: { type: 'gateforge', description: process.env.GATEFORGE_CLAIM } }; }",
          "test('uses a computed claim', claims(), async ({ page }) => { await page.goto('/accounts'); });",
          '',
        ].join('\n'),
      });

      const result = await runCli(repo, ['tests', 'sync']);

      expect(result.code).toBe(1);
      expect(result.stdout).toContain('UNRESOLVED');
      expect(result.stdout).toContain('e2e/unresolved.spec.js');
      expect(result.stdout).toContain('uses a computed claim');
    });
  });

  it('warns when generated claims drift without blocking the check or requiring Playwright', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { include: "['src/**/*.txt', 'e2e/**/*.spec.js']" });
      const source = [
        "import { test } from 'playwright/test';",
        `test('reads an account', { annotation: { type: 'gateforge', description: '${OBLIGATION_ACCOUNTS}' } }, async ({ page }) => { await page.goto('/accounts'); });`,
        '',
      ].join('\n');
      repo.writeFiles({ 'e2e/accounts.spec.js': source });
      expect((await runCli(repo, ['tests', 'sync'])).code).toBe(0);

      const checkBefore = await runCli(repo, ['check', '--format', 'json']);
      const before = JSON.parse(checkBefore.stdout) as {
        summary: { blocking: number };
        advisories?: Array<{ cause: string }>;
        verdicts: Array<{ obligationId: string; cause: string | null }>;
      };
      expect(before.advisories ?? []).toHaveLength(0);
      expect(before.verdicts.find((entry) => entry.obligationId === OBLIGATION_ACCOUNTS)?.cause).not.toBe(
        'TEST_MAPPING_MISSING',
      );

      repo.writeFiles({ 'e2e/accounts.spec.js': source.replace(OBLIGATION_ACCOUNTS, OBLIGATION_ORDERS) });
      const checkAfter = await runCli(repo, ['check', '--format', 'json']);
      expect(checkAfter.code).toBe(checkBefore.code);
      const after = JSON.parse(checkAfter.stdout) as {
        summary: { blocking: number };
        blocking: Array<{ cause?: string }>;
        advisories?: Array<{ cause: string; detail: string; nextAction: string }>;
      };
      expect(after.advisories).toContainEqual(
        expect.objectContaining({
          cause: 'TEST_MAP_OUT_OF_SYNC',
          nextAction: 'gateforge tests sync',
        }),
      );
      const drift = after.advisories?.find((entry) => entry.cause === 'TEST_MAP_OUT_OF_SYNC');
      expect(drift?.detail).toContain('e2e/accounts.spec.js');
      expect(drift?.detail).toContain(OBLIGATION_ACCOUNTS);
      expect(drift?.detail).toContain(OBLIGATION_ORDERS);
      expect(after.blocking.some((entry) => entry.cause === 'TEST_MAP_OUT_OF_SYNC')).toBe(false);
      expect(after.summary.blocking).toBe(before.summary.blocking);
    });
  }, 120_000);
});
