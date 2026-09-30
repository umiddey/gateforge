/**
 * The `init` repository scan recognises a SQLModel table whose base is
 * declared through ANOTHER class.
 *
 * The canonical FastAPI template — the repository class this product
 * exists for — writes its models as
 *
 *     class UserBase(SQLModel):
 *         email: str = Field(unique=True, index=True)
 *
 *     class User(UserBase, table=True):
 *         id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
 *
 * The needle only matched `SQLModel` written literally in the class
 * head, so this shape produced NO `sqlalchemy` signal at all: `init`
 * recommended `pack-fastapi, pack-http` and never `pack-sqlalchemy`, the
 * one pack whose proof channel the whole persistence layer needs.
 *
 * Pinned here, for both resolutions the brief names:
 *   - the base class in the SAME module (the template's own layout);
 *   - the base IMPORTED from a module that imports sqlmodel.
 *
 * A `table=True` class whose base chain never reaches SQLModel stays
 * invisible — a non-model is never promoted by this rule.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo } from '@gate-forge/core';
import { join } from 'node:path';
import { runCli } from './helpers.js';

/** The template's own model module (bases and tables in one file). */
const TEMPLATE_MODELS = [
  'import uuid',
  '',
  'from sqlmodel import Field, SQLModel',
  '',
  '',
  'class UserBase(SQLModel):',
  '    email: str = Field(unique=True, index=True, max_length=255)',
  '',
  '',
  'class User(UserBase, table=True):',
  '    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)',
  '',
].join('\n');

/** The same shape with the base class in an imported module. */
const IMPORTED_BASE = [
  'from sqlmodel import Field, SQLModel',
  '',
  '',
  'class ItemBase(SQLModel):',
  '    title: str = Field(min_length=1)',
  '',
].join('\n');

/** The consumer module importing that base across files. */
const IMPORTED_MODEL = [
  'from sqlmodel import Field',
  '',
  'from app.base import ItemBase',
  '',
  '',
  'class Item(ItemBase, table=True):',
  '    id: int = Field(default=None, primary_key=True)',
  '',
].join('\n');

/** The `init` stdout signals/recommendation facts for a repo. */
async function initScan(repo: Parameters<typeof runCli>[0]): Promise<{ code: number; stdout: string }> {
  return runCli(repo, ['init']);
}

describe('init scan: a table=True class whose base chain reaches SQLModel', () => {
  it('detects the base class declared in the same module (the template shape)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/app/main.py': ['from fastapi import FastAPI', '', 'app = FastAPI()', ''].join('\n'),
        'backend/app/models.py': TEMPLATE_MODELS,
      });
      const { code, stdout } = await initScan(repo);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('signals: sqlalchemy');
      expect(stdout).toContain('gateforge.pack-sqlalchemy');
      // The reason names the concrete class the table belongs to.
      expect(stdout).toMatch(/gateforge\.pack-sqlalchemy .*User\(UserBase, table=True\).*backend\/app\/models\.py/);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toContain('gateforge.pack-sqlalchemy');
    });
  });

  it('detects a base class imported from a module that imports sqlmodel', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/app/main.py': ['from fastapi import FastAPI', '', 'app = FastAPI()', ''].join('\n'),
        'backend/app/base.py': IMPORTED_BASE,
        'backend/app/models.py': IMPORTED_MODEL,
      });
      const { code, stdout } = await initScan(repo);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('signals: sqlalchemy');
      expect(stdout).toMatch(/gateforge\.pack-sqlalchemy .*Item\(ItemBase, table=True\).*backend\/app\/models\.py/);
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      expect(config.plugins.map((plugin) => plugin.id)).toContain('gateforge.pack-sqlalchemy');
    });
  });

  it('never promotes a table=True class whose base chain never reaches SQLModel', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        'backend/app/main.py': ['from fastapi import FastAPI', '', 'app = FastAPI()', ''].join('\n'),
        'backend/app/models.py': [
          'from dataclasses import dataclass',
          '',
          '',
          'class RowBase:',
          '    pass',
          '',
          '',
          'class Row(RowBase, table=True):',
          '    pass',
          '',
        ].join('\n'),
      });
      const { code, stdout } = await initScan(repo);
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('signals: fastapi');
      expect(stdout).not.toContain('signals: sqlalchemy');
      expect(stdout).not.toContain('gateforge.pack-sqlalchemy');
    });
  });
});
