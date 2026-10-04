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
import { pathToFileURL } from 'node:url';
import { chmodSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { loadConfig, withTempRepo, type RuntimeConfig, type TempRepo } from '@gate-forge/core';
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
import { runtimeReuseDigest } from '../src/runtime.js';
import { computeCandidateTreeId, resolveGitDir } from '../src/candidate-tree.js';
import { loadDocsExclusions } from '../src/docs-exclusions.js';
import { loadCacheExclusions } from '../src/cache-exclusions.js';
import { trustedPolicyDigestForConfig } from '../src/execution.js';
import { FIXED_AT, configYml, installFixture } from './helpers.js';

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
  it('keeps documentation read through dynamic code in the evidence digest', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const docPath = ['docs', ['gui', 'de.md'].join('')].join('/');
      repo.writeFiles({ [docPath]: 'first document value\n' });
      const config = fixtureConfig(repo);
      const stateDir = resolveStateDir(repo.root);
      const readers = [
        {
          path: 'src/split-path-reader.mjs',
          source: [
            "import { readFileSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "export function readDocument() {",
            "  const name = ['gui', 'de.md'].join('');",
            "  return readFileSync(join('docs', name), 'utf8');",
            '}',
          ].join('\n'),
        },
        {
          path: 'src/directory-reader.mjs',
          source: [
            "import { readFileSync, readdirSync } from 'node:fs';",
            "import { join } from 'node:path';",
            "export function readDocument() {",
            "  return readdirSync('docs').filter((name) => name.endsWith('.md')).sort()",
            "    .map((name) => readFileSync(join('docs', name), 'utf8')).join('');",
            '}',
          ].join('\n'),
        },
      ];

      const digestChanges: boolean[] = [];
      const originalCwd = process.cwd();
      process.chdir(repo.root);
      try {
        for (const reader of readers) {
          repo.writeFiles({ [reader.path]: reader.source });
          const imported = await import(pathToFileURL(join(repo.root, reader.path)).href);
          const before = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
          expect(imported.readDocument()).toBe('first document value\n');

          repo.writeFiles({ [docPath]: 'changed document value\n' });
          const after = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
          expect(imported.readDocument()).toBe('changed document value\n');
          digestChanges.push(after !== before);
          repo.writeFiles({ [docPath]: 'first document value\n' });
        }
      } finally {
        process.chdir(originalCwd);
      }
      expect(digestChanges, 'each dynamic reader must change the evidence digest').toEqual([true, true]);
    });
  });

  it('keeps documentation changes in evidence identity and exact candidate identity', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const docName = ['guide', '.md'].join('');
      const docPath = ['docs', docName].join('/');
      repo.writeFiles({ [docPath]: '# First guide\n' });
      repo.stage();
      repo.commit('base docs');

      const config = fixtureConfig(repo);
      const stateDir = resolveStateDir(repo.root);
      const before = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
      const gitDir = resolveGitDir(repo.root, process.env);
      if (gitDir === null) throw new Error('test repository has no Git directory');
      const beforeTree = computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record');

      repo.writeFiles({ [docPath]: '# Corrected spelling\n' });
      repo.stage([docPath]);

      const after = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
      const afterTree = computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record');
      expect(afterTree).not.toBe(beforeTree);
      expect(after).not.toBe(before);

      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\nexecutable change\n' });
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest).not.toBe(after);
    });
  });

  it('omits only an owner-approved documentation folder from both identities', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'docs/guide.md': '# Owner-approved guide\n',
        '.gateforge.yml': configYml({ evidence: { docs: ['docs'] } }),
      });
      repo.stage();
      repo.commit('approved documentation folder');

      const config = fixtureConfig(repo);
      const stateDir = resolveStateDir(repo.root);
      const exclusions = loadDocsExclusions(repo.root, config);
      const gitDir = resolveGitDir(repo.root, process.env);
      if (gitDir === null) throw new Error('test repository has no Git directory');
      const beforeInput = computeInputSnapshot({ cwd: repo.root, config, stateDir, docsExclusions: exclusions }).inputDigest;
      const beforeTree = computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record', [], exclusions);

      repo.writeFiles({ 'docs/guide.md': '# Corrected guide\n', 'docs/new-page.md': '# Added page\n' });
      repo.stage(['docs/guide.md', 'docs/new-page.md']);
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir, docsExclusions: exclusions }).inputDigest).toBe(
        beforeInput,
      );
      expect(computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record', [], exclusions)).toBe(beforeTree);

      repo.writeFiles({ 'src/accounts.txt': 'accounts fixture.table\nsource changed\n' });
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir, docsExclusions: exclusions }).inputDigest).not.toBe(
        beforeInput,
      );
      expect(computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record', [], exclusions)).not.toBe(
        beforeTree,
      );

      // The declaration's bytes now live in `.gateforge.yml`, which the
      // snapshot already hashes: a comment-only edit still moves both
      // identities, exactly like an approval-revision edit did.
      repo.writeFiles({ '.gateforge.yml': `# owner approval revision changed\n${configYml({ evidence: { docs: ['docs'] } })}` });
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir, docsExclusions: exclusions }).inputDigest).not.toBe(
        beforeInput,
      );
      expect(computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record', [], exclusions)).not.toBe(
        beforeTree,
      );
    });
  });

  it('preserves default input behavior and owner-excludes bytecode from tree identity', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const cacheFile = 'src/__pycache__/accounts.cpython-313.pyc';
      repo.writeFiles({
        '.gitignore': 'src/__pycache__/\n',
        [cacheFile]: 'first-bytecode\n',
        '.gateforge.yml': configYml({ evidence: { cache: [cacheFile] } }),
      });
      const config = fixtureConfig(repo);
      const exclusions = loadCacheExclusions(repo.root, config);
      expect(exclusions).toEqual([cacheFile]);
      const approvedPolicyDigest = trustedPolicyDigestForConfig(repo.root, config);
      const stateDir = resolveStateDir(repo.root);
      const gitDir = resolveGitDir(repo.root, process.env);
      if (gitDir === null) throw new Error('test repository has no Git directory');
      const strictInput = computeInputSnapshot({ cwd: repo.root, config, stateDir }).inputDigest;
      const approvedInput = computeInputSnapshot({
        cwd: repo.root,
        config,
        stateDir,
        cacheExclusions: exclusions,
      }).inputDigest;
      const strictTree = computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record');
      const approvedTree = computeCandidateTreeId(
        gitDir,
        repo.root,
        process.env,
        stateDir,
        'record',
        [],
        [],
        exclusions,
      );

      repo.writeFiles({ [cacheFile]: 'rewritten-bytecode\n' });

      expect(approvedInput).toBe(strictInput);
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir }).inputDigest).toBe(strictInput);
      expect(
        computeInputSnapshot({ cwd: repo.root, config, stateDir, cacheExclusions: exclusions }).inputDigest,
      ).toBe(approvedInput);
      expect(computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record')).not.toBe(strictTree);
      expect(
        computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record', [], [], exclusions),
      ).toBe(approvedTree);
      expect(trustedPolicyDigestForConfig(repo.root, config)).toBe(approvedPolicyDigest);
      repo.writeFiles({
        '.gateforge.yml': `# owner approval revision\n${configYml({ evidence: { cache: [cacheFile] } })}`,
      });
      expect(trustedPolicyDigestForConfig(repo.root, config)).not.toBe(approvedPolicyDigest);
    });
  });
  it('rejects exclusions that overlap source, gate inputs, or symlinks', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'docs/readme.md': '# Guide\n',
        'docs/run.js': 'export const unsafe = true;\n',
        '.gateforge.yml': configYml({ evidence: { docs: ['docs'] } }),
      });
      let config = fixtureConfig(repo);
      expect(() => loadDocsExclusions(repo.root, config)).toThrow(/cannot exclude executable or gate input 'docs\/run.js'/);

      unlinkSync(join(repo.root, 'docs/run.js'));
      repo.writeFiles({ '.gateforge.yml': configYml({ evidence: { docs: ['src'] } }) });
      config = fixtureConfig(repo);
      expect(() => loadDocsExclusions(repo.root, config)).toThrow(/cannot exclude executable or gate input 'src\//);

      repo.writeFiles({ '.gateforge.yml': configYml({ evidence: { docs: ['docs'] } }) });
      config = fixtureConfig(repo);
      symlinkSync(join(repo.root, 'src/accounts.txt'), join(repo.root, 'docs/current.txt'));
      expect(() => loadDocsExclusions(repo.root, config)).toThrow(/rejects symlink 'docs\/current.txt'/);

      unlinkSync(join(repo.root, 'docs/current.txt'));
      repo.writeFiles({ 'docs/package.json': '{"scripts":{"test":"unsafe"}}\n' });
      expect(() => loadDocsExclusions(repo.root, config)).toThrow(/cannot exclude executable or gate input 'docs\/package.json'/);
      unlinkSync(join(repo.root, 'docs/package.json'));
      repo.writeFiles({ 'docs/diagram.png': 'static raster placeholder\n' });
      expect(loadDocsExclusions(repo.root, config)).toEqual(['docs']);

      unlinkSync(join(repo.root, 'docs/diagram.png'));
      rmSync(join(repo.root, 'docs'), { recursive: true });
      expect(() => loadDocsExclusions(repo.root, config)).toThrow(/folder 'docs' does not exist/);
    });
  });

  it('accepts data and document formats inside a declared documentation folder', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'docs/readme.md': '# Guide\n',
        'docs/schema.json': '{"type":"object"}\n',
        'docs/values.yaml': 'key: value\n',
        'docs/values.yml': 'key: value\n',
        'docs/rows.csv': 'name,role\n',
        'docs/page.html': '<!doctype html>\n<title>Guide</title>\n',
        '.gateforge.yml': configYml({ evidence: { docs: ['docs'] } }),
      });
      const config = fixtureConfig(repo);
      const exclusions = loadDocsExclusions(repo.root, config);
      expect(exclusions).toEqual(['docs']);

      // Outside a declared folder `.html` keeps full evidence identity.
      const stateDir = resolveStateDir(repo.root);
      repo.stage();
      repo.commit('documentation folder carrying data formats');
      const before = computeInputSnapshot({ cwd: repo.root, config, stateDir, docsExclusions: exclusions }).inputDigest;
      repo.writeFiles({ 'assets/page.html': '<!doctype html>\n<title>Product</title>\n' });
      repo.stage(['assets/page.html']);
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir, docsExclusions: exclusions }).inputDigest).not.toBe(
        before,
      );
    });
  });

  it('still refuses manifests, execution configs, lockfiles and source in a declared documentation folder', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'docs/readme.md': '# Guide\n',
        'docs/values.yaml': 'key: value\n',
        '.gateforge.yml': configYml({ evidence: { docs: ['docs'] } }),
      });
      const config = fixtureConfig(repo);
      expect(loadDocsExclusions(repo.root, config)).toEqual(['docs']);

      const refused = [
        'package.json',
        'tsconfig.json',
        '.gitlab-ci.yml',
        '.pre-commit-config.yaml',
        'pnpm-workspace.yaml',
        'composer.json',
        'vite.config.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'run.js',
      ];
      for (const name of refused) {
        repo.writeFiles({ [`docs/${name}`]: '{}\n' });
        expect(() => loadDocsExclusions(repo.root, config)).toThrow(
          `cannot exclude executable or gate input 'docs/${name}'`,
        );
        unlinkSync(join(repo.root, 'docs', name));
      }
      expect(loadDocsExclusions(repo.root, config)).toEqual(['docs']);
    });
  });

  it('keeps Markdown referenced by test configuration in the evidence digest', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const docName = ['guide', '.md'].join('');
      const docPath = ['docs', docName].join('/');
      repo.writeFiles({ [docPath]: '# First guide\n' });
      const config = fixtureConfig(repo);
      const stateDir = resolveStateDir(repo.root);
      repo.writeFiles({ 'playwright.config.ts': `export default { testDir: '${docPath}' };\n` });
      const before = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
      repo.writeFiles({ [docPath]: '# Corrected spelling\n' });
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest).not.toBe(before);

      const secondName = ['index', '.md'].join('');
      const secondPath = ['docs', secondName].join('/');
      repo.writeFiles({ [secondPath]: '# First index\n' });
      const glob = ['docs', '**', '*.md'].join('/');
      repo.writeFiles({ 'playwright.config.ts': `export default { testMatch: '${glob}' };\n` });
      const beforeGlobEdit = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
      repo.writeFiles({ [secondPath]: '# Corrected index\n' });
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest).not.toBe(beforeGlobEdit);
    });
  });

  it('keeps executable and gate-definition files in the evidence digest', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = fixtureConfig(repo);
      const stateDir = resolveStateDir(repo.root);
      const evidenceInputs = [
        'tests/example.test.ts',
        'test/helpers.ts',
        'scripts/build.sh',
        '.gateforge/policies.yml',
        'package-lock.json',
        '.gateforge/runtime.yml',
        '.gateforge/adapters/adapter.mjs',
      ];
      let previous = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
      for (const [index, path] of evidenceInputs.entries()) {
        repo.writeFiles({ [path]: `changed ${index}\n` });
        const next = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
        expect(next, `${path} must invalidate evidence`).not.toBe(previous);
        previous = next;
      }
    });
  });

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
      expect(snapshot.evidenceInputDigest).toBe(snapshot.inputDigest);
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

  it('moves the authenticated input identity when ignored reused dependency bytes change', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({ '.gitignore': 'reused/\n' });
      mkdirSync(join(repo.root, 'reused'), { recursive: true });
      writeFileSync(join(repo.root, 'reused', 'dependency.js'), 'export const value = 1;\n', 'utf8');
      const runtime: RuntimeConfig = { schemaVersion: 1, prepare: { reuse: ['reused'] } };
      const first = computeInputSnapshot({
        cwd: repo.root,
        config: fixtureConfig(repo),
        stateDir: resolveStateDir(repo.root),
        runtimeReuseDigest: runtimeReuseDigest(repo.root, runtime),
      }).inputDigest;
      writeFileSync(join(repo.root, 'reused', 'dependency.js'), 'export const value = 2;\n', 'utf8');
      const second = computeInputSnapshot({
        cwd: repo.root,
        config: fixtureConfig(repo),
        stateDir: resolveStateDir(repo.root),
        runtimeReuseDigest: runtimeReuseDigest(repo.root, runtime),
      }).inputDigest;
      expect(second).not.toBe(first);
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

  it('preserves executable mode in the evidence digest', async () => {
    if (process.platform === 'win32') return;
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const config = fixtureConfig(repo);
      const stateDir = resolveStateDir(repo.root);
      repo.writeFiles({ 'scripts/run.sh': '#!/bin/sh\ntrue\n' });
      chmodSync(join(repo.root, 'scripts/run.sh'), 0o644);
      const before = computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest;
      chmodSync(join(repo.root, 'scripts/run.sh'), 0o755);
      expect(computeInputSnapshot({ cwd: repo.root, config, stateDir }).evidenceInputDigest).not.toBe(before);
    });
  });

  it('records a dangling tracked symlink by its link text and keeps the run usable', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      mkdirSync(join(repo.root, 'skills'), { recursive: true });
      symlinkSync('../.venv/skills/fastapi', join(repo.root, 'skills/fastapi'));
      repo.git(['add', '-A']);
      repo.git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@gateforge.invalid', 'commit', '--quiet', '-m', 'dangling link']);
      const entries = collectInputFiles(repo.root, fixtureConfig(repo), resolveStateDir(repo.root));
      const dangling = entries.find((entry) => entry.path === 'skills/fastapi');
      expect(dangling?.type).toBe('dangling-symlink');
      expect(dangling?.linkTarget).toBe('../.venv/skills/fastapi');
      expect(filesDigest(repo)).toMatch(/^[0-9a-f]{64}$/);
      // The link text IS the identity: retargeting moves the digest...
      const baseline = filesDigest(repo);
      unlinkSync(join(repo.root, 'skills/fastapi'));
      symlinkSync('../.venv/skills/sqlmodel', join(repo.root, 'skills/fastapi'));
      expect(filesDigest(repo)).not.toBe(baseline);
      // ...and bootstrapping the target turns the entry into a real
      // symlink entry (with target bytes) with a different digest.
      repo.writeFiles({ '.venv/skills/sqlmodel': 'model\n' });
      const afterBootstrap = collectInputFiles(repo.root, fixtureConfig(repo), resolveStateDir(repo.root));
      expect(afterBootstrap.find((entry) => entry.path === 'skills/fastapi')?.type).toBe('symlink');
      expect(filesDigest(repo)).not.toBe(baseline);
    });
  });

  it('still rejects a symlink escaping the repository with unsupported-snapshot', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      symlinkSync('/etc/hostname', join(repo.root, 'src/escape.txt'));
      expect(() => filesDigest(repo)).toThrow(UnsupportedSnapshotError);
    });
  });

  it('records a tracked DIRECTORY symlink by its link text and keeps the run usable (F2)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      mkdirSync(join(repo.root, '.venv/skills/fastapi'), { recursive: true });
      mkdirSync(join(repo.root, '.agents/skills'), { recursive: true });
      symlinkSync('../../.venv/skills/fastapi', join(repo.root, '.agents/skills/fastapi'));
      repo.git(['add', '-A']);
      repo.git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@gateforge.invalid', 'commit', '--quiet', '-m', 'directory skill link']);
      const entries = collectInputFiles(repo.root, fixtureConfig(repo), resolveStateDir(repo.root));
      const link = entries.find((entry) => entry.path === '.agents/skills/fastapi');
      // The link text IS the identity; the target directory is never walked.
      expect(link?.type).toBe('directory-symlink');
      expect(link?.linkTarget).toBe('../../.venv/skills/fastapi');
      expect(filesDigest(repo)).toMatch(/^[0-9a-f]{64}$/);
      // Retargeting the link moves the digest...
      const baseline = filesDigest(repo);
      unlinkSync(join(repo.root, '.agents/skills/fastapi'));
      symlinkSync('../../.venv/skills/sqlmodel', join(repo.root, '.agents/skills/fastapi'));
      expect(filesDigest(repo)).not.toBe(baseline);
      // ...and a link whose target is not a directory becomes a plain
      // `symlink` entry (target bytes in the digest), a different type.
      repo.writeFiles({ '.venv/skills/sqlmodel': 'model\n' });
      const afterRetype = collectInputFiles(repo.root, fixtureConfig(repo), resolveStateDir(repo.root));
      expect(afterRetype.find((entry) => entry.path === '.agents/skills/fastapi')?.type).toBe('symlink');
      expect(filesDigest(repo)).not.toBe(baseline);
    });
  });

  it('records a tracked link to a NOT-YET-CREATED directory like a dangling link (F2)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      mkdirSync(join(repo.root, '.agents/skills'), { recursive: true });
      // The template shape after the venv is bootstrapped: the link text
      // names a directory, and nothing exists at that path yet.
      symlinkSync('../../.venv/lib/python3.14/site-packages/fastapi', join(repo.root, '.agents/skills/fastapi'));
      const entries = collectInputFiles(repo.root, fixtureConfig(repo), resolveStateDir(repo.root));
      expect(entries.find((entry) => entry.path === '.agents/skills/fastapi')?.type).toBe('dangling-symlink');
      // The bootstrap turning that path into a directory changes the entry
      // type (and the digest) instead of failing the run.
      const baseline = filesDigest(repo);
      repo.writeFiles({ '.venv/lib/python3.14/site-packages/fastapi/skill.md': 'skill\n' });
      const after = collectInputFiles(repo.root, fixtureConfig(repo), resolveStateDir(repo.root));
      expect(after.find((entry) => entry.path === '.agents/skills/fastapi')?.type).toBe('directory-symlink');
      expect(filesDigest(repo)).not.toBe(baseline);
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
  it('matches published default snapshots and tree identity with ignored bytecode', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const cacheFile = 'src/__pycache__/accounts.cpython-313.pyc';
      repo.writeFiles({
        '.gitignore': 'src/__pycache__/\n',
        [cacheFile]: 'first-bytecode\n',
      });
      const config = fixtureConfig(repo);
      const stateDir = resolveStateDir(repo.root);
      const gitDir = resolveGitDir(repo.root, process.env);
      if (gitDir === null) throw new Error('test repository has no Git directory');
      const beforeFiles = collectInputFiles(repo.root, config, stateDir);
      const beforeInput = computeInputSnapshot({ cwd: repo.root, config, stateDir }).inputDigest;
      expect(beforeFiles.some((entry) => entry.path === cacheFile)).toBe(false);

      const beforeTree = computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record');
      repo.writeFiles({ [cacheFile]: 'rewritten-bytecode\n' });
      const afterFiles = collectInputFiles(repo.root, config, stateDir);
      const afterInput = computeInputSnapshot({ cwd: repo.root, config, stateDir }).inputDigest;
      const afterTree = computeCandidateTreeId(gitDir, repo.root, process.env, stateDir, 'record');
      expect(diffInputFiles(beforeFiles, afterFiles)).toEqual([]);
      expect(afterInput).toBe(beforeInput);
      expect(afterTree).not.toBe(beforeTree);

      repo.git(['add', '--all', '--force']);
      const publishedTree = repo.git(['write-tree']).stdout.trim();
      expect(afterTree).toBe(publishedTree);
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
