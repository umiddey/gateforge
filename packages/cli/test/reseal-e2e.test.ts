/**
 * Test-only re-seal, end to end through the REAL CLI: a full
 * supervised run seals a whole-suite receipt, ONE test file changes,
 * and `test-gates --changed --scope changed` re-runs exactly the
 * affected tests, carries the rest, and seals a receipt bound to the
 * parent. The path is OPT-IN: only `enforcement.reseal: true` enables
 * it, in every gate mode including the strict default.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Canonical, withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import {
  changeOneSpecAndReseal,
  fixFailingSpecAndReseal,
  installAndRunFailingParent,
  installAndSealParent,
  sealedExecution,
  sealedReceipt,
  sealedRunRecord,
  SPECS,
  writeIgnoredRuntimeState,
} from './reseal-e2e-fixture.js';

describe('test-only re-seal (real CLI, end to end)', () => {
  it('re-runs only the changed spec, re-seals from the parent, and passes check --require-e2e', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo);
      const parent = sealedReceipt(repo);
      expect(parent.scope).toBeUndefined();
      expect(parent.resealedFrom).toBeUndefined();
      expect(parent.verdictSummary.blocking).toBe(0);
      const fullExecution = sealedExecution(repo);
      expect(fullExecution.outcomes.map((row) => row.logicalKey).sort()).toEqual([
        'playwright:chromium:e2e/accounts.spec.mjs:reads an account',
        'playwright:chromium:e2e/orders.spec.mjs:reads an order',
      ]);
      const parentDigest = sha256Canonical(parent as unknown as Record<string, never>);

      await changeOneSpecAndReseal(repo, env);

      const execution = sealedExecution(repo);
      expect(execution.outcomes.map((row) => row.logicalKey)).toEqual([
        'playwright:chromium:e2e/accounts.spec.mjs:reads an account',
      ]);
      expect(execution.outcomes.every((row) => row.status === 'passed')).toBe(true);

      const receipt = sealedReceipt(repo);
      expect(receipt.changeClass).toBe('test-only');
      expect(receipt.changedPaths).toEqual(['e2e/accounts.spec.mjs']);
      expect(receipt.rerunTests).toBe(1);
      expect(receipt.carriedTests).toBe(1);
      expect(receipt.resealedFrom).toBe(parentDigest);

      // The parent chain is retained next to the new receipt, and CI
      // recomputes the re-seal from it with its own engine and key.
      expect(existsSync(join(repo.root, '.gateforge/test-gates/reseal-chain/hop-1-receipt.json'))).toBe(true);
      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
    });
  }, 180_000);

  it('re-seals under the strict default when the owner opts in, and never without the key', async () => {
    await withTempRepo({}, async (repo) => {
      // Strict is the default mode; `enforcement.reseal: true` is the
      // owner's explicit request, and it is honored there too.
      const env = await installAndSealParent(repo, 'enforcement:\n  reseal: true\n');
      await changeOneSpecAndReseal(repo, env);
      expect(sealedReceipt(repo).changeClass).toBe('test-only');
    });
  }, 180_000);

  it('never re-seals without the opt-in, and writes no run record for a slice run', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo, '');
      const stateDir = join(repo.root, '.gateforge/test-gates');
      // The clean parent run sealed a receipt, so it left no run record
      // behind: a receipt supersedes the record of its own run.
      expect(existsSync(join(stateDir, 'run-record.json'))).toBe(false);

      const refused = await changeOneSpecAndReseal(repo, env, { expectReseal: false });
      expect(refused.stderr).toContain('the re-seal path is off (`enforcement.reseal` is not true) → changed-scope run');
      expect(refused.stderr).not.toContain('only test files changed');
      // The refused re-seal falls through to the ordinary changed-scope
      // path, which seals nothing here (E07: no stale proof survives),
      // and a SLICE run never leaves a run record either.
      expect(existsSync(join(stateDir, 'receipt.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'run-record.json'))).toBe(false);
    });
  }, 180_000);
});

describe('test-only re-seal from a RUN RECORD (a failed parent run)', () => {
  it('re-seals after fixing only the failing test file, and the receipt passes check --require-e2e', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndRunFailingParent(repo);

      // A failing run seals no receipt but leaves a MAC'd, digest-bound
      // run record — the same evidence without a gate verdict.
      const record = sealedRunRecord(repo) as {
        executionResultDigest: string;
        candidateTreeId: string;
        testOutcomesDigest: string;
        mac: string;
        verdictSummary?: unknown;
      };
      expect(record.mac).toMatch(/^[0-9a-f]{64}$/);
      expect(record.verdictSummary).toBeUndefined();
      expect(record.candidateTreeId).toMatch(/^[0-9a-f]{40}$/);
      const failedExecution = sealedExecution(repo);
      expect(failedExecution.outcomes.map((row) => row.status).sort()).toEqual(['failed', 'passed']);

      await fixFailingSpecAndReseal(repo, env);

      const receipt = sealedReceipt(repo);
      expect(receipt.resealedFromKind).toBe('run-record');
      expect(receipt.resealedFrom).toBe(sha256Canonical(record as never));
      expect(receipt.parentReceiptDigest).toBeUndefined();
      expect(receipt.rerunTests).toBe(1);
      expect(receipt.carriedTests).toBe(1);
      expect(sealedExecution(repo).outcomes.every((row) => row.status === 'passed')).toBe(true);
      expect(existsSync(join(repo.root, '.gateforge/test-gates/reseal-chain/hop-1-run-record.json'))).toBe(true);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
    });
  }, 180_000);

  it('never accepts a run record as a receipt: a failed run leaves require-e2e blocked', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndRunFailingParent(repo);
      expect(existsSync(join(repo.root, '.gateforge/test-gates/run-record.json'))).toBe(true);
      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).not.toBe(0);
      expect(checked.stdout).not.toContain('run-record');
    });
  }, 180_000);

  it('refuses the re-seal when the failed test is outside the affected set', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndRunFailingParent(repo);
      // A DIFFERENT test file changes; the failing one does not.
      repo.commitFiles({ 'e2e/orders.spec.mjs': `${SPECS['e2e/orders.spec.mjs'] as string}// touched\n` }, 'touch one spec');
      const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
      expect(resealed.stderr).toContain(
        "the previous run's test playwright:chromium:e2e/accounts.spec.mjs:reads an account failed outside the affected set → changed-scope run",
      );
      expect(resealed.stderr).not.toContain('only test files changed');
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 180_000);

  it('refuses a run record whose MAC was made with a foreign key', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndRunFailingParent(repo);
      const path = join(repo.root, '.gateforge/test-gates/run-record.json');
      const forged = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify({ ...forged, mac: 'f'.repeat(64) }, null, 2)}\n`, 'utf8');

      const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
      expect(resealed.stderr).not.toContain('only test files changed');
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 180_000);
});

describe('a runtime file the run itself rewrites (owner-declared)', () => {
  // The state directory sits OUTSIDE the runner's test root, exactly
  // as it does on the consumer: the specs live in `e2e/`, the login
  // stage writes its storage state into a gitignored `.auth/`.
  const DECLARED = "mode: changed\nenforcement:\n  reseal: true\n  resealRuntimeFiles:\n    - '.auth/*.json'\n";
  const UNDECLARED = 'mode: changed\nenforcement:\n  reseal: true\n';

  it('refuses it with one plain line when the owner declared nothing', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo, UNDECLARED);
      writeIgnoredRuntimeState(repo, 'contractor.json', 'a');
      const run = await changeOneSpecAndReseal(repo, env, { expectReseal: false });
      expect(run.stderr.split('\n').filter((row) => row.startsWith('test-gates: app file changed'))).toEqual([
        'test-gates: app file changed: .auth/contractor.json → changed-scope run',
      ]);
      expect(run.stderr).not.toContain('only test files changed');
      expect(run.stderr).not.toContain('re-seal disregards');
    });
  }, 180_000);

  it('re-seals when the owner declared it, records it, and check --require-e2e recomputes the same decision', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo, DECLARED);
      // The bytes are the run's own: ignored by Git, absent from every
      // commit, present in the sealed candidate tree.
      writeIgnoredRuntimeState(repo, 'contractor.json', 'a');
      expect(repo.git(['ls-files', '.auth/contractor.json']).stdout.trim()).toBe('');
      expect(repo.git(['check-ignore', '.auth/contractor.json']).stdout.trim()).toBe('.auth/contractor.json');
      // A second stage rewrites both before the fix run.
      writeIgnoredRuntimeState(repo, 'employee.json', 'b');
      writeIgnoredRuntimeState(repo, 'contractor.json', 'c');

      const resealed = await changeOneSpecAndReseal(repo, env);

      expect(resealed.stderr).toContain(
        'test-gates: re-seal disregards 2 declared runtime file(s): .auth/contractor.json, .auth/employee.json',
      );
      expect(sealedReceipt(repo).resealDisregarded).toEqual([
        '.auth/contractor.json',
        '.auth/employee.json',
      ]);
      // The receipt still names the REAL tree difference; the
      // declaration only removed those paths from the classification.
      expect(sealedReceipt(repo).changedPaths).toEqual([
        '.auth/contractor.json',
        '.auth/employee.json',
        'e2e/accounts.spec.mjs',
      ]);
      // The consumer recomputes with its own engine, key and config, so
      // an agreeing recomputation is the proof the declaration is sound.
      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code, `${checked.stdout}\n${checked.stderr}`).toBe(0);
    });
  }, 180_000);

  it('prints no disregard line when the declaration covers nothing', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo, DECLARED);
      const plain = await changeOneSpecAndReseal(repo, env);
      expect(plain.stderr).not.toContain('re-seal disregards');
      expect(sealedReceipt(repo).resealDisregarded).toBeUndefined();
    });
  }, 180_000);

  it('never lets the declaration hide a TRACKED file', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo, DECLARED);
      // The same declared glob, on a path this run COMMITS: an owner
      // declaration is an assertion about ignored runtime bytes, never
      // about source, so trackedness is what decides.
      repo.writeFiles({ '.auth/contractor.json': '{"token":"a"}\n' });
      repo.git(['add', '-f', '.auth/contractor.json']);
      repo.commit('track the state file');
      writeIgnoredRuntimeState(repo, 'contractor.json', 'b');
      repo.git(['add', '-f', '.auth/contractor.json']);
      repo.commitFiles(
        { 'e2e/accounts.spec.mjs': `${SPECS['e2e/accounts.spec.mjs'] as string}// the race fix\n` },
        'a tracked state file changed next to a test fix',
      );
      const refused = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
      expect(refused.stderr.split('\n').filter((row) => row.startsWith('test-gates: app file changed'))).toEqual([
        'test-gates: app file changed: .auth/contractor.json → changed-scope run',
      ]);
      expect(refused.stderr).not.toContain('re-seal disregards');
      expect(refused.stderr).not.toContain('only test files changed');
    });
  }, 240_000);
});

describe('one plain reason line when a re-seal parent cannot be used', () => {
  // The consumer's case: the previous run tested bytes the merge-base
  // commit does not contain (an uncommitted edit), so its sealed tree is
  // not the tree of that commit. That refusal is correct — and it must
  // be visible, not a silent fall-through to the changed-scope path.
  const UNCOMMITTED = { 'e2e/orders.spec.mjs': `${SPECS['e2e/orders.spec.mjs'] as string}// edited, never committed\n` };

  async function fixAndRunChanged(
    repo: TempRepo,
    gateConfig: string,
  ): Promise<{ stderr: string; stdout: string; code: number; baseSha: string }> {
    const env = await installAndRunFailingParent(repo, gateConfig, { uncommittedChanges: UNCOMMITTED });
    repo.commitFiles(
      { 'e2e/accounts.spec.mjs': `${SPECS['e2e/accounts.spec.mjs'] as string}// the race is fixed\n` },
      'fix the race in the one failing spec',
    );
    const run = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
    return { ...run, stderr: run.stderr.split(repo.root).join('<repo>'), baseSha: env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] as string };
  }

  it('names the uncommitted tree when the previous run tested uncommitted changes', async () => {
    await withTempRepo({}, async (repo) => {
      const run = await fixAndRunChanged(repo, 'mode: changed\nenforcement:\n  reseal: true\n');
      const line = `test-gates: the previous run cannot be re-sealed from: its sealed tree is not the tree of commit ${run.baseSha.slice(0, 7)} (uncommitted changes were tested) → changed-scope run`;
      expect(run.stderr.split('\n').filter((row) => row.startsWith('test-gates: the previous run cannot be re-sealed'))).toEqual([line]);
      expect(run.stderr).not.toContain('only test files changed');
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 180_000);

  it('names a replaced execution result', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndRunFailingParent(repo);
      // A later run replaced the execution result the record binds: the
      // record no longer describes the evidence beside it.
      const path = join(repo.root, '.gateforge/test-gates/execution-result.json');
      const replaced = JSON.parse(readFileSync(path, 'utf8')) as { outcomes: Array<{ status: string }> };
      for (const outcome of replaced.outcomes) if (outcome.status === 'failed') outcome.status = 'passed';
      writeFileSync(path, `${JSON.stringify(replaced, null, 2)}\n`, 'utf8');
      repo.commitFiles(
        { 'e2e/accounts.spec.mjs': `${SPECS['e2e/accounts.spec.mjs'] as string}// the race is fixed\n` },
        'fix the race in the one failing spec',
      );

      const resealed = await runCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], env);
      expect(resealed.stderr.split('\n').filter((row) => row.startsWith('test-gates: the previous run cannot be re-sealed'))).toEqual([
        'test-gates: the previous run cannot be re-sealed from: its execution result was replaced by a later run → changed-scope run',
      ]);
      expect(resealed.stderr).not.toContain('only test files changed');
    });
  }, 180_000);

  it('prints nothing when the re-seal path is off, byte for byte', async () => {
    const on = await withTempRepo({}, (repo) => fixAndRunChanged(repo, 'mode: changed\nenforcement:\n  reseal: true\n'));
    const off = await withTempRepo({}, (repo) => fixAndRunChanged(repo, 'mode: changed\nenforcement:\n  reseal: false\n'));
    const lines = on.stderr.split('\n');
    const reasonLine = lines.findIndex((row) => row.startsWith('test-gates: the previous run cannot be re-sealed'));
    expect(reasonLine).toBeGreaterThan(-1);
    // The opted-in run differs from the opted-out one by EXACTLY that one
    // line — nothing else about the run changes.
    expect(lines.filter((_, index) => index !== reasonLine).join('\n')).toBe(off.stderr);
  }, 300_000);
});
