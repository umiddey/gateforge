/**
 * Candidate-tree ingestion: the fast in-process path.
 *
 * Two properties are load-bearing and are proven here against the FROZEN
 * per-file reference in `candidate-tree-legacy.ts`:
 *
 * 1. Byte identity — for the same workspace bytes the in-process path
 *    produces exactly the tree id the per-file `git hash-object` /
 *    `git mktree` path produced, with identical fail-closed messages.
 * 2. Bounded spawns — the cost of ingestion is hashing and writing, not
 *    process spawning, so the number of `git` children must not grow
 *    with the number of files.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { describe, expect, it } from 'vitest';
import { computeCandidateTreeId, computeCandidateTreeSnapshot, resolveGitDir } from '../src/candidate-tree.js';
import { computeCandidateTreeIdLegacy, computeCandidateTreeSnapshotLegacy } from './candidate-tree-legacy.js';
import type { RuntimeReuseMount } from '../src/runtime-reuse.js';

/** Absolute path of this repository's checkout (`packages/cli/test`'s grandparent). */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 1.5 MB of deterministic content (a large blob, not a small one). */
const LARGE_BLOB = Buffer.alloc(1_500_000);
for (let index = 0; index < LARGE_BLOB.length; index += 1) LARGE_BLOB[index] = (index * 31) % 251;

/**
 * The mixed fixture the byte-identity property is proven on: nested
 * directories, an executable bit, symlinks, gitignored files, a
 * node_modules-like deep tree, an empty file, a large file, non-ASCII
 * and space-containing names, names that sort differently with and
 * without Git's trailing-slash rule, and an empty directory.
 */
function writeMixedFixture(repo: TempRepo): void {
  repo.writeFiles({
    '.gitignore': 'ignored/\n*.log\n',
    'README.md': '# mixed fixture\n',
    'src/app/main.ts': 'export const main = true;\n',
    'src/app/util/deep/nested.ts': 'export const nested = true;\n',
    'bin/run.sh': '#!/bin/sh\nexit 0\n',
    'bin/plain': 'not executable\n',
    'empty.txt': '',
    'docs/café.md': '# accents\n',
    '日本/語.md': '# japanese\n',
    'my dir/file with space.txt': 'spaces\n',
    'node_modules/pkg-a/lib/deep/index.js': 'module.exports = 1;\n',
    'node_modules/.bin/tool': 'binary\n',
    'ignored/secret.txt': 'ignored but hashed\n',
    'debug.log': 'ignored log\n',
    // Trailing-slash rule discriminators: the blob `a!/bang.txt` sorts
    // BEFORE the directory `a` under Git's rule (0x21 < 0x2F) but after
    // it under a plain name sort; `a~/tilde.txt` sorts after under both.
    'a!/bang.txt': 'bang\n',
    'a-b.txt': 'dash\n',
    'a.b.txt': 'dot\n',
    'a~/tilde.txt': 'tilde\n',
    'a/inside.txt': 'inside a\n',
    'a.d/inside.txt': 'inside a.d\n',
    'links/target.txt': 'target\n',
  });
  writeFileSync(join(repo.root, 'large.bin'), LARGE_BLOB);
  mkdirSync(join(repo.root, 'empty-dir'), { recursive: true });
  chmodSync(join(repo.root, 'bin', 'run.sh'), 0o755);
  chmodSync(join(repo.root, 'node_modules', '.bin', 'tool'), 0o755);
  symlinkSync('target.txt', join(repo.root, 'links', 'shortcut'));
  symlinkSync('../a b/c', join(repo.root, 'links', '日本語 link'));
}

/** Writes `count` more files under one nested level in the repository. */
function writeManyFiles(repo: TempRepo, count: number): void {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) files[`pkg/file-${index}.txt`] = `content ${index}\n`;
  repo.writeFiles(files);
}

/** A `git` wrapper on PATH that records every invocation and forwards to the real binary. */
function gitSpawnCounter(): { dir: string; log: string; env: NodeJS.ProcessEnv } {
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  if (realGit.length === 0) throw new Error('cannot locate the real git binary for the spawn counter');
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-git-counter-'));
  const log = join(dir, 'spawns.log');
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GIT_SPAWN_LOG"\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  );
  return { dir, log, env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}`, GIT_SPAWN_LOG: log } };
}

/** Number of `git` processes recorded so far. */
function spawnCount(counter: { log: string }): number {
  if (!existsSync(counter.log)) return 0;
  return readFileSync(counter.log, 'utf8').split('\n').filter((line) => line.length > 0).length;
}

/** Runs `body` with a fresh spawn log and the counting `git` first on PATH. */
function counting<T>(
  counter: { dir: string; log: string; env: NodeJS.ProcessEnv },
  body: (env: NodeJS.ProcessEnv) => T,
): T {
  rmSync(counter.log, { force: true });
  return body(counter.env);
}

/** The message the ingestion path fails with, or the empty string. */
function ingestionMessage(compute: typeof computeCandidateTreeIdLegacy, ...args: Parameters<typeof computeCandidateTreeIdLegacy>): string {
  try {
    compute(...args);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('candidate tree ingestion computes the same id in process as it did one git spawn per file', () => {
  it('produces the reference tree id on a mixed workspace and leaves the objects readable by git', () => {
    withTempRepo({}, (repo) => {
      writeMixedFixture(repo);
      const gitDir = resolveGitDir(repo.root, process.env);
      if (gitDir === null) throw new Error('test repository has no Git directory');
      const reference = computeCandidateTreeIdLegacy(gitDir, repo.root, process.env, null, 'record');
      const fast = computeCandidateTreeId(gitDir, repo.root, process.env, null, 'record');
      expect(fast).toBe(reference);
      // The objects are real: git walks the tree this path wrote.
      const walked = repo.git(['--git-dir', gitDir, 'ls-tree', '-r', fast]);
      expect(walked.status).toBe(0);
      expect(walked.stdout).toContain('100755 blob');
      expect(walked.stdout).toContain('120000 blob');
      expect(walked.stdout).toContain('large.bin');
      expect(repo.git(['--git-dir', gitDir, 'cat-file', '-t', fast]).stdout.trim()).toBe('tree');
      const fromReference = repo.git(['--git-dir', gitDir, 'ls-tree', '-r', reference]);
      expect(walked.stdout).toBe(fromReference.stdout);
    });
  });

  it('records the same entries in the snapshot', () => {
    withTempRepo({}, (repo) => {
      writeMixedFixture(repo);
      const gitDir = resolveGitDir(repo.root, process.env);
      if (gitDir === null) throw new Error('test repository has no Git directory');
      const reference = computeCandidateTreeSnapshotLegacy(gitDir, repo.root, process.env, null, 'record');
      const fast = computeCandidateTreeSnapshot(gitDir, repo.root, process.env, null, 'record');
      expect(fast.treeId).toBe(reference.treeId);
      expect(fast.entries).toEqual(reference.entries);
    });
  });

  it('honours the state, documentation, and bytecode exclusions', () => {
    withTempRepo({}, (repo) => {
      writeMixedFixture(repo);
      repo.writeFiles({
        '.gateforge/test-gates/report.json': '{"ignored":true}\n',
        'vendor/__pycache__/mod.cpython-312.pyc': 'bytecode\n',
        'docs/generated/auto.md': '# generated\n',
      });
      const gitDir = resolveGitDir(repo.root, process.env);
      if (gitDir === null) throw new Error('test repository has no Git directory');
      const stateDir = join(repo.root, '.gateforge', 'test-gates');
      const options = [
        stateDir,
        'record',
        [],
        ['docs/generated'],
        ['vendor/__pycache__/mod.cpython-312.pyc'],
      ] as const;
      const reference = computeCandidateTreeIdLegacy(gitDir, repo.root, process.env, ...options);
      const fast = computeCandidateTreeId(gitDir, repo.root, process.env, ...options);
      expect(fast).toBe(reference);
      const entries = computeCandidateTreeSnapshot(gitDir, repo.root, process.env, ...options).entries;
      expect(entries.some((entry) => entry.path.startsWith('.gateforge/'))).toBe(false);
      expect(entries.some((entry) => entry.path.startsWith('docs/generated/'))).toBe(false);
      expect(entries.some((entry) => entry.path.endsWith('.pyc'))).toBe(false);
    });
  });

  it('binds an approved runtime reuse mount to the same marker blob', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gateforge-reuse-mount-'));
    try {
      withTempRepo({}, (repo) => {
        const ownerRoot = join(scratch, 'owner');
        mkdirSync(join(ownerRoot, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(ownerRoot, 'node_modules', 'dep', 'index.js'), 'export const dep = true;\n');
        writeFileSync(join(repo.root, 'src.ts'), 'export const src = true;\n');
        symlinkSync(join(ownerRoot, 'node_modules'), join(repo.root, 'node_modules'));
        const mounts: RuntimeReuseMount[] = [
          { path: 'node_modules', checkoutRoot: repo.root, ownerRoot, sourceRoot: join(ownerRoot, 'node_modules') },
        ];
        const gitDir = resolveGitDir(repo.root, process.env);
        if (gitDir === null) throw new Error('test repository has no Git directory');
        const reference = computeCandidateTreeIdLegacy(gitDir, repo.root, process.env, null, 'record', mounts);
        const fast = computeCandidateTreeId(gitDir, repo.root, process.env, null, 'record', mounts);
        expect(fast).toBe(reference);
        const entries = computeCandidateTreeSnapshot(gitDir, repo.root, process.env, null, 'record', mounts).entries;
        expect(entries.find((entry) => entry.path === 'node_modules')?.mode).toBe('120000');
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed with the reference messages on a symlink, a nested .git, and a fifo', () => {
    withTempRepo({}, (repo) => {
      const gitDir = resolveGitDir(repo.root, process.env);
      if (gitDir === null) throw new Error('test repository has no Git directory');
      const message = (compute: typeof computeCandidateTreeId): string =>
        ingestionMessage(compute as typeof computeCandidateTreeIdLegacy, gitDir, repo.root, process.env, null, 'reject');
      const referenceMessage = (): string => message(computeCandidateTreeIdLegacy as typeof computeCandidateTreeId);

      writeFileSync(join(repo.root, 'plain.txt'), 'plain\n');
      symlinkSync('plain.txt', join(repo.root, 'shortcut'));
      expect(message(computeCandidateTreeId)).toBe(referenceMessage());
      expect(message(computeCandidateTreeId)).toContain("symlink at 'shortcut'");
      rmSync(join(repo.root, 'shortcut'));

      mkdirSync(join(repo.root, 'submodule', '.git'), { recursive: true });
      writeFileSync(join(repo.root, 'submodule', '.git', 'config'), '[core]\n');
      expect(message(computeCandidateTreeId)).toBe(referenceMessage());
      expect(message(computeCandidateTreeId)).toContain("nested '.git' at 'submodule/.git'");
      rmSync(join(repo.root, 'submodule'), { recursive: true, force: true });

      if (spawnSync('mkfifo', [join(repo.root, 'pipe.fifo')]).status !== 0) {
        throw new Error('cannot create the fifo fixture');
      }
      expect(message(computeCandidateTreeId)).toBe(referenceMessage());
      expect(message(computeCandidateTreeId)).toContain("unsupported entry at 'pipe.fifo'");
    });
  });

  it('rejects a runtime reuse link that no longer matches its approved source, like the reference does', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gateforge-reuse-drift-'));
    try {
      withTempRepo({}, (repo) => {
        const ownerRoot = join(scratch, 'owner');
        mkdirSync(join(ownerRoot, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(ownerRoot, 'node_modules', 'dep', 'index.js'), 'export const dep = true;\n');
        symlinkSync(join(scratch, 'elsewhere'), join(repo.root, 'node_modules'));
        const mounts: RuntimeReuseMount[] = [
          { path: 'node_modules', checkoutRoot: repo.root, ownerRoot, sourceRoot: join(ownerRoot, 'node_modules') },
        ];
        const gitDir = resolveGitDir(repo.root, process.env);
        if (gitDir === null) throw new Error('test repository has no Git directory');
        const message = (compute: typeof computeCandidateTreeId): string =>
          ingestionMessage(
            compute as typeof computeCandidateTreeIdLegacy,
            gitDir,
            repo.root,
            process.env,
            null,
            'record',
            mounts,
          );
        expect(message(computeCandidateTreeId)).toBe(
          message(computeCandidateTreeIdLegacy as typeof computeCandidateTreeId),
        );
        expect(message(computeCandidateTreeId)).toContain('runtime reuse mount');
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('spawns a bounded number of git processes whatever the file count', () => {
    const counter = gitSpawnCounter();
    try {
      withTempRepo({}, (repo) => {
        writeManyFiles(repo, 20);
        const gitDir = resolveGitDir(repo.root, process.env);
        if (gitDir === null) throw new Error('test repository has no Git directory');
        const small = counting(counter, (env) => {
          computeCandidateTreeId(gitDir, repo.root, env, null, 'record');
          return spawnCount(counter);
        });
        writeManyFiles(repo, 400);
        const large = counting(counter, (env) => {
          computeCandidateTreeId(gitDir, repo.root, env, null, 'record');
          return spawnCount(counter);
        });
        const reference = counting(counter, (env) => {
          computeCandidateTreeIdLegacy(gitDir, repo.root, env, null, 'record');
          return spawnCount(counter);
        });
        // Constant in the file count: the object store and the built
        // tree are verified once, then everything is hashed in process.
        expect(large).toBe(small);
        expect(large).toBeLessThanOrEqual(3);
        // And no longer proportional to it, which is exactly what the
        // per-file reference spent its processes on.
        expect(reference).toBeGreaterThan(400);
        expect(reference).toBeGreaterThan(large * 100);
      });
    } finally {
      rmSync(counter.dir, { recursive: true, force: true });
    }
  });

  it('computes this repository checkout to the reference tree id', { timeout: 600_000 }, () => {
    const workspace = resolve(REPOSITORY_ROOT);
    const scratch = mkdtempSync(join(tmpdir(), 'gateforge-self-tree-'));
    const initialized = spawnSync('git', ['init', '--quiet', '--bare', scratch], { encoding: 'utf8' });
    if (initialized.status !== 0) {
      throw new Error(`cannot create the scratch object store: ${initialized.stderr}`);
    }
    try {
      const reference = computeCandidateTreeIdLegacy(scratch, workspace, process.env, null, 'record');
      const fast = computeCandidateTreeId(scratch, workspace, process.env, null, 'record');
      expect(fast).toBe(reference);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('writes into the common object store of a linked worktree', () => {
    withTempRepo({}, (repo) => {
      writeMixedFixture(repo);
      repo.stage();
      repo.commit('mixed fixture');
      const linked = mkdtempSync(join(tmpdir(), 'gateforge-linked-wt-'));
      rmSync(linked, { recursive: true, force: true });
      repo.git(['worktree', 'add', '--quiet', linked, '-b', 'linked']);
      try {
        const linkedGitDir = spawnSync('git', ['-C', linked, 'rev-parse', '--absolute-git-dir'], {
          encoding: 'utf8',
        }).stdout.trim();
        const tree = computeCandidateTreeId(linkedGitDir, linked, process.env, null, 'record');
        // Readable through the worktree's own git dir, which is not where
        // the objects live: a linked worktree shares the common store.
        const kind = spawnSync(
          'git',
          ['--git-dir', linkedGitDir, '--no-replace-objects', 'cat-file', '-t', tree],
          { encoding: 'utf8' },
        );
        expect(kind.stdout.trim()).toBe('tree');
        expect(computeCandidateTreeIdLegacy(linkedGitDir, linked, process.env, null, 'record')).toBe(tree);
      } finally {
        repo.git(['worktree', 'remove', '--force', linked], { allowFailure: true });
        rmSync(linked, { recursive: true, force: true });
      }
    });
  });
});
