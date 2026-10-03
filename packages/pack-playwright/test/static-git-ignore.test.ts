/**
 * Git-ignored files never become STATIC discovery rows (defect K4).
 *
 * A frontend build writes a minified, git-IGNORED bundle into the tree
 * (`backend/app/frontend/assets/*.js` in the FastAPI full-stack
 * template). `test(`-shaped calls inside it were scanned as tests,
 * produced rows the runner can never enumerate, and each one sealed as a
 * permanent `unenumeratedReason` gap — so the run could never reach
 * `inventoryComplete` even with every real test passing.
 *
 * Covered here:
 * - a git work tree: an ignored `dist/` bundle yields no static row,
 *   while the tracked spec beside it is scanned normally;
 * - untracked-but-NOT-ignored files are still planned (a new spec not
 *   yet committed must reach the plan);
 * - a TRACKED file matching an ignore pattern is still scanned and
 *   still fail-closed as an unresolved row;
 * - outside a work tree (plain fixture dirs, no git) every candidate is
 *   kept exactly as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanTestFiles, type StaticScanResult } from '../src/discovery/index.js';

/** Temp dirs to remove after each test. */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes a file tree (repo-relative posix keys) into a fresh temp dir. */
function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-gitignore-'));
  tempDirs.push(root);
  for (const [key, content] of Object.entries(files)) {
    const absolute = join(root, key);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

/** Runs one git command against `root`, failing the test on a non-zero exit. */
function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
}

/** Commits the current tree as `fixture` in an initialized work tree. */
function initGitRepo(root: string): void {
  git(root, ['init', '-q', '.']);
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']);
}

/** A resolvable spec (its `test` binding is provable through the import). */
const TRACKED_SPEC = [
  "import { test, expect } from '@playwright/test';",
  "test('real journey', async () => {",
  '  expect(1).toBe(1);',
  '});',
].join('\n');

/** A minified-bundle shape: a bare `test(` call with no module-scope binding. */
const BUNDLE_SHAPE = 'test("sort by name",function(){return 1});export{test as t};';
/** The distinct files the scan reported as unresolved, sorted. */
function unresolvedFiles(scan: StaticScanResult): string[] {
  return [...new Set(scan.unresolved.map((row) => row.file))].sort();
}

/** Every file the scan read, sorted. */
function scannedFiles(scan: StaticScanResult): string[] {
  return [...scan.scannedFiles].sort();
}

describe('static discovery inside a git work tree', () => {
  it('never plans a row from a git-ignored bundle (the K4 defect)', () => {
    const root = makeProject({
      '.gitignore': 'backend/app/frontend/\n',
      'tests/tracked.spec.ts': TRACKED_SPEC,
      'backend/app/frontend/assets/Bundle-abc123.js': BUNDLE_SHAPE,
    });
    initGitRepo(root);

    const scan = scanTestFiles({ cwd: root, include: ['**/*.ts', '**/*.js'], exclude: [] });

    expect(scannedFiles(scan)).toEqual(['tests/tracked.spec.ts']);
    expect(scan.entries.map((entry) => entry.title)).toEqual(['real journey']);
    expect(unresolvedFiles(scan)).toEqual([]);
  });

  it('still plans an untracked, NOT-ignored spec (a new uncommitted spec)', () => {
    const root = makeProject({
      '.gitignore': 'backend/app/frontend/\n',
      'tests/tracked.spec.ts': TRACKED_SPEC,
    });
    initGitRepo(root);
    // Written AFTER the commit: untracked, but not ignored.
    writeFileSync(join(root, 'tests/brand-new.spec.ts'), TRACKED_SPEC.replace('real journey', 'brand new journey'), 'utf8');

    const scan = scanTestFiles({ cwd: root, include: ['**/*.ts', '**/*.js'], exclude: [] });

    expect(scannedFiles(scan)).toEqual(['tests/brand-new.spec.ts', 'tests/tracked.spec.ts']);
    expect(scan.unresolved).toEqual([]);
  });

  it('still fail-closes a TRACKED file that matches an ignore pattern', () => {
    const root = makeProject({
      '.gitignore': 'tests/*.spec.ts\n',
      'tests/committed.spec.ts': BUNDLE_SHAPE,
    });
    // Force-add the ignored file so it is genuinely TRACKED: `git
    // check-ignore` never reports tracked files, so it must still be
    // scanned and still fail closed as unresolved.
    initGitRepo(root);
    git(root, ['add', '-f', 'tests/committed.spec.ts']);
    git(root, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qam', 'forced']);

    const scan = scanTestFiles({ cwd: root, include: ['**/*.ts', '**/*.js'], exclude: [] });

    expect(scannedFiles(scan)).toEqual(['tests/committed.spec.ts']);
    expect(unresolvedFiles(scan)).toEqual(['tests/committed.spec.ts']);
  });
});

describe('static discovery outside a git work tree (unchanged behavior)', () => {
  it('keeps every candidate file, ignore patterns notwithstanding', () => {
    const root = makeProject({
      '.gitignore': 'backend/app/frontend/\n',
      'tests/tracked.spec.ts': TRACKED_SPEC,
      'backend/app/frontend/assets/Bundle-abc123.js': BUNDLE_SHAPE,
    });
    // No `git init`: this directory is not a work tree, so there are no
    // ignore rules to consult and the scan must behave exactly as before.

    const scan = scanTestFiles({ cwd: root, include: ['**/*.ts', '**/*.js'], exclude: [] });

    expect(scannedFiles(scan)).toEqual(['backend/app/frontend/assets/Bundle-abc123.js', 'tests/tracked.spec.ts']);
    expect(unresolvedFiles(scan)).toEqual(['backend/app/frontend/assets/Bundle-abc123.js']);
  });
});