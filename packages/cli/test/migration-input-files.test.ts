/** Regression: Python bytecode under an Alembic versions directory is never an input. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationInputFiles } from '../src/input-snapshot.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('migrationInputFiles', () => {
  it('lists migration sources but not the bytecode Alembic writes when it imports them', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-migration-inputs-'));
    roots.push(root);
    mkdirSync(join(root, 'migrations/versions/__pycache__'), { recursive: true });
    writeFileSync(join(root, 'migrations/versions/001_create_invoices.py'), 'revision = "001"\n');
    writeFileSync(join(root, 'migrations/versions/__pycache__/001_create_invoices.cpython-312.pyc'), 'bytecode');
    writeFileSync(join(root, 'migrations/versions/stray.pyc'), 'bytecode');
    expect(migrationInputFiles(root, 'migrations/versions')).toEqual(['migrations/versions/001_create_invoices.py']);
  });
});
