/**
 * Scoped receipt consumption + baseline participation (Goals 1 and 2):
 *
 * - `check --require-e2e` acceptance/rejection matrix over receipt
 *   scopes: a full receipt covers everything (unchanged), a
 *   changed-scope receipt satisfies the gate only when EVERY obligation
 *   this evaluation demands is in its sealed covered set, and a
 *   non-covering slice is a typed EVIDENCE_SCOPE_INCOMPLETE block naming
 *   the uncovered obligations.
 * - Goal 1 regression: the supervised evaluation seam
 *   (`resolveAdoptedBaseline` + `evaluateRun`) grades baselined
 *   obligations `waived` while NEW unbaselined obligations still block,
 *   and an unrecorded baseline forgives nothing.
 *
 * The receipts are minted with the REAL trusted machinery
 * (`sealExecutionResult` + `issueGateReceipt`, core HMAC over the
 * `gateforge.receipt.v1` domain); no browser is launched.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, runExitCode, sha256Canonical, withTempRepo, type TempRepo, type TestCatalog } from '@gate-forge/core';
import type { RunnerOutcomesDocument } from '@gate-forge/pack-playwright';
import { currentInputDigest, fixtureFingerprint, installFixture, runCli, FIXED_AT } from './helpers.js';
import { resolveAdoptedBaseline } from '../src/adopted-baseline.js';
import { trustedPolicyDigestForConfig, issueGateReceipt, sealExecutionResult } from '../src/execution.js';
import { evaluateRun, obligationFingerprint } from '../src/evaluate.js';
import { runPipeline } from '../src/pipeline.js';
import { resolveStateDir, writeExecutionResult, writeGateReceipt } from '../src/state.js';
import { VERIFIER_KEY_ENV } from '../src/commands/common.js';

const KEY = 'scoped-receipt-verifier-key';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const INVOCATION_ID = '66666666-7777-4888-8999-000000000000';
const PLANNED_KEY = 'playwright:chromium:e2e/accounts.spec.ts:deletes an account';

/** Pin-#2 fingerprints of the standard fixture's obligations. */
const FP_ACCOUNTS = fixtureFingerprint('tenant.accounts');
const FP_ORDERS = fixtureFingerprint('tenant.orders');

/** Policies document demanding read AND delete (two obligations per resource). */
const READ_DELETE_POLICIES =
  'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require:\n      - persistence:read\n      - persistence:delete\n';

/** Installs the fixture with the read+delete policy (obligations ×4). */
function installReadDeleteFixture(repo: TempRepo): void {
  installFixture(repo);
  repo.writeFiles({ '.gateforge/policies.yml': READ_DELETE_POLICIES });
}

/** One planned playwright instance (the expected-set row of the sealed run). */
function plannedRow() {
  return {
    planned: {
      logicalKey: PLANNED_KEY,
      project: 'chromium',
      file: 'e2e/accounts.spec.ts',
      titlePath: ['deletes an account'],
      frameworkId: null,
    },
    input: {
      logicalKey: PLANNED_KEY,
      project: 'chromium',
      file: 'e2e/accounts.spec.ts',
      titlePath: ['deletes an account'],
      blockingAnnotations: [],
    },
  };
}

function outcomesDoc(): RunnerOutcomesDocument {
  return {
    schemaVersion: 1,
    runStatus: 'passed',
    runnerErrors: [],
    shard: null,
    outcomes: [
      {
        testId: 'spec-1',
        file: 'e2e/accounts.spec.ts',
        titlePath: ['deletes an account'],
        project: 'chromium',
        status: 'passed',
        attempt: 1,
        expectedFailure: false,
      },
    ],
  };
}

const EMPTY_CATALOG: TestCatalog = {
  schemaVersion: 1,
  entries: [],
  unresolved: [],
  parseErrors: [],
  inventoryComplete: true,
  runnerSummaries: [],
};

/**
 * Mints a complete-run execution result + receipt for the CURRENT tree
 * (any scope) — exactly what a successful supervised run leaves behind.
 */
function sealGreenRun(
  repo: TempRepo,
  inputDigest: string,
  scope?: { kind: 'changed'; covered: string[] },
): string {
  const config = loadConfig(`${repo.root}/.gateforge.yml`);
  const stateDir = resolveStateDir(repo.root);
  const trustedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
  const sealed = sealExecutionResult({
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest,
    trustedPolicyDigest,
    runner: 'playwright',
    ...(scope !== undefined ? { mode: 'mapped-selection' as const } : {}),
    logicalKeys: [PLANNED_KEY],
    catalog: EMPTY_CATALOG,
    plannedRows: [plannedRow()],
    envelope: {
      processExit: 0,
      complete: true,
      outcomes: [],
      fixtureOutcome: 'passed',
      shards: null,
      retriesDetected: false,
      engines: { node: process.version },
      browsers: {},
    },
    outcomesDoc: outcomesDoc(),
    startedAt: FIXED_AT,
    finishedAt: FIXED_AT,
  });
  writeExecutionResult(stateDir, sealed.result);
  const receipt = issueGateReceipt({
    verifierKey: KEY,
    runId: RUN_ID,
    invocationId: INVOCATION_ID,
    inputDigest,
    gitSha: null,
    parentSha: null,
    trustedPolicyDigest,
    invocation: 'test-gates --changed',
    selectionDigest: sealed.result.selectionDigest,
    catalogDigest: sha256Canonical(EMPTY_CATALOG as unknown as Record<string, never>),
    ...(scope !== undefined
      ? { scope: 'changed' as const, coveredObligationFingerprints: scope.covered }
      : {}),
    executionResultDigest: sealed.digest,
    evidenceAttestationDigest: null,
    verdictSummary: { total: 0, satisfied: 0, waived: 0, blocking: 0 },
    issuedAt: FIXED_AT,
  });
  writeGateReceipt(stateDir, receipt);
  return receipt.receiptId;
}

describe('check --require-e2e: scope-aware receipt consumption (acceptance/rejection matrix)', () => {
  /**
   * Installs the standard fixture with BOTH resources waived: the
   * obligations grade `waived` (clean) so the receipt gate ALONE drives
   * the matrix exit codes — exactly the seam under test.
   */
  function installWaivedFixture(repo: TempRepo): void {
    installFixture(repo);
    const waiver = (resourceId: string): string =>
      JSON.stringify({
        schemaVersion: 1,
        owner: 'team',
        justificationUrl: 'https://example.invalid/justification',
        approver: 'approver@example.invalid',
        scope: { kind: 'exact', resourceId, fingerprint: fixtureFingerprint(resourceId) },
        expiresAt: '2027-01-01T00:00:00.000Z',
      });
    repo.writeFiles({
      '.gateforge/waivers/accounts.json': waiver('tenant.accounts'),
      '.gateforge/waivers/orders.json': waiver('tenant.orders'),
    });
  }

  it('a full receipt covers everything — unchanged acceptance (regression)', async () => {
    await withTempRepo({}, async (repo) => {
      installWaivedFixture(repo);
      const digest = await currentInputDigest(repo);
      sealGreenRun(repo, digest);
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toMatch(/EVIDENCE_SCOPE_INCOMPLETE|EVIDENCE_STALE|RUN_INCOMPLETE/);
    });
  });

  it('a changed-scope receipt covering every current obligation passes an unscoped check', async () => {
    await withTempRepo({}, async (repo) => {
      installWaivedFixture(repo);
      const digest = await currentInputDigest(repo);
      sealGreenRun(repo, digest, { kind: 'changed', covered: [FP_ACCOUNTS, FP_ORDERS].sort() });
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toMatch(/EVIDENCE_SCOPE_INCOMPLETE/);
    });
  });

  it('a non-covering slice receipt is a typed EVIDENCE_SCOPE_INCOMPLETE block naming the uncovered obligations', async () => {
    await withTempRepo({}, async (repo) => {
      installWaivedFixture(repo);
      const digest = await currentInputDigest(repo);
      sealGreenRun(repo, digest, { kind: 'changed', covered: [FP_ACCOUNTS] });
      const result = await runCli(repo, ['check', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/EVIDENCE_SCOPE_INCOMPLETE/);
      // The blocker NAMES the uncovered obligation, not just a count.
      expect(result.stdout).toContain('tenant.orders:persistence:read');
    });
  });

  it('a slice receipt covers a diff-scoped check exactly when it matches the changed files', async () => {
    await withTempRepo({}, async (repo) => {
      installWaivedFixture(repo);
      repo.commitFiles({}, 'base');
      // Only the accounts source changes (and is staged): the narrowed
      // check demands exactly the accounts slice.
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table v2\n' });
      repo.stage();
      const digest = await currentInputDigest(repo);
      sealGreenRun(repo, digest, { kind: 'changed', covered: [FP_ACCOUNTS] });
      const result = await runCli(repo, ['check', '--changed', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toMatch(/EVIDENCE_SCOPE_INCOMPLETE/);

      // The inverse: a slice receipt for the WRONG obligations cannot
      // certify the accounts change — typed block naming it.
      sealGreenRun(repo, digest, { kind: 'changed', covered: [FP_ORDERS] });
      const wrong = await runCli(repo, ['check', '--changed', '--require-e2e'], { [VERIFIER_KEY_ENV]: KEY });
      expect(wrong.code).toBe(1);
      expect(wrong.stdout).toMatch(/EVIDENCE_SCOPE_INCOMPLETE/);
      expect(wrong.stdout).toContain('tenant.accounts:persistence:read');
    });
  });

  it('--scope validates strictly: supervised-only and enum-checked (usage errors, exit 2)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const bogus = await runCli(repo, ['test-gates', '--changed', '--scope', 'slice-of-pie'], {
        [VERIFIER_KEY_ENV]: KEY,
      });
      expect(bogus.code).toBe(2);
      expect(bogus.stderr).toMatch(/--scope must be 'full' or 'changed'/);
      const unsupervised = await runCli(repo, ['test-gates', '--scope', 'changed'], { [VERIFIER_KEY_ENV]: KEY });
      expect(unsupervised.code).toBe(2);
      expect(unsupervised.stderr).toMatch(/supervised `--changed` option/);
    });
  });
});

/** Fingerprint of a non-default contract obligation (helper does read only). */
function fixtureFingerprint2(resourceId: string, contract: string): string {
  return obligationFingerprint({
    schemaVersion: 1,
    id: `${resourceId}:${contract}`,
    resourceId,
    contract,
    policyId: 'user-facing-crud',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  });
}

/** Adoption artifacts over the read+delete fixture's four obligations. */
function writeAdoption(repo: TempRepo): void {
  const fingerprints = [
    FP_ACCOUNTS,
    FP_ORDERS,
    fixtureFingerprint2('tenant.accounts', 'persistence:delete'),
    fixtureFingerprint2('tenant.orders', 'persistence:delete'),
  ].sort();
  repo.writeFiles({
    '.gateforge/baselines/obligations.json': `${JSON.stringify({ schemaVersion: 1, fingerprints })}\n`,
    '.gateforge/baselines/adoption.json': `${JSON.stringify({
      schemaVersion: 1,
      adoptedAt: FIXED_AT,
      gitSha: null,
      adopted: fingerprints.length,
      proven: 0,
    })}\n`,
  });
}

/**
 * Runs the supervised evaluation shape (the exact seam Goal 1 changed):
 * the shared `resolveAdoptedBaseline` + the unscoped `evaluateRun` call
 * test-gates now performs with a baseline attached.
 */
async function supervisedSeamEvaluation(repo: TempRepo) {
  const config = loadConfig(`${repo.root}/.gateforge.yml`);
  const baseline = resolveAdoptedBaseline(repo.root, config.baselines);
  // In-process plugins resolve repo-relative paths against the process
  // cwd (the production contract) — mirror it like currentInputDigest.
  const previousCwd = process.cwd();
  if (previousCwd !== repo.root) process.chdir(repo.root);
  try {
    const pipeline = await runPipeline({
      cwd: repo.root,
      env: { ...process.env },
      config,
      provider: 'all-files',
      stateDir: resolveStateDir(repo.root),
    });
    return {
      pipeline,
      evaluated: evaluateRun({
        cwd: repo.root,
        config,
        graph: pipeline.graph,
        obligations: pipeline.policy.obligations,
        blocking: pipeline.policy.blocking,
        stateDir: resolveStateDir(repo.root),
        now: pipeline.now,
        changedFiles: null, // supervised shape: whole graded surface, baseline applied
        witnessVerifierKey: KEY,
        baseline,
        evidenceContext: {
          expectedInputDigest: null,
          snapshotUnavailable: true, // no attestation channel in this unit seam
          requireInvocationId: false,
          changedInputs: false,
        },
      }),
      baseline,
    };
  } finally {
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
  }
}

describe('goal 1: baseline participation in the supervised evaluation seam', () => {
  it('a baselined repo grades waived (not blocking) through the supervised evaluation shape', async () => {
    await withTempRepo({}, async (repo) => {
      installReadDeleteFixture(repo);
      writeAdoption(repo);
      const { evaluated } = await supervisedSeamEvaluation(repo);
      expect(evaluated.baselined?.obligations).toBe(4);
      expect(evaluated.verdicts.every((entry) => entry.verdict === 'waived')).toBe(true);
      expect(runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking })).toBe(0);
    });
  });

  it('the 4-new-unbaselined-obligations case still blocks: shrink-only forgiveness', async () => {
    await withTempRepo({}, async (repo) => {
      installReadDeleteFixture(repo);
      writeAdoption(repo);
      // Four NEW obligations appear after adoption (two resources ×
      // read+delete): none is in the shrink-only baseline. The new
      // resources carry reviewed adapters (the fixture contract), so they
      // classify and generate obligations like the originals.
      repo.writeFiles({
        'src/cache.txt': 'cache fixture.table\n',
        'src/queue.txt': 'queue fixture.table\n',
        '.gateforge/adapters/cache.mjs': 'export default {};\n',
        '.gateforge/adapters/queue.mjs': 'export default {};\n',
      });
      const { evaluated, baseline } = await supervisedSeamEvaluation(repo);
      const waived = evaluated.verdicts.filter((entry) => entry.verdict === 'waived');
      const blocking = evaluated.verdicts.filter((entry) => entry.verdict === 'missing');
      expect(waived).toHaveLength(4);
      expect(blocking).toHaveLength(4);
      expect(
        blocking.every(
          (entry) => !baseline?.fingerprints.has(obligationFingerprint(entry.obligation)),
        ),
      ).toBe(true);
      expect(runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking })).toBe(1);
    });
  });

  it('an unrecorded baseline forgives nothing through the same seam (fail closed)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // Baseline file WITHOUT the sibling adoption record.
      repo.writeFiles({
        '.gateforge/baselines/obligations.json': `${JSON.stringify({
          schemaVersion: 1,
          fingerprints: [FP_ACCOUNTS, FP_ORDERS].sort(),
        })}\n`,
      });
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      expect(resolveAdoptedBaseline(repo.root, config.baselines)).toBeNull();
    });
  });
});
