/**
 * The test-only re-seal over a PREPARED candidate: a parent run that
 * freezes its generated session state, and then the honest outcomes once
 * that generated state changes under a new commit.
 *
 * The fixture's preparation stages can embed the current commit in the
 * session they save, so every commit changes the bytes the candidate was
 * prepared over. That is the condition the re-seal must reason about:
 * carrying a parent's evidence is only honest while the generated state it
 * was proved over still matches.
 *
 * Every selection here is the ordinary PUBLIC CLI surface — a real parent
 * run, a real commit, a real `--changed --scope changed` re-seal and a real
 * independent `check --changed`. Nothing about the classification is
 * configured, stubbed or mocked: the chain is proved by what the sealed
 * receipt and the independent check actually say.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  attestedEnv,
  BODY_SPEC_FILES,
  candidateTreeIdOf,
  CONSUMER_CASES,
  consumerOf,
  installNativeFreezeFixture,
  nativeRunEnv,
  resealChainHops,
  runNativeCli,
  sealedExecution,
  sealedReceipt,
  startNativeApp,
  writeCandidateChange,
} from './native-freeze-fixture.js';

/**
 * Every blocking detail one report printed, joined, plus the command's own
 * stderr — a refusal may surface in either channel.
 *
 * @param result: the CLI result.
 *
 * @returns
 *   string: everything the command said about what it refused.
 */
function surfaced(result: { stdout: string; stderr: string }): string {
  let blocking = '';
  try {
    blocking = (JSON.parse(result.stdout) as { blocking: Array<{ detail: string }> }).blocking
      .map((entry) => entry.detail)
      .join('\n');
  } catch {
    blocking = '';
  }
  return `${blocking}\n${result.stderr}`;
}

/**
 * The operator environment for a merge-request shaped run: the run's own
 * environment plus the diff base the changed-scope provider and the strict
 * check ask about.
 *
 * @param repo: the fixture repository.
 * @param app: the attested base URL, the protected route and the per-run
 *   session secret.
 * @param diffBase: the commit the parent sealed at.
 *
 * @returns
 *   Record<string, string>: the environment both the run and the check share.
 */
function mergeEnv(
  repo: TempRepo,
  app: { url: string; protectedUrl: string; sessionSecret: string },
  diffBase: string,
): Record<string, string> {
  return {
    ...nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret)),
    CI_MERGE_REQUEST_DIFF_BASE_SHA: diffBase,
  };
}

/**
 * Appends a comment-only touch to one committed spec file.
 *
 * @param repo: the fixture repository.
 * @param file: the repo-relative spec file to touch.
 *
 * @returns
 *   string: the sha of the commit that touched it.
 */
function touchSpec(repo: TempRepo, file: string): string {
  return repo.commitFiles(
    { [file]: `${readFileSync(repo.path(file), 'utf8')}// a comment-only touch\n` },
    `touch ${file}`,
  );
}

describe('the test-only re-seal over a prepared candidate', () => {
  it(
    'carries untouched cases when the generated state is byte-stable',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-reseal-' }, async (repo) => {
          installNativeFreezeFixture(repo, { resealEnabled: true });
          writeCandidateChange(repo);
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));

          // The parent: a full supervised native run that freezes the
          // generated session state and seals a receipt over THAT tree.
          const parent = await runNativeCli(repo, ['test-gates', '--scope', 'full', '--format', 'json'], env);
          expect(parent.code, `stdout:\n${parent.stdout}\nstderr:\n${parent.stderr}`).toBe(0);
          const parentSha = repo.headSha() as string;
          const parentReceipt = sealedReceipt(repo);
          expect(parentReceipt?.candidateTreeId).toBe(candidateTreeIdOf(repo));
          expect(sealedExecution(repo)?.outcomes).toHaveLength(CONSUMER_CASES.length);

          // A committed, test-only change to exactly one spec file. The
          // generated state is byte-stable, so preparation freezes the very
          // same bytes again and a carry stays honest.
          touchSpec(repo, 'specs/epsilon-body.spec.js');
          const base = mergeEnv(repo, app, parentSha);

          const resealed = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
            base,
          );
          expect(resealed.code, `stdout:\n${resealed.stdout}\nstderr:\n${resealed.stderr}`).toBe(0);
          const receipt = sealedReceipt(repo);
          // The re-seal really re-sealed from that parent…
          expect(receipt?.resealedFromKind).toBe('receipt');
          expect(receipt?.resealedFrom, 'the chain names the parent it carried from').toBeTruthy();
          expect(receipt?.carriedTests).toBeGreaterThan(0);
          expect((receipt?.carriedTests ?? 0) + (receipt?.rerunTests ?? 0)).toBe(CONSUMER_CASES.length);
          expect(resealChainHops(repo)).toBeGreaterThan(0);
          // …and it bound the candidate this run really tested: a NEW tree,
          // because the committed change is part of it, carrying exactly the
          // parent's generated session bytes (which is what makes the carry
          // honest rather than a re-freeze in disguise).
          const resealedTree = candidateTreeIdOf(repo);
          expect(receipt?.candidateTreeId).toBe(resealedTree);
          expect(receipt?.candidateTreeId).not.toBe(parentReceipt?.candidateTreeId);
          expect(receipt?.changedPaths).toContain('specs/epsilon-body.spec.js');

          // The independent strict check recomputes the same decision and
          // passes over the re-frozen candidate.
          const checked = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], base);
          expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
        });
      } finally {
        await app.stop();
      }
    },
    1_800_000,
  );

  it(
    'refuses to carry when the generated state changed and a consumer was not executed fresh',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-reseal-changed-' }, async (repo) => {
          // Every commit changes the generated session bytes, so this
          // fixture's re-seal always faces a CHANGED runtime target.
          installNativeFreezeFixture(repo, { resealEnabled: true, stateTracksCommit: true });
          writeCandidateChange(repo);
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));
          const parent = await runNativeCli(repo, ['test-gates', '--scope', 'full', '--format', 'json'], env);
          expect(parent.code, `parent stdout:\n${parent.stdout}\nstderr:\n${parent.stderr}`).toBe(0);
          const parentSha = repo.headSha() as string;
          const parentReceipt = sealedReceipt(repo);
          expect(parentReceipt?.candidateTreeId).toBe(candidateTreeIdOf(repo));
          expect(readFileSync(repo.path('.auth/alpha.json'), 'utf8')).toContain(parentSha);

          // A committed change to ONE mapped spec. The preparation chain it
          // depends on runs again in the next run and regenerates that
          // session with THIS commit's bytes, while the independent chain's
          // session still holds the previous ones and its consumer is not
          // executed at all.
          touchSpec(repo, 'specs/delta-body.spec.js');

          const refused = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
            mergeEnv(repo, app, parentSha),
          );
          // The re-seal is refused outright: the run fails closed, clears
          // the receipt and the chain, and says what to run instead.
          expect(refused.code, `stdout:\n${refused.stdout}\nstderr:\n${refused.stderr}`).toBe(1);
          expect(sealedReceipt(repo), 'no receipt survives a refused re-seal').toBeNull();
          expect(resealChainHops(repo), 'no chain hop survives a refused re-seal').toBe(0);

          // The state really was regenerated for the chain that ran again…
          expect(readFileSync(repo.path('.auth/alpha.json'), 'utf8')).toContain(repo.headSha() as string);
          // …and really not for the chain this run never reached, which is
          // exactly why its consumer's evidence may not be carried.
          expect(readFileSync(repo.path('.auth/omega.json'), 'utf8')).toContain(parentSha);
          expect(readFileSync(repo.path('.auth/omega.json'), 'utf8')).not.toContain(repo.headSha() as string);

          const message = surfaced(refused);
          // The refusal is actionable: it names a consumer of the changed
          // state this run did not execute, and the explicit full-fresh
          // command that would prove every consumer.
          expect(message).toContain('gateforge test-gates --changed --scope full');
          expect(message).toContain(`specs/${consumerOf('.auth/alpha.json')}.spec.js`);
          expect(message).toContain(`specs/${consumerOf('.auth/gamma.json')}.spec.js`);
        });
      } finally {
        await app.stop();
      }
    },
    1_800_000,
  );

  it(
    'seals a re-seal CHAIN when every consumer executes fresh after the state changed',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-reseal-fresh-' }, async (repo) => {
          installNativeFreezeFixture(repo, { resealEnabled: true, stateTracksCommit: true });
          writeCandidateChange(repo);
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));
          const parent = await runNativeCli(repo, ['test-gates', '--scope', 'full', '--format', 'json'], env);
          expect(parent.code, `parent stdout:\n${parent.stdout}\nstderr:\n${parent.stderr}`).toBe(0);
          const parentSha = repo.headSha() as string;
          const parentReceipt = sealedReceipt(repo);
          expect(readFileSync(repo.path('.auth/alpha.json'), 'utf8')).toContain(parentSha);

          // The same regenerated state, but now EVERY consumer of it is
          // executed fresh: all four body specs change, so the whole
          // captured graph is inside the re-seal's affected set.
          for (const file of BODY_SPEC_FILES) touchSpec(repo, file);
          const base = mergeEnv(repo, app, parentSha);

          const fresh = await runNativeCli(repo, ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'], base);
          expect(fresh.code, `stdout:\n${fresh.stdout}\nstderr:\n${fresh.stderr}`).toBe(0);

          const receipt = sealedReceipt(repo);
          // This is a CHAIN, not an ordinary receipt: it names the parent
          // it carried from and retains the hop that links them.
          expect(receipt?.resealedFromKind).toBe('receipt');
          expect(receipt?.resealedFrom).toBeTruthy();
          expect(resealChainHops(repo), 'the chain hop was retained').toBeGreaterThan(0);

          // Every case executed fresh against the prepared candidate, so no
          // parent evidence had to be carried.
          expect(receipt?.rerunTests).toBe(CONSUMER_CASES.length);
          expect((receipt?.carriedTests ?? 0) + (receipt?.rerunTests ?? 0)).toBe(CONSUMER_CASES.length);
          expect(sealedExecution(repo)?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual(
            [...CONSUMER_CASES].sort(),
          );

          // The signed changedPaths describe the ACTUAL prepared tree: the
          // regenerated session targets and the test files that changed.
          const changedPaths = receipt?.changedPaths ?? [];
          expect(changedPaths).toContain('.auth/alpha.json');
          expect(changedPaths).toContain('.auth/omega.json');
          for (const file of BODY_SPEC_FILES) expect(changedPaths).toContain(file);

          // The receipt binds the actual prepared tree, whose regenerated
          // session bytes carry the NEW commit.
          const preparedTree = candidateTreeIdOf(repo);
          expect(preparedTree).not.toBe(parentReceipt?.candidateTreeId);
          expect(receipt?.candidateTreeId).toBe(preparedTree);
          expect(readFileSync(repo.path('.auth/alpha.json'), 'utf8')).toContain(repo.headSha() as string);

          // And the independent chain recomputation agrees: the strict
          // check verifies the re-prepared candidate on its own.
          const checked = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], base);
          expect(checked.code, `check stdout:\n${checked.stdout}\nstderr:\n${checked.stderr}`).toBe(0);
        });
      } finally {
        await app.stop();
      }
    },
    1_800_000,
  );
});