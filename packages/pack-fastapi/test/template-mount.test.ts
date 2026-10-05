/**
 * The canonical template's mount shape, against the REAL python detector.
 *
 * `fixtures/template-mount/` is the FastAPI full-stack layout reduced to
 * its mount graph: `backend/app/main.py` includes `app.api.main.api_router`
 * with a literal prefix, and `backend/app/api/main.py` includes
 * `app.api.routes.login.router` and `app.api.routes.items.router`.
 *
 * Without import roots the two inner mounts are an unfollowable target —
 * `FASTAPI_PREFIX_UNRESOLVED: include_router target 'router' in … cannot
 * be resolved in the scanned set` — and the routes come back standalone
 * and prefix-less, so nothing can join a frontend call to them. Declaring
 * `{ "importRoots": ["<fixture>/backend"] }` resolves the whole mount with
 * NO application edit and every route carries its real `/api/v1` prefix.
 *
 * That is the fact `gateforge next`'s unresolvable-target guidance relies
 * on, pinned here rather than asserted in prose.
 */
import { describe, expect, it } from 'vitest';
import { createFastapiDetector } from '../src/detector.js';
import { FIXTURE_ROOT, pythonEnv, type WrapperOutcome } from './helpers.js';

const MOUNT_FIXTURES = [
  'template-mount/backend/app/__init__.py',
  'template-mount/backend/app/main.py',
  'template-mount/backend/app/api/__init__.py',
  'template-mount/backend/app/api/main.py',
  'template-mount/backend/app/api/routes/__init__.py',
  'template-mount/backend/app/api/routes/login.py',
  'template-mount/backend/app/api/routes/items.py',
] as const;

const BACKEND_ROOT = ['template-mount/backend'] as const;

interface ContractFact {
  attributes: Record<string, unknown>;
}

function scan(importRoots: readonly string[]): Promise<WrapperOutcome> {
  const detector = createFastapiDetector({ env: pythonEnv(), cwd: FIXTURE_ROOT, importRoots });
  return detector.discover([...MOUNT_FIXTURES]) as Promise<WrapperOutcome>;
}

function paths(outcome: WrapperOutcome): string[] {
  return (outcome.resources as unknown as ContractFact[])
    .map((fact) => `${String(fact.attributes['method'])} ${String(fact.attributes['normalizedPath'])}`)
    .sort();
}

describe('the template mount shape under scan.fastapi importRoots', () => {
  it('without roots the inner mounts are an unresolvable target and routes lose their prefix', async () => {
    const outcome = await scan([]);
    expect(
      (outcome.unresolved as ReadonlyArray<Record<string, unknown>>).map((entry) => entry['detail']),
    ).toEqual([
      "include_router target 'router' in template-mount/backend/app/api/main.py cannot be resolved in the scanned set",
      "include_router target 'router' in template-mount/backend/app/api/main.py cannot be resolved in the scanned set",
    ]);
    // Standalone, prefix-less: no frontend call could ever join them.
    expect(paths(outcome)).toEqual(['GET /items', 'POST /login/access-token']);
  });

  it('with the backend root the mount resolves and every route carries its real prefix', async () => {
    const outcome = await scan(BACKEND_ROOT);
    expect(outcome.unresolved).toEqual([]);
    expect(paths(outcome)).toEqual(['GET /api/v1/items', 'POST /api/v1/login/access-token']);
  });

  it('reads the same root from the handed section (byte-identical outcome)', async () => {
    const detector = createFastapiDetector({ env: pythonEnv(), cwd: FIXTURE_ROOT });
    const fromSection = (await detector.discover([...MOUNT_FIXTURES], {
      root: FIXTURE_ROOT,
      sections: { fastapi: { importRoots: BACKEND_ROOT } },
    })) as WrapperOutcome;
    expect(JSON.stringify(fromSection)).toBe(JSON.stringify(await scan(BACKEND_ROOT)));
  });
});
