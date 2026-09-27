import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, withTempRepo, type RuntimeConfig } from '@gate-forge/core';
import { describe, expect, it } from 'vitest';
import type { Io } from '../src/io.js';
import { collectInputFiles } from '../src/input-snapshot.js';
import { prepareRuntime, runtimeReuseDigest } from '../src/runtime.js';
import { digestRuntimeReuseMounts } from '../src/runtime-reuse.js';
import { resolveStateDir } from '../src/state.js';
import { computeCandidateTreeId, resolveGitDir } from '../src/candidate-tree.js';
import { installFixture } from './helpers.js';

describe('staged runtime reuse and input snapshot boundary', () => {
  it('accepts ignored root and nested dependency links without snapshotting external links', async () => {
    await withTempRepo({}, async (repo) => {
      const scratchRoot = mkdtempSync(join(tmpdir(), 'gateforge-reuse-snapshot-'));
      const checkoutRoot = join(scratchRoot, 'checkout');
      try {
        installFixture(repo, { include: "['src/**/*.txt','e2e/**/*.js']" });
        repo.writeFiles({
          '.gitignore': 'node_modules/\ne2e/node_modules/\n',
          '.gateforge/runtime.yml': `schemaVersion: 1
prepare:
  reuse:
    - node_modules
    - e2e/node_modules
`,
          '.gateforge.yml': `${readFileSync(join(repo.root, '.gateforge.yml'), 'utf8').replace('exclude: []', "exclude: ['**/node_modules/**']")}runtime: .gateforge/runtime.yml\n`,
          'e2e/spec.js': '// the runtime scans the nested test tree\n',
        });
        repo.stage();
        repo.commit('reuse fixture');
        cpSync(repo.root, checkoutRoot, { recursive: true });

        mkdirSync(join(repo.root, 'node_modules', 'dep'), { recursive: true });
        mkdirSync(join(repo.root, 'e2e', 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(repo.root, 'node_modules', 'dep', 'index.js'), 'export const root = true;\n');
        writeFileSync(join(repo.root, 'e2e', 'node_modules', 'dep', 'index.js'), 'export const nested = true;\n');

        const runtime: RuntimeConfig = {
          schemaVersion: 1,
          prepare: { reuse: ['node_modules', 'e2e/node_modules'] },
        };
        const io: Io = {
          cwd: repo.root,
          env: process.env,
          stdout: process.stdout,
          stderr: process.stderr,
        };
        const prepared = await prepareRuntime(repo.root, checkoutRoot, runtime, io, join(checkoutRoot, '.state'));

        expect(prepared.reuseDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(lstatSync(join(checkoutRoot, 'node_modules')).isSymbolicLink()).toBe(true);
        expect(lstatSync(join(checkoutRoot, 'e2e', 'node_modules')).isSymbolicLink()).toBe(true);
        const config = loadConfig(join(checkoutRoot, '.gateforge.yml'));
        const files = collectInputFiles(checkoutRoot, config, resolveStateDir(checkoutRoot), prepared.reuseMounts);
        expect(files.some((entry) => entry.path.startsWith('node_modules/'))).toBe(false);
        expect(files.some((entry) => entry.path.startsWith('e2e/node_modules/'))).toBe(false);

        const sourceCopy = join(scratchRoot, 'source-copy');
        const checkoutCopy = join(scratchRoot, 'checkout-copy');
        cpSync(repo.root, sourceCopy, { recursive: true });
        rmSync(join(sourceCopy, 'node_modules'), { recursive: true, force: true });
        rmSync(join(sourceCopy, 'e2e', 'node_modules'), { recursive: true, force: true });
        cpSync(sourceCopy, checkoutCopy, { recursive: true });
        mkdirSync(join(sourceCopy, 'node_modules', 'dep'), { recursive: true });
        mkdirSync(join(sourceCopy, 'e2e', 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(sourceCopy, 'node_modules', 'dep', 'index.js'), 'export const root = true;\n');
        writeFileSync(join(sourceCopy, 'e2e', 'node_modules', 'dep', 'index.js'), 'export const nested = true;\n');
        const preparedCopy = await prepareRuntime(
          sourceCopy,
          checkoutCopy,
          runtime,
          io,
          join(checkoutCopy, '.state'),
        );
        const gitDir = resolveGitDir(checkoutRoot, process.env);
        const gitDirCopy = resolveGitDir(checkoutCopy, process.env);
        expect(gitDir).not.toBeNull();
        expect(gitDirCopy).not.toBeNull();
        expect(
          computeCandidateTreeId(gitDir as string, checkoutRoot, process.env, resolveStateDir(checkoutRoot), 'record', prepared.reuseMounts),
        ).toBe(
          computeCandidateTreeId(
            gitDirCopy as string,
            checkoutCopy,
            process.env,
            resolveStateDir(checkoutCopy),
            'record',
            preparedCopy.reuseMounts,
          ),
        );
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true });
      }
    });
  });

  it('rejects a broken link beneath a declared reuse root', async () => {
    await withTempRepo({}, async (repo) => {
      const scratchRoot = mkdtempSync(join(tmpdir(), 'gateforge-reuse-escape-'));
      try {
        mkdirSync(join(repo.root, 'node_modules'), { recursive: true });
        symlinkSync(join(scratchRoot, 'missing'), join(repo.root, 'node_modules', 'broken'), 'dir');
        const runtime: RuntimeConfig = { schemaVersion: 1, prepare: { reuse: ['node_modules'] } };
        expect(() => runtimeReuseDigest(repo.root, runtime)).toThrow(/broken or unreadable/);
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true });
      }
    });
  });

  it('does not include absolute workspace paths in the reuse digest', async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'gateforge-reuse-stable-'));
    try {
      const firstRoot = join(scratchRoot, 'first');
      const secondRoot = join(scratchRoot, 'second');
      for (const root of [firstRoot, secondRoot]) {
        mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'export const same = true;\n');
      }
      const runtime: RuntimeConfig = { schemaVersion: 1, prepare: { reuse: ['node_modules'] } };
      expect(runtimeReuseDigest(firstRoot, runtime)).toBe(runtimeReuseDigest(secondRoot, runtime));
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('detects dependency mutation and rejects a retargeted mount', async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'gateforge-reuse-mutation-'));
    const sourceRoot = join(scratchRoot, 'source');
    const checkoutRoot = join(scratchRoot, 'checkout');
    try {
      mkdirSync(join(sourceRoot, 'node_modules', 'dep'), { recursive: true });
      mkdirSync(checkoutRoot, { recursive: true });
      writeFileSync(join(sourceRoot, 'node_modules', 'dep', 'index.js'), 'export const value = 1;\n');
      const runtime: RuntimeConfig = { schemaVersion: 1, prepare: { reuse: ['node_modules'] } };
      const prepared = await prepareRuntime(
        sourceRoot,
        checkoutRoot,
        runtime,
        { env: process.env } as Io,
        join(checkoutRoot, '.state'),
      );
      const before = digestRuntimeReuseMounts(prepared.reuseMounts);
      writeFileSync(join(sourceRoot, 'node_modules', 'dep', 'index.js'), 'export const value = 2;\n');
      expect(digestRuntimeReuseMounts(prepared.reuseMounts)).not.toBe(before);
      const outside = join(scratchRoot, 'outside');
      mkdirSync(outside, { recursive: true });
      unlinkSync(join(checkoutRoot, 'node_modules'));
      symlinkSync(outside, join(checkoutRoot, 'node_modules'), 'dir');
      expect(() => digestRuntimeReuseMounts(prepared.reuseMounts)).toThrow(/no longer points to its approved source/);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('still rejects an undeclared external input symlink', async () => {
    await withTempRepo({}, async (repo) => {
      const scratchRoot = mkdtempSync(join(tmpdir(), 'gateforge-reuse-unapproved-'));
      try {
        installFixture(repo);
        const outsideFile = join(scratchRoot, 'outside.txt');
        writeFileSync(outsideFile, 'not an approved dependency\n');
        mkdirSync(join(repo.root, 'src'), { recursive: true });
        symlinkSync(outsideFile, join(repo.root, 'src', 'escape.txt'));
        const config = loadConfig(join(repo.root, '.gateforge.yml'));
        expect(() => collectInputFiles(repo.root, config, resolveStateDir(repo.root))).toThrow(/escaping the repository/);
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true });
      }
    });
  });
});
