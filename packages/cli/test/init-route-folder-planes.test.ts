/**
 * `gateforge init --planes` asks the owner about ROUTE folders too, in
 * the same flow as model folders (owner decision D1: ask, never infer).
 *
 * The non-interactive path is the honest one to pin: it proposes
 * NOTHING and writes NOTHING for routes — it names every folder that
 * still has unresolved endpoints and prints the exact
 * `gateforge classify plane` command for it. The model-folder rules are
 * still inferred and written as before, into the same file.
 *
 * Two properties this guards, both of which the old code had backwards:
 * - a route folder with unresolved endpoints is NAMED, so the owner is
 *   told the question exists instead of meeting 600 silent
 *   PLANE_UNRESOLVED endpoints;
 * - a linked model's plane is only ever a hint, and here the model has
 *   no resolved plane at all, so no hint is printed — nothing is inferred.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { runCli } from './helpers.js';

/** A SQLAlchemy model: discovery sees a table with no answered plane. */
const MODELS = `from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
`;

/** A FastAPI app whose route discovery sees one plane-unresolved route. */
const ROUTES = `from fastapi import FastAPI

app = FastAPI()


@app.get("/api/v2/orders")
def list_orders():
    return []
`;

interface PlanesFile {
  rules: Array<{ match?: string; plane?: string; reason?: string }>;
}

describe('init --planes names the route folders it cannot infer (D1)', () => {
  it('prints one runnable command per unresolved route folder and writes no route rule', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/models.py': MODELS, 'app/main.py': ROUTES });
      const { code, stdout, stderr } = await runCli(repo, [
        'init',
        '--no-scan',
        '--preset',
        'light',
        '--planes',
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);

      // The folder is NAMED, with the exact owner-reviewed command.
      expect(stdout).toContain('route folders with no answered plane');
      expect(stdout).toMatch(/^ {2}app \(\d+ route\(s\)/m);
      expect(stdout).toContain('gateforge classify plane app tenant --reason');

      // Nothing is inferred from the linked model: `orders` has no
      // resolved plane, so there is no hint to show.
      expect(stdout).not.toContain('hint only');

      // And nothing was written for routes — the model rule is all that
      // the inference produced, exactly as before.
      const written = JSON.parse(readFileSync(repo.path('.gateforge/planes.json'), 'utf8')) as PlanesFile;
      expect(written.rules.map((rule) => rule.match)).toEqual(['app/*.py']);
    });
  });

  it('leaves a reviewed planes file completely alone', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/models.py': MODELS, 'app/main.py': ROUTES });
      const first = await runCli(repo, ['init', '--no-scan', '--preset', 'light', '--planes']);
      expect(first.code, first.stderr).toBe(0);
      const before = readFileSync(repo.path('.gateforge/planes.json'), 'utf8');

      const second = await runCli(repo, ['init', '--no-scan', '--preset', 'light', '--planes']);
      expect(second.code, second.stderr).toBe(0);
      expect(second.stdout).toContain('exists, leaving untouched');
      // A reviewed document is never re-proposed or rewritten.
      expect(second.stdout).not.toContain('route folders with no answered plane');
      expect(readFileSync(repo.path('.gateforge/planes.json'), 'utf8')).toBe(before);
    });
  });
});