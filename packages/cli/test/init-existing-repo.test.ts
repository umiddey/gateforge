/**
 * `init` on an EXISTING repository (regression: the preset summary used
 * to claim things this run did not do).
 *
 * Three false claims, all on a repo that already has a config, a
 * baseline and a hook:
 * 1. the `undo:` line listed fixed paths, so following it would have
 *    deleted the owner's pre-existing config, baselines, waivers, hooks
 *    and CI file — it must list ONLY what this run created, and print
 *    nothing when it created nothing;
 * 2. "writing the light preset" was printed even when an existing
 *    config was kept, so the run claimed a write it never made;
 * 3. "wrote no hooks: nothing blocks your commits" was printed even
 *    when the repo already had a commit hook, so it claimed an absence
 *    that was not there.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

/** Repo-relative paths a preset must never offer to delete. */
const PRE_EXISTING: readonly string[] = [
  '.gateforge.yml',
  '.gateforge/baselines/obligations.json',
  '.gateforge/waivers',
  '.git/hooks/pre-commit',
  '.gitlab-ci.yml',
];

/**
 * Runs `init` once so the repo already has a gateforge config, a
 * baseline, a commit hook and a CI file before the run under test.
 */
async function runInitOnPopulatedRepo(
  run: (repo: TempRepo) => Promise<void>,
): Promise<void> {
  await withTempRepo({}, async (repo) => {
    const first = await runCli(repo, ['init', '--no-scan', '--preset', 'normal']);
    expect(first.code, first.stdout).toBe(0);
    for (const relative of PRE_EXISTING) {
      expect(existsSync(repo.path(relative)), `${relative} must exist before the second run`).toBe(true);
    }
    await run(repo);
  });
}

describe('init on an existing repository claims only what it did', () => {
  it('offers an undo line only for paths this run created', async () => {
    await withTempRepo({}, async (repo) => {
      const first = await runCli(repo, ['init', '--no-scan', '--preset', 'normal']);
      expect(first.code, first.stdout).toBe(0);
      const baselineBefore = readFileSync(repo.path('.gateforge/baselines/obligations.json'), 'utf8');
      const configBefore = readFileSync(repo.path('.gateforge.yml'), 'utf8');

      const second = await runCli(repo, ['init', '--no-scan', '--preset', 'normal']);
      expect(second.code, second.stdout).toBe(0);

      // Nothing new was created, so there is nothing to undo. Printing a
      // fixed `rm -rf` list here would delete the owner's own files.
      expect(second.stdout).not.toContain('undo:');
      // And the run really did leave every pre-existing file alone.
      expect(readFileSync(repo.path('.gateforge.yml'), 'utf8')).toBe(configBefore);
      expect(readFileSync(repo.path('.gateforge/baselines/obligations.json'), 'utf8')).toBe(baselineBefore);
    });
  });

  it('lists exactly the created paths when the run did create some', async () => {
    await withTempRepo({}, async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--no-scan', '--preset', 'strict']);
      expect(code, stdout).toBe(0);
      const undo = stdout.split('\n').find((line) => line.startsWith('undo:'));
      expect(undo).toBeDefined();
      // Every path the undo line names must be one this run created.
      for (const path of (undo ?? '').replace('undo: rm -rf ', '').split(/\s+/).filter((p) => p !== '')) {
        expect(path, `undo names a path this run did not create: ${path}`).not.toBe('');
        expect(existsSync(repo.path(path)), `undo names a path this run did not create: ${path}`).toBe(true);
      }
      expect(undo).toContain('.gateforge.yml');
    });
  });

  it('does not claim it wrote the light preset when a config already exists', async () => {
    await runInitOnPopulatedRepo(async (repo) => {
      const { code, stdout } = await runCli(repo, ['init', '--no-scan']);
      expect(code, stdout).toBe(0);
      expect(stdout).not.toContain('no terminal: writing the light preset');
      expect(stdout).toContain('no terminal: keeping your existing .gateforge.yml');
      expect(stdout).toContain('existing .gateforge.yml left untouched');
      // The existing mode is untouched: the run did not "write" warn.
      expect(loadConfig(join(repo.root, '.gateforge.yml')).mode).toBe('changed');
    });
  });

  it('does not claim nothing blocks commits when a commit hook already exists', async () => {
    await withTempRepo({}, async (repo) => {
      // A pre-existing, owner-written commit hook that init must not touch.
      mkdirSync(join(repo.root, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(repo.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const { code, stdout } = await runCli(repo, ['init', '--no-scan', '--preset', 'light']);
      expect(code, stdout).toBe(0);
      expect(stdout).not.toContain('nothing blocks your commits');
      expect(stdout).toContain('your existing commit hook and/or CI job (left untouched) still decide');
      expect(readFileSync(join(repo.root, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    });
  });
});
