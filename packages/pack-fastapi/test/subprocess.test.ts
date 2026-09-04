/**
 * Phase 2 subprocess tests: the real python AST detector over GPP/3,
 * wrapped by the pack's canonicalization and signal minting.
 * Engine-class tests: deterministic, offline (spawn + files only).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClassificationSignalSchema, ResourceSchema } from '@gateforge/core';
import { createFastapiDetector } from '../src/detector.js';
import { PACK_PLUGIN_ID, PACK_VERSION } from '../src/version.js';
import { ALL_FIXTURES, FIXTURE_ROOT, pythonEnv, runDetector, runDiscover } from './helpers.js';

interface FactView {
  id: string;
  kind: string;
  location: { file: string; line: number };
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

describe('fastapi detector (subprocess, real python)', () => {
  it('reports every literal route as a canonical contract fact', async () => {
    const outcome = await runDetector([
      'simple/main.py',
      'simple/routers.py',
      'simple/standalone.py',
    ]);
    expect(outcome.findings).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
    expect(effectivePaths(outcome).sort()).toEqual([
      'DELETE /items/{}',
      'GET /admin/stats',
      'GET /api/accounts',
      'GET /api/accounts/{}',
      'GET /api/health/ready',
      'GET /items',
      'GET /items/{}',
      'POST /api/accounts',
      'POST /items',
    ]);
  });

  it('composes repeated mounts: one router mounted twice yields two facts', async () => {
    const outcome = await runDetector(['app/main.py', 'app/routers.py', 'app/alias.py']);
    const paths = effectivePaths(outcome);
    expect(paths.filter((path) => path === 'GET /api/v1/items/{}')).toHaveLength(1);
    expect(paths.filter((path) => path === 'GET /api/latest/items/{}')).toHaveLength(1);
    expect(paths.filter((path) => path === 'POST /api/v1/items')).toHaveLength(1);
    expect(paths.filter((path) => path === 'POST /api/latest/items')).toHaveLength(1);
    // The alias-declared route joined the defining router and both mounts.
    expect(paths.filter((path) => path === 'GET /api/v1/items/{}')).toHaveLength(1);
    expect(
      facts(outcome.resources).some(
        (fact) => fact.attributes['handlerSymbol'] === 'app.alias:aliased_route',
      ),
    ).toBe(true);
    expect(outcome.unresolved).toEqual([]);
  });

  it('resolves imports from a source-root package alias', async () => {
    const outcome = await runDetector(['source-root/main.py', 'source-root/api/routers.py']);
    expect(effectivePaths(outcome)).toContain('GET /api/v1/accounts');
    expect(outcome.unresolved).toEqual([]);
  });

  it('carries canonical paths, raw paths, schemas, and provenance on facts', async () => {
    const outcome = await runDetector(['simple/main.py']);
    const create = facts(outcome.resources).find(
      (fact) => fact.attributes['handlerSymbol'] === 'simple.main:create_account',
    );
    expect(create).toBeDefined();
    expect(create?.attributes['method']).toBe('POST');
    expect(create?.attributes['rawPath']).toBe('/api/accounts');
    expect(create?.attributes['normalizedPath']).toBe('/api/accounts');
    expect(create?.attributes['responseModel']).toBe('AccountOut');
    expect(create?.attributes['requestSchemaSymbols']).toEqual(['AccountIn']);
    expect(create?.attributes['tags']).toEqual(['accounts']);
    expect(create?.attributes['operationId']).toBe('create-account');
    expect(create?.attributes['isAsync']).toBe(true);

    const get = facts(outcome.resources).find(
      (fact) => fact.attributes['handlerSymbol'] === 'simple.main:get_account',
    );
    expect(get?.attributes['normalizedPath']).toBe('/api/accounts/{}');
    expect(get?.attributes['rawPath']).toBe('/api/accounts/{account_id}');
    // Path params never leak into the request-schema facts.
    expect(get?.attributes['requestSchemaSymbols']).toEqual([]);
  });

  it('blocks computed prefixes and computed paths with typed entries', async () => {
    const outcome = await runDiscover(['simple/computed.py']);
    expect(facts(outcome.resources)).toEqual([]);
    const codes = outcome.unresolved.map((entry) => entry['code']);
    expect(codes).toContain('FASTAPI_PREFIX_UNRESOLVED');
    expect(codes).toContain('HTTP_PATH_DYNAMIC');
    for (const entry of outcome.unresolved) {
      expect(entry['location']).toHaveProperty('file', 'simple/computed.py');
    }
  });

  it('reports unsupported verbs instead of dropping the route', async () => {
    const outcome = await runDiscover(['unsupported.py']);
    expect(facts(outcome.resources)).toEqual([]);
    expect(outcome.unresolved.map((entry) => entry['code'])).toContain('HTTP_METHOD_DYNAMIC');
  });

  it('keeps syntax errors as PARSE_ERROR findings and never counts them scanned', async () => {
    const outcome = await runDiscover(['simple/broken.py', 'simple/main.py']);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.['code']).toBe('PARSE_ERROR');
    expect(outcome.findings[0]?.['locations']?.[0]).toMatchObject({ file: 'simple/broken.py' });
    expect(outcome.scannedPaths).toEqual(['simple/main.py']);
  });

  it('mints exposure/lifecycle signals for name-derivable routes only', async () => {
    const outcome = await runDetector(['simple/main.py']);
    const signals = outcome.classificationSignals.map(
      (signal: unknown) => {
        const typed = signal as { dimension: string; target: { resourceName?: string } };
        return `${typed.dimension}:${typed.target?.['resourceName']}`;
      },
    );
    expect(signals).toContain('exposure:accounts');
    expect(signals).toContain('lifecycle.create:accounts');
    expect(signals).toContain('lifecycle.read:accounts');
    expect(signals).toContain('exposure:ready');
    // No signals carry a foreign detector identity (host authority tie).
    for (const signal of outcome.classificationSignals) {
      const detector = (signal as { detector: { id: string; version: string } })['detector'];
      expect(detector).toEqual({ id: PACK_PLUGIN_ID, version: PACK_VERSION });
    }
  });

  it('validates every fact against the core ResourceSchema and every signal', async () => {
    const outcome = await runDetector([...ALL_FIXTURES]);
    for (const resource of outcome.resources) {
      const parsed = ResourceSchema.safeParse(resource);
      expect(parsed.success).toBe(true);
    }
    for (const signal of outcome.classificationSignals) {
      const parsed = ClassificationSignalSchema.safeParse(signal);
      expect(parsed.success).toBe(true);
    }
  });

  it('is byte-identical across two fresh sessions (input permutation too)', async () => {
    const first = await runDetector([...ALL_FIXTURES]);
    const second = await runDetector([...ALL_FIXTURES].reverse());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('in-process transport matches the subprocess transport byte for byte', async () => {
    const detector = createFastapiDetector({ env: pythonEnv(), cwd: FIXTURE_ROOT });
    const outcome = await detector.discover([...ALL_FIXTURES]);
    const reference = await runDetector([...ALL_FIXTURES]);
    expect(JSON.stringify(outcome)).toBe(JSON.stringify(reference));
  });

  it('raw GPP surface carries uncanonicalized facts and no signals', async () => {
    const raw = await runDiscover(['simple/main.py']);
    const rawFacts = facts(raw.resources);
    expect(rawFacts.length).toBeGreaterThan(0);
    expect(rawFacts.every((fact) => fact.attributes['normalizedPath'] === '')).toBe(true);
    expect(raw.classificationSignals).toEqual([]);
  });

  it('keeps the python and TS pack versions in lockstep', async () => {
    const init = readFileSync(
      fileURLToPath(new URL('../python/gateforge_fastapi_detector/__init__.py', import.meta.url)),
      'utf8',
    );
    expect(init).toContain(`VERSION = "${PACK_VERSION}"`);
  });
});
