import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLineage } from '../src/execute.js';

const pythonPath = [fileURLToPath(new URL('../python/', import.meta.url))];

describe('Alembic AST lineage scanner', () => {
  it('reads annotated revision constants and tuple parents without importing scripts', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gf-alembic-scan-'));
    try {
      const versions = join(cwd, 'migrations');
      mkdirSync(versions);
      writeFileSync(join(versions, 'a.py'), `revision: str = 'a1'\ndown_revision: str | None = None\ndef upgrade():\n    pass\ndef downgrade():\n    op.drop_table('x')\n`);
      writeFileSync(join(versions, 'b.py'), `revision: str = 'b2'\ndown_revision: tuple[str, ...] = ('a1',)\ndef upgrade():\n    raise RuntimeError('must not execute')\ndef downgrade():\n    ...\n`);
      const result = scanLineage(cwd, ['migrations'], 'python3', pythonPath);
      expect(result.migrations.map(({ revision, downRevisions }) => ({ revision, downRevisions }))).toEqual([
        { revision: 'a1', downRevisions: [] },
        { revision: 'b2', downRevisions: ['a1'] },
      ]);
      expect(result.heads).toEqual(['b2']);
      expect(result.migrations[1]?.downgradeNoop).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reports duplicate ids, dangling parents, and multiple heads with canonical file locations', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gf-alembic-lineage-'));
    try {
      mkdirSync(join(cwd, 'versions'));
      writeFileSync(join(cwd, 'versions/a.py'), `revision = 'same'\ndown_revision = None\n`);
      writeFileSync(join(cwd, 'versions/b.py'), `revision = 'same'\ndown_revision = None\n`);
      writeFileSync(join(cwd, 'versions/c.py'), `revision = 'other'\ndown_revision = None\n`);
      writeFileSync(join(cwd, 'versions/d.py'), `revision = 'dangling'\ndown_revision = 'missing'\n`);
      const result = scanLineage(cwd, ['versions'], 'python3', pythonPath);
      expect(result.findings.map(({ code }) => code).sort()).toEqual([
        'DANGLING_DOWN_REVISION', 'DUPLICATE_REVISION_ID', 'MULTIPLE_MIGRATION_HEADS',
      ]);
      expect(result.findings.every(({ locations }) => locations.every((location) =>
        typeof location.file === 'string' && typeof location.line === 'number' && typeof location.col === 'number'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
