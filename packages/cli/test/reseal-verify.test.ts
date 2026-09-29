/**
 * CI recomputation of a re-sealed receipt: `check --require-e2e`
 * re-derives the change set, the classification and the affected set
 * from the two sealed trees with its OWN engine and key, and rejects
 * every claim that does not reproduce — a forged changed-path list, a
 * missing parent, or a chain past the bound.
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import {
  changeOneSpecAndReseal,
  installAndSealParent,
  reforgeReceipt,
  sealedReceipt,
} from './reseal-e2e-fixture.js';

describe('re-seal recomputation in check --require-e2e', () => {
  it('rejects a re-sealed receipt whose changed paths differ from the real diff', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo);
      await changeOneSpecAndReseal(repo, env);
      reforgeReceipt(repo, ['e2e/accounts.spec.mjs', 'e2e/orders.spec.mjs']);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).not.toBe(0);
      expect(checked.stdout).toContain('EVIDENCE_STALE');
      expect(checked.stdout).toContain(
        're-sealed receipt names changed paths e2e/accounts.spec.mjs, e2e/orders.spec.mjs but the trees differ in e2e/accounts.spec.mjs',
      );
    });
  }, 180_000);

  it('rejects a re-sealed receipt whose parent is missing from the run state', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo);
      await changeOneSpecAndReseal(repo, env);
      rmSync(join(repo.root, '.gateforge/test-gates/reseal-chain'), { recursive: true, force: true });

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).not.toBe(0);
      expect(checked.stdout).toContain('EVIDENCE_STALE');
      expect(checked.stdout).toContain('the run state retains no parent receipt');
    });
  }, 180_000);

  it('rejects a re-seal chain longer than the bound of five hops', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo);
      await changeOneSpecAndReseal(repo, env);
      const chain = join(repo.root, '.gateforge/test-gates/reseal-chain');
      for (const hop of [2, 3, 4, 5, 6]) {
        for (const part of ['receipt', 'execution-result', 'catalog']) {
          copyFileSync(join(chain, `hop-1-${part}.json`), join(chain, `hop-${String(hop)}-${part}.json`));
        }
      }

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).not.toBe(0);
      expect(checked.stdout).toContain('EVIDENCE_STALE');
      expect(checked.stdout).toContain('carries 6 consecutive re-seals, past the bound of 5 — run the full suite');
    });
  }, 180_000);
});
