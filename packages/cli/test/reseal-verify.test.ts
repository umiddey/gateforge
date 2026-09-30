/**
 * CI recomputation of a re-sealed receipt: `check --require-e2e`
 * re-derives the change set, the classification and the affected set
 * from the two sealed trees with its OWN engine and key, and rejects
 * every claim that does not reproduce — a forged changed-path list, a
 * missing parent, or a chain past the bound.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import {
  changeOneSpecAndReseal,
  fixFailingSpecAndReseal,
  installAndRunFailingParent,
  installAndSealParent,
  reforgeReceipt,
  sealedReceipt,
  writeIgnoredRuntimeState,
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

  it('rejects a re-sealed receipt whose disregarded runtime-file list does not recompute', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(
        repo,
        "mode: changed\nenforcement:\n  reseal: true\n  resealRuntimeFiles:\n    - '.auth/*.json'\n",
      );
      writeIgnoredRuntimeState(repo, 'contractor.json', 'a');
      await changeOneSpecAndReseal(repo, env);
      expect(sealedReceipt(repo).resealDisregarded).toEqual(['.auth/contractor.json']);
      // The strongest forgery available: a fresh MAC over a claim the
      // consumer must reproduce list for list.
      reforgeReceipt(repo, ['.auth/contractor.json', 'e2e/accounts.spec.mjs'], []);

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).not.toBe(0);
      expect(checked.stdout).toContain('EVIDENCE_STALE');
      expect(checked.stdout).toContain(
        're-sealed receipt names 0 disregarded declared runtime file(s) (<none>) but the recomputation ' +
          'disregards 1 (.auth/contractor.json) (fail closed)',
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

  it('rejects a re-seal from a run record whose retained parent was re-mac\'d with a foreign key', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndRunFailingParent(repo);
      await fixFailingSpecAndReseal(repo, env);
      const retained = join(repo.root, '.gateforge/test-gates/reseal-chain/hop-1-run-record.json');
      const forged = JSON.parse(readFileSync(retained, 'utf8')) as Record<string, unknown>;
      writeFileSync(retained, `${JSON.stringify({ ...forged, mac: 'e'.repeat(64) }, null, 2)}\n`, 'utf8');

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).not.toBe(0);
      expect(checked.stdout).toContain('EVIDENCE_STALE');
      expect(checked.stdout).toContain("parent run record does not authenticate with this keyring");
    });
  }, 240_000);

  it('rejects a re-seal whose chain claims a receipt parent but retains a run record', async () => {
    await withTempRepo({}, async (repo) => {
      const env = await installAndSealParent(repo);
      await changeOneSpecAndReseal(repo, env);
      expect(sealedReceipt(repo).resealedFromKind).toBe('receipt');
      // Inject a run record beside the retained receipt parent: the hop
      // must be recomputed as what it actually holds, never as what a
      // consumer would prefer to read.
      const retained = join(repo.root, '.gateforge/test-gates/reseal-chain/hop-1-run-record.json');
      writeFileSync(retained, `${JSON.stringify({ recordVersion: 1 })}\n`, 'utf8');

      const checked = await runCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
      expect(checked.code).not.toBe(0);
      expect(checked.stdout).toContain('EVIDENCE_STALE');
      expect(checked.stdout).toContain('claims a receipt parent but the run state retains a run-record');
    });
  }, 240_000);
});
