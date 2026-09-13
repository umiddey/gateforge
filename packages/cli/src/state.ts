/**
 * Test-gates run state (the orchestration surface G6 consumes).
 *
 * `gateforge test-gates` materializes a run state directory (default
 * `.gateforge/test-gates/`, overridable with `--out`) before any suite
 * runs, and `gateforge check` reads the same directory. The layout is
 * the documented protocol between the CLI, G6's witness service +
 * Playwright reporter, and the verifier:
 *
 * - `manifest.json`  — pin #4 RunManifest (validated).
 * - `obligations.json` — every obligation the suite must cover, with its
 *   pin #2 fingerprint and resource source/location.
 * - `env.json`       — the ambient contract for the suite: the per-run
 *   token, run id, state dir, obligations path, and (when a witness
 *   service is wired, `--witness-url`) its URL. G6 fills the URL when it
 *   spawns the loopback witness service (pin #7, header
 *   `x-gateforge-run: <token>`; env vars `GATEFORGE_WITNESS_URL` +
 *   `GATEFORGE_RUN_TOKEN`).
 * - `claims.json` / `records.json` — reporter output: claims extracted
 *   from `{type: 'gateforge', description: '<obligation id>'}` annotations
 *   and evidence records posted through the witness service. Consumed by
 *   check/test-gates verdict evaluation (records without service-issued
 *   provenance stay claimed — GF-23).
 * - `report.json`    — the canonical json-format run report.
 *
 * All functions take ABSOLUTE directories; commands resolve the
 * repo-relative default against their cwd. Reads are fail-closed: a
 * state file that exists but is not valid JSON is a usage error (exit 2),
 * never a silent skip.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  compareStrings,
  fingerprint,
  type HttpRouteCandidate,
  type JsonValue,
  type Obligation,
  type ResourceGraph,
  type RunManifest,
} from '@gateforge/core';
import { UsageError } from './errors.js';

/** Default run-state directory, repo-root-relative. */
export const DEFAULT_STATE_DIR = '.gateforge/test-gates';

/** Resolves the run-state directory: override (absolute or relative) or default. */
export function resolveStateDir(cwd: string, override?: string): string {
  return resolve(cwd, override ?? DEFAULT_STATE_DIR);
}

/**
 * Builds the COMPLETE runtime route inventory for HTTP attribution
 * (plan §9, D2): one candidate per `http.endpoint` graph resource —
 * including routes with no frontend consumer and no generated
 * obligation. Derived from the graph only; never from a claim or
 * evidence payload. Sorted by resourceId codepoint-wise so the
 * context is deterministic (Phase 6 snapshots it).
 *
 * A malformed endpoint resource (missing method/canonicalPath) is
 * NEVER dropped: it is carried with empty fields so the core resolver
 * flags the inventory incomplete instead of claiming completeness.
 *
 * Args:
 *   graph: built resource graph.
 *
 * Returns:
 *   HttpRouteCandidate[]: sorted complete candidate list.
 */
export function httpRoutesView(graph: ResourceGraph): HttpRouteCandidate[] {
  const routes: HttpRouteCandidate[] = [];
  for (const resource of graph.resources) {
    if (resource.id === null || resource.kind !== 'http.endpoint') continue;
    const method = resource.attributes['method'];
    const canonicalPath = resource.attributes['canonicalPath'];
    routes.push({
      resourceId: resource.id,
      method: typeof method === 'string' ? method : '',
      canonicalPath: typeof canonicalPath === 'string' ? canonicalPath : '',
    });
  }
  routes.sort((a, b) => compareStrings(a.resourceId, b.resourceId));
  return routes;
}

/** One obligation as the suite must see it (identity + fingerprint). */
export interface StateObligation {
  id: string;
  resourceId: string;
  contract: string;
  policyId: string;
  lifecycle: { create: boolean; read: boolean; update: boolean; delete: boolean };
  fingerprint: string;
  source: string;
  location: { file: string; line: number; col: number } | null;
}
/**
 * Builds the suite-visible obligation list: pin-#2 fingerprints plus the
 * resource source/location from the graph (empty when the resource is
 * gone — the reporter still sees the obligation id it must cover).
 *
 * Args:
 *   obligations: policy-generated obligations.
 *   graph: built resource graph (source/location lookup).
 *
 * Returns:
 *   StateObligation[]: one entry per obligation.
 */
export function stateObligations(
  obligations: readonly Obligation[],
  graph: ResourceGraph,
): StateObligation[] {
  const lookup = new Map<string, { source: string; location: { file: string; line: number; col: number } | null }>();
  for (const resource of graph.resources) {
    if (resource.id !== null) lookup.set(resource.id, { source: resource.source, location: resource.location });
  }
  return obligations.map((obligation) => {
    const entry = lookup.get(obligation.resourceId);
    return {
      id: obligation.id,
      resourceId: obligation.resourceId,
      contract: obligation.contract,
      policyId: obligation.policyId,
      lifecycle: obligation.lifecycle,
      fingerprint: fingerprint({
        resourceId: obligation.resourceId,
        contract: obligation.contract,
        policyId: obligation.policyId,
        lifecycle: obligation.lifecycle,
      }),
      source: entry?.source ?? '',
      location: entry?.location ?? null,
    };
  });
}

/** The ambient env record written to `env.json` and exported to the suite. */
export interface TestGatesEnv {
  GATEFORGE_RUN_ID: string;
  GATEFORGE_RUN_TOKEN: string;
  GATEFORGE_STATE_DIR: string;
  GATEFORGE_OBLIGATIONS: string;
  /** Witness-service URL; null until G6 wires the loopback service. */
  GATEFORGE_WITNESS_URL: string | null;
}

/** Reads an optional JSON array state file; absent → [], invalid → error. */
export function readJsonArray(stateDir: string, name: string): unknown[] {
  const path = join(stateDir, name);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new UsageError(`cannot read '${path}': ${(error as Error).message}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`state file '${path}' is not valid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(document)) {
    throw new UsageError(`state file '${path}' must contain a JSON array`);
  }
  return document;
}

/** Writes one JSON document into the state dir (creating it). */
function writeStateFile(stateDir: string, name: string, value: JsonValue): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, name), `${canonicalJson(value)}\n`, 'utf8');
}

/** Persists the validated run manifest. */
export function writeManifest(stateDir: string, manifest: RunManifest): void {
  writeStateFile(stateDir, 'manifest.json', manifest as unknown as JsonValue);
}

/** Persists the suite-visible obligations document (sorted by id). */
export function writeObligations(
  stateDir: string,
  obligations: readonly StateObligation[],
): void {
  const sorted = [...obligations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeStateFile(stateDir, 'obligations.json', {
    schemaVersion: 1,
    obligations: sorted,
  } as unknown as JsonValue);
}


/**
 * Persists the derived runtime route inventory (plan §9, D2) for the
 * suite-side reporter: advisory context ONLY so the reporter can show
 * useful per-claim rows. The authoritative CLI recomputes this list
 * from the graph on every run and never reads this file.
 */
export function writeHttpRoutesView(stateDir: string, routes: readonly HttpRouteCandidate[]): void {
  const sorted = [...routes].sort((a, b) => compareStrings(a.resourceId, b.resourceId));
  writeStateFile(stateDir, 'http-routes.json', {
    schemaVersion: 1,
    routes: sorted.map((route) => ({
      resourceId: route.resourceId,
      method: route.method,
      canonicalPath: route.canonicalPath,
    })),
  } as unknown as JsonValue);
}

/**
 * Persists the run's effective-classification view (plan phase 5) as a
 * derived artifact for the verifier side (e.g. the witness service's
 * `GET /classifications` surface). NEVER authoritative engine input: the
 * engine recomputes classifications from signals on every run.
 */
export function writeClassificationsView(
  stateDir: string,
  view: Record<string, unknown>,
): void {
  writeStateFile(stateDir, 'classifications.json', view as unknown as JsonValue);
}

/** Persists the ambient env record and returns it (fresh token unless adopted). */
export function writeEnv(
  stateDir: string,
  manifest: RunManifest,
  witnessUrl: string | null,
  runToken?: string,
): TestGatesEnv {
  const record: TestGatesEnv = {
    GATEFORGE_RUN_ID: manifest.runId,
    GATEFORGE_RUN_TOKEN: runToken ?? randomUUID(),
    GATEFORGE_STATE_DIR: stateDir,
    GATEFORGE_OBLIGATIONS: join(stateDir, 'obligations.json'),
    GATEFORGE_WITNESS_URL: witnessUrl,
  };
  writeStateFile(stateDir, 'env.json', record as unknown as JsonValue);
  return record;
}

/** Persists the canonical json-format run report. */
export function writeReport(stateDir: string, report: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'report.json'), `${report}\n`, 'utf8');
}