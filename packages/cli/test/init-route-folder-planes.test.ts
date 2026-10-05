/**
 * `gateforge init --planes` asks the owner about ROUTE folders too, in
 * the same flow as model folders (owner decision D1: ask, never infer).
 *
 * The non-interactive path is the honest one to pin: it proposes
 * NOTHING and writes NOTHING for routes — it names every folder that
 * still has unresolved endpoints and prints the exact
 * `gateforge classify plane` command for it. The model-folder rules are
 * still inferred and written as before, into the same `planes:` section
 * of the owner-answers document (0.11.0 — it was `.gateforge/planes.json`).
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
import { OWNER_ANSWERS_PATH, withTempRepo } from '@gate-forge/core';
import { parse as parseYaml } from 'yaml';
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

/**
 * The `planes:` rules the owner-answers document declares. Since 0.11.0
 * the plane answer is a SECTION of that one document, so a fixture that
 * read a `.gateforge/planes.json` file no longer describes any real home.
 */
function planeRulesOf(repo: { path: (relative: string) => string }): PlanesFile['rules'] {
  const document = parseYaml(readFileSync(repo.path(OWNER_ANSWERS_PATH), 'utf8')) as
    | { planes?: PlanesFile }
    | null;
  return document?.planes?.rules ?? [];
}

describe('init --planes names the route folders it cannot infer (D1)', () => {
  it('prints one runnable command SHAPE per unresolved route folder, with no plane chosen', async () => {
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

      // The folder is NAMED, with the exact owner-reviewed command shape
      // — and with the plane LEFT AS A PLACEHOLDER. Printing a concrete
      // plane infers it for the owner (D1), and an agent that copies the
      // line would apply a wrong plane to a folder whose models init
      // itself inferred as `master`.
      expect(stdout).toContain('route folders with no answered plane');
      expect(stdout).toMatch(/^ {2}app \(\d+ route\(s\)/m);
      expect(stdout).toContain(
        "gateforge classify plane app <tenant|master|global> --reason '<why the ROUTES in this folder serve that data>' --confirm",
      );
      // No printed classify command may carry a concrete plane word: an
      // agent copying any of them must still have to decide.
      const classifyLines = stdout
        .split('\n')
        .filter((line) => line.includes('gateforge classify plane'));
      expect(classifyLines.length).toBeGreaterThan(0);
      for (const line of classifyLines) {
        expect(line, `a printed command must not choose a plane: ${line}`).not.toMatch(
          /classify plane \S+ (tenant|master|global) /,
        );
      }

      // Nothing is inferred from the linked model: `orders` has no
      // resolved plane, so there is no hint to show.
      expect(stdout).not.toContain('hint only');

      // And nothing was written for routes — the model rule is all that
      // the inference produced, exactly as before.
      expect(planeRulesOf(repo).map((rule) => rule.match)).toEqual(['app/*.py']);
    });
  });

  it('leaves a reviewed planes section completely alone', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({ 'app/models.py': MODELS, 'app/main.py': ROUTES });
      const first = await runCli(repo, ['init', '--no-scan', '--preset', 'light', '--planes']);
      expect(first.code, first.stderr).toBe(0);
      const before = readFileSync(repo.path(OWNER_ANSWERS_PATH), 'utf8');

      const second = await runCli(repo, ['init', '--no-scan', '--preset', 'light', '--planes']);
      expect(second.code, second.stderr).toBe(0);
      expect(second.stdout).toContain('exists, leaving untouched');
      // A reviewed document is never re-proposed or rewritten.
      expect(second.stdout).not.toContain('route folders with no answered plane');
      expect(readFileSync(repo.path(OWNER_ANSWERS_PATH), 'utf8')).toBe(before);
    });
  });
});