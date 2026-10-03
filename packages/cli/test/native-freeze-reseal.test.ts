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
  commitCandidateChange,
  CONSUMER_CASES,
  consumerOf,
  installNativeFreezeFixture,
  nativeRunEnv,
  newestSpoolLines,
  retainedResealArtifactCount,
  runNativeCli,
  sealedExecution,
  sealedReceipt,
  SESSION_REVISION_ENV,
  startNativeApp,
  writeGeneratedSessionState,
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
          commitCandidateChange(repo);
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));

          // The parent: a full supervised native run that freezes the
          // generated session state and seals a receipt over THAT tree.
          const parent = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'full', '--format', 'json'],
            env,
          );
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
          commitCandidateChange(repo);
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));
          const parent = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'full', '--format', 'json'],
            env,
          );
          expect(parent.code, `parent stdout:\n${parent.stdout}\nstderr:\n${parent.stderr}`).toBe(0);
          const parentSha = repo.headSha() as string;
          const parentReceipt = sealedReceipt(repo);
          expect(parentReceipt?.candidateTreeId).toBe(candidateTreeIdOf(repo));
          expect(readFileSync(repo.path('.auth/alpha.json'), 'utf8')).toContain(parentSha);

          // A committed change to ONE mapped spec. Every preparation stage
          // this changed-scope run reaches mints its session for THIS
          // commit, in both chains, so what no longer holds is not the
          // parent's generated state — it is the outcome for the readers
          // of that state. Which readers really executed is read below
          // from the run's own lifecycle records, not assumed here.
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
          expect(retainedResealArtifactCount(repo), 'no chain artifact survives a refused re-seal').toBe(0);

          // The generated state really was regenerated for THIS commit:
          // both chains' bytes now carry the child's own commit, which is
          // exactly why the parent's evidence may not be carried over
          // them.
          const childSha = repo.headSha() as string;
          expect(readFileSync(repo.path('.auth/alpha.json'), 'utf8')).toContain(childSha);
          expect(readFileSync(repo.path('.auth/omega.json'), 'utf8')).toContain(childSha);

          // And the reason the re-seal is refused is a READER, not the
          // state. Which readers this run really executed is read out of
          // its OWN lifecycle records — one entry per `testBegin` line,
          // attributed to the project the runner really named, never to a
          // list this fixture promised.
          const freshProjects = [
            ...new Set(
              newestSpoolLines(repo)
                .filter((line) => line.kind === 'testBegin' && typeof line.project === 'string')
                .map((line) => line.project as string),
            ),
          ];
          // The reader of the spec this commit touched really ran again…
          expect(freshProjects, 'the changed spec really executed fresh').toContain(consumerOf('.auth/beta.json'));
          // …and the reader the refusal names really did not, which is the
          // whole reason no parent evidence may be carried for it.
          const missingReader = consumerOf('.auth/alpha.json');
          expect(freshProjects, `${missingReader} executed fresh, so no evidence would be missing`).not.toContain(
            missingReader,
          );

          const message = surfaced(refused);
          // The refusal is actionable: it names a consumer of the changed
          // state this run did not execute, and the explicit full-fresh
          // command that would prove every consumer.
          expect(message).toContain('gateforge test-gates --changed --scope full');
          expect(message).toContain(`specs/${consumerOf('.auth/alpha.json')}.spec.js`);
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
          commitCandidateChange(repo);
          const env = nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret));
          const parent = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'full', '--format', 'json'],
            env,
          );
          expect(parent.code, `parent stdout:\n${parent.stdout}\nstderr:\n${parent.stderr}`).toBe(0);
          const parentSha = repo.headSha() as string;
          const parentReceipt = sealedReceipt(repo);
          expect(readFileSync(repo.path('.auth/alpha.json'), 'utf8')).toContain(parentSha);

          // The same regenerated state, but now EVERY consumer of it is
          // executed fresh: all four body specs change, so the whole
          // captured graph is inside the re-seal's affected set.
          for (const file of BODY_SPEC_FILES) touchSpec(repo, file);
          const base = mergeEnv(repo, app, parentSha);

          const fresh = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
            base,
          );
          expect(fresh.code, `stdout:\n${fresh.stdout}\nstderr:\n${fresh.stderr}`).toBe(0);

          const receipt = sealedReceipt(repo);
          // This is a CHAIN, not an ordinary receipt: it names the parent
          // it carried from, and the independent strict check below
          // recomputes that very chain.
          expect(receipt?.resealedFromKind).toBe('receipt');
          expect(receipt?.resealedFrom).toBeTruthy();

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

  it(
    'refuses a re-seal whose planned fresh consumers leave the affected set preparation restored',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-reseal-restored-' }, async (repo) => {
          // The generated state is minted for an OPERATOR revision, so the
          // preparation a later run performs restores exactly the bytes the
          // parent sealed. The state differs between the two runs only when
          // something genuinely rewrites it.
          installNativeFreezeFixture(repo, { resealEnabled: true, stateRevision: true });
          commitCandidateChange(repo);
          const revision = 'parentrevision';
          const parent = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'full', '--format', 'json'],
            {
              ...nativeRunEnv(repo, attestedEnv(app.url, app.protectedUrl, app.sessionSecret)),
              [SESSION_REVISION_ENV]: revision,
            },
          );
          expect(parent.code, `parent stdout:\n${parent.stdout}\nstderr:\n${parent.stderr}`).toBe(0);
          const parentSha = repo.headSha() as string;
          expect(sealedReceipt(repo)?.candidateTreeId).toBe(candidateTreeIdOf(repo));
          expect(sealedExecution(repo)?.outcomes).toHaveLength(CONSUMER_CASES.length);

          // ONE mapped spec changes, and the two untracked sessions really
          // change too: both are rewritten to another revision of the same
          // signed session, so the plan this re-seal is decided from is WIDE
          // and every reader of either state is inside it.
          touchSpec(repo, 'specs/delta-body.spec.js');
          const parentStates = new Map<string, Buffer>();
          for (const statePath of ['.auth/alpha.json', '.auth/omega.json']) {
            const before = readFileSync(repo.path(statePath));
            expect(before.toString('utf8'), `${statePath} is minted for the parent revision`).toContain(revision);
            parentStates.set(statePath, before);
            writeGeneratedSessionState(repo, statePath, app.url, app.sessionSecret, 'foreignrevision');
            expect(readFileSync(repo.path(statePath), 'utf8'), `${statePath} really changed`).not.toEqual(
              before.toString('utf8'),
            );
          }

          const reversion = await runNativeCli(
            repo,
            ['test-gates', '--changed', '--scope', 'changed', '--format', 'json'],
            { ...mergeEnv(repo, app, parentSha), [SESSION_REVISION_ENV]: revision },
          );
          // The producer may not seal a hop its own independent consumer
          // rejects: the run refuses, clears the receipt and the chain, and
          // names the command that would prove every consumer fresh.
          expect(reversion.code, `stdout:\n${reversion.stdout}\nstderr:\n${reversion.stderr}`).toBe(1);
          expect(sealedReceipt(repo), 'no receipt survives the refusal').toBeNull();
          expect(retainedResealArtifactCount(repo), 'no chain artifact survives the refusal').toBe(0);

          // The preparation really ran and really restored the parent's own
          // bytes, so the sealed difference it would have to sign shrank back
          // to the single spec — while the run had already executed the
          // readers the wide plan named.
          for (const [statePath, before] of parentStates) {
            expect(readFileSync(repo.path(statePath)), `${statePath} is the parent's own bytes again`).toEqual(before);
          }
          const message = surfaced(reversion);
          expect(message).toContain('gateforge test-gates --changed --scope full');
          expect(message).toContain(`specs/${consumerOf('.auth/alpha.json')}.spec.js`);
          expect(message).toContain(`specs/${consumerOf('.auth/omega.json')}.spec.js`);
        });
      } finally {
        await app.stop();
      }
    },
    1_800_000,
  );
});