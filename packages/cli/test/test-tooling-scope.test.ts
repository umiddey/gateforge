/**
 * `project.paths.testTooling` — the OWNER DECLARATION half of 0.10.2.
 *
 * The automatic half (a runner configuration's own named files) cannot
 * see `scripts/e2e/run.sh`: nothing imports it and no runner
 * configuration names it — the repository's own `package.json` scripts do.
 * So the owner declares it, and the declaration is deliberately weak:
 *
 * - it EXPANDS the evaluation scope to the full repository (like test
 *   infrastructure), so a change to declared tooling can never be proven
 *   by a slice of the suite — it is never a skip;
 * - it is NEUTRAL: a change set of declared tooling alone carries no
 *   product behaviour, so it never becomes `CHANGE_UNMAPPED`;
 * - it can NEVER hide product code: a discovered resource's own source
 *   keeps its own treatment, and a glob that matches one is a CONFIG
 *   ERROR (exit 2, naming the file and the glob), not a silent pass.
 *
 * The key lives in `.gateforge.yml`, so it is inside the owner-approved
 * policy digest — a candidate cannot widen the list without the owner
 * re-pinning. Absent means today's behaviour, byte for byte, digests
 * included.
 *
 * `engine` class: the pure scope function plus one CLI exit-code and one
 * doctor row; no runner spawns.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import { configYml, installFixture, runCli } from './helpers.js';
import { computeEvaluationScope } from '../src/scope.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';

/** The tool script the owner declares. */
const TOOLING_FILE = 'scripts/e2e/run.sh';

/**
 * The approved policy digest of the standard fixture repository when the
 * owner declares no `testTooling` at all. The key adds no digest entry and
 * no document bytes when it is absent, so a repository that does not
 * declare it keeps exactly this revision.
 *
 * Re-pinned ONCE by 0.11.0, and only for that reason: `.gateforge.yml`
 * gained the REQUIRED `scan:` section (the scanner settings that moved
 * out of the answers document), which is document bytes the digest
 * legitimately covers. The invariant this case pins — absent means one
 * exact, unchanging revision — is unchanged; only that revision's value
 * moved. The sibling case pins the other half: declaring the list moves it.
 */
const DIGEST_WITHOUT_TEST_TOOLING = 'd069ba243d256c15b86bacce6cb6bfc8093044e6a3f81721790585b24c7e0665';

describe('a declared test-toolging file is attributable, scope-expanding and neutral', () => {
  it('is CHANGE_UNMAPPED without the declaration and attributed with it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const undeclared = loadConfig(`${repo.root}/.gateforge.yml`);
      const before = computeEvaluationScope({
        config: undeclared,
        changedFiles: [TOOLING_FILE],
        strictE2E: true,
      });
      expect(before.unmappedFiles).toEqual([TOOLING_FILE]);
      expect(before.mode).toBe('all');

      repo.writeFiles({ '.gateforge.yml': configYml({ testTooling: ['scripts/e2e/**'] }) });
      const declared = loadConfig(`${repo.root}/.gateforge.yml`);
      const after = computeEvaluationScope({
        config: declared,
        changedFiles: [TOOLING_FILE],
        strictE2E: true,
      });
      // Conservative, never a skip: the whole repository must be proven.
      expect(after.mode).toBe('all');
      expect(after.expandedBecause).toEqual([`test-tooling:${TOOLING_FILE}`]);
      // Neutral: a declared tool script is never an unmapped product change.
      expect(after.unmappedFiles).toEqual([]);
      expect(after.productBehaviorNeutral).toBe(true);
    });
  });

  it('never reaches a discovered resource\'s own source', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { testTooling: ['src/**'] });
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['src/accounts.txt'],
        knownSourceFiles: ['src/accounts.txt'],
        strictE2E: true,
      });
      // Product behaviour by definition: never neutral, never a
      // test-tooling pass, and not blocked as unmapped either.
      expect(decision.expandedBecause).toEqual([]);
      expect(decision.unmappedFiles).toEqual([]);
      expect(decision.productBehaviorNeutral).toBe(false);
    });
  });

  it('leaves a file outside every declared glob unmapped', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { testTooling: ['scripts/e2e/**'] });
      const config = loadConfig(`${repo.root}/.gateforge.yml`);
      const decision = computeEvaluationScope({
        config,
        changedFiles: ['src/orders/loyalty.js'],
        strictE2E: true,
      });
      expect(decision.unmappedFiles).toEqual(['src/orders/loyalty.js']);
    });
  });
});

describe('a glob over product code is a config error, not a silent pass', () => {
  it('check exits 2 naming the file and the glob', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { testTooling: ['src/**'] });
      repo.writeFiles({ [TOOLING_FILE]: '#!/bin/sh\nexit 0\n' });
      repo.commitFiles({}, 'base');

      const run = await runCli(repo, ['check', '--changed']);
      const output = `${run.stdout}\n${run.stderr}`;

      expect(run.code, output).toBe(2);
      expect(run.stderr).toContain('src/accounts.txt');
      expect(run.stderr).toContain('src/**');
      expect(output).toContain('testTooling');
    });
  }, 240_000);

  it('enforcement doctor reports it as a failing check', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { testTooling: ['src/**'] });
      repo.commitFiles({}, 'base');

      const run = await runCli(repo, ['enforcement', 'doctor', '--json']);
      const output = `${run.stdout}\n${run.stderr}`;
      expect(run.code, output).toBe(0);
      const report = JSON.parse(run.stdout) as {
        checks: Array<{ id: string; status: string; detail: string }>;
        ready: boolean;
      };
      const check = report.checks.find((entry) => entry.id === 'test-tooling');
      expect(check?.status, output).toBe('fail');
      expect(check?.detail).toContain('src/accounts.txt');
      expect(check?.detail).toContain('src/**');
      expect(report.ready).toBe(false);
    });
  }, 240_000);
});

describe('the declaration is owner-pinned: it lives in the approved policy digest', () => {
  it('changing the list moves the approved revision', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo, { testTooling: ['scripts/e2e/**'] });
      const one = trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')));

      repo.writeFiles({ '.gateforge.yml': configYml({ testTooling: ['scripts/e2e/**', 'tools/dev/**'] }) });
      const two = trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')));

      expect(two).not.toBe(one);
    });
  });

  it('absent means the pre-existing revision, byte for byte', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      expect(trustedPolicyDigestForConfig(repo.root, loadConfig(repo.path('.gateforge.yml')))).toBe(
        DIGEST_WITHOUT_TEST_TOOLING,
      );
    });
  });
});