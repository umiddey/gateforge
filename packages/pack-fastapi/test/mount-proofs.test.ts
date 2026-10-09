/**
 * Mount proofs (plan findings 13/13c): every route the detector reaches
 * THROUGH an app's include graph carries the chain that mounts it; a
 * router no include edge targets carries NO proof (its standalone
 * fallback emission is a claim, not a mount), and the reader is told so
 * with a report-only `HTTP_ENDPOINT_UNMOUNTED` finding.
 *
 * The chain is the SAME walk that produces `registration` (0.13.7): one
 * mount-graph traversal, no second resolver. The proof string names the
 * nodes it crossed so a reader can check the claim by hand.
 *
 * 13b: a route declared under a module-level `if` is `conditional: true`
 * — it registers only when its branch runs, so served-ness is unknown
 * statically — but the route is still MOUNTED, and the proof says so.
 *
 * Fixtures are written to a temp dir per case (neutral projects, no
 * repo-root assumptions), scanned through the real python detector.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFastapiDetector } from '../src/detector.js';
import { pythonEnv } from './helpers.js';
import { describe, expect, it } from 'vitest';

interface WrapperOutcome {
  resources: unknown[];
  unresolved: unknown[];
  findings: unknown[];
  classificationSignals: unknown[];
}

/** One code off an unresolved/finding entry; null when absent or not a string. */
function entryCode(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || !('code' in entry)) return null;
  return typeof entry.code === 'string' ? entry.code : null;
}

/** One detail off a finding entry; '' when absent or not a string. */
function entryDetail(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null || !('detail' in entry)) return '';
  return typeof entry.detail === 'string' ? entry.detail : '';
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

/** Scans one temp project through the real python detector. */
async function scan(files: Record<string, string>): Promise<WrapperOutcome> {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-fastapi-mount-'));
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

/** Facts keyed by their effective mounted path (last wins, as in the sibling file). */
function factsByEffectivePath(outcome: WrapperOutcome): Record<string, Record<string, unknown>> {
  const facts: Record<string, Record<string, unknown>> = {};
  for (const resource of outcome.resources) {
    if (!isWireFact(resource) || resource.kind !== 'http.contract') continue;
    facts[String(resource.attributes['effectivePath'])] = resource.attributes;
  }
  return facts;
}

/** Every mount proof on the wire, sorted (one fact per mount). */
function mountProofs(outcome: WrapperOutcome): string[] {
  return outcome.resources
    .filter(isWireFact)
    .filter((resource) => resource.kind === 'http.contract')
    .map((resource) => resource.attributes['mountProvenance'])
    .filter((value): value is string => typeof value === 'string')
    .sort();
}

/** app → api_router → items_router, plus a router nobody includes. */
const MOUNT_GRAPH: Record<string, string> = {
  'app/main.py': [
    'from fastapi import FastAPI',
    '',
    'from app.api import api_router',
    '',
    'app = FastAPI()',
    'app.include_router(api_router, prefix="/api/v1")',
  ].join('\n'),
  'app/api.py': [
    'from fastapi import APIRouter',
    '',
    'from app.items import items_router',
    '',
    'api_router = APIRouter()',
    'api_router.include_router(items_router)',
  ].join('\n'),
  'app/items.py': [
    'from fastapi import APIRouter',
    '',
    'items_router = APIRouter(prefix="/items")',
    '',
    '',
    '@items_router.get("/export")',
    'def export_items():',
    '    return {}',
  ].join('\n'),
  'app/orphan.py': [
    'from fastapi import APIRouter',
    '',
    'orphan_router = APIRouter(prefix="/orphan")',
    '',
    '',
    '@orphan_router.get("/ping")',
    'def ping():',
    '    return {}',
  ].join('\n'),
};

describe('mount proofs: a router reached through the app carries its include chain', () => {
  it('names every node the walk crossed, root app first', async () => {
    const facts = factsByEffectivePath(await scan(MOUNT_GRAPH));
    const proof = facts['/api/v1/items/export']?.['mountProvenance'];

    expect(typeof proof).toBe('string');
    // The chain is app → api_router → items_router, in the order the
    // edges execute: the root app, then each router it reaches.
    expect(String(proof)).toBe(
      'include-chain:app.main:app → app.api:api_router → app.items:items_router',
    );
  });

  it('a route declared straight on the app proves the app itself, with no router hop', async () => {
    const facts = factsByEffectivePath(
      await scan({
        'app/main.py': [
          'from fastapi import FastAPI',
          '',
          'app = FastAPI()',
          '',
          '',
          '@app.get("/health")',
          'def health():',
          '    return {}',
        ].join('\n'),
      }),
    );

    expect(facts['/health']?.['mountProvenance']).toBe('include-chain:app.main:app');
  });
});

describe('mount proofs: a router no include edge targets carries none', () => {
  it('emits the standalone route WITHOUT a mount proof', async () => {
    const outcome = await scan(MOUNT_GRAPH);
    const facts = factsByEffectivePath(outcome);

    // The route is still a claim — it exists in source — but nothing
    // mounts it, so it must NOT claim a proof. A proof here is exactly
    // what would make core's `isServed` call dead code served.
    expect(facts['/orphan/ping']).toBeDefined();
    expect(facts['/orphan/ping']?.['mountProvenance']).toBeUndefined();

    // The sibling router IS mounted, so the scan did prove mounts: the
    // empty proof is per-route, not a detector that proved nothing.
    expect(facts['/api/v1/items/export']?.['mountProvenance']).toBeDefined();
  });

  it('names the unmounted router in a report-only HTTP_ENDPOINT_UNMOUNTED finding', async () => {
    const outcome = await scan(MOUNT_GRAPH);
    const unmounted = outcome.findings.filter(
      (entry) => entryCode(entry) === 'HTTP_ENDPOINT_UNMOUNTED',
    );

    expect(unmounted).toHaveLength(1);
    expect(entryDetail(unmounted[0])).toContain('orphan_router');
    expect(entryDetail(unmounted[0])).toContain('app/orphan.py');
  });

  it('reports no unmounted finding when nothing is mounted at all (no app in the set)', async () => {
    const outcome = await scan({
      'app/orphan.py': [
        'from fastapi import APIRouter',
        '',
        'orphan_router = APIRouter(prefix="/orphan")',
        '',
        '',
        '@orphan_router.get("/ping")',
        'def ping():',
        '    return {}',
      ].join('\n'),
    });

    // The mounting code may simply be outside the scanned set: "unmounted"
    // is not provable without an app, so no finding is minted.
    const codes = outcome.findings.map(entryCode);
    expect(codes).not.toContain('HTTP_ENDPOINT_UNMOUNTED');
    expect(factsByEffectivePath(outcome)['/orphan/ping']).toBeDefined();
  });

  it('keeps the typed blocking entry for an unresolvable include instead of claiming mounts', async () => {
    const outcome = await scan({
      'app/main.py': [
        'from fastapi import FastAPI',
        '',
        'app = FastAPI()',
        'app.include_router(built_elsewhere, prefix="/x")',
      ].join('\n'),
    });

    // The mount graph is not proven, so nothing may be called unmounted
    // and the typed unresolved entry stays the honest outcome.
    const unresolved = outcome.unresolved.map(entryCode);
    expect(unresolved).toContain('FASTAPI_PREFIX_UNRESOLVED');
    const codes = outcome.findings.map(entryCode);
    expect(codes).not.toContain('HTTP_ENDPOINT_UNMOUNTED');
  });
});

describe('mount proofs: a second app object is its own scope', () => {
  it('carries the dev app identity, never the main app it shares routers with', async () => {
    const outcome = await scan({
      'app/main.py': [
        'from fastapi import FastAPI',
        '',
        'from app.items import items_router',
        '',
        'app = FastAPI()',
        'app.include_router(items_router, prefix="/api")',
      ].join('\n'),
      'app/dev.py': [
        'from fastapi import FastAPI',
        '',
        'from app.items import items_router',
        '',
        'dev_app = FastAPI()',
        'dev_app.include_router(items_router, prefix="/dev")',
      ].join('\n'),
      'app/items.py': [
        'from fastapi import APIRouter',
        '',
        'items_router = APIRouter(prefix="/items")',
        '',
        '',
        '@items_router.get("/export")',
        'def export_items():',
        '    return {}',
      ].join('\n'),
    });

    // Two mounts of one router = two facts, one per app, each naming its
    // OWN app: the proof must never borrow the main app's scope.
    const proofs = mountProofs(outcome).filter((proof) => proof.includes('items_router'));

    expect(proofs).toEqual([
      'include-chain:app.dev:dev_app → app.items:items_router',
      'include-chain:app.main:app → app.items:items_router',
    ]);
  });
});

describe('mount proofs: a route under a module-level if (13b)', () => {
  it('is conditional, still proves its mount, and the unconditional sibling is not', async () => {
    const facts = factsByEffectivePath(
      await scan({
        'app/main.py': [
          'import os',
          '',
          'from fastapi import APIRouter, FastAPI',
          '',
          'app = FastAPI()',
          'router = APIRouter()',
          '',
          'if os.environ.get("DEBUG") != "0":',
          '',
          '    @router.get("/tasks/debug")',
          '    def debug_tasks():',
          '        return {}',
          '',
          '',
          '@router.get("/tasks/{task_id}")',
          'def get_task(task_id: int):',
          '    return {}',
          '',
          'app.include_router(router, prefix="/api")',
        ].join('\n'),
      }),
    );

    // Both routes hang off the module-level `router`, so both proofs
    // name the router hop: app → router.
    const chain = 'include-chain:app.main:app → app.main:router';

    // 13b: served-ness is unknown statically — the route exists only
    // when its branch runs. Marked, not dropped.
    expect(facts['/api/tasks/debug']?.['conditional']).toBe(true);

    // It IS mounted (its router is included), so the proof stands and
    // core keeps counting it served.
    expect(facts['/api/tasks/debug']?.['mountProvenance']).toBe(chain);

    // The unconditional sibling carries no conditional flag.
    expect(facts['/api/tasks/{task_id}']?.['conditional']).toBeUndefined();
    expect(facts['/api/tasks/{task_id}']?.['mountProvenance']).toBe(chain);
  });
});