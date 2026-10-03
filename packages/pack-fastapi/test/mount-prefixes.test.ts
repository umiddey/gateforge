/**
 * Mount-prefix regressions, run against the REAL python detector.
 *
 * Three shapes used to lose a prefix SILENTLY — the route was published at
 * a path no app serves, with no typed outcome at all — and one router
 * shape was invisible in the inventory:
 *
 *  - `router: APIRouter = APIRouter(prefix="/api/v1")`: an annotated
 *    definition was not indexed as a router at all;
 *  - `router = make_router()`: the object came from an expression the
 *    AST pass cannot model, and its routes were emitted prefix-less;
 *  - `PREFIX = "/api/v1"` + `prefix=PREFIX`: a provable literal that was
 *    treated as computed, dropping the whole router from the inventory.
 *
 * Engine-class tests: deterministic, offline (files + the spawned
 * detector only).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFastapiDetector } from '../src/detector.js';
import { pythonEnv } from './helpers.js';

interface WrapperOutcome {
  resources: ReadonlyArray<{ kind: string; attributes: Record<string, unknown> }>;
  unresolved: ReadonlyArray<Record<string, unknown>>;
}

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-mount-'));
  for (const [rel, text] of Object.entries(files)) {
    const absolute = join(dir, rel);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true });
    writeFileSync(absolute, text);
  }
  return dir;
}

async function scan(
  files: Record<string, string>,
  paths: readonly string[],
  importRoots: readonly string[] = [],
): Promise<WrapperOutcome> {
  const dir = project(files);
  try {
    const detector = createFastapiDetector({ env: pythonEnv(), cwd: dir, importRoots });
    return (await detector.discover(paths)) as unknown as WrapperOutcome;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function paths(outcome: WrapperOutcome): string[] {
  return outcome.resources
    .filter((resource) => resource.kind === 'http.contract')
    .map((resource) => `${String(resource.attributes['method'])} ${String(resource.attributes['normalizedPath'])}`)
    .sort();
}

function codes(outcome: WrapperOutcome): string[] {
  return outcome.unresolved.map((entry) => String(entry['code'])).sort();
}

describe('mount prefixes the AST pass can prove', () => {
  it('treats an annotated router definition exactly like a plain one', async () => {
    const outcome = await scan(
      {
        'main.py': [
          'from fastapi import APIRouter, FastAPI',
          '',
          'router: APIRouter = APIRouter(prefix="/api/v1")',
          '',
          'app = FastAPI()',
          'app.include_router(router)',
          '',
          '@router.get("/widgets/{widget_id}")',
          'def get_widget(widget_id: str):',
          '    return {}',
        ].join('\n'),
      },
      ['main.py'],
    );
    // Before: the annotated name was not a router definition, so the route
    // was emitted as `GET /widgets/{}` — a prefix silently dropped.
    expect(paths(outcome)).toEqual(['GET /api/v1/widgets/{}']);
    expect(codes(outcome)).toEqual([]);
  });

  it('folds a module-level string constant used as the prefix, at both mount sites', async () => {
    const outcome = await scan(
      {
        'main.py': [
          'from fastapi import APIRouter, FastAPI',
          '',
          'API = "/api/v1"',
          'MOUNT = "/api/v1"',
          '',
          'router = APIRouter(prefix=API)',
          'reports = APIRouter(prefix="/reports")',
          'app = FastAPI()',
          'app.include_router(router)',
          'app.include_router(reports, prefix=MOUNT)',
          '',
          '@router.get("/widgets/{widget_id}")',
          'def get_widget(widget_id: str):',
          '    return {}',
          '',
          '@reports.get("/orders/{order_id}")',
          'def get_order(order_id: str):',
          '    return {}',
        ].join('\n'),
      },
      ['main.py'],
    );
    // Before: both constants were "computed", so both routers emitted
    // nothing and their by-id routes were absent from the inventory.
    expect(paths(outcome)).toEqual(['GET /api/v1/reports/orders/{}', 'GET /api/v1/widgets/{}']);
    expect(codes(outcome)).toEqual([]);
  });

  it('reports a router built by an unmodeled expression instead of inventing its paths', async () => {
    const outcome = await scan(
      {
        'main.py': [
          'from fastapi import APIRouter',
          '',
          'def build_router():',
          '    return APIRouter(prefix="/api/v1")',
          '',
          'router = build_router()',
          '',
          '@router.get("/widgets/{widget_id}")',
          'def get_widget(widget_id: str):',
          '    return {}',
        ].join('\n'),
      },
      ['main.py'],
    );
    // Before: `GET /widgets/{}` was emitted as a served route, prefix-less,
    // with nothing reported.
    expect(paths(outcome)).toEqual([]);
    expect(codes(outcome)).toEqual(['FASTAPI_PREFIX_UNRESOLVED']);
    expect(String(outcome.unresolved[0]?.['detail'])).toContain(
      "router 'router' in main.py is created by an expression",
    );
  });
});

describe('routers no scanned app mounts', () => {
  it('names the unmounted router and its routes, and still reports them', async () => {
    const outcome = await scan(
      {
        'main.py': [
          'from fastapi import APIRouter, FastAPI',
          '',
          'app = FastAPI()',
          '',
          '@app.get("/api/v1/health")',
          'def health():',
          '    return {}',
        ].join('\n'),
        'orphan.py': [
          'from fastapi import APIRouter',
          '',
          'router = APIRouter(prefix="/reports")',
          '',
          '@router.get("/widgets/{widget_id}")',
          'def get_widget(widget_id: str):',
          '    return {}',
        ].join('\n'),
      },
      ['main.py', 'orphan.py'],
    );
    // The route keeps its documented standalone emission …
    expect(paths(outcome)).toEqual(['GET /api/v1/health', 'GET /reports/widgets/{}']);
    // … and one typed entry says plainly that nothing serves it.
    expect(codes(outcome)).toEqual(['FASTAPI_ROUTER_UNMOUNTED']);
    const entry = outcome.unresolved[0];
    expect(String(entry?.['detail'])).toContain("router 'router' in orphan.py is never included");
    expect(String(entry?.['detail'])).toContain('GET /reports/widgets/{widget_id}');
    expect(entry?.['location']).toMatchObject({ file: 'orphan.py' });
  });

  it('stays silent when the scan cannot prove the mount graph', async () => {
    const unresolvableInclude = await scan(
      {
        'main.py': [
          'from fastapi import APIRouter, FastAPI',
          '',
          'app = FastAPI()',
          'app.include_router(router)',
          '',
          '@app.get("/api/v1/health")',
          'def health():',
          '    return {}',
        ].join('\n'),
        'orphan.py': [
          'from fastapi import APIRouter',
          '',
          'router = APIRouter(prefix="/reports")',
          '',
          '@router.get("/widgets/{widget_id}")',
          'def get_widget(widget_id: str):',
          '    return {}',
        ].join('\n'),
      },
      ['main.py', 'orphan.py'],
    );
    // The include target does not exist in the scanned set: this scan
    // cannot say which routers it would have reached, so "unmounted" is
    // not a claim this pack may make. The real blocker stays the only one.
    expect(paths(unresolvableInclude)).toEqual(['GET /api/v1/health', 'GET /reports/widgets/{}']);
    expect(codes(unresolvableInclude)).toEqual(['FASTAPI_PREFIX_UNRESOLVED']);
  });

  it('stays silent when no application is in the scanned set at all', async () => {
    const outcome = await scan(
      {
        'routers.py': [
          'from fastapi import APIRouter',
          '',
          'router = APIRouter(prefix="/reports")',
          '',
          '@router.get("/widgets/{widget_id}")',
          'def get_widget(widget_id: str):',
          '    return {}',
        ].join('\n'),
      },
      ['routers.py'],
    );
    // The mounting code may simply live outside the scan.
    expect(paths(outcome)).toEqual(['GET /reports/widgets/{}']);
    expect(codes(outcome)).toEqual([]);
  });
});