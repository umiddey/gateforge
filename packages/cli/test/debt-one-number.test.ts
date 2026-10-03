/**
 * One repository-debt number for one run (plan §2, "One blocking
 * number"): a real consumer run printed `412 known (baselined), 87 new
 * blocking` from the in-runner reporter and `396 known (baselined), 0
 * new blocking` from the CLI for the SAME run, and the CLI's own JSON
 * contradicted its own text.
 *
 * The fixture is deliberately the shape that produces the disagreement:
 * the adopted baseline covers a CLAIMED and an UNCLAIMED obligation, a
 * WAIVER covers another, and the rest blocks. The reporter grades claims
 * only; it has no waivers, no scope and no baseline, so it must not
 * print a debt split at all. The gate's split has exactly ONE
 * definition (`repositoryDebtOf`) over the graded verdicts.
 *
 * And the split is the count THIS run's exit code blocks on: a
 * changed-scope run that grades only forgiven debt exits 0 and must say
 * `0 new blocking`, with the debt it never observed named apart instead
 * of counted as new. Its full-scope twin, on the same data, blocks.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateforgeReporter } from '@gate-forge/pack-playwright';
import { BLOCKING_VERDICTS, loadConfig, repositoryDebtOf, renderRun, runExitCode, withTempRepo, type ObligationVerdict, type RepositoryDebt, type TempRepo } from '@gate-forge/core';
import { FIXED_AT, installFixture } from './helpers.js';
import { resolveAdoptedBaseline } from '../src/adopted-baseline.js';
import { evaluateRun, obligationFingerprint, type EvaluateResult } from '../src/evaluate.js';
import { runPipeline } from '../src/pipeline.js';
import { resolveStateDir, stateObligations, writeObligations } from '../src/state.js';

const KEY = 'debt-one-number-verifier-key';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Read+delete policy: two obligations per resource. */
const READ_DELETE_POLICIES =
  'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require:\n      - persistence:read\n      - persistence:delete\n';

/** One resource's two obligation ids. */
function obligationsOf(resourceId: string): { read: string; delete: string } {
  return { read: `${resourceId}:persistence:read`, delete: `${resourceId}:persistence:delete` };
}

/** Pin-#2 fingerprint of one read/delete obligation. */
function fingerprintOf(resourceId: string, contract: 'persistence:read' | 'persistence:delete'): string {
  return obligationFingerprint({
    schemaVersion: 1,
    id: `${resourceId}:${contract}`,
    resourceId,
    contract,
    policyId: 'user-facing-crud',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  });
}

/** Four resources x (read+delete) = eight obligations. */
function installEightObligationFixture(repo: TempRepo): void {
  installFixture(repo);
  repo.writeFiles({
    '.gateforge/policies.yml': READ_DELETE_POLICIES,
    'src/cache.txt': 'cache fixture.table\n',
    'src/queue.txt': 'queue fixture.table\n',
    '.gateforge/adapters/cache.mjs': 'export default {};\n',
    '.gateforge/adapters/queue.mjs': 'export default {};\n',
  });
}

/** Adopts the given obligations (mixing claimed and unclaimed ones). */
function writeAdoption(repo: TempRepo, adopted: readonly string[]): void {
  const fingerprints = adopted
    .map((id) => {
      const [resourceId, contract] = id.split(':persistence:') as [string, 'read' | 'delete'];
      return fingerprintOf(resourceId, `persistence:${contract}` as 'persistence:read' | 'persistence:delete');
    })
    .sort();
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

/** A time-bounded waiver for ONE unclaimed obligation (cache:read). */
function writeWaiver(repo: TempRepo): void {
  repo.writeFiles({
    '.gateforge/waivers/cache.json': `${JSON.stringify({
      schemaVersion: 1,
      owner: 'team-cache',
      justificationUrl: 'https://example.invalid/justification',
      approver: 'approver@example.invalid',
      scope: {
        kind: 'exact',
        resourceId: 'tenant.cache',
        fingerprint: fingerprintOf('tenant.cache', 'persistence:read'),
      },
      expiresAt: '2027-01-01T00:00:00.000Z',
    })}\n`,
  });
}

/** The obligations the suite CLAIMS (two tests, one claim each). */
const CLAIMED = [obligationsOf('tenant.accounts').read, obligationsOf('tenant.orders').read] as const;

/** Runs the REAL in-suite reporter over the run state the CLI publishes. */
async function runReporter(stateDir: string, obligationsPath: string): Promise<string> {
  const output: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    output.push(values.map(String).join(' '));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const reporter = new GateforgeReporter({
      stateDir,
      runId: RUN_ID,
      outcomesPath: join(stateDir, 'runner-outcomes.json'),
      obligationsPath,
    });
    for (const [index, obligationId] of CLAIMED.entries()) {
      reporter.onTestEnd(
        {
          id: `spec.js > claim ${String(index)}`,
          title: `claim ${String(index)}`,
          annotations: [{ type: 'gateforge', description: obligationId }],
        } as never,
        { status: 'passed', workerIndex: 0, retry: 0 },
      );
    }
    await reporter.onEnd({ status: 'passed' });
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return output.join('\n');
}

/** One supervised run: the reporter's artifacts, then the gate's grading. */
interface SupervisedRun {
  /** What the in-runner reporter printed. */
  reporter: string;
  /** The run-summary.json debt the reporter wrote. */
  reporterDebt: Record<string, number>;
  /** What the run's exit code grades. */
  graded: EvaluateResult;
  /** The whole-repository evaluation the debt is reported from. */
  repository: EvaluateResult;
  /** Registered obligations with no claim row. */
  unclaimed: number;
  /** The debt every surface reports, from the one definition. */
  debt: RepositoryDebt;
}

/**
 * Runs the in-suite reporter and then the gate's evaluation over the same
 * run state — twice, exactly as `test-gates` does: the graded surface
 * (which decides the exit code) and the whole repository (which the
 * report describes).
 */
async function supervisedRun(
  repo: TempRepo,
  options: { changedFiles: readonly string[] | null },
): Promise<SupervisedRun> {
  const stateDir = resolveStateDir(repo.root);
  const config = loadConfig(join(repo.root, '.gateforge.yml'));
  const scope = options.changedFiles === null ? 'full' : 'changed';
  // In-process plugins resolve repo-relative paths against the process
  // cwd (the production contract) — mirror it.
  const previousCwd = process.cwd();
  if (previousCwd !== repo.root) process.chdir(repo.root);
  try {
    const pipeline = await runPipeline({
      cwd: repo.root,
      env: { ...process.env },
      config,
      provider: 'all-files',
      stateDir,
    });
    const obligationsPath = join(stateDir, 'obligations.json');
    writeObligations(stateDir, stateObligations(pipeline.policy.obligations, pipeline.graph));
    // The CLI publishes the graded scope BEFORE the suite starts; the
    // reporter reads it. It publishes no debt view: the reporter grades
    // claims only, so it has no baseline, waivers or scope to split
    // debt with.
    writeFileSync(
      join(stateDir, 'run-scope.json'),
      `${JSON.stringify({ schemaVersion: 1, scope })}\n`,
    );
    const reporter = await runReporter(stateDir, obligationsPath);
    const evaluation = (changedFiles: readonly string[] | null): EvaluateResult =>
      evaluateRun({
        cwd: repo.root,
        config,
        graph: pipeline.graph,
        obligations: pipeline.policy.obligations,
        blocking: pipeline.policy.blocking,
        stateDir,
        now: pipeline.now,
        changedFiles,
        witnessVerifierKey: KEY,
        baseline: resolveAdoptedBaseline(repo.root, config.baselines),
        evidenceContext: {
          expectedInputDigest: null,
          snapshotUnavailable: true,
          requireInvocationId: false,
          changedInputs: false,
        },
      });
    const graded = evaluation(options.changedFiles);
    const repository = evaluation(null);
    const claims = JSON.parse(readFileSync(join(stateDir, 'claims.json'), 'utf8')) as Array<{
      obligationId: string;
    }>;
    const claimedIds = new Set(claims.map((row) => row.obligationId));
    const unclaimed = repository.verdicts.filter((entry) => !claimedIds.has(entry.obligation.id)).length;
    const summary = JSON.parse(readFileSync(join(stateDir, 'run-summary.json'), 'utf8')) as {
      repositoryDebt: Record<string, number>;
    };
    return {
      reporter,
      reporterDebt: summary.repositoryDebt,
      graded,
      repository,
      unclaimed,
      debt: repositoryDebtOf({
        verdicts: repository.verdicts,
        findings: repository.blocking,
        gradedVerdicts: graded.verdicts,
        gradedFindings: graded.blocking,
        unclaimed,
      }),
    };
  } finally {
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
  }
}

/** Renders the report text the CLI prints for one run. */
function debtText(debt: RepositoryDebt, scope: 'full' | 'changed'): string {
  const execution = {
    scope,
    mode: 'executed',
    testsPerformedThisInvocation: 2,
    selectedTests: { selected: 2, passed: 2, failed: 0, skipped: 0, expectedFailures: 0 },
    selectedClaims: { selected: 2, satisfied: 0, blocking: 0, blockingEntries: 0, waived: 0 },
    repositoryDebt: debt,
  };
  return renderRun([], { format: 'text', execution } as unknown as Parameters<typeof renderRun>[1]);
}

/** The blocking verdicts of one evaluation (the verdicts that block). */
function blockingOf(evaluated: EvaluateResult): ObligationVerdict[] {
  return evaluated.verdicts.filter((entry) => BLOCKING_VERDICTS.includes(entry.verdict));
}

describe('repository debt: one definition, one number, one run', () => {
  it('the gate grades one blocking number and the in-runner reporter defers', async () => {
    await withTempRepo({}, async (repo) => {
      installEightObligationFixture(repo);
      // One CLAIMED (accounts:read) and two UNCLAIMED obligations
      // forgiven; the waiver covers a third.
      writeAdoption(repo, [
        obligationsOf('tenant.accounts').read,
        obligationsOf('tenant.accounts').delete,
        obligationsOf('tenant.orders').delete,
      ]);
      writeWaiver(repo);
      const run = await supervisedRun(repo, { changedFiles: null });

      // The reporter defers: it never names a debt number it cannot
      // own, so a run can never show two different counts.
      expect(run.reporter).toContain('repository debt: graded by gateforge after the run');
      expect(run.reporter).not.toMatch(/known \(baselined\)/);
      expect(run.reporter).not.toMatch(/new blocking/);
      // The legacy run-summary keys stay exactly as they were; the
      // unreleased split is gone rather than guessed at.
      expect(run.reporterDebt).toEqual({ obligations: 8, unclaimed: 6, blocking: 8 });

      // 8 obligations: 3 baselined, 1 waived, 4 still blocking. ONE
      // number names what the gate blocks on.
      expect(run.debt).toMatchObject({
        obligations: 8,
        unclaimed: 6,
        baselined: 3,
        blocking: 4,
        newlyBlocking: 4,
      });
      // The gate really does block on exactly that many obligations:
      // the reported number and the exit decision are one fact.
      expect(blockingOf(run.graded).length + run.graded.blocking.length).toBe(run.debt.newlyBlocking);
      expect(runExitCode({ verdicts: run.graded.verdicts, blocking: run.graded.blocking })).toBe(1);

      // Text and JSON carry the same numbers.
      expect(debtText(run.debt, 'full')).toContain(
        'repository debt: 3 known (baselined), 4 new blocking / 8 obligations (6 unclaimed; 0 blocking entries)',
      );
    });
  });

  it('a changed-scope run that blocks on nothing says 0 new blocking, and names what it never graded', async () => {
    await withTempRepo({}, async (repo) => {
      installEightObligationFixture(repo);
      // Everything the changed slice touches is forgiven; two unclaimed
      // obligations outside it (cache:delete, queue:read) are not.
      writeAdoption(repo, [
        obligationsOf('tenant.accounts').read,
        obligationsOf('tenant.accounts').delete,
        obligationsOf('tenant.orders').read,
        obligationsOf('tenant.orders').delete,
        obligationsOf('tenant.queue').delete,
      ]);
      writeWaiver(repo);
      const run = await supervisedRun(repo, { changedFiles: ['src/accounts.txt'] });

      // The slice grades only forgiven debt: the run exits 0, so the
      // line must not call anything new blocking.
      expect(runExitCode({ verdicts: run.graded.verdicts, blocking: run.graded.blocking })).toBe(0);
      expect(blockingOf(run.graded)).toHaveLength(0);
      expect(run.debt.newlyBlocking).toBe(0);
      // The debt it never observed is reported, with its own words.
      expect(run.debt).toMatchObject({ obligations: 8, baselined: 5, notGradedBlocking: 2 });
      const text = debtText(run.debt, 'changed');
      expect(text).toContain(
        'repository debt: 5 known (baselined), 0 new blocking / 8 obligations (6 unclaimed; 0 blocking entries)',
      );
      expect(text).toContain('not graded by this changed-scope run: 2 blocking obligation(s)');
      // The full-scope twin of the same data blocks on exactly those.
      const full = await supervisedRun(repo, { changedFiles: null });
      expect(runExitCode({ verdicts: full.graded.verdicts, blocking: full.graded.blocking })).toBe(1);
      expect(full.debt.newlyBlocking).toBe(2);
      expect(full.debt.notGradedBlocking).toBe(0);
      expect(debtText(full.debt, 'full')).toContain(
        'repository debt: 5 known (baselined), 2 new blocking / 8 obligations (6 unclaimed; 0 blocking entries)',
      );
    });
  });
});
