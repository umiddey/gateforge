/**
 * The broker is the final judge of a re-sealed receipt: it never takes
 * the `test-only` claim on the candidate's word, but recomputes the
 * tree difference, the classification and the affected set from the two
 * sealed trees in its OWN object store, with its own key. An honest
 * re-seal commits; a re-sealed receipt whose changed paths differ from
 * the real diff is a typed EVIDENCE_STALE reject and never a commit.
 *
 * The authority repository IS the workspace here, so the sealed parent
 * and the compare-and-swap base are the same real commit.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Canonical, withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import {
  VERIFIER_KEY,
  changeOneSpecAndReseal,
  changeSpecAndReseal,
  fixFailingSpecAndReseal,
  installAndRunFailingParent,
  installAndSealParent,
  reforgeReceipt,
  sealedReceipt,
  type ResealEnv,
} from './reseal-e2e-fixture.js';

/** Installs the fixture, seals a parent receipt, then re-seals over one changed spec. */
async function withResealedAuthority(body: (authority: TempRepo, env: ResealEnv) => Promise<void>): Promise<void> {
  await withTempRepo({}, async (authority) => {
    const env = await installAndSealParent(authority);
    await changeOneSpecAndReseal(authority, env);
    expect(sealedReceipt(authority).changeClass).toBe('test-only');
    // The authority ref is the BASE the run was sealed against, with the
    // candidate bytes in the workspace — the broker's real posture.
    authority.git(['reset', '--soft', env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] as string]);
    await body(authority, env);
  });
}

describe('broker recomputation of a re-sealed receipt', () => {
  it('commits an honest re-seal after recomputing it', async () => {
    await withResealedAuthority(async (authority) => {
      const committed = await runCli(
        authority,
        ['broker', 'commit', '--workspace', authority.root, '--message', 'honest re-seal'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
      );
      expect(committed.code, `${committed.stdout}\n${committed.stderr}`).toBe(0);
      expect(committed.stdout).toContain('broker: committed');
    });
  }, 240_000);

  it('rejects a re-sealed receipt whose changed paths differ from the real diff, with no commit', async () => {
    await withResealedAuthority(async (authority) => {
      reforgeReceipt(authority, ['e2e/accounts.spec.mjs', 'e2e/orders.spec.mjs']);
      const headBefore = authority.headSha();

      const forged = await runCli(
        authority,
        ['broker', 'commit', '--workspace', authority.root, '--message', 'forged re-seal'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
      );
      expect(forged.code).not.toBe(0);
      expect(forged.stderr).toContain(
        're-sealed receipt names changed paths e2e/accounts.spec.mjs, e2e/orders.spec.mjs but the trees differ in e2e/accounts.spec.mjs',
      );
      expect(authority.headSha()).toBe(headBefore);
    });
  }, 240_000);

  it('commits a re-seal whose parent is a run record, and rejects one whose retained run record was forged', async () => {
    await withTempRepo({}, async (authority) => {
      const env = await installAndRunFailingParent(authority);
      await fixFailingSpecAndReseal(authority, env);
      expect(sealedReceipt(authority).resealedFromKind).toBe('run-record');
      authority.git(['reset', '--soft', env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] as string]);

      const committed = await runCli(
        authority,
        ['broker', 'commit', '--workspace', authority.root, '--message', 're-seal from a run record'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
      );
      expect(committed.code, `${committed.stdout}\n${committed.stderr}`).toBe(0);
      expect(committed.stdout).toContain('broker: committed');
    });

    await withTempRepo({}, async (authority) => {
      const env = await installAndRunFailingParent(authority);
      await fixFailingSpecAndReseal(authority, env);
      authority.git(['reset', '--soft', env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] as string]);
      // The retained parent is re-mac'd with a foreign key: the
      // strongest forgery a holder of another verifier key can make.
      const retained = join(authority.root, '.gateforge/test-gates/reseal-chain/hop-1-run-record.json');
      const forged = JSON.parse(readFileSync(retained, 'utf8')) as Record<string, unknown>;
      writeFileSync(retained, `${JSON.stringify({ ...forged, mac: 'e'.repeat(64) }, null, 2)}\n`, 'utf8');
      const headBefore = authority.headSha();

      const rejected = await runCli(
        authority,
        ['broker', 'commit', '--workspace', authority.root, '--message', 'forged run record'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
      );
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("parent run record does not authenticate with this keyring");
      expect(authority.headSha()).toBe(headBefore);
    });
  }, 300_000);
});

/**
 * A CHAIN of re-seals reaches the broker as one receipt with two hops
 * beneath it, and the broker recomputes both with its own object store
 * and key. An honest chain commits; a chain whose deeper hop was
 * touched is a typed reject with no commit — the broker never believes
 * a hop because the hop above it vouched for it.
 */
describe('broker recomputation of a CHAIN of re-seals', () => {
  /**
   * Seals a full parent, then re-seals twice. The receipt of record
   * names the FIRST re-seal's commit as its parent, so that commit is
   * the compare-and-swap base the broker must be at.
   */
  async function withTwoHopChain(body: (authority: TempRepo) => Promise<void>): Promise<void> {
    await withTempRepo({}, async (authority) => {
      const env = await installAndSealParent(authority);
      await changeOneSpecAndReseal(authority, env);
      // A second hop: a different spec file, so the second re-seal's
      // parent is the first re-seal.
      const firstHop = sealedReceipt(authority);
      await changeSpecAndReseal(authority, env, 'e2e/orders.spec.mjs');
      const receipt = sealedReceipt(authority);
      expect(receipt.changeClass).toBe('test-only');
      expect(receipt.resealedFrom).toBe(sha256Canonical(firstHop as unknown as Record<string, never>));
      expect(existsSync(join(authority.root, '.gateforge/test-gates/reseal-chain/hop-2-receipt.json'))).toBe(true);
      // The authority ref is the commit the chain's immediate parent
      // sealed, with the candidate bytes in the workspace — the
      // broker's real posture.
      authority.git(['reset', '--soft', receipt.carriedFrom as string]);
      await body(authority);
    });
  }

  it('commits an honest two-hop chain after recomputing every hop', async () => {
    await withTwoHopChain(async (authority) => {
      const committed = await runCli(
        authority,
        ['broker', 'commit', '--workspace', authority.root, '--message', 'honest re-seal chain'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
      );
      expect(committed.code, `${committed.stdout}\n${committed.stderr}`).toBe(0);
      expect(committed.stdout).toContain('broker: committed');
    });
  }, 300_000);

  it('rejects a chain whose deeper hop receipt was forged, with no commit', async () => {
    await withTwoHopChain(async (authority) => {
      // Hop 2 is the FIRST re-seal: the broker walks outward from the
      // receipt of record and must authenticate it with its own key.
      const retained = join(authority.root, '.gateforge/test-gates/reseal-chain/hop-2-receipt.json');
      const forged = JSON.parse(readFileSync(retained, 'utf8')) as Record<string, unknown>;
      writeFileSync(retained, `${JSON.stringify({ ...forged, mac: 'b'.repeat(64) }, null, 2)}\n`, 'utf8');
      const headBefore = authority.headSha();

      const rejected = await runCli(
        authority,
        ['broker', 'commit', '--workspace', authority.root, '--message', 'forged chain'],
        { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY },
      );
      expect(rejected.code).not.toBe(0);
      expect(rejected.stderr).toContain("re-seal hop 2's parent receipt does not authenticate with this keyring");
      expect(authority.headSha()).toBe(headBefore);
    });
  }, 300_000);
});
