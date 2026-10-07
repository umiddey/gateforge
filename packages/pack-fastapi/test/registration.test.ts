/**
 * Registration-order facts (0.14): every endpoint the detector can place
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
import { pythonEnv } from './helpers.js';
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

function factsByEffectivePath(outcome: WrapperOutcome): Record<string, Record<string, unknown>> {
  const facts: Record<string, Record<string, unknown>> = {};
  for (const resource of outcome.resources) {
    if (resource.kind !== 'http.contract') continue;
    facts[String(resource.attributes['effectivePath'])] = resource.attributes;
  }
  return facts;
}

describe('registration-order facts (0.14)', () => {
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
