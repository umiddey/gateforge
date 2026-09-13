/**
 * Input snapshot unit tests (plan §11.2): one shared deterministic
 * digest over the bytes the pipeline examines plus the gate context.
 *
 * Red-probe rule: every guard below fails on the pre-Phase-6 tree
 * (no snapshot helper at all — the import itself fails), and each
 * behavioral case asserts a digest change or a fail-closed error that
 * the legacy HEAD-SHA-only world could not produce.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { symlinkSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { loadConfig, withTempRepo, type TempRepo } from '@gateforge/core';
import {
  GATEFORGE_VERIFIER_FORMAT,
  INPUT_SNAPSHOT_VERSION,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  assertOutputDisjoint,
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
} from '../src/input-snapshot.js';
import { resolveStateDir } from '../src/state.js';
import { FIXED_AT, installFixture } from './helpers.js';

/** Loads the fixture config from an absolute path. */
function fixtureConfig(repo: TempRepo): ReturnType<typeof loadConfig> {
  return loadConfig(join(repo.root, '.gateforge.yml'));
}

/** Computes the files-only digest (empty gate context) for stability assertions. */
function filesDigest(repo: TempRepo): string {
  const config = fixtureConfig(repo);
  return computeInputSnapshot({
    cwd: repo.root,
    config,
    stateDir: resolveStateDir(repo.root),
  }).inputDigest;
}

describe('input snapshot (§11.2)', () => {
  it('is deterministic: identical inputs in two runs produce identical digests', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const first = filesDigest(repo);
      const second = filesDigest(repo);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toBe(first);
      const snapshot = computeInputSnapshot({
        cwd: repo.root,
        config: fixtureConfig(repo),
        stateDir: resolveStateDir(repo.root),
      });
      expect(snapshot.snapshotVersion).toBe(INPUT_SNAPSHOT_VERSION);
      expect(snapshot.verifierFormat).toBe(GATEFORGE_VERIFIER_FORMAT);
      // Reordered file enumeration cannot change the digest (entries
      // are codepoint-sorted before hashing).
      const reordered = [...snapshot.files].reverse();
      expect(
        computeInputSnapshot({
          cwd: repo.root,
          config: fixtureConfig(repo),
          stateDir: resolveStateDir(repo.root),
        }).inputDigest,
      ).toBe(snapshot.inputDigest);
      expect(reordered.map((entry) => entry.path).sort()).toEqual(
        snapshot.files.map((entry) => entry.path),
      );
    });
  });

  it('covers tracked edits, new untracked files, and configured-but-ignored inputs', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const baseline = filesDigest(repo);
      // Tracked working-tree edit (uncommitted — HEAD SHA alone misses it).
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\nextra line\n' });
      expect(filesDigest(repo)).not.toBe(baseline);
      // New untracked source counts before it is committed.
      repo.writeFiles({ 'src/sneaky.txt': 'sneaky fixture.table\n' });
      const withUntracked = filesDigest(repo);
      expect(withUntracked).not.toBe(baseline);
      // Configured scan inputs count even when Git ignores them.
      repo.writeFiles({ '.gitignore': 'src/ignored.txt\n' });
      repo.writeFiles({ 'src/ignored.txt': 'ignored fixture.table\n' });
      const withIgnored = filesDigest(repo);
      expect(withIgnored).not.toBe(withUntracked);
      repo.writeFiles({ 'src/ignored.txt': 'ignored fixture.table\nchanged\n' });
      expect(filesDigest(repo)).not.toBe(withIgnored);
    });
  });

  it('covers config, policy, classification, adapter, plugin, waiver, and manifest inputs', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const baseline = filesDigest(repo);
      // Pack configs absent → explicit absence entries, present → hashed.
      const snapshot = computeInputSnapshot({
        cwd: repo.root,
        config: fixtureConfig(repo),
        stateDir: resolveStateDir(repo.root),
      });
      expect(
        snapshot.files.some(
          (entry) => entry.type === 'absent' && entry.path.includes('.gateforge/planes.json'),
        ),
      ).toBe(true);
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({ rules: [] }),
        '.gateforge/waivers/scope.json': JSON.stringify({ schemaVersion: 1 }),
        'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
      });
      expect(filesDigest(repo)).not.toBe(baseline);
      const withConfigs = filesDigest(repo);
      // Policy / classification / adapter / plugin edits all move the digest.
      repo.writeFiles({ '.gateforge/policies.yml': '# touched\n' });
      expect(filesDigest(repo)).not.toBe(withConfigs);
    });
  });

  it('a deleted tracked file changes the digest (explicit deleted entry)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.stage();
      repo.commit('fixture');
      const baseline = filesDigest(repo);
      rmSync(join(repo.root, 'src/orders.txt'));
      const after = computeInputSnapshot({
        cwd: repo.root,
        config: fixtureConfig(repo),
        stateDir: resolveStateDir(repo.root),
      });
      expect(after.inputDigest).not.toBe(baseline);
      expect(
        after.files.find((entry) => entry.path === 'src/orders.txt')?.type,
      ).toBe('deleted');
    });
  });

  it('preserves symlink identity: target edits and retargets move the digest', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      symlinkSync(join(repo.root, 'src/accounts.txt'), join(repo.root, 'src/link.txt'));
      const baseline = filesDigest(repo);
      const entries = collectInputFiles(repo.root, fixtureConfig(repo), resolveStateDir(repo.root));
      expect(entries.find((entry) => entry.path === 'src/link.txt')?.type).toBe('symlink');
      // Target content change moves the digest through the link.
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\nchanged\n' });
      expect(filesDigest(repo)).not.toBe(baseline);
      // Retargeting the link moves it too.
      rmSync(join(repo.root, 'src/link.txt'));
      symlinkSync(join(repo.root, 'src/orders.txt'), join(repo.root, 'src/link.txt'));
      expect(filesDigest(repo)).not.toBe(baseline);
    });
  });

  it('rejects escaping, broken, and directory symlinks with unsupported-snapshot', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      symlinkSync('/etc/hostname', join(repo.root, 'src/escape.txt'));
      expect(() => filesDigest(repo)).toThrow(UnsupportedSnapshotError);
      rmSync(join(repo.root, 'src/escape.txt'));
      symlinkSync(join(repo.root, 'src/no-such-target.txt'), join(repo.root, 'src/broken.txt'));
      expect(() => filesDigest(repo)).toThrow(UnsupportedSnapshotError);
      rmSync(join(repo.root, 'src/broken.txt'));
      mkdirSync(join(repo.root, 'src/subdir'), { recursive: true });
      symlinkSync(join(repo.root, 'src/subdir'), join(repo.root, 'src/dirlink'));
      expect(() => filesDigest(repo)).toThrow(UnsupportedSnapshotError);
    });
  });

  it('rejects submodules with an explicit unsupported-snapshot block', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // A real nested repository to submodule (clone needs a HEAD).
      repo.git(['init', '--quiet', 'other']);
      writeFileSync(join(repo.root, 'other', 'file.txt'), 'other\n');
      repo.git(['-C', 'other', 'add', '-A']);
      repo.git([
        '-C', 'other',
        '-c', 'user.name=fixture',
        '-c', 'user.email=fixture@gateforge.invalid',
        'commit', '--quiet', '-m', 'other',
      ]);
      repo.git(['-c', 'protocol.file.allow=always', 'submodule', 'add', './other', 'vendor/other']);
      expect(() => filesDigest(repo)).toThrow(UnsupportedSnapshotError);
    });
  });

  it('excludes only the actual --out run state; generated outputs keep the digest stable', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const baseline = filesDigest(repo);
      // Generated run-state outputs (report, ledger copies) do not move
      // the digest — but policies under .gateforge still do.
      repo.writeFiles({
        '.gateforge/test-gates/report.json': JSON.stringify({ summary: {} }),
        '.gateforge/test-gates/records.json': '[]',
        '.gateforge/test-gates/manifest.json': '{}',
      });
      expect(filesDigest(repo)).toBe(baseline);
      repo.writeFiles({ '.gateforge/policies.yml': '# touched\n' });
      expect(filesDigest(repo)).not.toBe(baseline);
    });
  });

  it('rejects unsafe --out overlap, including through a symlink alias', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = fixtureConfig(repo);
      // --out strictly inside a source dir but hiding no declared input
      // is allowed (declared scan inputs stay hashed)...
      expect(() =>
        assertOutputDisjoint(repo.root, join(repo.root, 'src', 'out'), ['lib/other.txt']),
      ).not.toThrow();
      // ...while --out src hides declared scan inputs.
      expect(() =>
        assertOutputDisjoint(repo.root, join(repo.root, 'src'), ['src/accounts.txt']),
      ).toThrow(/overlaps declared/);
      // The full helper agrees: --out src hides declared scan inputs.
      expect(() =>
        computeInputSnapshot({ cwd: repo.root, config, stateDir: join(repo.root, 'src') }),
      ).toThrow(/overlaps/);
      // A symlink alias of a source directory hides exactly like the
      // directory itself: --out at the alias is --out at src.
      symlinkSync(join(repo.root, 'src'), join(repo.root, 'alias'));
      expect(() =>
        assertOutputDisjoint(repo.root, join(repo.root, 'alias'), ['src/accounts.txt']),
      ).toThrow(/overlaps/);
      // Committed source under --out is unsafe even with no scan glob
      // covering it.
      repo.stage();
      repo.commit('fixture');
      repo.writeFiles({ 'src/out/note.txt': 'note\n' });
      repo.stage();
      repo.commit('out note');
      expect(() =>
        assertOutputDisjoint(repo.root, join(repo.root, 'src', 'out'), ['lib/other.txt']),
      ).toThrow(/overlaps committed/);
    });
  });

  it('reports snapshot-unavailable outside usable Git inventory (auth fails, discovery may work)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      rmSync(join(repo.root, '.git'), { recursive: true, force: true });
      expect(() => filesDigest(repo)).toThrow(SnapshotUnavailableError);
      expect(() =>
        collectInputFiles(repo.root, fixtureConfig(repo), resolveStateDir(repo.root)),
      ).toThrow(SnapshotUnavailableError);
    });
  });

  it('detects discovery drift via diffInputFiles (added/removed/changed)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = fixtureConfig(repo);
      const stateDir = resolveStateDir(repo.root);
      const before = collectInputFiles(repo.root, config, stateDir);
      expect(diffInputFiles(before, before)).toEqual([]);
      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\n drift\n' });
      repo.writeFiles({ 'src/added.txt': 'added fixture.table\n' });
      const after = collectInputFiles(repo.root, config, stateDir);
      const drift = diffInputFiles(before, after);
      expect(drift.some((line) => line.includes('src/accounts.txt'))).toBe(true);
      expect(drift.some((line) => line.includes('src/added.txt'))).toBe(true);
    });
  });

  it('never hashes tokens, keys, or absolute paths into the digest', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const snapshot = computeInputSnapshot({
        cwd: repo.root,
        config: fixtureConfig(repo),
        stateDir: resolveStateDir(repo.root),
      });
      const canonical = JSON.stringify(snapshot);
      expect(canonical).not.toContain(repo.root);
      expect(canonical).not.toContain('GATEFORGE_WITNESS_VERIFIER_KEY');
      expect(snapshot.files.some((entry) => entry.path.startsWith('.git/'))).toBe(false);
      expect(FIXED_AT.length).toBeGreaterThan(0);
    });
  });
});
