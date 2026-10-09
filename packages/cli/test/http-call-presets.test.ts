/**
 * 0.14 WP5 step 3: the `http.callFindings` preset defaults and the one-line
 * migration message for a repository that has NO adoption receipt.
 *
 * - light writes `report` (advisory); normal and strict write `block`.
 * - A 0.13 config has no `callFindings` key; the schema default is `block`,
 *   so such a repository reaches the migration path, never an unexplained red.
 * - Without any receipt, a NEW call finding blocks, and the one line names
 *   the plain `gateforge adopt` as the way to record it as debt.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpConfigSchema, loadConfig, withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';
import { UNSERVED_PATH, VERIFIER_KEY, installRepo, sealRunWithCalls } from './http-call-session.js';

const ENV = { GATEFORGE_WITNESS_VERIFIER_KEY: VERIFIER_KEY };

describe('the http.callFindings preset defaults (0.14 WP5)', () => {
  it.each([
    ['light', 'report'],
    ['normal', 'block'],
    ['strict', 'block'],
  ] as const)('the %s preset writes callFindings: %s', async (preset, expected) => {
    await withTempRepo({}, async (repo) => {
      const init = await runCli(repo, ['init', '--no-scan', '--preset', preset]);
      expect(init.code, init.stderr).toBe(0);
      expect(loadConfig(join(repo.root, '.gateforge.yml')).http.callFindings).toBe(expected);
    });
  });

  it('a 0.13 config with no callFindings key reaches block (the schema default)', () => {
    expect(HttpConfigSchema.parse({}).callFindings).toBe('block');
  });
});

describe('a repository with no adoption receipt (0.14 WP5)', () => {
  it('a NEW call finding blocks, and one line names the plain adopt', async () => {
    await withTempRepo({}, async (repo) => {
      installRepo(repo);
      await sealRunWithCalls(repo, [UNSERVED_PATH]);
      const check = await runCli(repo, ['check'], ENV);
      expect(check.code, check.stdout).toBe(1);
      expect(check.stdout).toContain('HTTP call findings: 1 not yet recorded as debt');
      expect(check.stdout).toContain('`gateforge adopt` to record them as debt');
      expect(check.stdout).not.toContain('--family http-calls');
    });
  }, 120_000);
});
