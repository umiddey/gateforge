/**
 * Slash-variant registration facts: ONE handler under TWO decorators —
 * `@router.get("/resolve", include_in_schema=False)` over
 * `@router.get("/resolve/")` — registers two raw routes at ADJACENT
 * flattened positions. The detector emits BOTH facts (same effective
 * path, different rawPath) each with its own `{scope, order}`; folding
 * them into the compiled endpoint's registration range is the CLI
 * compiler's job (see endpoint-compiler.test.ts), the resolver's
 * conservative range comparison core's.
 *
 * Engine-class test: deterministic, offline (files + the spawned python
 * detector only).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pythonEnv } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { createFastapiDetector } from '../src/detector.js';
import { dirname, join } from 'node:path';

/** The fixture app: the two-decorator handler, then the parameter route. */
const APP = [
  'from fastapi import FastAPI, APIRouter',
  '',
  'app = FastAPI()',
  'router = APIRouter(prefix="/preferences")',
  '',
  '@router.get("/resolve", include_in_schema=False)',
  '@router.get("/resolve/")',
  'def resolve_preference():',
  '    return {}',
  '',
  '@router.get("/{preference_id}")',
  'def get_preference(preference_id: int):',
  '    return {}',
  '',
  'app.include_router(router)',
].join('\n');

/** A detector fact on the wire: `kind` discriminator plus attribute bag. */
interface WireFact {
  kind: string;
  attributes: Record<string, unknown>;
}

/** Type guard for the one shape this file reads off a detector outcome. */
function isWireFact(resource: unknown): resource is WireFact {
  if (typeof resource !== 'object' || resource === null) return false;
  if (!('kind' in resource) || !('attributes' in resource)) return false;
  return (
    typeof resource.kind === 'string' &&
    typeof resource.attributes === 'object' &&
    resource.attributes !== null
  );
}

describe('slash-variant registration facts', () => {
  it('emits one proven order per raw route of a two-decorator handler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-slash-'));
    try {
      const main = join(dir, 'app/main.py');
      mkdirSync(dirname(main), { recursive: true });
      writeFileSync(main, APP, 'utf8');
      const detector = createFastapiDetector({ env: pythonEnv(), cwd: dir });
      const outcome = (await detector.discover(['app/main.py'])) as unknown as {
        resources: ReadonlyArray<unknown>;
      };
      const byRawPath: Record<string, Record<string, unknown>> = {};
      for (const resource of outcome.resources) {
        if (!isWireFact(resource) || resource.kind !== 'http.contract') continue;
        byRawPath[String(resource.attributes['rawPath'])] = resource.attributes;
      }
      // Adjacent flattened positions in declaration order; both raw
      // variants normalize to the SAME path (the trailing slash folds),
      // which is what makes the CLI compiler merge them into one
      // endpoint.
      expect(byRawPath['/resolve']?.['normalizedPath']).toBe('/preferences/resolve');
      expect(byRawPath['/resolve/']?.['normalizedPath']).toBe('/preferences/resolve');
      expect(byRawPath['/resolve']?.['registration']).toEqual({
        scope: 'app.main:app',
        order: 0,
      });
      expect(byRawPath['/resolve/']?.['registration']).toEqual({
        scope: 'app.main:app',
        order: 1,
      });
      expect(byRawPath['/{preference_id}']?.['registration']).toEqual({
        scope: 'app.main:app',
        order: 2,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
