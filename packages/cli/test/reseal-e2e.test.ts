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
import { sha256Canonical, withTempRepo } from '@gate-forge/core';
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
      expect(refused.stderr).toContain('the re-seal path is off (`enforcement.reseal` is not true) → full run');
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
        "the previous run's test playwright:chromium:e2e/accounts.spec.mjs:reads an account failed outside the affected set → full run",
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
