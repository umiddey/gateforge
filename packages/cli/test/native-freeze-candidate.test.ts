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
 *
 * Each leg carries the dependency layout that posture really has. A
 * checkout is materialized from tracked index bytes, so it reaches the
 * owner's dependencies through the one sanctioned bridge: the committed
 * runtime document's approved reuse. The broker's workspace has no such
 * bridge at all — its ingestion verifies raw bytes and fails closed on
 * every link — so that workspace carries a real installed closure, and
 * the broker's authority is the workspace itself, holding exactly the
 * commit the receipt was sealed against.
 */
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { brokerCommitCommand } from '../src/broker.js';
import { VERIFIER_KEY_ENV } from '../src/commands/common.js';
import { CaptureStream } from '../src/io.js';
import {
  attestedEnv,
  candidateTreeIdOf,
  commitCandidateChange,
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
          // The checkout this gate materializes is built from TRACKED
          // index bytes, so it would otherwise carry no dependencies at
          // all. The committed runtime document declares the owner's
          // approved reuse, which is the ONLY sanctioned bridge that
          // hands the checkout the dependencies it needs to run this real
          // suite — no product flag, no copied launcher.
          installNativeFreezeFixture(repo, { declaredDependencyReuse: true });
          // The exact candidate under commit: a comment-only change to the
          // resource source, staged for the frozen index the gate runs.
          writeCandidateChange(repo);
          repo.stage();
          const stagedBefore = repo.git(['diff', '--cached', '--name-only']).stdout;
          const indexBefore = repo.git(['write-tree']).stdout;
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));
          // The candidate the gate must not disturb, as raw bytes: the
          // workspace is this exact tree before and after, whatever the
          // gate copied back or ran in its isolated checkout.
          const workspaceTreeBefore = candidateTreeIdOf(repo);

          // The COMPLETE suite, not the mapped subset: `--scope staged`
          // deliberately runs only the tests mapped to obligations the
          // staged paths affect, and what this case grades is the whole
          // frozen candidate — every consumer project of it. Both scopes
          // execute against the very same frozen index, so the frozen
          // bytes, the checkout and the workspace are identical either
          // way; only the selection differs.
          const result = await runNativeCli(repo, ['pre-commit', '--scope', 'full'], env);
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

          // The user's index and worktree are byte-identical to before:
          // the same staged paths, the same index tree, and the same raw
          // candidate the gate read before it started. The engine's own
          // run state is excluded from that walk, so copying it back is
          // not a change to the candidate.
          expect(repo.git(['diff', '--cached', '--name-only']).stdout).toBe(stagedBefore);
          expect(repo.git(['write-tree']).stdout).toBe(indexBefore);
          expect(candidateTreeIdOf(repo), 'the gate left the user workspace byte-identical').toBe(workspaceTreeBefore);

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
          // A raw ingestion that must VERIFY these bytes has no reuse
          // mount support and fails closed on every link, so the
          // workspace carries a real installed dependency closure from
          // the start: the candidate the run seals over is ordinary
          // files, and nothing is removed afterwards to make it look
          // unchanged.
          installNativeFreezeFixture(workspace, { installedDependencies: true });
          // The candidate change is COMMITTED, so the run seals against a
          // real parent commit of THIS workspace and the broker's
          // compare-and-swap base can be that very commit.
          commitCandidateChange(workspace);
          const sealedParent = workspace.git(['rev-parse', 'HEAD^']).stdout.trim();
          const env = nativeRunEnv(workspace, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));
          const run = await runNativeCli(
            workspace,
            ['test-gates', '--changed', '--scope', 'full', '--format', 'json'],
            env,
          );
          expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
          const preparedTree = candidateTreeIdOf(workspace);
          expect(sealedReceipt(workspace)?.candidateTreeId).toBe(preparedTree);
          expect(sealedReceipt(workspace)?.parentSha, 'the run sealed against that parent commit').toBe(sealedParent);

          // The authority IS the workspace: the ref this broker updates
          // holds exactly the commit the receipt was sealed against, with
          // the candidate bytes still in the workspace. A soft reset moves
          // that ref and nothing else, so the prepared bytes, the index
          // state and the commit content are all preserved.
          workspace.git(['reset', '--soft', sealedParent]);
          const brokerEnv = {
            [VERIFIER_KEY_ENV]: env[VERIFIER_KEY_ENV] as string,
            GATEFORGE_APPROVED_POLICY_DIGEST: env['GATEFORGE_APPROVED_POLICY_DIGEST'] as string,
          };

          // The SAME workspace that was tested: the broker recomputes the
          // raw candidate tree, finds the prepared bytes and commits them.
          const committed = await runNativeCli(
            workspace,
            ['broker', 'commit', '--workspace', workspace.root, '--message', 'prepared native candidate'],
            brokerEnv,
          );
          expect(committed.code, `stdout:\n${committed.stdout}\nstderr:\n${committed.stderr}`).toBe(0);
          expect(workspace.git(['log', '-1', '--format=%s']).stdout.trim()).toBe('prepared native candidate');
          expect(workspace.git(['show', 'HEAD:src/accounts.js']).stdout).toContain('change: audited comment');
          const headAfterCommit = workspace.headSha();

          // A workspace that LOST its prepared bytes is a different
          // candidate: the broker refuses it and the ref never moves.
          rmSync(join(workspace.root, '.auth'), { recursive: true, force: true });
          expect(existsSync(workspace.path('.auth/alpha.json'))).toBe(false);
          const stale = await runNativeCli(
            workspace,
            ['broker', 'commit', '--workspace', workspace.root, '--message', 'candidate without prepared state'],
            brokerEnv,
          );
          // Every typed broker rejection is a config-class failure, so the
          // documented exit code for a refusal is 2; the command's own
          // output is carried by the assertion message below.
          expect(stale.code, `broker stdout:\n${stale.stdout}\nbroker stderr:\n${stale.stderr}`).toBe(2);
          expect(workspace.headSha(), 'the refusal created no commit').toBe(headAfterCommit);

          // The CLI prints a refusal's MESSAGE, never its typed cause, so
          // the cause is proved where it is actually carried: the broker's
          // own API, called on this very repository, this very receipt and
          // this very owner-approved policy environment, with the tree
          // ingestion, the policy recomputation, the receipt verification
          // and the authoritative ref all the real ones. The workspace
          // really lost its prepared bytes, so the raw candidate tree is
          // no longer the tree the receipt sealed, and that binding is
          // decided before the compare-and-swap base ever is.
          // It runs under exactly the environment the CLI leg above used,
          // so the two legs differ only in HOW the refusal is observed.
          await expect(
            brokerCommitCommand(
              {
                cwd: workspace.root,
                env: { ...process.env, ...brokerEnv },
                stdout: new CaptureStream(),
                stderr: new CaptureStream(),
              },
              ['--workspace', workspace.root, '--message', 'candidate without prepared state'],
            ),
          ).rejects.toMatchObject({ causeCode: 'EVIDENCE_STALE' });
          expect(workspace.headSha(), 'the typed refusal created no commit either').toBe(headAfterCommit);
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
          const run = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'full', '--format', 'json'],
            env,
          );
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