/**
 * The prepared candidate OUTSIDE its own workspace: the staged pre-commit
 * gate that runs the whole supervised flow inside an isolated checkout,
 * and the broker that commits a workspace against the very bytes the run
 * prepared.
 *
 * Both paths consume a receipt whose candidate tree id is the PREPARED
 * tree — the tree that contains the git-ignored session state the native
 * preparation stages generated — and both must keep the user's workspace
 * and index exactly as they were.
 */
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { VERIFIER_KEY_ENV } from '../src/commands/common.js';
import {
  attestedEnv,
  candidateTreeIdOf,
  CONSUMER_CASES,
  installNativeFreezeFixture,
  nativeRunEnv,
  runNativeCli,
  sealedExecution,
  sealedReceipt,
  startNativeApp,
  writeCandidateChange,
} from './native-freeze-fixture.js';

describe('the prepared candidate in an isolated checkout and at the broker', () => {
  it(
    'staged pre-commit binds the prepared candidate inside its checkout and never touches the user workspace',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-staged-' }, async (repo) => {
          installNativeFreezeFixture(repo);
          // The exact candidate under commit: a comment-only change to the
          // resource source, staged for the frozen index the gate runs.
          writeCandidateChange(repo);
          repo.stage();
          const stagedBefore = repo.git(['diff', '--cached', '--name-only']).stdout;
          const indexBefore = repo.git(['write-tree']).stdout;
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));

          const result = await runNativeCli(repo, ['pre-commit', '--scope', 'staged'], env);
          expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

          // The gate ran a REAL supervised native run inside its isolated
          // checkout and sealed a receipt there: the whole suite, the real
          // engine controller and all.
          const sealed = sealedExecution(repo);
          expect(sealed?.complete).toBe(true);
          expect(sealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(sealed?.outcomes.every((outcome) => outcome.status === 'passed')).toBe(true);
          const receipt = sealedReceipt(repo);
          expect(receipt, 'the checkout state was copied back').not.toBeNull();
          // The receipt binds the tree the freeze accepted inside that
          // checkout, a real tree this run computed itself.
          expect(receipt?.candidateTreeId).not.toBeNull();

          // The user's index and worktree are byte-identical to before.
          expect(repo.git(['diff', '--cached', '--name-only']).stdout).toBe(stagedBefore);
          expect(repo.git(['write-tree']).stdout).toBe(indexBefore);

          // The GENERATED targets never leave the isolated checkout, so the
          // workspace is no longer the candidate the receipt describes and
          // a strict check over it is honestly stale.
          expect(existsSync(repo.path('.auth/alpha.json'))).toBe(false);
          const stale = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
          expect(stale.code).toBe(1);
          expect(`${stale.stdout}\n${stale.stderr}`).toContain('EVIDENCE_STALE');
        });
      } finally {
        await app.stop();
      }
    },
    1_500_000,
  );

  it(
    'the broker commits the SAME prepared workspace and reports EVIDENCE_STALE without the prepared bytes',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-ws-' }, async (workspace) => {
          installNativeFreezeFixture(workspace);
          writeCandidateChange(workspace);
          const env = nativeRunEnv(workspace, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));
          const run = await runNativeCli(workspace, ['test-gates', '--scope', 'full', '--format', 'json'], env);
          expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
          const preparedTree = candidateTreeIdOf(workspace);
          expect(sealedReceipt(workspace)?.candidateTreeId).toBe(preparedTree);

          await withTempRepo({ prefix: 'gateforge-native-authority-' }, async (authority) => {
            authority.commitFiles({ 'README.md': '# authority\n' }, 'authority base');
            const brokerEnv = {
              [VERIFIER_KEY_ENV]: env[VERIFIER_KEY_ENV] as string,
              GATEFORGE_APPROVED_POLICY_DIGEST: env['GATEFORGE_APPROVED_POLICY_DIGEST'] as string,
            };

            // The SAME workspace that was tested: the broker recomputes the
            // raw candidate tree, finds the prepared bytes and commits them.
            const committed = await runNativeCli(
              authority,
              ['broker', 'commit', '--workspace', workspace.root, '--message', 'prepared native candidate'],
              brokerEnv,
            );
            expect(committed.code, `stdout:\n${committed.stdout}\nstderr:\n${committed.stderr}`).toBe(0);
            expect(authority.git(['log', '-1', '--format=%s']).stdout.trim()).toBe('prepared native candidate');
            expect(authority.git(['show', 'HEAD:src/accounts.js']).stdout).toContain('change: audited comment');
            const headAfterCommit = authority.headSha();

            // A workspace that LOST its prepared bytes is a different
            // candidate: the broker refuses it and the ref never moves.
            rmSync(join(workspace.root, '.auth'), { recursive: true, force: true });
            expect(existsSync(workspace.path('.auth/alpha.json'))).toBe(false);
            const stale = await runNativeCli(
              authority,
              ['broker', 'commit', '--workspace', workspace.root, '--message', 'candidate without prepared state'],
              brokerEnv,
            );
            expect(stale.code).toBe(1);
            expect(`${stale.stdout}\n${stale.stderr}`).toContain('EVIDENCE_STALE');
            expect(authority.headSha()).toBe(headAfterCommit);
          });
        });
      } finally {
        await app.stop();
      }
    },
    1_500_000,
  );

  it(
    'a symlink in the workspace is refused by name when the candidate tree is recomputed',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-symlink-' }, async (repo) => {
          installNativeFreezeFixture(repo);
          writeCandidateChange(repo);
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));
          const run = await runNativeCli(repo, ['test-gates', '--scope', 'full', '--format', 'json'], env);
          expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
          const clean = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
          expect(clean.code, `check stdout:\n${clean.stdout}\nstderr:\n${clean.stderr}`).toBe(0);

          // Preparation itself may not symlink, and neither may the
          // workspace: the raw ingestion names the path and fails closed.
          symlinkSync(repo.path('src/accounts.js'), repo.path('leaked-link'));
          const refused = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], env);
          expect(refused.code).not.toBe(0);
          expect(`${refused.stdout}\n${refused.stderr}`).toContain('leaked-link');
        });
      } finally {
        await app.stop();
      }
    },
    1_500_000,
  );
});