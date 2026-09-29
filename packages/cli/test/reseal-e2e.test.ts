/**
 * Test-only re-seal, end to end through the REAL CLI: a full
 * supervised run seals a whole-suite receipt, ONE test file changes,
 * and `test-gates --changed --scope changed` re-runs exactly the
 * affected tests, carries the rest, and seals a receipt bound to the
 * parent. The path is OPT-IN: only `enforcement.reseal: true` enables
 * it, in every gate mode including the strict default.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Canonical, withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import {
  changeOneSpecAndReseal,
  installAndSealParent,
  sealedExecution,
  sealedReceipt,
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

  it('never re-seals when the repository declares no enforcement.reseal key', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo, '');
      const refused = await changeOneSpecAndReseal(repo, env, { expectReseal: false });
      expect(refused.stderr).toContain('the re-seal path is off (`enforcement.reseal` is not true) → full run');
      expect(refused.stderr).not.toContain('only test files changed');
      // The refused re-seal falls through to the ordinary changed-scope
      // path, which seals nothing here (E07: no stale proof survives).
      expect(existsSync(join(repo.root, '.gateforge/test-gates/receipt.json'))).toBe(false);
    });
  }, 180_000);
});
