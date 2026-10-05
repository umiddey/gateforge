/**
 * §7.7 acceptance (plan 2026-10-05, D2 pytest row): a rule case mapped to
 * a pytest test is satisfied ONLY by a WITNESSED pytest run inside the
 * sealed supervised run — never by an unwitnessed one.
 *
 * The fixture is the real supervised pytest path (`runner: pytest`): the
 * configured diagnostics suite IS the supervised run, the adapter
 * enumerates the expected set through `--collect-only -q` before the run,
 * the pack's pytest plugin spools the test lifecycle to the witness, and
 * the junit report is parsed strictly. Real pytest, real witness, real
 * sealing — no mocks.
 *
 * The two arms:
 * - `witnessed: true`: the suite runs inside the supervised window, the
 *   mapped test passes, and the case grades `satisfied (execution)` —
 *   both in the run report and, from the sealed receipt, in
 *   `check --require-e2e`;
 * - the same suite WITHOUT the witnessed declaration: the very same test
 *   passes in the very same kind of run, and the case stays `unproven`
 *   with the message that says to mark the suite witnessed — an
 *   unwitnessed suite is not proof (owner decision, 2026-10-04).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';
import { answersYml, businessRule, configYml, installFixture, runCli } from './helpers.js';
import { EVIDENCE_FINGERPRINT, evidenceAdapter, startEvidenceApp, VERIFIER_KEY } from './reseal-e2e-fixture.js';

const KEY_DIRECTORIES: string[] = [];
afterAll(() => {
  for (const directory of KEY_DIRECTORIES) rmSync(directory, { recursive: true, force: true });
});

/**
 * The base URL the fixture's adapters declare but nothing ever dials:
 * the witness validates the reviewed adapters at startup, and this
 * fixture's obligations are quiet (the one policy matches nothing), so
 * no adapter call ever happens.
 */

/** The one configured pytest suite; under `runner: pytest` it IS the run. */
const SUITE_NAME = 'invoice-pytest';

/** The rule's pytest test, in repo files, catalog keys and sealed keys. */
const PYTEST_FILE = 'tests/test_invoice_rule.py';
const PYTEST_TITLE = 'test_invoice_stays_readable';
/** Catalog key stored in the sidecar and pytest runner reconciliation reference. */
const PYTEST_KEY = `pytest:${SUITE_NAME}:${PYTEST_FILE}:${PYTEST_TITLE}`;
const PYTEST_REFERENCE = `${PYTEST_FILE}#${PYTEST_TITLE}`;

/** The one-case pytest rule the fixture declares. */
const RULE = businessRule({
  id: 'invoice-readable',
  title: 'An issued invoice stays readable',
  test: 'pytest',
  cases: [{ id: 'stays-readable', describe: 'The issued invoice is still readable afterwards' }],
});

const CLAIM = 'business-rule:invoice-readable/stays-readable';

/** One serialized case of a report's `businessRules` section. */
interface RuleSectionEntry {
  ruleId: string;
  caseId: string;
  status: string;
  channel: string | null;
  mappedTests: readonly string[];
  finding: { cause: string; detail: string; tests: readonly string[] } | null;
}

interface Report {
  summary: { blocking: number };
  businessRules?: RuleSectionEntry[];
}

/** The diagnostics registry block appended to the fixture config. */
function diagnosticsYaml(witnessed: boolean): string {
  return [
    'diagnostics:',
    '  suites:',
    `    - name: ${SUITE_NAME}`,
    '      runner: pytest',
    '      cwd: .',
    "      argv: ['python3', '-m', 'pytest', '-p', 'no:cacheprovider']",
    "      testPaths: ['tests']",
    '      timeoutMs: 120000',
    ...(witnessed ? ['      witnessed: true'] : []),
  ].join('\n');
}

/**
 * The repository: the standard fixture with a QUIET policy (the one
 * policy matches only `sqlalchemy.table` resources and this fixture's
 * resources are `fixture.table`, so no obligation competes with the
 * rule's own finding), the pytest rule, the supervised pytest suite and
 * its one passing test.
 */
function installPytestRepo(repo: TempRepo, witnessed: boolean, appUrl: string): void {
  installFixture(repo);
  repo.writeFiles({
    '.gateforge/policies.yml': [
      'schemaVersion: 1',
      'policies:',
      '  - id: tables-owe-persistence-read',
      '    when:',
      '      kind: sqlalchemy.table',
      '    require:',
      '      - persistence:read',
      '',
    ].join('\n'),
    '.gateforge/classification-policy.yml': answersYml([RULE]),
    // The witness validates every reviewed adapter at startup, so the
    // fixture ships the standard (never-dialed) evidence adapters.
    '.gateforge/adapters/accounts.mjs': evidenceAdapter(appUrl),
    '.gateforge/adapters/orders.mjs': evidenceAdapter(appUrl),
    '.gateforge.yml': `${configYml()}\nrunner: pytest\n${diagnosticsYaml(witnessed)}\n`,
    '.gitignore': '.gateforge/test-gates/\n__pycache__/\n.pytest_cache/\n',
    [PYTEST_FILE]: `def ${PYTEST_TITLE}():\n    assert True\n`,
  });
}

/** Operator environment with the verifier key ring external to the repository. */
function gateEnv(repo: TempRepo, appUrl: string): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-pytest-verifier-'));
  KEY_DIRECTORIES.push(directory);
  const keyFile = join(directory, 'keys.json');
  writeFileSync(
    keyFile,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'pytest-key', keys: { 'pytest-key': VERIFIER_KEY } })}\n`,
    { mode: 0o600 },
  );
  return {
    [VERIFIER_KEY_FILE_ENV]: keyFile,
    GATEFORGE_APP_BASE_URL: appUrl,
    GATEFORGE_TARGET_BASE_URL: appUrl,
    GATEFORGE_TARGET_FINGERPRINT: EVIDENCE_FINGERPRINT,
    GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(
      repo.root,
      loadConfig(repo.path('.gateforge.yml')),
    ),
    CI_MERGE_REQUEST_DIFF_BASE_SHA: repo.headSha() as string,
  };
}

describe('§7.7 a pytest rule case is satisfied only by a witnessed pytest run', () => {
  it('satisfies the case (execution) when the witnessed suite ran, and the receipt proves it to check', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
      installPytestRepo(repo, true, app.url);
      repo.commitFiles({}, 'base');
      // The owner declares the mapping through the product surface: the
      // pytest rule accepts unit/integration/server-e2e under runner
      // pytest, and this test is one.
      const marked = await runCli(repo, [
        'tests', 'mark',
        '--test', PYTEST_REFERENCE,
        '--kind', 'integration',
        '--rule', 'invoice-readable/stays-readable',
        '--reason', 'The witnessed suite executes the invoice read rule.',
      ]);
      const markedOutput = `${marked.stdout}\n${marked.stderr}`;
      expect(marked.code, markedOutput).toBe(0);

      const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], gateEnv(repo, app.url));
      const output = `${run.stdout}\n${run.stderr}`;
      const report = JSON.parse(run.stdout) as Report;
      expect(report.summary.blocking, output).toBe(0);
      expect(report.businessRules, output).toEqual([
        {
          ruleId: 'invoice-readable',
          caseId: 'stays-readable',
          test: 'pytest',
          enforcement: 'block',
          status: 'satisfied',
          channel: 'execution',
          mappedTests: [PYTEST_KEY],
          finding: null,
        },
      ]);
      // A green run with a green rule seals its receipt.
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json')), output).toBe(true);

      // The commit gate grades the SAME case satisfied from the sealed
      // receipt's facts — the witnessed run is the only thing that did it.
      const check = await runCli(
        repo,
        ['check', '--changed', '--require-e2e', '--format', 'json'],
        gateEnv(repo, app.url),
      );
      const checkOutput = `${check.stdout}\n${check.stderr}`;
      expect(check.code, checkOutput).toBe(0);
      const checkReport = JSON.parse(check.stdout) as Report;
      expect(
        checkReport.businessRules?.map((entry) => [entry.caseId, entry.status, entry.channel]),
        checkOutput,
      ).toEqual([['stays-readable', 'satisfied', 'execution']]);
    });
    } finally {
      await app.close();
    }
  }, 240_000);

  it('keeps the case unproven with the mark-witnessed message when the suite was never witnessed', async () => {
    const app = await startEvidenceApp();
    try {
      await withTempRepo({}, async (repo) => {
      installPytestRepo(repo, false, app.url);
      repo.commitFiles({}, 'base');
      const marked = await runCli(repo, [
        'tests', 'mark',
        '--test', PYTEST_REFERENCE,
        '--kind', 'integration',
        '--rule', 'invoice-readable/stays-readable',
        '--reason', 'The suite executes the invoice read rule, but nobody called it witnessed.',
      ]);
      const markedOutput = `${marked.stdout}\n${marked.stderr}`;
      expect(marked.code, markedOutput).toBe(0);

      // The very same run shape: the suite executes, the test passes, the
      // run seals — but no witnessed pytest suite ran, so the passing
      // test is not proof.
      const run = await runCli(repo, ['test-gates', '--changed', '--format', 'json'], gateEnv(repo, app.url));
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.code, output).toBe(1);
      const report = JSON.parse(run.stdout) as Report;
      expect(report.businessRules?.map((entry) => [entry.caseId, entry.status, entry.channel]), output).toEqual([
        ['stays-readable', 'unproven', null],
      ]);
      expect(report.businessRules?.[0]?.finding?.cause, output).toBe('BUSINESS_RULE_TEST_UNPROVEN');
      expect(
        report.businessRules?.[0]?.finding?.detail,
        output,
      ).toContain(
        `passed, but no WITNESSED pytest suite ran in the sealed run — mark the suite witnessed ` +
          '(`diagnostics.suites[].witnessed` in .gateforge.yml); an unwitnessed suite is not proof',
      );
      expect(report.businessRules?.[0]?.finding?.tests, output).toEqual([PYTEST_KEY]);
      // The rule finding fails the run, so nothing is sealed for a later
      // check to grade satisfied from.
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json')), output).toBe(false);
    });
    } finally {
      await app.close();
    }
  }, 240_000);
});
