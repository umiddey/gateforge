/**
 * Opt-in block rendering (R1-4): the alembic.ini may live at the
 * repository root OR in a first-level subdirectory (the
 * backend/ monorepo layout). `%(here)s` in `script_location`
 * anchors to the ini's own directory, and every printed path is
 * relative to the repository root. Dependency/build/VCS/test
 * directories are never searched.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectAlembicVersionsDir, renderAlembicOptIn } from '../src/index.js';

/** A temp repo root holding the given files. */
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-alembic-opt-in-'));
  for (const [rel, text] of Object.entries(files)) {
    const absolute = join(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, 'utf8');
  }
  return root;
}

/** Runs the assertions, then removes the temp repo. */
function withRepo(files: Record<string, string>, run: (root: string) => void): void {
  const root = makeRepo(files);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('detectAlembicVersionsDir finds the ini at the root or one level down', () => {
  it('resolves a first-level backend alembic.ini with %(here)s to a root-relative versions dir', () => {
    withRepo(
      {
        'backend/alembic.ini': '[alembic]\nscript_location = %(here)s/alembic_migrations\n',
      },
      (root) => {
        expect(detectAlembicVersionsDir(root)).toBe('backend/alembic_migrations/versions');
        const text = renderAlembicOptIn(root);
        expect(text).toContain('migrations: backend/alembic_migrations/versions');
        expect(text).toContain('alembicIni: backend/alembic.ini');
      },
    );
  });

  it('a root alembic.ini keeps its root-relative location (unchanged)', () => {
    withRepo(
      {
        'alembic.ini': '[alembic]\nscript_location = alembic_migrations\n',
      },
      (root) => {
        expect(detectAlembicVersionsDir(root)).toBe('alembic_migrations/versions');
        const text = renderAlembicOptIn(root);
        expect(text).toContain('migrations: alembic_migrations/versions');
        expect(text).toContain('alembicIni: alembic.ini');
      },
    );
  });

  it('prefers the root ini when a subdirectory also has one', () => {
    withRepo(
      {
        'alembic.ini': '[alembic]\nscript_location = root_migrations\n',
        'backend/alembic.ini': '[alembic]\nscript_location = %(here)s/backend_migrations\n',
      },
      (root) => {
        expect(detectAlembicVersionsDir(root)).toBe('root_migrations/versions');
      },
    );
  });

  it('skips node_modules, .git, and test/tests directories', () => {
    withRepo(
      {
        'node_modules/alembic.ini': '[alembic]\nscript_location = nm\n',
        '.git/alembic.ini': '[alembic]\nscript_location = git\n',
        'test/alembic.ini': '[alembic]\nscript_location = test\n',
        'tests/alembic.ini': '[alembic]\nscript_location = tests\n',
      },
      (root) => {
        expect(detectAlembicVersionsDir(root)).toBeNull();
        expect(renderAlembicOptIn(root)).toBeNull();
      },
    );
  });

  it('returns null without an alembic.ini anywhere', () => {
    withRepo(
      { 'README.md': 'no migrations here\n' },
      (root) => {
        expect(detectAlembicVersionsDir(root)).toBeNull();
        expect(renderAlembicOptIn(root)).toBeNull();
      },
    );
  });
});
