/**
 * The GLOBAL native preparation freeze, end to end through the real CLI:
 * one prepared candidate, frozen after EVERY native prerequisite stage and
 * before ANY body project.
 *
 * Everything under test is real. The repository carries eight real
 * Playwright projects — two uneven-depth preparation chains, an
 * independent preparation chain and four bodies, one of which has no edges
 * at all — the engine's own Chromium drives genuine browser sessions, the
 * preparation stages write genuine `storageState` files into a git-ignored
 * `.auth/` directory that every body then proves against a protected route,
 * and the CLI spawns its own witness. The engine's generated freeze
 * controller is the worker that performs the handshake: no stub runner, no
 * mocked controller and no mocked body anywhere in these suites.
 *
 * The controller is EXCLUDED from the native lifecycle by the trusted
 * reporter's absolute control-spec identity, so it contributes no native
 * `testBegin`, no outcome row, no witness session and no claim. What proves
 * the barrier is real is the signed release the CLI writes, the request the
 * controller really wrote, and the single accepted `freezeRelease` marker
 * the spool carries in append order.
 *
 * What a body inherited is asserted INSIDE that body (see
 * `native-freeze-fixture.ts`), because a worker's environment is produced
 * by real worker processes. The lifecycle-spool evidence below is read in
 * FILE order, which is append order for one ordinary local file; nothing
 * here claims physical immutability.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import {
  attestedEnv,
  BODY_CASE_COUNT,
  BODY_PROJECTS,
  candidateTreeIdOf,
  CONSUMER_CASES,
  consumerCasesFor,
  CONTROL_PROJECT,
  CONTROL_SPEC_FILE,
  controlDirPath,
  controlRefusalPath,
  controlReleasePath,
  controlRequestPath,
  controlSpecsInRepo,
  GENERATED_STATE,
  installNativeFreezeFixture,
  installOperatorState,
  listConsumerCases,
  nativeRunEnv,
  newestSpoolLines,
  type NativeFixtureOptions,
  PREREQUISITE_PROJECTS,
  runNativeCli,
  sealedExecution,
  sealedReceipt,
  sessionCookieFor,
  spoolLines,
  type SpoolLine,
  startNativeApp,
  writeCandidateChange,
} from './native-freeze-fixture.js';

/** The blocking entries one CLI report produced. */
interface GateReport {
  blocking: Array<{ detail: string; cause?: string }>;
  summary: { blocking: number };
}

/**
 * Runs the supervised gate over the whole fixture suite, exactly the way
 * the owner's native run does.
 *
 * @param repo: the fixture repository.
 * @param app: the attested base URL, the protected route and the per-run
 *   session secret.
 * @param extra: ordinary environment the run forwards to the suite.
 * @param options: the fixture variant whose baseline the run inherits.
 * @param out: repo-relative run-state directory to pass as `--out`; the
 *   configured one when absent.
 *
 * @returns
 *   Promise<{ code, stdout, stderr, env }>: the CLI result and the
 *   environment the run and every later check share.
 */
async function runSupervised(
  repo: TempRepo,
  app: { url: string; protectedUrl: string; sessionSecret: string },
  extra: Record<string, string> = {},
  options: NativeFixtureOptions = {},
  out?: string,
): Promise<{ code: number; stdout: string; stderr: string; env: Record<string, string> }> {
  const env = nativeRunEnv(
    repo,
    {
      ...attestedEnv(app.url, app.protectedUrl, app.sessionSecret),
      ...extra,
    },
    options,
  );
  const argv = ['test-gates', '--changed', '--scope', 'full', '--format', 'json'];
  if (out !== undefined) argv.push('--out', out);
  const result = await runNativeCli(repo, argv, env);
  return { ...result, env };
}

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
    blocking = (JSON.parse(result.stdout) as GateReport).blocking
      .map((entry) => `${entry.detail} ${entry.cause ?? ''}`)
      .join('\n');
  } catch {
    blocking = '';
  }
  return `${blocking}\n${result.stderr}`;
}

/**
 * The file-order positions of the lifecycle lines the freeze ordering audit
 * grades: every preparation stage's and body's TEST begin, the engine
 * controller's begin, and the single accepted freeze marker.
 *
 * @param lines: the spool lines to grade.
 *
 * @returns
 *   { markers, prerequisites, controller, bodies }: file-order indices.
 */
function freezeOrdering(lines: SpoolLine[]): {
  markers: number[];
  prerequisites: number[];
  controller: number[];
  bodies: number[];
} {
  const indexOf = (predicate: (line: SpoolLine) => boolean): number[] =>
    lines.flatMap((line, index) => (predicate(line) ? [index] : []));
  return {
    markers: indexOf((line) => line.kind === 'freezeRelease'),
    prerequisites: indexOf(
      (line) => line.kind === 'testBegin' && PREREQUISITE_PROJECTS.includes(line.project ?? ''),
    ),
    controller: indexOf((line) => line.kind === 'testBegin' && line.project === CONTROL_PROJECT),
    bodies: indexOf((line) => line.kind === 'testBegin' && BODY_PROJECTS.includes(line.project ?? '')),
  };
}

describe('global native preparation freeze (one prepared candidate, real CLI and real browser)', () => {
  it(
    'freezes ONE candidate after every preparation stage and before every body, and seals a receipt over it',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-freeze-' }, async (repo) => {
          // A consumer at `init`'s defaults: every parseable source file is
          // a declared scan input, and the run-state directory is ordinary
          // untracked workspace bytes rather than a gitignored one. That is
          // what makes the SECOND run in this very test the same situation a
          // real repository reaches — the run's own control documents are
          // inside the configured scan scope of every later command.
          installNativeFreezeFixture(repo, { initLikeScanInputs: true });
          writeCandidateChange(repo);
          const preRunTree = candidateTreeIdOf(repo);

          const first = await runSupervised(repo, app);
          expect(first.code, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0);
          expect((JSON.parse(first.stdout) as GateReport).summary.blocking).toBe(0);

          // EXACT native accounting: every consumer case the catalog holds
          // ran exactly once — four preparation cases and seven body cases.
          const sealed = sealedExecution(repo);
          expect(sealed, 'the run sealed an execution result').not.toBeNull();
          expect(sealed?.complete).toBe(true);
          expect(sealed?.planned.map((row) => row.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(sealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(sealed?.outcomes.every((outcome) => outcome.status === 'passed' && outcome.attempt === 1)).toBe(true);

          // The engine's own controller is NOT a native case: no planned
          // row, no outcome row, no witness session, no claim.
          expect(sealed?.planned.filter((row) => row.project === CONTROL_PROJECT)).toEqual([]);
          expect(sealed?.outcomes.filter((outcome) => outcome.project === CONTROL_PROJECT)).toEqual([]);
          expect(sealed?.sessionTrace?.filter((traced) => traced.file.includes(CONTROL_SPEC_FILE))).toEqual([]);
          expect(freezeOrdering(spoolLines(repo)).controller, 'the controller is not a native lifecycle').toEqual([]);

          // The zero-claim preparation stages are genuine executions: each
          // sealed exactly one PASSED session, and a stage whose honest job
          // is to produce an artifact carries no witness activity at all.
          const trace = sealed?.sessionTrace ?? [];
          expect(trace).toHaveLength(CONSUMER_CASES.length);
          for (const project of PREREQUISITE_PROJECTS) {
            const traced = trace.filter((entry) => entry.file.includes(`${project}.setup.js`));
            expect(traced, `${project} has a session trace`).toHaveLength(1);
            expect(traced[0]?.sessions).toHaveLength(1);
            expect(traced[0]?.sessions[0]?.outcome).toBe('passed');
            expect(traced[0]?.sessions[0]?.sealedTick).not.toBeNull();
            expect(traced[0]?.sessions[0]?.activity).toBe(0);
          }
          // The generated state is REAL browser session state, and it is
          // git-ignored workspace bytes that never reach a commit.
          for (const state of GENERATED_STATE) {
            expect(existsSync(repo.path(state)), `${state} was generated`).toBe(true);
            expect(readFileSync(repo.path(state), 'utf8'), `${state} carries its session`).toContain(
              sessionCookieFor(state),
            );
          }
          expect(repo.git(['status', '--porcelain']).stdout).not.toContain('.auth/');
          expect(repo.git(['ls-files', '.auth']).stdout.trim()).toBe('');

          // The receipt binds the PREPARED candidate (the tree that
          // contains the generated state), never the pre-run tree.
          const preparedTree = candidateTreeIdOf(repo);
          expect(preparedTree).not.toBeNull();
          expect(preparedTree).not.toBe(preRunTree);
          const receipt = sealedReceipt(repo);
          expect(receipt, 'the run sealed a gate receipt').not.toBeNull();
          expect(receipt?.candidateTreeId).toBe(preparedTree);

          // The ordering evidence the freeze grades: the controller really
          // asked (its request document exists), ONE accepted marker, in
          // file order after EVERY preparation stage and before EVERY body
          // test began.
          expect(existsSync(repo.path(controlRequestPath())), 'the controller asked for a freeze').toBe(true);
          const ordering = freezeOrdering(spoolLines(repo));
          expect(ordering.markers, 'exactly one accepted freeze marker').toHaveLength(1);
          const marker = ordering.markers[0] as number;
          expect(ordering.prerequisites).toHaveLength(PREREQUISITE_PROJECTS.length);
          expect(ordering.bodies).toHaveLength(BODY_CASE_COUNT);
          for (const index of ordering.prerequisites) {
            expect(index, 'a preparation stage began after the accepted release').toBeLessThan(marker);
          }
          for (const index of ordering.bodies) {
            expect(index, 'a body test began before the accepted release').toBeGreaterThan(marker);
          }

          // The handshake's own evidence stays in the run state — the
          // controller asked, the CLI published a signed release, and the
          // spool carries the one accepted marker — while the generated
          // controller CODE does not stay behind in this candidate at all:
          // it is the engine's, it is written per run, and a consumer's
          // own runner must never find it sitting in their repository.
          expect(existsSync(repo.path(controlReleasePath())), 'the CLI published its signed release').toBe(true);
          expect(controlSpecsInRepo(repo), 'no generated controller code was left in this repository').toEqual([]);

          // The strict check over the very same prepared candidate.
          const check = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], first.env);
          expect(check.code, `check stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).toBe(0);

          // STABLE generated state: a second supervised run over the
          // identical candidate freezes the same bytes again, so the
          // receipt still describes exactly this candidate.
          const second = await runSupervised(repo, app);
          expect(second.code, `second run stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0);
          expect(sealedReceipt(repo)?.candidateTreeId).toBe(preparedTree);
          // The second run planned and executed EXACTLY the same consumer
          // cases: nothing the first run left behind in this workspace is a
          // planned row, an outcome row or an unresolved gap, so the
          // identities stay the catalog's own.
          const resealed = sealedExecution(repo);
          expect(resealed?.complete).toBe(true);
          expect(resealed?.planned.map((row) => row.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(resealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(resealed?.outcomes.every((outcome) => outcome.status === 'passed' && outcome.attempt === 1)).toBe(true);
          expect(resealed?.planned.filter((row) => row.project === CONTROL_PROJECT)).toEqual([]);
          expect(resealed?.outcomes.filter((outcome) => outcome.project === CONTROL_PROJECT)).toEqual([]);
          expect(resealed?.sessionTrace?.filter((traced) => traced.file.includes(CONTROL_SPEC_FILE))).toEqual([]);
          expect(freezeOrdering(spoolLines(repo)).controller, 'the controller is not a native lifecycle').toEqual([]);
          expect(controlSpecsInRepo(repo), 'the second run left no controller code behind either').toEqual([]);
          const recheck = await runNativeCli(
            repo,
            ['check', '--changed', '--require-e2e', '--format', 'json'],
            second.env,
          );
          expect(recheck.code, `recheck stdout:\n${recheck.stdout}\nstderr:\n${recheck.stderr}`).toBe(0);
        });
      } finally {
        await app.stop();
      }
    },
    1_500_000,
  );

  it(
    'a ROOT-SCANNING consumer config lists only its own cases, and the engine leaves no controller code in its repository',
    async () => {
      const app = await startNativeApp();
      // The common repository-level Playwright shape: the config declares
      // NO `testDir` at all, the four preparation projects name their own
      // file, and the ONE body project (`chromium`) names neither a
      // `testDir` nor a `testMatch` — so the directory the consumer's own
      // runner enumerates is the REPOSITORY ROOT and its default match
      // collects every spec file there. That is exactly the situation in
      // which anything the engine writes inside the candidate becomes one
      // of the consumer's own tests. The run state is ordinary untracked
      // workspace bytes here, never a gitignored one.
      const options: NativeFixtureOptions = { initLikeScanInputs: true, rootScanningConfig: true };
      const expected = consumerCasesFor(options);
      try {
        await withTempRepo({ prefix: 'gateforge-native-root-scan-' }, async (repo) => {
          installNativeFreezeFixture(repo, options);
          writeCandidateChange(repo);

          // The baseline the consumer's OWN runner reports before any
          // Gateforge command has run here: this layout's consumer cases,
          // and nothing else. No `GATEFORGE_*` variable reaches this child.
          const pristine = await listConsumerCases(repo);
          expect(pristine.code, `listing stdout:\n${pristine.stdout}\nstderr:\n${pristine.stderr}`).toBe(0);
          expect([...pristine.cases]).toEqual([...expected].sort());

          const first = await runSupervised(repo, app, {}, options);
          expect(first.code, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0);
          expect((JSON.parse(first.stdout) as GateReport).summary.blocking).toBe(0);

          // EXACT accounting again, over this layout's own identities: the
          // engine's controller is not a planned row, an outcome row or a
          // session, and every consumer case ran once and passed.
          const sealed = sealedExecution(repo);
          expect(sealed, 'the run sealed an execution result').not.toBeNull();
          expect(sealed?.complete).toBe(true);
          expect(sealed?.planned.map((row) => row.logicalKey).sort()).toEqual([...expected].sort());
          expect(sealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...expected].sort());
          expect(sealed?.outcomes.every((outcome) => outcome.status === 'passed' && outcome.attempt === 1)).toBe(true);
          expect(sealed?.planned.filter((row) => row.project === CONTROL_PROJECT)).toEqual([]);
          expect(sealed?.outcomes.filter((outcome) => outcome.project === CONTROL_PROJECT)).toEqual([]);
          expect(sealed?.sessionTrace?.filter((traced) => traced.file.includes(CONTROL_SPEC_FILE))).toEqual([]);
          // The handshake really happened: the controller asked, the CLI
          // published a signed release, and the spool carries exactly one
          // accepted marker with no native lifecycle of the controller's
          // own.
          expect(existsSync(repo.path(controlRequestPath())), 'the controller asked for a freeze').toBe(true);
          expect(existsSync(repo.path(controlReleasePath())), 'the CLI published its signed release').toBe(true);
          const spool = spoolLines(repo);
          const ordering = freezeOrdering(spool);
          expect(ordering.markers, 'exactly one accepted freeze marker').toHaveLength(1);
          expect(ordering.controller, 'the controller is not a native lifecycle').toEqual([]);
          const marker = ordering.markers[0] as number;
          expect(ordering.prerequisites).toHaveLength(PREREQUISITE_PROJECTS.length);
          expect(
            Math.max(...ordering.prerequisites),
            'every preparation stage began before the accepted release',
          ).toBeLessThan(marker);
          // Every body case of THIS layout began after the accepted
          // release, read from the spool by the project each identity
          // names rather than through the narrow layout's project list.
          const bodyProjects = [
            ...new Set(
              expected.map((key) => key.split(':')[1] ?? '').filter((name) => !PREREQUISITE_PROJECTS.includes(name)),
            ),
          ];
          const bodyBegins = spool.flatMap((line, index) =>
            line.kind === 'testBegin' && bodyProjects.includes(line.project ?? '') ? [index] : [],
          );
          expect(bodyBegins, 'every body case really began').toHaveLength(
            expected.length - PREREQUISITE_PROJECTS.length,
          );
          for (const index of bodyBegins) {
            expect(index, 'a body test began before the accepted release').toBeGreaterThan(marker);
          }

          // The engine generated a controller for this run and left no
          // controller code anywhere in the candidate: the repository root
          // is the very directory this consumer's runner enumerates, and
          // its own listing still reports exactly this layout's consumer
          // cases and nothing else.
          expect(controlSpecsInRepo(repo), 'no generated controller code was left in this repository').toEqual([]);
          const afterFirst = await listConsumerCases(repo);
          expect(afterFirst.code, `listing stdout:\n${afterFirst.stdout}\nstderr:\n${afterFirst.stderr}`).toBe(0);
          expect([...afterFirst.cases]).toEqual([...expected].sort());

          // The strict check over the very same prepared candidate.
          const check = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], first.env);
          expect(check.code, `check stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).toBe(0);

          // A second supervised run over the SAME workspace: the same
          // identities, and still no controller code in the repository.
          const second = await runSupervised(repo, app, {}, options);
          expect(second.code, `second run stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0);
          const resealed = sealedExecution(repo);
          expect(resealed?.complete).toBe(true);
          expect(resealed?.planned.map((row) => row.logicalKey).sort()).toEqual([...expected].sort());
          expect(resealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...expected].sort());
          expect(resealed?.outcomes.every((outcome) => outcome.status === 'passed' && outcome.attempt === 1)).toBe(true);
          expect(resealed?.sessionTrace?.filter((traced) => traced.file.includes(CONTROL_SPEC_FILE))).toEqual([]);
          expect(controlSpecsInRepo(repo), 'the second run left no controller code behind either').toEqual([]);
          const afterSecond = await listConsumerCases(repo);
          expect(afterSecond.code, `listing stdout:\n${afterSecond.stdout}\nstderr:\n${afterSecond.stderr}`).toBe(0);
          expect([...afterSecond.cases]).toEqual([...expected].sort());

          const recheck = await runNativeCli(
            repo,
            ['check', '--changed', '--require-e2e', '--format', 'json'],
            second.env,
          );
          expect(recheck.code, `recheck stdout:\n${recheck.stdout}\nstderr:\n${recheck.stderr}`).toBe(0);
        });
      } finally {
        await app.stop();
      }
    },
    1_500_000,
  );

  it(
    'keeps ONE prepared candidate across two supervised runs whose state directory is a custom one',
    async () => {
      const app = await startNativeApp();
      // A repository-relative state directory that is NOT the configured
      // one, so the ownership boundary the engine applies is the directory
      // this run really resolved — never an assumption about the default.
      const custom = '.gateforge/alt-state';
      try {
        await withTempRepo({ prefix: 'gateforge-native-custom-state-' }, async (repo) => {
          installNativeFreezeFixture(repo, { initLikeScanInputs: true });
          writeCandidateChange(repo);

          const first = await runSupervised(repo, app, {}, {}, custom);
          expect(first.code, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0);
          expect((JSON.parse(first.stdout) as GateReport).summary.blocking).toBe(0);
          // The run graded a candidate and sealed its receipt where
          // `--out` said, and never touched the configured state directory.
          const preparedTree = candidateTreeIdOf(repo, custom);
          expect(preparedTree).not.toBeNull();
          expect(sealedReceipt(repo, custom)?.candidateTreeId).toBe(preparedTree);
          expect(
            existsSync(repo.path(controlReleasePath(custom))),
            'the CLI published its signed release into the custom state',
          ).toBe(true);
          expect(existsSync(repo.path('.gateforge/test-gates')), 'the default state directory was never created').toBe(false);

          // The second run over the SAME workspace: the control documents
          // the first run published are inside the declared scan scope, and
          // the identities stay the catalog's own eleven consumer cases.
          const second = await runSupervised(repo, app, {}, {}, custom);
          expect(second.code, `second run stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0);
          expect((JSON.parse(second.stdout) as GateReport).summary.blocking).toBe(0);
          const resealed = sealedExecution(repo, custom);
          expect(resealed?.complete).toBe(true);
          expect(resealed?.planned.map((row) => row.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(resealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(resealed?.outcomes.every((outcome) => outcome.status === 'passed' && outcome.attempt === 1)).toBe(true);
          expect(resealed?.planned.filter((row) => row.project === CONTROL_PROJECT)).toEqual([]);
          expect(resealed?.outcomes.filter((outcome) => outcome.project === CONTROL_PROJECT)).toEqual([]);
          expect(resealed?.sessionTrace?.filter((traced) => traced.file.includes(CONTROL_SPEC_FILE))).toEqual([]);
          // Same candidate both times, and the handshake's own documents are
          // still on disk: nothing here passes by deleting the engine's own
          // evidence, while its generated code belongs to no candidate.
          expect(sealedReceipt(repo, custom)?.candidateTreeId).toBe(preparedTree);
          expect(candidateTreeIdOf(repo, custom)).toBe(preparedTree);
          expect(controlSpecsInRepo(repo), 'no generated controller code was left in this repository').toEqual([]);
          expect(existsSync(repo.path('.gateforge/test-gates')), 'the default state directory was never created').toBe(false);
        });
      } finally {
        await app.stop();
      }
    },
    1_500_000,
  );

  it(
    'freezes ONE candidate when the root package is CommonJS and the spec directory is ESM',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-module-scope-' }, async (repo) => {
          // The MIXED module scope a real consumer template has: the root
          // package declares no module kind at all, so everything under it
          // — including the generated freeze controller the CLI writes into
          // the state directory — is interpreted under the CommonJS default,
          // while the spec directory carries an ESM package of its own. The
          // native config is an `.mjs` module either way, so the layout that
          // is under test is the module scope, not the configuration.
          installNativeFreezeFixture(repo, { mixedModuleScope: true });
          writeCandidateChange(repo);
          expect(JSON.parse(readFileSync(repo.path('package.json'), 'utf8'))).not.toHaveProperty('type');
          expect(JSON.parse(readFileSync(repo.path('specs/package.json'), 'utf8'))).toHaveProperty('type', 'module');

          const run = await runSupervised(repo, app);
          expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
          expect((JSON.parse(run.stdout) as GateReport).summary.blocking).toBe(0);

          // The SAME honest native accounting as any other layout: every
          // consumer case the catalog holds ran exactly once and passed.
          const sealed = sealedExecution(repo);
          expect(sealed?.complete).toBe(true);
          expect(sealed?.planned.map((row) => row.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(sealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(sealed?.outcomes.every((outcome) => outcome.status === 'passed' && outcome.attempt === 1)).toBe(true);

          // One prepared candidate behind ONE accepted release: the
          // controller really performed the handshake, after every
          // preparation stage and before every body.
          expect(existsSync(repo.path(controlRequestPath())), 'the controller asked for a freeze').toBe(true);
          const ordering = freezeOrdering(spoolLines(repo));
          expect(ordering.markers, 'exactly one accepted freeze marker').toHaveLength(1);
          const marker = ordering.markers[0] as number;
          expect(ordering.prerequisites).toHaveLength(PREREQUISITE_PROJECTS.length);
          expect(ordering.bodies).toHaveLength(BODY_CASE_COUNT);
          for (const index of ordering.prerequisites) {
            expect(index, 'a preparation stage began after the accepted release').toBeLessThan(marker);
          }
          for (const index of ordering.bodies) {
            expect(index, 'a body test began before the accepted release').toBeGreaterThan(marker);
          }

          // The receipt binds the prepared candidate, and the independent
          // strict check verifies that very candidate on its own.
          expect(sealedReceipt(repo)?.candidateTreeId).toBe(candidateTreeIdOf(repo));
          const check = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], run.env);
          expect(check.code, `check stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).toBe(0);
        });
      } finally {
        await app.stop();
      }
    },
    1_500_000,
  );

  it(
    'projects OWN trusted baseline values of the three prototype names, and the alpha chain\u2019s own changes to two of them',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-prototype-env-' }, async (repo) => {
          // The UNCERTAIN key boundary: the operator's own baseline really
          // carries `constructor`, `toString` and `__proto__` as OWN values
          // — the three names a plain object already inherits — and the
          // alpha stage changes two of them for its dependents while
          // leaving the third exactly as the baseline declared it. What
          // every body then sees is asserted INSIDE that body (see the
          // fixture), because a worker's environment is produced by real
          // worker processes; this case proves the run really executed all
          // of them and sealed an honest receipt over the result.
          installNativeFreezeFixture(repo, { prototypeEnvironment: true });
          writeCandidateChange(repo);

          const run = await runSupervised(repo, app, {}, { prototypeEnvironment: true });
          expect(run.code, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
          expect((JSON.parse(run.stdout) as GateReport).summary.blocking).toBe(0);

          // The SAME honest native accounting as any other layout: every
          // consumer case the catalog holds ran exactly once and passed.
          const sealed = sealedExecution(repo);
          expect(sealed?.complete).toBe(true);
          expect(sealed?.planned.map((row) => row.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(sealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(sealed?.outcomes.every((outcome) => outcome.status === 'passed' && outcome.attempt === 1)).toBe(true);

          // One prepared candidate behind ONE accepted release, still
          // after every preparation stage and before every body.
          expect(existsSync(repo.path(controlRequestPath())), 'the controller asked for a freeze').toBe(true);
          const ordering = freezeOrdering(spoolLines(repo));
          expect(ordering.markers, 'exactly one accepted freeze marker').toHaveLength(1);
          const marker = ordering.markers[0] as number;
          expect(ordering.prerequisites).toHaveLength(PREREQUISITE_PROJECTS.length);
          expect(ordering.bodies).toHaveLength(BODY_CASE_COUNT);
          for (const index of ordering.prerequisites) {
            expect(index, 'a preparation stage began after the accepted release').toBeLessThan(marker);
          }
          for (const index of ordering.bodies) {
            expect(index, 'a body test began before the accepted release').toBeGreaterThan(marker);
          }

          // The receipt binds the prepared candidate, and the independent
          // strict check verifies that very candidate on its own.
          expect(sealedReceipt(repo)?.candidateTreeId).toBe(candidateTreeIdOf(repo));
          const check = await runNativeCli(repo, ['check', '--changed', '--require-e2e', '--format', 'json'], run.env);
          expect(check.code, `check stdout:\n${check.stdout}\nstderr:\n${check.stderr}`).toBe(0);
        });
      } finally {
        await app.stop();
      }
    },
    1_500_000,
  );

  it(
    'refuses preparation that writes an UNDECLARED file into the generated state directory',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-undeclared-' }, async (repo) => {
          installNativeFreezeFixture(repo, { unsafePreparation: true });
          const result = await runSupervised(repo, app);
          expect(result.code).not.toBe(0);
          expect(sealedReceipt(repo), 'no receipt over an inadmissible prepared candidate').toBeNull();
          // The declared storage states are the only writable paths; the
          // stray file beside them is refused by name.
          expect(surfaced(result)).toContain('.auth/undeclared.json');
          // The refusal reached the controller through the engine's own
          // failure-only channel, naming the inadmissible path.
          expect(readFileSync(repo.path(controlRefusalPath()), 'utf8')).toContain('.auth/undeclared.json');
          // And no body ever ran against that candidate.
          const ordering = freezeOrdering(newestSpoolLines(repo));
          expect(ordering.markers).toHaveLength(0);
          expect(ordering.bodies).toHaveLength(0);
        });
      } finally {
        await app.stop();
      }
    },
    900_000,
  );

  it(
    'refuses preparation that moved the input inventory the run pinned (tracked edit, tracked removal, undeclared file)',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-unsafe-' }, async (repo) => {
          installNativeFreezeFixture(repo, { inputMovingPreparation: true });
          const result = await runSupervised(repo, app);
          expect(result.code).not.toBe(0);
          expect(sealedReceipt(repo)).toBeNull();
          const refused = surfaced(result);
          // The tracked source edit, the tracked file the stage deleted and
          // the undeclared file it created are all input-bound bytes, and
          // every one of them is named.
          expect(refused).toContain('src/accounts.js');
          expect(refused).toContain('src/orders.js');
          expect(refused).toContain('tmp/undeclared.txt');
          expect(readFileSync(repo.path(controlRefusalPath()), 'utf8')).toContain('src/orders.js');
          expect(freezeOrdering(newestSpoolLines(repo)).bodies).toHaveLength(0);
        });
      } finally {
        await app.stop();
      }
    },
    900_000,
  );

  it(
    'refuses a generated target that is a symlink escaping the candidate root, and pollutes nothing outside it',
    async () => {
      const app = await startNativeApp();
      const outside = mkdtempSync(join(tmpdir(), 'gateforge-native-escaping-'));
      const escapingTarget = join(outside, 'escaping-session.json');
      try {
        await withTempRepo({ prefix: 'gateforge-native-escaping-' }, async (repo) => {
          installNativeFreezeFixture(repo, { escapingSymlinkTarget: true });
          // The directory OUTSIDE the candidate the escaping target will
          // point at travels as an ordinary allowlisted runtime value, the
          // same seam every other per-run fixture value uses: the run
          // forwards it to the stage, and the stage really writes there.
          const result = await runSupervised(repo, app, { SHOP_ESCAPING_DIR: outside });
          expect(result.code).not.toBe(0);
          expect(sealedReceipt(repo), 'a target outside the root is never a prepared candidate').toBeNull();
          expect(surfaced(result)).toContain('.auth/alpha.json');
          expect(freezeOrdering(newestSpoolLines(repo)).bodies).toHaveLength(0);
          // The target really is still a symlink after the storageState
          // serialization, and the bytes it points at are this fixture's
          // own — nothing outside the repository was overwritten.
          expect(lstatSync(repo.path('.auth/alpha.json')).isSymbolicLink(), 'the target is a symlink').toBe(true);
          const outsideBytes = readFileSync(escapingTarget, 'utf8');
          expect(outsideBytes).toContain('the escaping fixture');
          expect(outsideBytes, 'the escaped bytes are this run\u2019s real alpha session').toContain(
            sessionCookieFor('.auth/alpha.json'),
          );
          // Causality: every preparation stage really executed and
          // really PASSED, on genuine credentials. The target became a
          // link only AFTER its state was serialized and the bytes it
          // points at carry that very session, so what the freeze refused
          // is the physical containment boundary rather than an upstream
          // stage that could no longer authenticate.
          const preparationOutcomes =
            sealedExecution(repo)?.outcomes.filter((row) => row.file.endsWith('-auth.setup.js')) ?? [];
          expect(preparationOutcomes, 'every preparation stage ran').toHaveLength(PREREQUISITE_PROJECTS.length);
          expect(preparationOutcomes.filter((row) => row.status !== 'passed')).toEqual([]);
        });
      } finally {
        await app.stop();
        rmSync(outside, { recursive: true, force: true });
      }
    },
    900_000,
  );

  it(
    'refuses a body TEST that began before the accepted release, however late it was processed',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-early-begin-' }, async (repo) => {
          installNativeFreezeFixture(repo, { queueEarlyBodyBegin: true });
          const result = await runSupervised(repo, app);
          expect(result.code).not.toBe(0);
          expect(sealedReceipt(repo)).toBeNull();
          const ordering = freezeOrdering(newestSpoolLines(repo));
          expect(
            ordering.bodies.some((index) => index < (ordering.markers[0] ?? Number.MAX_SAFE_INTEGER)),
            'the queued begin really is before the accepted release in file order',
          ).toBe(true);
          expect(surfaced(result)).toContain('zeta-body');
        });
      } finally {
        await app.stop();
      }
    },
    900_000,
  );

  it(
    'refuses a body that rewrites an eligible generated target AFTER the accepted release',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-late-write-' }, async (repo) => {
          installNativeFreezeFixture(repo, { bodyRewritesGeneratedState: true });
          const result = await runSupervised(repo, app);
          // The run executed every case, but the candidate it tested is no
          // longer the candidate on disk: no receipt is sealed over mixed
          // bytes.
          expect(result.code).not.toBe(0);
          expect(sealedReceipt(repo)).toBeNull();
          const ordering = freezeOrdering(newestSpoolLines(repo));
          expect(ordering.markers, 'the release itself was accepted').toHaveLength(1);
          expect(ordering.bodies, 'every body really ran').toHaveLength(BODY_CASE_COUNT);
          expect(readFileSync(repo.path('.auth/alpha.json'), 'utf8')).toContain('after the freeze');
        });
      } finally {
        await app.stop();
      }
    },
    900_000,
  );

  for (const outcome of ['failed', 'skipped', 'retried'] as const) {
    it(
      `a ${outcome.toUpperCase()} preparation stage yields no release, no receipt and no body`,
      async () => {
        const app = await startNativeApp();
        try {
          await withTempRepo({ prefix: `gateforge-native-${outcome}-prep-` }, async (repo) => {
            const option =
              outcome === 'failed'
                ? { failingPrerequisite: true }
                : outcome === 'skipped'
                  ? { skippedPrerequisite: true }
                  : { retriedPrerequisite: true };
            installNativeFreezeFixture(repo, option);
            const result = await runSupervised(repo, app);
            expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).not.toBe(0);
            expect(sealedReceipt(repo), 'no receipt over an unfrozen prerequisite').toBeNull();
            // The stage that could not be frozen over is named in the
            // refusal, and the run ended on its own, without hanging.
            expect(surfaced(result)).toContain('prepares the alpha session state');
            const ordering = freezeOrdering(newestSpoolLines(repo));
            expect(ordering.markers, 'no candidate was released over this stage').toHaveLength(0);
            expect(ordering.bodies, 'no body ran against an unprepared candidate').toHaveLength(0);

            const sealed = sealedExecution(repo);
            const alphaKey = CONSUMER_CASES.find((key) => key.startsWith('playwright:alpha-auth:')) as string;
            const alpha = sealed?.outcomes.find((row) => row.logicalKey === alphaKey);
            // Whatever rows the runner emits for the dependents it never
            // started, the graded fact is what really EXECUTED and sealed
            // as a pass. Only alpha's OWN dependents are named: the
            // independent chain declares no edge to alpha, so a stage
            // there is free to run either way.
            const executedAndPassed = (sealed?.sessionTrace ?? [])
              .filter((entry) => entry.sessions.some((session) => session.outcome === 'passed'))
              .map((entry) => entry.file);
            const executedDependents = executedAndPassed.filter(
              (file) => file.includes('beta-auth') || file.includes('gamma-auth'),
            );
            if (outcome === 'failed') {
              // The stage failed for real, so the controller this project
              // depends on never started: there is nothing to answer, and
              // the run must say so from the outcome it did observe.
              expect(alpha?.status, 'the failing stage is reported as failed').toBe('failed');
              expect(alpha?.attempt).toBe(1);
              // Not one dependent preparation stage, and not one body.
              expect(executedDependents, 'no dependent preparation stage executed behind a failed one').toEqual([]);
              expect(
                executedAndPassed.filter((file) => BODY_PROJECTS.some((project) => file.includes(project))),
                'no body executed against an unprepared candidate',
              ).toEqual([]);
            } else {
              expect(alpha, 'this stage did execute').toBeDefined();
              expect(alpha?.status, 'the stage did not pass cleanly').not.toBe('passed');
              if (outcome === 'skipped') {
                expect(alpha?.status).toBe('skipped');
                // A stage that declined to run is still a prerequisite
                // that never passed, so the runner's own scheduler starts
                // none of ITS dependents either.
                expect(executedDependents, 'no dependent preparation stage executed behind a skipped one').toEqual(
                  [],
                );
              }
              // Whatever the barrier did with the request this stage never
              // earned, the run published no release over it.
              expect(existsSync(repo.path(controlReleasePath())), 'nothing was released over this stage').toBe(
                false,
              );
            }
          });
        } finally {
          await app.stop();
        }
      },
      900_000,
    );
  }

  for (const shape of ['unsigned', 'forged'] as const) {
    it(
      `a ${shape} release carrying THIS run's exact identities never unblocks the controller`,
      async () => {
        const app = await startNativeApp();
        try {
          await withTempRepo({ prefix: `gateforge-native-release-${shape}-` }, async (repo) => {
            installNativeFreezeFixture(repo, { plantedRelease: shape });
            const result = await runSupervised(repo, app);
            expect(result.code).not.toBe(0);
            expect(sealedReceipt(repo), `a ${shape} release never seals a receipt`).toBeNull();
            // This run armed a controller, the controller really asked for a
            // freeze, and a correctly-shaped document this invocation never
            // signed was already sitting at the release path. Two independent
            // facts are true here and both matter: the trusted side refuses
            // to publish over a document it did not write, and the controller
            // verifies the release that IS there with its own crypto — an
            // unsigned one for its missing signature, a tampered one for a
            // signature this invocation's ephemeral key never made.
            //
            // The assertion below pins the deterministic observable, the
            // refusal channel. I deliberately do not assert the controller's
            // own reason string: the supervised runner's output is captured
            // and discarded by design, so it is not something a consumer can
            // observe, and guessing at it would be an unbacked claim.
            expect(existsSync(repo.path(controlRequestPath())), 'the controller asked for a freeze').toBe(true);
            // The trusted side also refuses, in its own right, to publish
            // over a release document it did not write, and says which path
            // it found — the control directory is never quietly overwritten.
            expect(readFileSync(repo.path(controlRefusalPath()), 'utf8')).toContain(controlReleasePath());
            expect(
              controlSpecsInRepo(repo),
              'the controller this run armed left no generated code in the repository',
            ).toEqual([]);
            expect(freezeOrdering(newestSpoolLines(repo)).bodies).toHaveLength(0);
          });
        } finally {
          await app.stop();
        }
      },
      900_000,
    );
  }

  it(
    'the GENUINE release an earlier invocation signed never unblocks a later one',
    async () => {
      const app = await startNativeApp();
      const capture = mkdtempSync(join(tmpdir(), 'gateforge-native-replay-'));
      const captured = join(capture, 'freeze-release.json');
      try {
        await withTempRepo({ prefix: 'gateforge-native-replay-' }, async (repo) => {
          // The capture path is configured when the repository is
          // installed, so both invocations run the same candidate shape
          // and only the value of one ordinary variable differs between
          // them. Nothing exists at that path yet, so the first
          // invocation plants nothing.
          installNativeFreezeFixture(repo, { replayCapturePath: captured });
          expect(existsSync(captured), 'no release has been captured yet').toBe(false);

          // The first invocation is a genuine, complete run: it seals a
          // receipt over the candidate it froze and leaves its own real
          // signed release in the control directory.
          const first = await runSupervised(repo, app);
          expect(first.code, `first run stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0);
          expect(sealedReceipt(repo), 'the first invocation sealed a receipt').not.toBeNull();

          // Capture those exact bytes OUTSIDE the engine's own control
          // directory: arming the second invocation legitimately clears
          // the control files this run does not own. The captured bytes
          // are kept so the planted document can be compared with them.
          const capturedRelease = readFileSync(repo.path(controlReleasePath()));
          writeFileSync(captured, capturedRelease);
          // A GENUINE, COUNTED candidate change before the second
          // invocation: the candidate it tests really is not the first
          // invocation's, so the gate runs it instead of reusing an
          // authenticated receipt over identical inputs. A reused receipt
          // would spawn no run at all and would say nothing about the
          // document under test.
          writeCandidateChange(repo);

          // The second invocation re-plants that exact document during its
          // own preparation stage, long before its controller asks: a real
          // signature over identities that no longer belong to this run. The
          // trusted side refuses to overwrite it, and the controller's own
          // verification rejects it against the fresh public key this
          // invocation pinned — so an authentic release signed by an earlier
          // invocation buys nothing here.
          const second = await runSupervised(repo, app, { SHOP_CAPTURED_RELEASE: captured });
          expect(second.code, `second run stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).not.toBe(0);
          // The refused run sealed no receipt of its own, and a run that
          // seals none invalidates the one it replaced.
          expect(sealedReceipt(repo), 'the refused run left no current valid receipt').toBeNull();
          // That run began no body against a candidate nobody released.
          const replayed = freezeOrdering(newestSpoolLines(repo));
          expect(replayed.bodies, 'the replayed release let a body start').toHaveLength(0);
          expect(replayed.controller, 'the controller is not a native lifecycle').toHaveLength(0);
          // That really was a second INVOCATION and not a reused receipt:
          // its own preparation stages executed before the controller was
          // ever reached. Reusing an authenticated receipt over identical
          // inputs spawns no lifecycle at all.
          expect(replayed.prerequisites.length, 'the replayed invocation really executed').toBeGreaterThan(0);
          // The trusted side refused to publish over a release document it
          // did not write, naming the path it found: the replayed bytes were
          // never replaced by a genuine release, so nothing downstream of
          // them could be trusted either.
          expect(readFileSync(repo.path(controlRefusalPath()), 'utf8')).toContain(controlReleasePath());
          // The document still sitting at the release path is byte for
          // byte the genuine release an EARLIER invocation signed: the
          // trusted side refused to publish over it and nothing replaced
          // it, so a replayed signature is never mistaken for this run's.
          expect(readFileSync(repo.path(controlReleasePath()))).toEqual(capturedRelease);
        });
      } finally {
        await app.stop();
        rmSync(capture, { recursive: true, force: true });
      }
    },
    1_800_000,
  );

  it(
    'a forged preparation REQUEST is refused and no body ever begins',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-forged-request-' }, async (repo) => {
          installNativeFreezeFixture(repo, { forgedRequest: true });
          const result = await runSupervised(repo, app);
          expect(result.code).not.toBe(0);
          expect(sealedReceipt(repo)).toBeNull();
          const ordering = freezeOrdering(newestSpoolLines(repo));
          expect(ordering.markers).toHaveLength(0);
          expect(ordering.bodies).toHaveLength(0);
          expect(surfaced(result)).toContain('preparation freeze refused');
        });
      } finally {
        await app.stop();
      }
    },
    900_000,
  );

  it(
    'refuses a consumer project that claims the engine controller name',
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-reserved-name-' }, async (repo) => {
          installNativeFreezeFixture(repo, { reservedProjectName: true });
          const result = await runSupervised(repo, app);
          expect(result.code).not.toBe(0);
          expect(sealedReceipt(repo)).toBeNull();
          expect(result.stderr).toContain(CONTROL_PROJECT);
          expect(existsSync(repo.path(controlDirPath())), 'no control document was ever written').toBe(false);
          expect(controlSpecsInRepo(repo), 'no controller was ever generated').toEqual([]);
          expect(spoolLines(repo)).toEqual([]);
        });
      } finally {
        await app.stop();
      }
    },
    600_000,
  );

  it(
    "an operator's whole-run session state bypasses the preparation path exactly as before",
    async () => {
      const app = await startNativeApp();
      try {
        await withTempRepo({ prefix: 'gateforge-native-operator-state-' }, async (repo) => {
          installNativeFreezeFixture(repo, { operatorState: true });
          const operatorState = installOperatorState(repo, app.url, app.sessionSecret);
          const result = await runSupervised(repo, app, { GATEFORGE_SESSION_STATE: operatorState });
          expect(result.code).not.toBe(0);
          // The preparation path is bypassed: no controller, no control
          // documents, no accepted marker — and no receipt either, because
          // the stages still wrote generated bytes into a candidate that was
          // never prepared for them.
          expect(existsSync(repo.path(controlDirPath()))).toBe(false);
          expect(controlSpecsInRepo(repo), 'no controller code was ever generated').toEqual([]);
          const ordering = freezeOrdering(newestSpoolLines(repo));
          expect(ordering.markers).toHaveLength(0);
          expect(ordering.controller).toHaveLength(0);
          expect(sealedReceipt(repo)).toBeNull();
          // Every case still executed, and every body consumed the
          // OPERATOR's session rather than any declared project state (the
          // in-body protected-route proof is what enforces this).
          const sealed = sealedExecution(repo);
          expect(sealed?.outcomes.map((outcome) => outcome.logicalKey).sort()).toEqual([...CONSUMER_CASES].sort());
          expect(sealed?.outcomes.every((outcome) => outcome.status === 'passed')).toBe(true);
        });
      } finally {
        await app.stop();
      }
    },
    900_000,
  );
});