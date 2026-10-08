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
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  compareStrings,
  fingerprintObligation,
  type HttpRouteCandidate,
  type JsonValue,
  type Obligation,
  type ResourceGraph,
  type RunManifest,
} from '@gate-forge/core';
import type { InputSnapshot } from './input-snapshot.js';
import { UsageError } from './errors.js';
import type { CandidateTreeEntry } from './candidate-tree.js';

/** Default run-state directory, repo-root-relative. */
export const DEFAULT_STATE_DIR = '.gateforge/test-gates';

/** Resolves the run-state directory: override (absolute or relative) or default. */
export function resolveStateDir(cwd: string, override?: string): string {
  return resolve(cwd, override ?? DEFAULT_STATE_DIR);
}

/**
 * The validated `registration` attribute of an `http.endpoint` resource,
 * or undefined when absent or malformed: the inventory stays fail-closed
 * (an unprovable route never carries a half-validated position). A
 * merged slash-variant identity carries `orderMax` (the raw routes'
 * latest proven order); it must never sit below `order`.
 */
function endpointRegistration(
  value: unknown,
): { scope: string; order: number; orderMax?: number } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!('scope' in value) || !('order' in value)) return undefined;
  const scope: unknown = value.scope;
  const order: unknown = value.order;
  const orderMax: unknown = 'orderMax' in value ? value.orderMax : undefined;
  if (typeof scope !== 'string' || scope.length === 0) return undefined;
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) return undefined;
  if (orderMax === undefined) return { scope, order };
  if (typeof orderMax !== 'number' || !Number.isInteger(orderMax) || orderMax < order) {
    return undefined;
  }
  return { scope, order, orderMax };
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
 * The detector-proven registration-order metadata (0.14) rides along:
 * `registration` (the route's static position in its serving app's
 * flattened registration sequence) and `typedPathParams` (the raw path
 * carries a typed convertor, so the route matches narrower than its
 * canonical shape). Both are optional; the resolver treats their
 * absence as "no provable order".
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
    const linkedResourceName = resource.attributes['linkedResourceName'];
    const capabilities = resource.attributes['capabilities'];
    const registration = endpointRegistration(resource.attributes['registration']);
    routes.push({
      resourceId: resource.id,
      method: typeof method === 'string' ? method : '',
      canonicalPath: typeof canonicalPath === 'string' ? canonicalPath : '',
      ...(typeof linkedResourceName === 'string' ? { linkedResourceName } : {}),
      ...(Array.isArray(capabilities)
        ? { capabilities: capabilities.filter((value): value is string => typeof value === 'string') }
        : {}),
      ...(registration !== undefined ? { registration } : {}),
      ...(resource.attributes['typedPathParams'] === true ? { typedPathParams: true } : {}),
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
      fingerprint: fingerprintObligation(obligation),
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
  /** Frontend build mode when exposed by standard build environment variables. */
  frontendBuildMode?: string;
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

/**
 * Writes one JSON document into the state dir (creating it), or into
 * a subdirectory of it when `name` carries one.
 *
 * The state dir is shared with the witness and later `check` runs, and a
 * run's processes can be killed at any point (a container exiting ends
 * everything in it). The document goes to a temporary file first and
 * replaces the old one by rename, so a kill leaves the previous document
 * or the new one, never a truncated file.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   name: the document name, optionally inside a subdirectory.
 *   value: the document to write.
 *
 * Returns:
 *   void.
 */
export function writeStateFile(stateDir: string, name: string, value: JsonValue): void {
  const target = join(stateDir, name);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, 'utf8');
  renameSync(temporary, target);
}

/** Persists the validated run manifest. */
export function writeManifest(stateDir: string, manifest: RunManifest): void {
  writeStateFile(stateDir, 'manifest.json', manifest as unknown as JsonValue);
}

/** Persists the input inventory for authenticated stale-input diagnosis. */
export function writeInputSnapshot(stateDir: string, snapshot: InputSnapshot): void {
  writeStateFile(stateDir, 'input-snapshot.json', snapshot as unknown as JsonValue);
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
 * Persists the route inventory the twin-shape recorder resolves
 * request paths against (E64).
 *
 * It is the engine's own compiled `http.endpoint` list, written ONLY
 * when the owner configured `enforcement.twinPaths`: a repository
 * without that key never grows this file, and its runs stay
 * byte-identical. The witness reads it so a recorded shape names a
 * route TEMPLATE (`/accounts/{}`) instead of a concrete id.
 */
export function writeTwinInventory(path: string, templates: readonly string[]): void {
  const document = {
    schemaVersion: 1,
    templates: [...new Set(templates)].sort(compareStrings),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${canonicalJson(document as unknown as JsonValue)}\n`, 'utf8');
}

/**
 * Persists the twin shapes this run observed (E64): per test, the
 * logical key, whether the session was observation-only, and the
 * request SHAPES it exercised.
 *
 * Shapes and logical keys only — never a URL, a body or a
 * non-allowlisted query value — so the document is safe to read, diff
 * and paste into a bug. It is diagnostic: no gate reads it, and a
 * shape in it can satisfy nothing.
 */
export function writeTwinShapes(
  stateDir: string,
  twins: readonly {
    logicalKey: string;
    observationOnly: boolean;
    shapes: readonly { method: string; route: string; query?: Record<string, string> }[];
  }[],
): void {
  writeStateFile(stateDir, 'twin-shapes.json', {
    schemaVersion: 1,
    twins: [...twins].sort((left, right) => compareStrings(left.logicalKey, right.logicalKey)),
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
  operatorEnv: NodeJS.ProcessEnv = process.env,
): TestGatesEnv {
  const configuredBuildMode =
    operatorEnv['VITE_MODE']?.trim() || operatorEnv['NODE_ENV']?.trim();
  const record: TestGatesEnv = {
    GATEFORGE_RUN_ID: manifest.runId,
    GATEFORGE_RUN_TOKEN: runToken ?? randomUUID(),
    GATEFORGE_STATE_DIR: stateDir,
    GATEFORGE_OBLIGATIONS: join(stateDir, 'obligations.json'),
    GATEFORGE_WITNESS_URL: witnessUrl,
    ...(configuredBuildMode === undefined || configuredBuildMode.length === 0
      ? {}
      : { frontendBuildMode: configuredBuildMode }),
  };
  writeStateFile(stateDir, 'env.json', record as unknown as JsonValue);
  return record;
}

/** Persists the canonical json-format run report. */
export function writeReport(stateDir: string, report: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'report.json'), `${report}\n`, 'utf8');
}

/**
 * Reads one optional JSON state document (Phase 4): absent → null;
 * present-but-invalid → UsageError (fail closed — a corrupted
 * supervision artifact is never silently ignored).
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   name: file name inside the state dir.
 *
 * Returns:
 *   unknown | null: the parsed document, or null when absent.
 *
 * Throws:
 *   UsageError: when the file exists but is not valid JSON.
 */
export function readStateDocument(stateDir: string, name: string): unknown | null {
  const path = join(stateDir, name);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'EACCES' || code === 'EPERM') {
      const info = lstatSync(path);
      const currentUid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
      throw new UsageError(
        `state file exists at '${path}' but is not readable by uid ${String(currentUid)} ` +
          `(owner uid ${String(info.uid)}) — rerun the suite as this user or fix ownership`,
      );
    }
    throw new UsageError(`cannot read '${path}': ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`state file '${path}' is not valid JSON: ${(error as Error).message}`);
  }
}

/** Persists the Phase 4 claim-injections document (derived run state). */
export function writeClaimInjections(
  stateDir: string,
  injections: Record<string, string[]>,
): void {
  writeStateFile(stateDir, 'claim-injections.json', {
    schemaVersion: 1,
    injections,
  } as unknown as JsonValue);
}

/** Advisory timing data for the most recently completed full test run. */
export interface LastFullRunSummary {
  /** Number of tests selected by that full run. */
  testCount: number;
  /** Wall-clock duration of the supervised test execution in milliseconds. */
  durationMs: number;
}

/**
 * Persists advisory cost data for a completed full test run.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   summary: selected test count and measured execution duration.
 *
 * Returns:
 *   void.
 */
export function writeLastFullRunSummary(stateDir: string, summary: LastFullRunSummary): void {
  writeStateFile(stateDir, 'last-full-run.json', {
    schemaVersion: 1,
    testCount: summary.testCount,
    durationMs: summary.durationMs,
  });
}

/**
 * Reads advisory full-run cost data without letting it affect gate trust.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   LastFullRunSummary | null: valid saved cost data, or null when missing
 *   or unusable.
 */
export function readLastFullRunSummary(stateDir: string): LastFullRunSummary | null {
  let document: unknown;
  try {
    document = readStateDocument(stateDir, 'last-full-run.json');
  } catch {
    return null;
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;
  const testCount = record['testCount'];
  const durationMs = record['durationMs'];
  if (
    record['schemaVersion'] !== 1 ||
    typeof testCount !== 'number' ||
    !Number.isSafeInteger(testCount) ||
    testCount < 0 ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return null;
  }
  return { testCount, durationMs };
}

/** Persists the sealed supervision execution result. */
export function writeExecutionResult(stateDir: string, result: unknown): void {
  writeStateFile(stateDir, 'execution-result.json', result as JsonValue);
}

/** Persists the authenticated gate receipt. */
export function writeGateReceipt(stateDir: string, receipt: unknown): void {
  writeStateFile(stateDir, 'receipt.json', receipt as JsonValue);
}

/**
 * Persists the run record of a whole-suite run that sealed no receipt.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   record: the authenticated run record.
 *
 * Returns:
 *   void.
 */
export function writeRunRecord(stateDir: string, record: unknown): void {
  writeStateFile(stateDir, 'run-record.json', record as JsonValue);
}

/**
 * Removes the retained run record. A gate receipt supersedes it (the
 * receipt is the same evidence plus a verdict), so a sealed run never
 * leaves a stale parent behind for the next one to re-seal from.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   void.
 */
export function clearRunRecord(stateDir: string): void {
  rmSync(join(stateDir, 'run-record.json'), { force: true });
}

/**
 * Persists the run-scope view the in-runner reporter reads.
 *
 * A reporter that graded a named test list or a changed slice observed
 * no repository-wide debt, and must say so instead of printing a
 * repository verdict the CLI never asked for. The view is derived run
 * state, written before the suite starts, and read by nothing the gate
 * trusts.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   scope: the scope this run actually grades.
 *
 * Returns:
 *   void.
 */
export function writeRunScopeView(stateDir: string, scope: 'full' | 'changed' | 'named'): void {
  writeStateFile(stateDir, 'run-scope.json', { schemaVersion: 1, scope } as unknown as JsonValue);
}

/**
 * Persists the Gateforge-owned failing-test diagnosis artifact.
 *
 * A failed witnessed test used to ship nothing but an ARIA snapshot:
 * the runner's message and stack lived in the runner log, which the CI
 * job keeps private precisely because it carries secrets. This file is
 * the screened alternative — the first error line and a short
 * `file:line` stack per failure, already passed through the credential
 * guard, never a request or response body. It is written only when the
 * progress stream is on, so a local run leaves the state directory
 * exactly as it found it.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   runId: the run that produced the failures.
 *   failures: the guarded failure records, in the order the run saw them.
 *
 * Returns:
 *   void.
 */
export function writeTestFailures(
  stateDir: string,
  runId: string,
  failures: readonly {
    logicalKey: string;
    title: string;
    message: string;
    stackFrames: string[];
  }[],
): void {
  writeStateFile(stateDir, 'failures.json', {
    schemaVersion: 1,
    runId,
    failures: failures.map((failure) => ({
      logicalKey: failure.logicalKey,
      title: failure.title,
      message: failure.message,
      stackFrames: [...failure.stackFrames],
    })),
  } as unknown as JsonValue);
}

/**
 * Persists the entries included in the sealed candidate tree.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   entries: sorted tree entries bound by the sealed receipt.
 *
 * Returns:
 *   void.
 */
export function writeCandidateTreeEntries(stateDir: string, entries: readonly CandidateTreeEntry[]): void {
  writeStateFile(stateDir, 'candidate-tree.json', entries as unknown as JsonValue);
}

/**
 * Reads the saved candidate-tree entries for mismatch diagnostics.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   CandidateTreeEntry[] | null: validated entries, or null when absent or malformed.
 */
export function readCandidateTreeEntries(stateDir: string): CandidateTreeEntry[] | null {
  const document = readStateDocument(stateDir, 'candidate-tree.json');
  if (!Array.isArray(document)) return null;
  const entries: CandidateTreeEntry[] = [];
  for (const value of document) {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.mode !== 'string' ||
      typeof value.sha !== 'string' ||
      !/^[0-9a-f]{40}$/.test(value.sha) ||
      typeof value.path !== 'string'
    ) {
      return null;
    }
    entries.push({ mode: value.mode, sha: value.sha, path: value.path });
  }
  return entries;
}

/**
 * Removes the cached gate receipt (plan Phase 4 item 8 / E07): a
 * failing supervised run invalidates any cached success for its inputs —
 * a later `check --require-e2e` must block until a fresh complete run.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 */
export function clearGateReceipt(stateDir: string): void {
  try {
    rmSync(join(stateDir, 'receipt.json'), { force: true });
  } catch {
    // Best-effort removal; an undeletable receipt still fails the
    // receipt digest checks below (execution-result no longer matches).
  }
}

/** Persists the §3.5 diagnostics report (separate from the E2E verdict). */
export function writeDiagnosticsReport(stateDir: string, report: unknown): void {
  writeStateFile(stateDir, 'diagnostics.json', report as JsonValue);
}
