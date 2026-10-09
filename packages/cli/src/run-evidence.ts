/**
 * Evidence-backed `tests suggest --from-run`.
 *
 * A witnessed run already observes, per test, every API request each page
 * made (the 0.13 page observer records them as `apiStatuses` entries on
 * `page.observed` payloads, each carrying the method). This module turns
 * those observations into suggestions: same-origin app API exchanges with
 * a status under 400 are matched against the CURRENT endpoint inventory
 * under the shared router semantics (`routeMatchKind` — a literal segment
 * beats a parameter, more than one equal match is ambiguous and never
 * guessed), and every observation contract an endpoint owes that no test
 * declares and the run did not already satisfy is suggested together with
 * the tests that exercised it and the exact `tests mark` command.
 *
 * Pure module: record/route matching and aggregation only. All file I/O
 * and output rendering stays in `commands/tests.ts`.
 */
import { EvidenceRecordSchema, type ResourceGraph, type TestCatalog } from '@gate-forge/core';
import {
  canonicalEndpointIdentity,
  HTTP_METHODS,
  routeMatchKind,
  type HttpContractFact,
  type HttpLocation,
  type HttpMethod,
  type RouteMatchKind,
} from '@gate-forge/http-contract';
import { shellQuote } from './args.js';
import { httpRoutesView } from './state.js';

/** The observation contracts run evidence can speak for. */
export const RUN_EVIDENCE_CONTRACTS: readonly string[] = ['http:request-observed', 'http:response-status-ok'];

/** One app API exchange a test's page made, query dropped. */
export interface RunExchange {
  /** The runner-side test identity the witnessing session carried. */
  testId: string;
  /** Uppercase wire method. */
  method: string;
  /** URL pathname (query dropped). */
  path: string;
  status: number;
}

/** One endpoint inventory option the matcher may join to. */
export interface InventoryRoute {
  resourceId: string;
  method: HttpMethod;
  canonicalPath: string;
}

/**
 * The endpoint inventory the matcher joins against: one option per
 * `http.endpoint` graph resource (`httpRoutesView`), with malformed
 * entries (empty method or path — the resolver flags those separately)
 * dropped. A route registered `ANY` stays in the inventory but never
 * joins, exactly as in the static join.
 *
 * Args:
 *   graph: the built resource graph.
 *
 * Returns:
 *   InventoryRoute[]: sorted by resourceId codepoint-wise.
 */
export function inventoryRoutes(graph: ResourceGraph): InventoryRoute[] {
  const routes: InventoryRoute[] = [];
  for (const candidate of httpRoutesView(graph)) {
    if (candidate.method === '' || candidate.canonicalPath === '') continue;
    if (!(HTTP_METHODS as readonly string[]).includes(candidate.method)) continue;
    routes.push({
      resourceId: candidate.resourceId,
      method: candidate.method as HttpMethod,
      canonicalPath: candidate.canonicalPath,
    });
  }
  return routes;
}

/** The exchanges collected from one run's records. */
export interface ObservedRunExchanges {
  /** page.observed records of the OBSERVED channel (never the sweep referee). */
  records: number;
  /** Same-origin (or proxied) app API exchanges with a status under 400. */
  exchanges: RunExchange[];
}

/**
 * Collects the observed-channel app API exchanges from a run's raw
 * records. A record counts only when it is a witnessed engine-observed
 * `page.observed` record of the OBSERVED channel for a real test (never
 * `page-sweep`, the referee). An exchange counts only when it carries a
 * method (pre-0.13.2 runs wrote none), is same-origin with the visited
 * page or was proxied by the witness, and answered with a status under
 * 400: a 5xx is the server's answer about a broken endpoint, not usage
 * evidence for a suggestion.
 *
 * Args:
 *   rawRecords: the run's `records.json` entries, untrusted.
 *
 * Returns:
 *   ObservedRunExchanges: the record and exchange counts, exchanges
 *   sorted by (testId, method, path, status). One visit payload — the
 *   `page:loads`/`page:data-ok` record pair shares one — contributes its
 *   exchanges once.
 */
export function exchangesFromRecords(rawRecords: readonly unknown[]): ObservedRunExchanges {
  const exchanges: RunExchange[] = [];
  const seenPayloads = new Set<string>();
  let records = 0;
  for (const raw of rawRecords) {
    const parsed = EvidenceRecordSchema.safeParse(raw);
    if (!parsed.success) continue;
    const record = parsed.data;
    if (
      record.kind !== 'page.observed' ||
      record.origin !== 'engine-observed' ||
      record.trust !== 'witnessed' ||
      typeof record.testId !== 'string' ||
      record.testId === '' ||
      record.testId === 'page-sweep' ||
      record.payload === null ||
      typeof record.payload !== 'object' ||
      Array.isArray(record.payload)
    ) {
      continue;
    }
    const payload: unknown = record.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    if (!('channel' in payload) || payload.channel !== 'observed') continue;
    records += 1;
    // The `page:loads` and `page:data-ok` promises share ONE visit
    // payload (same test, same observation sequence): its exchanges are
    // one visit's evidence, never two.
    const sequence = 'observationSequence' in payload ? payload.observationSequence : undefined;
    const payloadKey =
      typeof sequence === 'number'
        ? `${record.testId}\u0000${String(sequence)}`
        : `${record.testId}\u0000${JSON.stringify('apiStatuses' in payload ? payload.apiStatuses : null)}`;
    if (seenPayloads.has(payloadKey)) continue;
    seenPayloads.add(payloadKey);
    const finalUrl = 'finalUrl' in payload && typeof payload.finalUrl === 'string' ? tryParseUrl(payload.finalUrl) : null;
    const pageOrigin = finalUrl === null ? null : finalUrl.origin;
    const statuses = 'apiStatuses' in payload && Array.isArray(payload.apiStatuses) ? payload.apiStatuses : [];
    for (const entry of statuses) {
      if (typeof entry !== 'object' || entry === null) continue;
      const url = 'url' in entry && typeof entry.url === 'string' ? entry.url : null;
      const method = 'method' in entry && typeof entry.method === 'string' ? entry.method.toUpperCase() : '';
      const code = 'status' in entry && typeof entry.status === 'number' ? entry.status : null;
      if (url === null || method === '' || code === null || code >= 400) continue;
      const parsedUrl = tryParseUrl(url);
      if (parsedUrl === null || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) continue;
      const proxied = 'proxied' in entry && entry.proxied === true;
      if (!proxied && (pageOrigin === null || parsedUrl.origin !== pageOrigin)) continue;
      exchanges.push({ testId: record.testId, method, path: parsedUrl.pathname, status: code });
    }
  }
  exchanges.sort((left, right) =>
    compareRows(left, right, (row) => [row.testId, row.method, row.path, String(row.status)]),
  );
  return { records, exchanges };
}

/** What the matcher decided about one exchange. */
export type ExchangeMatch =
  | { kind: 'matched'; route: InventoryRoute }
  | { kind: 'ambiguous'; candidates: InventoryRoute[] }
  | { kind: 'unmatched' };

/**
 * Matches one exchange against the endpoint inventory under the shared
 * router semantics: LITERAL PRECEDENCE partitions candidates exactly as
 * the static join does, so a literal segment shadows a parameter match,
 * and more than one surviving match is ambiguous — reported, never
 * guessed. Routes registered `ANY` never join.
 *
 * Args:
 *   routes: the discovered endpoint inventory (`httpRoutesView`).
 *   method: the exchange's uppercase method.
 *   path: the exchange's pathname (query already dropped).
 *
 * Returns:
 *   ExchangeMatch: the one route, the ambiguous candidate set, or no match.
 */
export function routeForExchange(
  routes: readonly InventoryRoute[],
  method: string,
  path: string,
): ExchangeMatch {
  const call = callFact(method, path);
  if (call === null) return { kind: 'unmatched' };
  const matched: Array<{ route: InventoryRoute; kind: RouteMatchKind }> = [];
  for (const route of routes) {
    if (route.method === 'ANY') continue;
    const kind = routeMatchKind(routeFact(route), call);
    if (kind !== null) matched.push({ route, kind });
  }
  const literal = matched.filter((entry) => entry.kind === 'literal');
  const pool = literal.length > 0 ? literal : matched;
  if (pool.length === 0) return { kind: 'unmatched' };
  if (pool.length > 1) return { kind: 'ambiguous', candidates: pool.map((entry) => entry.route) };
  return { kind: 'matched', route: pool[0]!.route };
}

/** One evidence row attached to a suggestion (test key resolved when possible). */
export type EvidenceRow = RunExchange & { testResolved: string | null };

/** One endpoint whose observation contracts the run's evidence can answer. */
export interface FromRunSuggestion {
  resourceId: string;
  /** Canonical identity of the matched endpoint (`METHOD path`). */
  route: string;
  /** The unsatisfied obligation ids this suggestion claims, sorted. */
  obligationIds: string[];
  /** The exchanges behind the claim, sorted, test keys resolved. */
  evidence: EvidenceRow[];
  /** The exact command when the owning test key resolved; null otherwise. */
  command: string | null;
}

/** The advisory sections and suggestions built from one run's evidence. */
export interface FromRunSuggestResult {
  runId: string;
  suggestions: FromRunSuggestion[];
  /** Exchanges that matched NO endpoint — usually an app bug. */
  unmatched: EvidenceRow[];
  /** Exchanges several endpoints match equally — reported, never guessed. */
  ambiguous: Array<EvidenceRow & { candidates: string[] }>;
  /** How many exchanges were classified. */
  considered: number;
}

export interface FromRunSuggestInput {
  runId: string;
  routes: readonly InventoryRoute[];
  obligations: ReadonlyArray<{ id: string; resourceId: string; contract: string }>;
  exchanges: readonly RunExchange[];
  /** Obligation ids the run's own report already graded satisfied or waived. */
  satisfiedObligationIds: ReadonlySet<string>;
  /** Obligation ids with a native or sidecar declaration in the current inventory. */
  mappedObligationIds: ReadonlySet<string>;
  /** Resolves a record testId to the catalog key `tests mark` accepts. */
  testKeyOf: (testId: string) => string | null;
}

/**
 * Aggregates matched exchanges into per-endpoint suggestions for the
 * observation obligations that are neither already satisfied by the run
 * nor declared by a test. A 2xx exchange can claim both observation
 * contracts; a lower non-error status only claims `http:request-observed`.
 * The command bundles every claimable obligation of one endpoint behind
 * one evidence line, exactly as `tests mark` accepts repeatable
 * `--obligation` flags.
 *
 * Args:
 *   input: routes, obligations, exchanges, and the exclusion sets.
 *
 * Returns:
 *   FromRunSuggestResult: suggestions plus the unmatched/ambiguous advisories.
 */
export function suggestFromRunEvidence(input: FromRunSuggestInput): FromRunSuggestResult {
  const matchedByResource = new Map<string, EvidenceRow[]>();
  const unmatched: EvidenceRow[] = [];
  const ambiguous: Array<EvidenceRow & { candidates: string[] }> = [];
  for (const exchange of input.exchanges) {
    const row: EvidenceRow = { ...exchange, testResolved: input.testKeyOf(exchange.testId) };
    const match = routeForExchange(input.routes, exchange.method, exchange.path);
    if (match.kind === 'unmatched') {
      unmatched.push(row);
      continue;
    }
    if (match.kind === 'ambiguous') {
      ambiguous.push({
        ...row,
        candidates: match.candidates.map((route) => canonicalEndpointIdentity(route.method, route.canonicalPath)).sort(),
      });
      continue;
    }
    const rows = matchedByResource.get(match.route.resourceId) ?? [];
    rows.push(row);
    matchedByResource.set(match.route.resourceId, rows);
  }

  const unsatisfiedByResource = new Map<string, Array<{ id: string; contract: string }>>();
  for (const obligation of input.obligations) {
    if (!RUN_EVIDENCE_CONTRACTS.includes(obligation.contract)) continue;
    if (input.satisfiedObligationIds.has(obligation.id) || input.mappedObligationIds.has(obligation.id)) continue;
    if (!matchedByResource.has(obligation.resourceId)) continue;
    const list = unsatisfiedByResource.get(obligation.resourceId) ?? [];
    if (!list.some((entry) => entry.id === obligation.id)) list.push({ id: obligation.id, contract: obligation.contract });
    unsatisfiedByResource.set(obligation.resourceId, list);
  }

  const routeById = new Map(input.routes.map((route) => [route.resourceId, route]));
  const suggestions: FromRunSuggestion[] = [];
  for (const resourceId of [...unsatisfiedByResource.keys()].sort()) {
    const route = routeById.get(resourceId);
    const rows = matchedByResource.get(resourceId) ?? [];
    if (route === undefined || rows.length === 0) continue;
    const unsatisfied = (unsatisfiedByResource.get(resourceId) ?? []).sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    // A 2xx exchange speaks for both observation contracts; a lower
    // non-error status only proves the request was observed.
    const ok = rows.filter((row) => row.status >= 200 && row.status <= 299);
    const tiers = ok.length > 0 ? [{ evidence: ok, obligations: unsatisfied }] : [];
    const requestOnly = unsatisfied.filter((obligation) => obligation.contract === 'http:request-observed');
    if (requestOnly.length > 0 && rows.some((row) => row.status < 200 || row.status > 299)) {
      tiers.push({ evidence: rows.filter((row) => row.status < 200 || row.status > 299), obligations: requestOnly });
    }
    for (const tier of tiers) {
      suggestions.push({
        resourceId,
        route: canonicalEndpointIdentity(route.method, route.canonicalPath),
        obligationIds: tier.obligations.map((obligation) => obligation.id),
        evidence: tier.evidence,
        command: commandFor(input.runId, tier.obligations.map((obligation) => obligation.id), tier.evidence),
      });
    }
  }

  const byRow = (left: EvidenceRow, right: EvidenceRow): number =>
    compareRows(left, right, (row) => [row.testId, row.method, row.path, String(row.status)]);
  suggestions.sort((left, right) =>
    left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : left.obligationIds.join(',') < right.obligationIds.join(',') ? -1 : 1,
  );
  return {
    runId: input.runId,
    suggestions,
    unmatched: unmatched.sort(byRow),
    ambiguous: ambiguous.sort((left, right) => byRow(left, right) || (left.candidates.join(',') < right.candidates.join(',') ? -1 : 1)),
    considered: input.exchanges.length,
  };
}

/** One runner-side test identity a run sealed (outcomes rows). */
export interface RunTestIdentity {
  testId: string;
  file: string;
  titlePath: readonly string[];
  project: string | null;
}

/**
 * Builds the testId → catalog logical key resolver: the same identity
 * joins the existing commands use. Direct catalog logical keys and
 * `<file>#<title path>` reconciliation keys resolve as typed; every
 * other testId resolves through the run's own outcome rows
 * (`runner-outcomes.json` / the execution envelope) by project-qualified
 * instance key, falling back to a UNIQUE reconciliation key.
 *
 * Args:
 *   catalog: the freshly discovered catalog.
 *   identities: the run's test identity rows.
 *
 * Returns:
 *   (testId: string) => string | null: the catalog key, or null when no
 *   current catalog test unambiguously owns the identity.
 */
export function testKeyResolver(
  catalog: TestCatalog,
  identities: readonly RunTestIdentity[],
): (testId: string) => string | null {
  const logicalKeys = new Set(catalog.entries.map((entry) => entry.logicalKey));
  const byInstance = new Map(
    catalog.entries.map((entry) => [
      `${entry.project ?? '-'}\u0000${entry.file}\u0000${entry.titlePath.join('>')}`,
      entry.logicalKey,
    ]),
  );
  const uniqueReconciliation = new Map<string, string | null>();
  for (const entry of catalog.entries) {
    const key = `${entry.file}#${entry.titlePath.join('>')}`;
    const previous = uniqueReconciliation.get(key);
    uniqueReconciliation.set(key, previous === undefined || previous === entry.logicalKey ? entry.logicalKey : null);
  }
  const identityByTestId = new Map<string, RunTestIdentity>();
  for (const row of identities) {
    if (row.testId !== '') identityByTestId.set(row.testId, row);
  }
  return (testId: string): string | null => {
    if (logicalKeys.has(testId)) return testId;
    const direct = uniqueReconciliation.get(testId);
    if (direct !== undefined) return direct;
    const row = identityByTestId.get(testId);
    if (row === undefined) return null;
    const instance = byInstance.get(`${row.project ?? '-'}\u0000${row.file}\u0000${row.titlePath.join('>')}`);
    if (instance !== undefined) return instance;
    return uniqueReconciliation.get(`${row.file}#${row.titlePath.join('>')}`) ?? null;
  };
}

/**
 * Builds the exact mark command for one evidence tier: repeatable
 * `--obligation` flags bundle every claimable obligation behind the first
 * qualifying evidence line. Null when no evidence row resolved to a
 * catalog key — an unresolvable test id must never produce a command that
 * `tests mark` would reject.
 */
function commandFor(
  runId: string,
  obligationIds: readonly string[],
  evidence: readonly EvidenceRow[],
): string | null {
  const line = evidence.find((row) => row.testResolved !== null);
  if (line === undefined || line.testResolved === null || obligationIds.length === 0) return null;
  return (
    `gateforge tests mark --test ${shellQuote(line.testResolved)} --kind observed-e2e ` +
    obligationIds.map((id) => `--obligation ${shellQuote(id)}`).join(' ') +
    ` --reason ${shellQuote(`observed in run ${runId}: ${line.method} ${line.path} -> ${String(line.status)}`)}`
  );
}

/** The route side of the matcher: canonical inventory route as a fact. */
function routeFact(route: InventoryRoute): HttpContractFact {
  return {
    schemaVersion: 1,
    role: 'server-route',
    method: route.method,
    normalizedPath: route.canonicalPath,
    rawPath: route.canonicalPath,
    framework: 'gateforge.inventory',
    source: inventoryLocation,
  };
}

/** The call side of the matcher: one concrete observed exchange. */
function callFact(method: string, path: string): HttpContractFact | null {
  if (!(HTTP_METHODS as readonly string[]).includes(method) || method === 'ANY' || path === '') return null;
  return {
    schemaVersion: 1,
    role: 'frontend-call',
    method: method as HttpMethod,
    normalizedPath: path,
    rawPath: path,
    framework: 'browser',
    source: inventoryLocation,
  };
}

const inventoryLocation: HttpLocation = { file: 'run://page-observations', line: 1, col: 0 };

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Deterministic row ordering over the given string projection. */
function compareRows<T>(left: T, right: T, projection: (row: T) => readonly string[]): number {
  const leftKeys = projection(left);
  const rightKeys = projection(right);
  for (let index = 0; index < leftKeys.length; index += 1) {
    const a = leftKeys[index] ?? '';
    const b = rightKeys[index] ?? '';
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}
