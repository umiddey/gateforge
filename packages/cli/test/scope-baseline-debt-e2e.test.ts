/**
 * Phase 4 (E62), end to end through the REAL CLI: a repository whose
 * adopted baseline carries never-mapped obligations must still be able
 * to run a `--scope changed` slice.
 *
 * The bug: the changed-scope planner turned every affected obligation
 * with no testable mapping into a hard EVIDENCE_SCOPE_INCOMPLETE
 * blocker, including the ones the run's own grading forgives through
 * the ADOPTED baseline. The full path ran green over exactly that debt
 * (`applyBaseline`), so the narrow path was unusable on any repository
 * that had adopted its unmapped obligations — the consumer's 192.
 *
 * The fix: the planner is told which fingerprints this run forgives and
 * reports them as adopted debt instead of blockers. They stay inside the
 * sealed covered set, so `check --require-e2e` still demands what the
 * full path grades; an obligation the baseline never adopted still
 * blocks; strict E2E forgives nothing and is byte-identical to before.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import { configYml, installFixture, OBLIGATION_ACCOUNTS, runCli } from './helpers.js';
import { ADAPTER, SPECS, STUB_CLI, VERIFIER_KEY } from './reseal-e2e-fixture.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';

/** The orders obligation: never claimed by any test — the adopted debt. */
const OBLIGATION_ORDERS = 'tenant.orders:persistence:read';

/** Sidecar: the accounts spec claims the accounts obligation; orders has none. */
const TEST_MAP = `\
schemaVersion: 1
tests:
  - key: playwright:chromium:e2e/accounts.spec.mjs:reads an account
    selector:
      runner: playwright
      project: chromium
      file: e2e/accounts.spec.mjs
      titlePath:
        - reads an account
    kind: browser-e2e
    claims:
      - ${OBLIGATION_ACCOUNTS}
    reason: The journey reads the accounts list in the rendered UI.
`;

/** Both resource files after the change under test. */
const CHANGED_FILES = {
  'src/accounts.txt': 'accounts fixture.changed\n',
  'src/orders.txt': 'orders fixture.changed\n',
};

interface Report {
  summary: { blocking: number };
  strictness: { blockingTotal: number };
  blocking: Array<{ name: string | null; cause?: string | null; detail: string }>;
}

/** Installs the two-resource repository with a stubbed playwright runner. */
function installRepo(repo: TempRepo, strictE2E: boolean): void {
  installFixture(repo);
  repo.writeFiles({
    ...SPECS,
    '.gateforge/adapters/accounts.mjs': ADAPTER,
    '.gateforge/adapters/orders.mjs': ADAPTER,
    '.gateforge/test-map.yml': TEST_MAP,
    '.gateforge.yml': `mode: changed\n${strictE2E ? 'enforcement:\n  strictE2E: true\n' : ''}${configYml()}`,
    'playwright.config.mjs': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    'node_modules/playwright/cli.js': STUB_CLI,
    '.gitignore': '.gateforge/test-gates/\nnode_modules/\n',
  });
  repo.commitFiles({}, 'base');
}

/** Adopts the repository's current red set, then runs the changed slice. */
async function adoptAndRunChangedSlice(
  repo: TempRepo,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const adopted = await runCli(repo, ['adopt']);
  expect(adopted.code, `${adopted.stdout}\n${adopted.stderr}`).toBe(0);
  const baseSha = repo.headSha() as string;
  repo.writeFiles(CHANGED_FILES);
  repo.commitFiles(CHANGED_FILES, 'change both resources');
  const config = loadConfig(repo.path('.gateforge.yml'));
  return runCli(
    repo,
    ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
    {
      GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY,
      GATEFORGE_APPROVED_POLICY_DIGEST: trustedPolicyDigestForConfig(repo.root, config),
      CI_MERGE_REQUEST_DIFF_BASE_SHA: baseSha,
    },
  );
}

/** The changed-scope receipt the run sealed. */
function sealedReceipt(repo: TempRepo): { scope: string; coveredObligationFingerprints: string[] } {
  return JSON.parse(readFileSync(`${repo.root}/.gateforge/test-gates/receipt.json`, 'utf8')) as {
    scope: string;
    coveredObligationFingerprints: string[];
  };
}

describe('changed scope against adopted baseline debt (real CLI)', () => {
  it('runs the mapped slice and reports the adopted debt instead of blocking on it', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, false);
      // The debt is real before adoption: the orders obligation has no
      // test, so the static gate is red and `adopt` records its
      // fingerprint as forgiven debt.
      const red = await runCli(repo, ['check', '--format', 'json']);
      const redReport = JSON.parse(red.stdout) as Report;
      // The debt is real before adoption: the orders obligation has no
      // test, so the static gate is red on the obligation verdicts.
      expect(redReport.strictness.blockingTotal).toBe(2);

      const slice = await adoptAndRunChangedSlice(repo);
      const report = JSON.parse(slice.stdout) as Report;
      const ordersBlockers = report.blocking.filter((entry) =>
        `${String(entry.name)} ${entry.detail}`.includes(OBLIGATION_ORDERS),
      );
      expect(ordersBlockers, `${slice.stdout}\n${slice.stderr}`).toEqual([]);
      // The debt is never silently green: the run says so in one plain
      // line, and the obligation stays inside the sealed covered set.
      expect(slice.stderr).toContain(
        '1 affected obligation(s) have no declared mapping and are forgiven by the adopted baseline',
      );
      expect(slice.code, `${slice.stdout}\n${slice.stderr}`).toBe(0);
      const receipt = sealedReceipt(repo);
      expect(receipt.scope).toBe('changed');
      expect(receipt.coveredObligationFingerprints).toHaveLength(2);
    });
  }, 240_000);

  it('strict E2E forgives nothing: the same slice still blocks on the unmapped obligation', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo, true);

      const slice = await adoptAndRunChangedSlice(repo);
      expect(slice.code).not.toBe(0);
      expect(`${slice.stdout}${slice.stderr}`).toContain('EVIDENCE_SCOPE_INCOMPLETE');
      expect(`${slice.stdout}${slice.stderr}`).toContain(OBLIGATION_ORDERS);
    });
  }, 240_000);
});
