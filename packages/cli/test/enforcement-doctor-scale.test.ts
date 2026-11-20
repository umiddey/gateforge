/**
 * `enforcement doctor` on a large repository (a large Python+React clone):
 * the staged index and the ignored tree are both bigger than Node's default
 * 1 MiB `spawnSync` buffer. Runs the real CLI in-process against a real git
 * repository; nothing is mocked.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';

/** Ignored files under `bulk/`; the verifier-key scan lists every one of them. */
const IGNORED_COUNT = 200_000;

interface DoctorCheck {
  id: string;
  status: string;
  detail: string;
}

function doctorChecks(stdout: string): DoctorCheck[] {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== 'object' || parsed === null || !('checks' in parsed) || !Array.isArray(parsed.checks)) {
    throw new Error('enforcement doctor --json did not return a checks array');
  }
  return parsed.checks;
}

describe('enforcement doctor on a large repository', () => {
  it('P1: staged index over 1 MiB is evaluated', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // 5,000 files with 200-character paths: `git ls-files --stage -z` is ~1.25 MB.
      const bulk: Record<string, string> = {};
      for (let i = 0; i < 5000; i += 1) {
        bulk[`bulk/${String(i).padStart(5, '0')}_${'a'.repeat(189)}`] = 'x\n';
      }
      repo.writeFiles(bulk);
      repo.stage();
      repo.commit('fixture with a large staged index');

      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      const checks = doctorChecks(result.stdout);

      const policy = checks.find((check) => check.id === 'policy-inputs-vs-HEAD');
      expect(policy?.detail).not.toContain('the staged index is empty');
      expect(policy?.detail).not.toContain('not evaluated');
      expect(checks.find((check) => check.id === 'snapshot')?.status).toBe('ok');
    });
  }, 60_000);

  it('P2: a large ignored tree gets a real verdict', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      appendFileSync(join(repo.root, '.gitignore'), 'bulk/\n');
      repo.stage();
      repo.commit('fixture with a large ignored tree');

      const bulkDir = join(repo.root, 'bulk');
      mkdirSync(bulkDir);
      for (let i = 0; i < IGNORED_COUNT; i += 1) {
        writeFileSync(join(bulkDir, String(i)), '');
      }

      // Must resolve: a throw here (e.g. RangeError from spreading the listing) fails the test.
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      const check = doctorChecks(result.stdout).find((entry) => entry.id === 'verifier-key-location');
      expect(check).toBeDefined();
      expect(check?.detail).not.toContain('could not verify every source');
    });
  }, 60_000);
});
