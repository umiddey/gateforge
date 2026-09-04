/**
 * Repo path expansion (project.paths include/exclude): determinism,
 * files-only, always-skip directories, exclude precedence, symlink
 * skipping (scan-scope integrity), fail-closed unreadable paths.
 */
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandIncludePaths } from '../src/glob.js';

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-glob-'));
  for (const [rel, content] of Object.entries(files)) {
    const absolute = join(root, ...rel.split('/'));
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

describe('expandIncludePaths', () => {
  it('expands globs to sorted repo-relative files only', () => {
    const root = tree({
      'src/a.txt': '',
      'src/sub/b.txt': '',
      'src/c.md': '',
      'README.md': '',
    });
    try {
      expect(expandIncludePaths(['src/**/*.txt'], [], root)).toEqual([
        'src/a.txt',
        'src/sub/b.txt',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('always skips .git and node_modules even when globs match them', () => {
    const root = tree({
      '.git/config': '',
      'node_modules/x/index.js': '',
      'src/app.js': '',
    });
    try {
      expect(expandIncludePaths(['**/*'], [], root)).toEqual(['src/app.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies excludes over includes and is deterministic', () => {
    const root = tree({
      'a.txt': '',
      'b.txt': '',
      'tests/b.txt': '',
    });
    try {
      const first = expandIncludePaths(['**/*.txt'], ['tests/**'], root);
      const second = expandIncludePaths(['**/*.txt'], ['tests/**'], root);
      expect(first).toEqual(second);
      expect(first).toEqual(['a.txt', 'b.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty for a glob that matches nothing', () => {
    const root = tree({ 'a.txt': '' });
    try {
      expect(expandIncludePaths(['missing/**'], [], root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
describe('expandIncludePaths fail-closed coverage (red-team F3)', () => {
  it('collects unreadable directories instead of silently dropping them', () => {
    const root = tree({ 'src/a.txt': '' });
    const hidden = join(root, 'src', 'guarded');
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, 'secret.txt'), 'x');
    chmodSync(hidden, 0o000);
    try {
      const errors: Array<{ path: string; detail: string }> = [];
      const files = expandIncludePaths(['src/**/*.txt'], [], root, errors);
      expect(files).toEqual(['src/a.txt']);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.path).toBe('src/guarded');
      expect(errors[0]?.detail).toContain('could not read directory');
    } finally {
      chmodSync(hidden, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('expandIncludePaths symlink scope integrity (phase 1)', () => {
  it('silently skips dangling symlinks and symlinked directories (never follows)', () => {
    const root = tree({
      'src/real.py': 'x = 1',
      'outside/ghost.py': 'y = 2',
    });
    // A dangling link (target does not exist): lstat succeeds, stat would
    // fail — the OLD behavior pushed an ExpandError and blocked the gate.
    symlinkSync(join(root, 'does-not-exist'), join(root, 'src', 'dangling.py'));
    // A symlinked DIRECTORY whose target matches the globs: the OLD
    // behavior recursed into it and scanned content outside the tree.
    symlinkSync(join(root, 'outside'), join(root, 'src', 'linked'));
    // A symlinked FILE matching the globs: never collected.
    symlinkSync(join(root, 'outside', 'ghost.py'), join(root, 'top-link.py'));
    try {
      const errors: Array<{ path: string; detail: string }> = [];
      // 'outside/ghost.py' is excluded from the scan directly, so the
      // ONLY way it could appear is by wrongly following 'src/linked'.
      const files = expandIncludePaths(['**/*.py'], ['outside/**'], root, errors);
      expect(files).toEqual(['src/real.py']);
      expect(errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
