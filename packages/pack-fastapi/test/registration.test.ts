/**
 * Registration-order facts: every endpoint the detector can place
 * statically in an app's flattened registration sequence carries
 * `registration: {scope, order}` — include call order across routers,
 * decorator source order within one router. Fail closed: a route appended
 * to a router AFTER it was included, and a route declared inside a
 * function body, carry NO registration (their static position is not
 * provable). A typed path convertor (`{n:int}`) sets `typedPathParams`.
 *
 * Engine-class test: deterministic, offline (files + the spawned python
 * detector only).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pythonEnv, runDetector } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { createFastapiDetector } from '../src/detector.js';
import { dirname, join } from 'node:path';

interface WrapperOutcome {
  resources: ReadonlyArray<{ kind: string; id: string; attributes: Record<string, unknown> }>;
  unresolved: ReadonlyArray<Record<string, unknown>>;
  scannedPaths?: string[];
}

/** The fixture app: two routers, include call order, a late route, a nested route. */
const APP_MAIN = [
  'from fastapi import FastAPI, APIRouter',
  '',
  'app = FastAPI()',
  'items = APIRouter(prefix="/items")',
  'extra = APIRouter(prefix="/extra")',
  '',
  '@items.get("/export")',
  'def export_items():',
  '    return {}',
  '',
  '@items.get("/{item_id}")',
  'def get_item(item_id: int):',
  '    return {}',
  '',
  '@extra.get("/counts/{n:int}")',
  'def counts(n: int):',
  '    return {}',
  '',
  'app.include_router(items)',
  'app.include_router(extra)',
  '',
  '@items.get("/late")',
  'def late_route():',
  '    return {}',
  '',
  'def register_more():',
  '    @items.get("/inside")',
  '    def inside():',
  '        return {}',
].join('\n');

/** Scans one temp project through the real python detector. */
async function scan(files: Record<string, string>): Promise<WrapperOutcome> {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-registration-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const absolute = join(dir, rel);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text, 'utf8');
    }
    const detector = createFastapiDetector({ env: pythonEnv(), cwd: dir });
    return (await detector.discover(Object.keys(files))) as unknown as WrapperOutcome;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

function factsByEffectivePath(outcome: { resources: readonly unknown[] }): Record<string, Record<string, unknown>> {
  const facts: Record<string, Record<string, unknown>> = {};
  for (const resource of outcome.resources) {
    if (!isWireFact(resource) || resource.kind !== 'http.contract') continue;
    facts[String(resource.attributes['effectivePath'])] = resource.attributes;
  }
  return facts;
}

describe('registration-order facts', () => {
  it('orders follow include call order and decorator order; fail-closed routes carry none', async () => {
    const outcome = await scan({ 'app/main.py': APP_MAIN });
    const facts = factsByEffectivePath(outcome);

    // Include call order (items first, extra second) and decorator order
    // within a router (export before {item_id}).
    expect(facts['/items/export']?.['registration']).toEqual({
      scope: 'app.main:app',
      order: 0,
    });
    expect(facts['/items/{item_id}']?.['registration']).toEqual({
      scope: 'app.main:app',
      order: 1,
    });
    expect(facts['/extra/counts/{n:int}']?.['registration']).toEqual({
      scope: 'app.main:app',
      order: 2,
    });

    // Appended after include_router: no statically provable position.
    expect(facts['/items/late']).toBeDefined();
    expect(facts['/items/late']?.['registration']).toBeUndefined();

    // Declared inside a function body: registration time is unknowable.
    expect(facts['/items/inside']).toBeDefined();
    expect(facts['/items/inside']?.['registration']).toBeUndefined();
  });

  it('a typed path convertor sets typedPathParams; plain paths do not carry it', async () => {
    const outcome = await scan({ 'app/main.py': APP_MAIN });
    const facts = factsByEffectivePath(outcome);

    expect(facts['/extra/counts/{n:int}']?.['typedPathParams']).toBe(true);
    expect(facts['/items/export']?.['typedPathParams']).toBeUndefined();
    expect(facts['/items/{item_id}']?.['typedPathParams']).toBeUndefined();
  });
});

/** Fixture file lists, relative to the fixtures root; one scan per variant. */
const BASIC_PATHS = [
  'registry-order/app/main.py',
  'registry-order/app/router_registry.py',
  'registry-order/app/items.py',
  'registry-order/app/orders.py',
  'registry-order/app/admin.py',
  'registry-order/app/sandbox.py',
  'registry-order/app/ops.py',
];

const NESTED_PATHS = [
  'registry-order/nested/app/main.py',
  'registry-order/nested/app/router_registry.py',
  'registry-order/nested/app/items.py',
  'registry-order/nested/app/orders.py',
  'registry-order/nested/app/audit.py',
  'registry-order/nested/app/sandbox.py',
];

const TWICE_PATHS = [
  'registry-order/twice/app/main.py',
  'registry-order/twice/app/router_registry.py',
  'registry-order/twice/app/items.py',
  'registry-order/twice/app/admin.py',
];

const CONDITIONAL_PATHS = [
  'registry-order/conditional/app/main.py',
  'registry-order/conditional/app/router_registry.py',
  'registry-order/conditional/app/items.py',
];

const FOREIGN_PATHS = [
  'registry-order/foreign/app/main.py',
  'registry-order/foreign/app/boot.py',
  'registry-order/foreign/app/router_registry.py',
  'registry-order/foreign/app/items.py',
];

describe('registry-function registration order', () => {
  it('expands a once-called registry function in place, in the app module statement order', async () => {
    const facts = factsByEffectivePath(await runDetector(BASIC_PATHS));
    const scope = 'registry-order.app.main:app';

    // The function's top-level includes expand at the call site, in
    // statement order; within each router, decorator source order.
    expect(facts['/api/v1/items/export']?.['registration']).toEqual({ scope, order: 0 });
    expect(facts['/api/v1/items/{item_id}']?.['registration']).toEqual({ scope, order: 1 });
    expect(facts['/api/v1/orders']?.['registration']).toEqual({ scope, order: 2 });
    expect(facts['/api/v1/orders/{order_id}']?.['registration']).toEqual({ scope, order: 3 });
    expect(facts['/api/v1/admin/reset']?.['registration']).toEqual({ scope, order: 4 });

    // The include written after the call registers after the whole
    // expansion, then the app's own route.
    expect(facts['/api/v1/ops/status']?.['registration']).toEqual({ scope, order: 5 });
    expect(facts['/health']?.['registration']).toEqual({ scope, order: 6 });
  });

  it('a literal route mounted through the function keeps the lower order over its param sibling', async () => {
    const facts = factsByEffectivePath(await runDetector(BASIC_PATHS));
    const literal = facts['/api/v1/items/export']?.['registration'] as
      | { scope: string; order: number }
      | undefined;
    const param = facts['/api/v1/items/{item_id}']?.['registration'] as
      | { scope: string; order: number }
      | undefined;
    expect(literal).toBeDefined();
    expect(param).toBeDefined();
    expect(literal?.scope).toBe(param?.scope);
    expect(literal?.order).toBeLessThan(param?.order ?? Number.MAX_SAFE_INTEGER);
  });

  it('the conditional include inside the function stays unattributable', async () => {
    const facts = factsByEffectivePath(await runDetector(BASIC_PATHS));
    expect(facts['/sandbox/echo']).toBeDefined();
    expect(facts['/sandbox/echo']?.['registration']).toBeUndefined();
  });

  it('fail-closed: a registry function called twice orders nothing', async () => {
    const facts = factsByEffectivePath(await runDetector(TWICE_PATHS));
    expect(facts['/api/v1/items/export']).toBeDefined();
    expect(facts['/api/v1/items/export']?.['registration']).toBeUndefined();
    expect(facts['/api/v1/admin/reset']?.['registration']).toBeUndefined();
  });

  it('fail-closed: a call inside a module-level if orders nothing', async () => {
    const facts = factsByEffectivePath(await runDetector(CONDITIONAL_PATHS));
    expect(facts['/api/v1/items/export']).toBeDefined();
    expect(facts['/api/v1/items/export']?.['registration']).toBeUndefined();
  });

  it('fail-closed: a call from a module that does not own the app orders nothing', async () => {
    const facts = factsByEffectivePath(await runDetector(FOREIGN_PATHS));
    expect(facts['/api/v1/items/export']).toBeDefined();
    expect(facts['/api/v1/items/export']?.['registration']).toBeUndefined();
  });

  it('fail-closed: includes nested in for/try/with stay unattributable while top-level ones order', async () => {
    const facts = factsByEffectivePath(await runDetector(NESTED_PATHS));
    const scope = 'registry-order.nested.app.main:app';

    // The one top-level include stays order-certain.
    expect(facts['/api/v1/items/export']?.['registration']).toEqual({ scope, order: 0 });
    expect(facts['/api/v1/items/{item_id}']?.['registration']).toEqual({ scope, order: 1 });

    // for / try / with bodies: no static position, no registration.
    expect(facts['/api/v1/orders']).toBeDefined();
    expect(facts['/api/v1/orders']?.['registration']).toBeUndefined();
    expect(facts['/audit/log']).toBeDefined();
    expect(facts['/audit/log']?.['registration']).toBeUndefined();
    expect(facts['/sandbox/echo']).toBeDefined();
    expect(facts['/sandbox/echo']?.['registration']).toBeUndefined();
  });
});
