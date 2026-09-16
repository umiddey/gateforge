/**
 * Import-root resolution tests (`.gateforge/fastapi.json`): the central
 * router-registry pattern (`from api.v1.endpoints import activities` +
 * `app.include_router(activities.router, prefix=...)`) that file-relative
 * resolution alone cannot join.
 *
 * Engine-class tests: deterministic, offline (spawn + files only). The
 * fixture tree `import-roots/` carries a `backend/` registry plus a
 * second root (`admin/`) declaring the SAME `api.v1.activities` module
 * path for the ambiguity case.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRedProbe } from '@gate-forge/core';
import {
  createFastapiDetector,
  DEFAULT_FASTAPI_SCAN_CONFIG,
  readFastapiScanConfigOrNull,
} from '../src/detector.js';
import {
  AMBIGUOUS_IMPORT_ROOTS,
  BACKEND_IMPORT_ROOTS,
  FIXTURE_ROOT,
  IMPORT_ROOTS_FIXTURES,
  REGISTRY_FIXTURES,
  pythonEnv,
  runDetector,
  runDetectorWithImportRoots,
  type WrapperOutcome,
} from './helpers.js';

interface FactView {
  id: string;
  kind: string;
  attributes: Record<string, unknown>;
}

function facts(resources: readonly unknown[]): FactView[] {
  return resources
    .filter((resource): resource is FactView =>
      typeof resource === 'object' &&
      resource !== null &&
      (resource as FactView).kind === 'http.contract',
    );
}

function effectivePaths(outcome: { resources: readonly unknown[] }): string[] {
  return facts(outcome.resources).map(
    (fact) => `${fact.attributes['method'] as string} ${fact.attributes['normalizedPath'] as string}`,
  );
}

describe('fastapi import-root resolution (.gateforge/fastapi.json)', () => {
  it('joins centrally-registered routers so effective paths carry real prefixes', async () => {
    const outcome = await runDetectorWithImportRoots(
      IMPORT_ROOTS_FIXTURES,
      BACKEND_IMPORT_ROOTS,
    );
    expect(outcome.unresolved).toEqual([]);
    expect(effectivePaths(outcome).sort()).toEqual([
      // admin's same-shaped router is NOT the include target; it stays standalone.
      'GET /activities/{}',
      'GET /api/v1/activities/{}',
      'GET /api/v1/health/live',
      'POST /api/v1/leases',
      'POST /api/v1/leasing/leases',
    ]);
    // Nested composition + repeated mount: leases.router is mounted by the
    // registry directly (/api/v1) AND through api_router (/api/v1/leasing)
    // — two contracts, both include-chain.
    const leaseFacts = facts(outcome.resources).filter(
      (fact) => fact.attributes['handlerSymbol'] === 'import-roots.backend.api.v1.endpoints.leases:create_lease',
    );
    expect(leaseFacts.map((fact) => fact.attributes['normalizedPath']).sort()).toEqual([
      '/api/v1/leases',
      '/api/v1/leasing/leases',
    ]);
    for (const fact of leaseFacts) {
      expect(fact.attributes['mountProvenance']).toBe('include-chain');
    }
  });

  it('reads the same roots from a config document path (byte-identical outcome)', async () => {
    const detector = createFastapiDetector({
      env: pythonEnv(),
      cwd: FIXTURE_ROOT,
      importRootsConfigPath: 'import-roots/fastapi.config.json',
    });
    const fromConfig = (await detector.discover([...IMPORT_ROOTS_FIXTURES])) as WrapperOutcome;
    const fromOption = await runDetectorWithImportRoots(IMPORT_ROOTS_FIXTURES, BACKEND_IMPORT_ROOTS);
    expect(JSON.stringify(fromConfig)).toBe(JSON.stringify(fromOption));
  });

  it('keeps an ambiguous module path typed-unresolved instead of guessing', async () => {
    const outcome = await runDetectorWithImportRoots(IMPORT_ROOTS_FIXTURES, AMBIGUOUS_IMPORT_ROOTS);
    // Closed world: exactly ONE typed entry — the ambiguous activities
    // include; every uniquely-resolvable include still joins.
    expect(outcome.unresolved).toHaveLength(1);
    const ambiguous = outcome.unresolved.filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        String((entry as Record<string, unknown>)['detail']).includes(
          'matches multiple scanned files',
        ),
    );
    expect(ambiguous).toHaveLength(1);
    const entry = ambiguous[0] as Record<string, unknown>;
    expect(entry['code']).toBe('FASTAPI_PREFIX_UNRESOLVED');
    expect(String(entry['detail'])).toContain('import-roots/admin/api/v1/activities.py');
    expect(String(entry['detail'])).toContain('import-roots/backend/api/v1/activities.py');
    expect(entry['location']).toMatchObject({ file: 'import-roots/backend/main.py' });
    // The unprovable mount emits NO guessed fact; everything unique still joins.
    expect(effectivePaths(outcome)).not.toContain('GET /api/v1/activities/{}');
    expect(effectivePaths(outcome)).toContain('POST /api/v1/leasing/leases');
    expect(effectivePaths(outcome)).toContain('GET /api/v1/health/live');
    // Both same-named routers fall back to their documented standalone mount.
    expect(effectivePaths(outcome).filter((path) => path === 'GET /activities/{}')).toHaveLength(2);
  });

  it('config absent keeps today’s behavior: typed unresolved, no prefix join', async () => {
    const outcome = await runDetector(IMPORT_ROOTS_FIXTURES);
    // Every registry include fails closed: the module-import chains
    // (activities, leases via `.router`, the deep health chain) and the
    // nested `leases.router` include inside api_router.
    expect(outcome.unresolved).toHaveLength(4);
    for (const entry of outcome.unresolved as ReadonlyArray<Record<string, unknown>>) {
      expect(entry['code']).toBe('FASTAPI_PREFIX_UNRESOLVED');
      expect(String(entry['detail'])).not.toContain('matches multiple scanned files');
      expect(String(entry['detail'])).toContain('cannot be resolved in the scanned set');
      expect(['import-roots/backend/main.py', 'import-roots/backend/api/v1/routers.py']).toContain(
        (entry['location'] as { file: string })['file'],
      );
    }
    // Registry-pattern routers stay prefix-less (standalone), so no
    // frontend call could ever join them — the dogfood failure itself.
    const paths = effectivePaths(outcome);
    expect(paths.sort()).toEqual([
      'GET /activities/{}',
      'GET /activities/{}',
      'GET /health/live',
      'POST /leases',
    ]);
  });

  it('red-probe: the prefix-join guard proves the config, and fails without it', async () => {
    const guard = async (outcome: WrapperOutcome): Promise<void> => {
      const paths = effectivePaths(outcome);
      expect(paths).toContain('GET /api/v1/activities/{}');
      expect(paths).toContain('POST /api/v1/leasing/leases');
      expect(paths).toContain('GET /api/v1/health/live');
    };
    const record = await runRedProbe({
      name: 'import-root registry joins carry effective prefixes',
      green: () => runDetectorWithImportRoots(IMPORT_ROOTS_FIXTURES, BACKEND_IMPORT_ROOTS).then(guard),
      // Deliberately broken behavior: config absent — today's prefix-less outcome.
      broken: () => runDetector(IMPORT_ROOTS_FIXTURES).then(guard),
    });
    expect(record).toMatchObject({ ok: true, greenPassed: true, brokenFailed: true });
  });
});

describe('fastapi registry-function propagation (function-mediated include_router)', () => {
  it('mounts parameter-mediated includes on the instance argument with real prefixes', async () => {
    const outcome = await runDetectorWithImportRoots(REGISTRY_FIXTURES, BACKEND_IMPORT_ROOTS);
    // The only typed entry is the unresolvable-argument negative below.
    expect(outcome.unresolved).toHaveLength(1);
    expect(effectivePaths(outcome).sort()).toEqual([
      // reports.router mounted TWICE: directly (/api/v1) and through the
      // chained helper (/api/v1/core) — repeated mounts duplicate.
      'GET /api/v1',
      'GET /api/v1/core',
      'GET /api/v1/core/ping',
      'GET /api/v1/ops/status',
      'GET /api/v1/ping',
    ]);
    for (const fact of facts(outcome.resources)) {
      expect(fact.attributes['mountProvenance']).toBe('include-chain');
    }
  });

  it('`from pkg import attr` joins through the package __init__ re-export', async () => {
    const outcome = await runDetectorWithImportRoots(REGISTRY_FIXTURES, BACKEND_IMPORT_ROOTS);
    // `from ops import router as ops_router` binds an __init__ re-export
    // (`from .endpoints import router`); there is no ops/router.py.
    expect(effectivePaths(outcome)).toContain('GET /api/v1/ops/status');
    // And no standalone prefix-less fallback for the same router.
    expect(effectivePaths(outcome)).not.toContain('GET /ops/status');
  });

  it('a never-called registry function mounts nothing and stays silent', async () => {
    const outcome = await runDetectorWithImportRoots(REGISTRY_FIXTURES, BACKEND_IMPORT_ROOTS);
    // register_orphan includes archive.router but is never called: the
    // router is provably included (no standalone prefix-less emission)
    // and provably never mounted (no prefixed emission, no entry — the
    // only unresolved stays the explicit negative).
    const paths = effectivePaths(outcome);
    expect(paths).not.toContain('GET /api/v1/archive/items');
    expect(paths).not.toContain('GET /archive/items');
    const details = (outcome.unresolved as ReadonlyArray<Record<string, unknown>>).map((entry) =>
      String(entry['detail']),
    );
    expect(details.some((detail) => detail.includes('archive'))).toBe(false);
  });

  it('an unresolvable call-site argument names the exact call site and emits nothing', async () => {
    const outcome = await runDetectorWithImportRoots(REGISTRY_FIXTURES, BACKEND_IMPORT_ROOTS);
    expect(outcome.unresolved).toHaveLength(1);
    const entry = outcome.unresolved[0] as Record<string, unknown>;
    expect(entry['code']).toBe('FASTAPI_PREFIX_UNRESOLVED');
    const detail = String(entry['detail']);
    expect(detail).toContain("registry function 'register_feature_routers'");
    expect(detail).toContain("'never_bound'");
    expect(detail).toContain('no prefix-less standalone paths are fabricated');
    expect(entry['location']).toMatchObject({
      file: 'import-roots/backend/server.py',
      line: 27,
    });
    // Closed-world honesty: the reports router's source carries prefixes,
    // so NOTHING emits for the unresolvable mount — no bare paths.
    const paths = effectivePaths(outcome);
    expect(paths).toContain('GET /api/v1/ping'); // the resolved mount still works
    expect(paths).not.toContain('GET /ping');
    expect(paths).not.toContain('GET /');
  });

  it('red-probe: the prefix guard fails when the call-site argument cannot be resolved', async () => {
    const guard = async (outcome: WrapperOutcome): Promise<void> => {
      const paths = effectivePaths(outcome);
      expect(paths).toContain('GET /api/v1/ping');
      expect(paths).toContain('GET /api/v1/core/ping');
      expect(paths).toContain('GET /api/v1/ops/status');
      expect(paths).not.toContain('GET /ping');
    };
    const record = await runRedProbe({
      name: 'registry-function propagation carries effective prefixes',
      green: () =>
        runDetectorWithImportRoots(REGISTRY_FIXTURES, BACKEND_IMPORT_ROOTS).then(guard),
      // Deliberately broken behavior: the dogfood regression itself — the
      // call-site argument no longer names the FastAPI instance, so every
      // parameter-mediated include unwires. The copied tree is
      // byte-identical to the fixture apart from those argument names.
      broken: async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-registry-'));
        try {
          const target = join(dir, 'import-roots');
          cpSync(join(FIXTURE_ROOT, 'import-roots'), target, { recursive: true });
          const serverPath = join(target, 'backend', 'server.py');
          writeFileSync(
            serverPath,
            readFileSync(serverPath, 'utf8').replaceAll('(fastapi_app)', '(unwired_app)'),
            'utf8',
          );
          const detector = createFastapiDetector({
            env: pythonEnv(),
            cwd: dir,
            importRoots: ['import-roots/backend'],
          });
          const outcome = (await detector.discover([...REGISTRY_FIXTURES])) as WrapperOutcome;
          expect(outcome.scannedPaths).toHaveLength(REGISTRY_FIXTURES.length);
          await guard(outcome); // must throw: zero prefixed paths survive
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    });
    expect(record).toMatchObject({ ok: true, greenPassed: true, brokenFailed: true });
  });

  it('helper chains at the documented depth bound resolve; beyond it stay typed-unresolved', async () => {
    const writeChain = (dir: string, functions: number): void => {
      // `functions` modules chained f0 -> ... -> f(n-1); the include lives
      // in f(n-1). Parameter transfers = functions - 1; the bound is 8.
      const lines = [
        'from fastapi import APIRouter',
        '',
        'local_router = APIRouter(prefix="/deep")',
        '',
        '@local_router.get("/x")',
        'def x():',
        '    return {}',
        '',
        `def f${functions - 1}(app):`,
        '    app.include_router(local_router, prefix="/d")',
        '',
      ];
      for (let index = 0; index < functions - 1; index += 1) {
        lines.push(`def f${index}(app):`, `    f${index + 1}(app)`, '');
      }
      writeFileSync(join(dir, 'registry.py'), `${lines.join('\n')}\n`, 'utf8');
      writeFileSync(
        join(dir, 'main.py'),
        'from fastapi import FastAPI\n'
          + `from registry import f0\n\n`
          + 'app = FastAPI()\n'
          + 'f0(app)\n',
        'utf8',
      );
    };
    const scan = async (dir: string): Promise<WrapperOutcome> => {
      const detector = createFastapiDetector({ env: pythonEnv(), cwd: dir });
      return (await detector.discover(['registry.py', 'main.py'])) as WrapperOutcome;
    };

    const atBound = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-depth-at-'));
    try {
      writeChain(atBound, 9); // 8 transfers: exactly the documented bound
      const outcome = await scan(atBound);
      expect(outcome.unresolved).toEqual([]);
      expect(effectivePaths(outcome)).toEqual(['GET /d/deep/x']);
    } finally {
      rmSync(atBound, { recursive: true, force: true });
    }

    const beyondBound = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-depth-over-'));
    try {
      writeChain(beyondBound, 10); // 9 transfers: one past the bound
      const outcome = await scan(beyondBound);
      // The router stays suppressed (provably included somewhere), the
      // mount is unprovable: exactly one typed entry, no facts.
      expect(facts(outcome.resources)).toEqual([]);
      expect(outcome.unresolved).toHaveLength(1);
      const entry = outcome.unresolved[0] as Record<string, unknown>;
      expect(entry['code']).toBe('FASTAPI_PREFIX_UNRESOLVED');
      expect(String(entry['detail'])).toContain('exceeds the supported helper depth (8)');
      expect(entry['location']).toMatchObject({ file: 'registry.py' });
    } finally {
      rmSync(beyondBound, { recursive: true, force: true });
    }
  });
});

describe('fastapi detector config reader (.gateforge/fastapi.json)', () => {
  it('absence is normal and yields the default config', () => {
    expect(readFastapiScanConfigOrNull(null)).toEqual(DEFAULT_FASTAPI_SCAN_CONFIG);
    expect(readFastapiScanConfigOrNull(join(FIXTURE_ROOT, 'definitely-absent.json'))).toEqual(
      DEFAULT_FASTAPI_SCAN_CONFIG,
    );
  });

  it('parses a valid document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-config-'));
    try {
      const path = join(dir, 'fastapi.json');
      writeFileSync(path, '{ "importRoots": ["backend", "services/api"] }\n', 'utf8');
      expect(readFastapiScanConfigOrNull(path)).toEqual({
        importRoots: ['backend', 'services/api'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on malformed documents (JSON, shape, unknown keys, bad roots)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-config-'));
    try {
      const write = (name: string, text: string): string => {
        const path = join(dir, name);
        writeFileSync(path, text, 'utf8');
        return path;
      };
      expect(() =>
        readFastapiScanConfigOrNull(write('broken.json', '{ "importRoots": [')),
      ).toThrow();
      expect(() => readFastapiScanConfigOrNull(write('array.json', '["backend"]'))).toThrow(
        /expected an object/,
      );
      expect(() =>
        readFastapiScanConfigOrNull(write('unknown.json', '{ "importRoot": ["backend"] }')),
      ).toThrow(/unknown key\(s\) importRoot/);
      expect(() =>
        readFastapiScanConfigOrNull(write('notarray.json', '{ "importRoots": "backend" }')),
      ).toThrow(/must be an array/);
      expect(() =>
        readFastapiScanConfigOrNull(write('escape.json', '{ "importRoots": ["../backend"] }')),
      ).toThrow(/repo-root-relative directory/);
      expect(() =>
        readFastapiScanConfigOrNull(write('number.json', '{ "importRoots": [7] }')),
      ).toThrow(/import roots must be strings/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed config fails the factory closed (no scan with partial trust)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-config-'));
    try {
      const path = join(dir, 'fastapi.json');
      writeFileSync(path, '{ "importRoots": [".."] }', 'utf8');
      expect(() =>
        createFastapiDetector({ env: pythonEnv(), cwd: FIXTURE_ROOT, importRootsConfigPath: path }),
      ).toThrow(/repo-root-relative directory/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
