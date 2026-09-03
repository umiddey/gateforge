/**
 * Repo path expansion (project.paths include/exclude): determinism,
 * files-only, always-skip directories, exclude precedence.
 */
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
