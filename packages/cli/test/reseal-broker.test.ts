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
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import {
  VERIFIER_KEY,
  changeOneSpecAndReseal,
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
});
