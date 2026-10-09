/**
 * The HTTP call rules R1-R5 (0.14 WP3, plan §4.3) over the exchange
 * ledger.
 *
 * One primitive, three questions the gate could not answer before:
 * - R1 USED: a route a witnessed exchange matched OR a static call site
 *   joined. Used routes already owe `http:request-observed` +
 * `http:response-status-ok`: those obligations are generated PRE-RUN by
 *   the policy engine from the same `frontendConsumed` join
 *   (`policy/evaluate.ts`), so this module never invents an obligation —
 *   it reports who is used and who has not been proven yet.
 * - R2/R3: a witnessed call that matches no route, or matches several at
 *   equal specificity, is a real defect — `HTTP_CALL_UNMATCHED` /
 *   `HTTP_CALL_AMBIGUOUS`.
 * - R4: a static call site the join could not resolve, with its
 *   `file:line` — `HTTP_CALL_UNRESOLVED`. It reads the unresolved
 *   call-site facts the graph ALREADY carries (`FRONTEND_CALL_TARGET_UNRESOLVED`);
 *   it never scans anything itself.
 * - R5: served-but-never-used is a COUNT, never a finding: the visible
 *   denominator, so an untested route cannot hide behind a green gate.
 *
 * `served` excludes endpoints whose router is never proven mounted
 * (plan finding 13: an unmounted router is not a served route).
 *
 * NOTHING here changes a verdict: the rules add findings and one
 * summary, and the channel those findings block on is the owner's
 * declaration (`http.callFindings`), never this module's judgement.
 */
import { compareStrings } from '../graph/util.js';
import { sha256Canonical } from '../canonical-json.js';
import { CAUSE_NEXT_ACTIONS, type CauseCode } from '../schemas/verdict.js';
import type { Location } from '../schemas/common.js';
import type { BlockingEntry } from '../policy/evaluate.js';
import type { HttpLedger, HttpLedgerRow } from './http-ledger.js';
import { HTTP_REQUEST_OBSERVED, HTTP_RESPONSE_STATUS_OK } from '../schemas/behavior-policy.js';

/** A witnessed call that matches no route in the run's inventory. */
export const HTTP_CALL_UNMATCHED = 'HTTP_CALL_UNMATCHED';
/** A witnessed response proves the app answered, but not that inventory is complete. */
export const HTTP_ROUTE_NOT_INVENTORIED = 'HTTP_ROUTE_NOT_INVENTORIED';

/** A witnessed call that matches several routes at equal specificity. */
export const HTTP_CALL_AMBIGUOUS = 'HTTP_CALL_AMBIGUOUS';

/** A static call site whose URL the join could not compute. */
export const HTTP_CALL_UNRESOLVED = 'HTTP_CALL_UNRESOLVED';

/**
 * The static-scanner code for exactly "a frontend call whose target
 * cannot be resolved statically". Read from the graph's unresolved
 * entries; the constant is restated here because core cannot depend on
 * `@gate-forge/http-contract` (same lockstep rule as
 * `HTTP_OBSERVATION_UNTRUSTED` in pack-verifiers).
 */
const FRONTEND_CALL_TARGET_UNRESOLVED = 'FRONTEND_CALL_TARGET_UNRESOLVED';

/** Every typed call-finding code this module mints. */
export type HttpCallFindingCode =
  | typeof HTTP_CALL_UNMATCHED
  | typeof HTTP_CALL_AMBIGUOUS
  | typeof HTTP_CALL_UNRESOLVED
  | typeof HTTP_ROUTE_NOT_INVENTORIED;

/** Which channel the call findings block on (owner-declared). */
export type HttpCallFindingsMode = 'report' | 'block';

/** One route of the served/used denominator, as the graph states it. */
export interface HttpCoverageRoute {
  /** The `http.endpoint` graph resource id. */
  resourceId: string;
  /** The static join: a frontend call resolved onto this route. */
  consumed: boolean;
  /** The joined static call sites, `file:line:col`. */
  callSites: readonly string[];
  /**
   * Proofs that this route's router is mounted on the scanned app (plan
   * finding 13). Empty means "no mount proof"; it is read as "proven
   * unmounted" only when {@link HttpCoverageInput.mountProvenanceEmitted}
   * says the detector emitted the fact at all.
   */
  mountProvenances: readonly string[];
}

/** The minimum a verdict must say for the proven/missing counts. */
export interface HttpCoverageVerdict {
  resourceId: string;
  contract: string;
  verdict: string;
}

/** One unresolved static entry, as the graph carries it. */
export interface HttpCoverageUnresolved {
  code: string;
  detail: string;
  location: Location;
}

/** Everything the rules read. */
export interface HttpCoverageInput {
  /** The run's route table, one entry per `http.endpoint` resource. */
  routes: readonly HttpCoverageRoute[];
  /**
   * Whether this run's detector emitted mount provenance anywhere. Until
   * a detector proves it (plan finding 13), NO route is subtracted from
   * `served`: an absent proof is unknown served-ness, never proof of an
   * unmounted router, and a summary line reading "0 served" would be a
   * wrong report, not a conservative one.
   */
  mountProvenanceEmitted?: boolean;
  /** The run's exchange ledger; null/absent for a run without exchanges. */
  ledger?: HttpLedger | null;
  /** The run's graded obligations (this run's scoped verdicts). */
  verdicts?: readonly HttpCoverageVerdict[];
  /** The graph's unresolved entries (R4's only source). */
  unresolvedCallSites?: readonly HttpCoverageUnresolved[];
  /** The owner's channel declaration; it never changes WHAT is found. */
  mode?: HttpCallFindingsMode;
}

/** One typed finding about a call the product makes. */
export interface HttpCallFinding {
  code: HttpCallFindingCode;
  /** The route the call belongs to, when it belongs to one. */
  resourceId: string | null;
  /** The source location, when the call has one (R4 always does). */
  location: Location | null;
  /** A readable name for the call. It is not the identity; see `fingerprint`. */
  key: string;
  /**
   * The identity the adoption receipt records (0.14 WP5 D1): a sha256 over
   * the call's identity, never its status or line. Equal fingerprints are
   * one debt.
   */
  fingerprint: string;
  detail: string;
}

/** One used route whose two transport obligations are not both satisfied. */
export interface HttpMissingRoute {
  resourceId: string;
  /** The witnessing tests whose exchange matched this route. */
  ledgerCallers: readonly string[];
  /** The static call sites joined onto this route. */
  callSites: readonly string[];
}

/** The one summary line's numbers (plan §4.5). */
export interface HttpCoverageSummary {
  /** Route-table size excluding endpoints with empty `mountProvenances`. */
  served: number;
  /** Served routes a witnessed exchange matched OR a static call joined. */
  used: number;
  /** Used routes whose two transport obligations are both satisfied. */
  proven: number;
  /** Used routes that are not proven. */
  missing: number;
  /** Ledger rows the one resolver could not place on any route. */
  unmatched: number;
  /** Ledger rows the one resolver placed on several equal candidates. */
  ambiguous: number;
  /** Route inventory availability for safe unmatched-call adjudication. */
  inventory?: 'complete' | 'incomplete' | 'unavailable';
}

/** What R1-R5 produced. */
export interface HttpCoverageResult {
  summary: HttpCoverageSummary;
  findings: HttpCallFinding[];
  missingRoutes: HttpMissingRoute[];
}

/** The two contracts R1's routes owe; both satisfied ⇒ proven. */
const TRANSPORT_CONTRACTS: readonly string[] = [HTTP_REQUEST_OBSERVED, HTTP_RESPONSE_STATUS_OK];

/**
 * Whether one route counts as served. An endpoint is only subtracted
 * from the denominator when the detector emitted mount provenance at all
 * and THIS route carries none of it (plan finding 13's `unmounted`).
 *
 * Args:
 *   route: one route of the table.
 *   mountProvenanceEmitted: whether the run carries mount proofs.
 *
 * Returns:
 *   boolean: true when the route is in the served denominator.
 */
function isServed(route: HttpCoverageRoute, mountProvenanceEmitted: boolean): boolean {
  return !mountProvenanceEmitted || route.mountProvenances.length > 0;
}

/**
 * Collects the callers of every used route: the witnessing tests whose
 * ledger row matched it, plus its joined static call sites.
 *
 * Args:
 *   routes: the run's route table.
 *   ledger: the run's exchange ledger (null when there is none).
 *   mountProvenanceEmitted: whether the run carries mount proofs.
 *
 * Returns:
 *   Map<string, HttpMissingRoute>: one entry per served route with at
 *   least one caller (a matched ledger row or a static join).
 */
function usedRoutes(
  routes: readonly HttpCoverageRoute[],
  ledger: HttpLedger | null,
  mountProvenanceEmitted: boolean,
): Map<string, HttpMissingRoute> {
  const used = new Map<string, HttpMissingRoute>();
  const serve = (route: HttpCoverageRoute, callers: readonly string[]): void => {
    const entry = used.get(route.resourceId);
    const ledgerCallers = [...new Set([...(entry?.ledgerCallers ?? []), ...callers])].sort(compareStrings);
    const callSites = [...new Set([...(entry?.callSites ?? []), ...route.callSites])].sort(compareStrings);
    used.set(route.resourceId, { resourceId: route.resourceId, ledgerCallers, callSites });
  };
  for (const route of routes) {
    if (!isServed(route, mountProvenanceEmitted)) continue;
    if (route.consumed) serve(route, []);
  }
  for (const entry of ledger?.rows ?? []) {
    if (entry.kind !== 'api' || entry.resolution !== 'match' || entry.route === null) continue;
    const route = routes.find((candidate) => candidate.resourceId === entry.route);
    // A row matched by the resolver can only name a route of the same
    // inventory; an id the table does not carry is never invented here.
    if (route === undefined || !isServed(route, mountProvenanceEmitted)) continue;
    serve(route, [entry.testId]);
  }
  return used;
}

/** The domain tag separating call-finding identities from every other hash. */
const HTTP_CALL_FINGERPRINT_DOMAIN = 'gateforge.http-call-finding.v1';

/** A path segment that is an id: all digits, a UUID, or a 16+ char hex run. */
const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/**
 * The shape of a call's path (0.14 WP5 D1): the query and fragment are
 * dropped and every id segment collapses to `:id`, so `/items/42` and
 * `/items/97` are one call shape.
 *
 * Args:
 *   path: the raw path the witness recorded.
 *
 * Returns:
 *   string: the path shape.
 */
function pathShape(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? '';
  return bare.split('/').map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment)).join('/');
}


/**
 * Reads one ledger row's placement into a finding, or null when the
 * placement is not a defect (a match, or an inventory that could not be
 * attributed — `incomplete` stays unknown, never a finding).
 *
 * Repeated identical calls collapse into ONE finding listing every
 * observed status: one bug is one finding, not a wall of duplicates.
 *
 * Args:
 *   rows: the ledger rows sharing one (test, method, path).
 *   code: the finding code to mint.
 *
 * Returns:
 *   HttpCallFinding | null: the finding, or null when nothing is wrong.
 */
function rowFinding(
  rows: readonly HttpLedger['rows'][number][],
  code: typeof HTTP_CALL_UNMATCHED | typeof HTTP_CALL_AMBIGUOUS | typeof HTTP_ROUTE_NOT_INVENTORIED,
): HttpCallFinding | null {
  const first = rows[0];
  if (first === undefined) return null;
  const statuses = [...new Set(rows.map((entry) => String(entry.status)))].sort(compareStrings);
  const call = `'${first.method} ${first.path}'`;
  const shape = pathShape(first.path);
  const identity = {
    domain: HTTP_CALL_FINGERPRINT_DOMAIN,
    code,
    method: first.method,
    pathShape: shape,
    testId: first.testId,
  };
  const named = {
    key: `${code} ${first.method} ${shape} (test ${first.testId})`,
    fingerprint: sha256Canonical(identity),
  };
  if (code === HTTP_CALL_UNMATCHED || code === HTTP_ROUTE_NOT_INVENTORIED) {
    return {
      code,
      resourceId: null,
      location: null,
      ...named,
      detail:
        code === HTTP_CALL_UNMATCHED
          ? `test '${first.testId}' called ${call} which matched no route in the run's inventory (HTTP ${statuses.join(', ')})`
          : `the app served ${first.method} ${first.path} (HTTP ${statuses.join(', ')}) but the route inventory has no such route — the inventory is incomplete; check the detector for this framework`,
    };
  }
  const candidates = [
    ...new Set(rows.flatMap((entry) => entry.candidates ?? [])),
  ].sort(compareStrings);
  return {
    code,
    resourceId: null,
    location: null,
    ...named,
    detail:
      `test '${first.testId}' called ${call} which matches ${String(candidates.length)} routes at ` +
      `equal specificity (${candidates.join('; ')})`,
  };
}

/**
 * The call findings, in a deterministic order: by code, then resource,
 * then detail.
 *
 * Args:
 *   ledger: the run's exchange ledger.
 *   unresolved: the graph's unresolved entries.
 *
 * Returns:
 *   HttpCallFinding[]: the run's call findings.
 */
function callFindings(
  ledger: HttpLedger | null,
  unresolved: readonly HttpCoverageUnresolved[],
): HttpCallFinding[] {
  const findings: HttpCallFinding[] = [];
  const grouped = new Map<string, HttpLedger['rows'][number][]>();
  for (const entry of ledger?.rows ?? []) {
    if (entry.kind !== 'api' || (entry.resolution !== 'nomatch' && entry.resolution !== 'ambiguous')) continue;
    const code =
      entry.resolution === 'ambiguous'
        ? HTTP_CALL_AMBIGUOUS
        : entry.status === 404 || entry.status === 405
          ? HTTP_CALL_UNMATCHED
          : HTTP_ROUTE_NOT_INVENTORIED;
    const key = `${code}\u0000${entry.testId}\u0000${entry.method}\u0000${pathShape(entry.path)}`;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [entry]);
    else bucket.push(entry);
  }
  for (const [key, rows] of grouped) {
    const code = key.slice(0, key.indexOf('\u0000')) as
      | typeof HTTP_CALL_UNMATCHED
      | typeof HTTP_CALL_AMBIGUOUS
      | typeof HTTP_ROUTE_NOT_INVENTORIED;
    const finding = rowFinding(rows, code);
    if (finding !== null) findings.push(finding);
  }
  for (const entry of unresolved) {
    if (entry.code !== FRONTEND_CALL_TARGET_UNRESOLVED) continue;
    const identity = {
      domain: HTTP_CALL_FINGERPRINT_DOMAIN,
      code: HTTP_CALL_UNRESOLVED,
      file: entry.location.file,
      detail: entry.detail,
    };
    findings.push({
      code: HTTP_CALL_UNRESOLVED,
      resourceId: null,
      location: entry.location,
      key: `${HTTP_CALL_UNRESOLVED} ${entry.location.file}: ${entry.detail}`,
      fingerprint: sha256Canonical(identity),
      detail:
        `${entry.code}: ${entry.detail} — ${entry.location.file}:${String(entry.location.line)}`,
    });
  }
  findings.sort(
    (left, right) =>
      compareStrings(left.code, right.code) ||
      compareStrings(left.resourceId ?? '', right.resourceId ?? '') ||
      compareStrings(left.detail, right.detail),
  );
  // Equal identities are one debt: a repeated call counts once.
  const unique = new Map<string, HttpCallFinding>();
  for (const finding of findings) {
    if (!unique.has(finding.fingerprint)) unique.set(finding.fingerprint, finding);
  }
  return [...unique.values()];
}

/**
 * Applies R1-R5 to one run.
 *
 * Args:
 *   input: the route table, the ledger, the graded obligations, the
 *     graph's unresolved entries and the owner's channel declaration.
 *
 * Returns:
 *   HttpCoverageResult: the summary line's numbers, the typed findings
 *   (identical in both modes) and the used-but-unproven routes with
 *   their callers.
 */
export function evaluateHttpCoverage(input: HttpCoverageInput): HttpCoverageResult {
  const routes = [...input.routes].sort((left, right) => compareStrings(left.resourceId, right.resourceId));
  const ledger = input.ledger ?? null;
  const mountProvenanceEmitted = input.mountProvenanceEmitted === true;
  const used = usedRoutes(routes, ledger, mountProvenanceEmitted);
  const verdicts = input.verdicts ?? [];
  const proven = new Set<string>();
  for (const [resourceId] of used) {
    const states = TRANSPORT_CONTRACTS.map(
      (contract) => verdicts.find((entry) => entry.resourceId === resourceId && entry.contract === contract)?.verdict,
    );
    // A waiver is a recorded forgiveness, not proof: only two
    // `satisfied` verdicts prove the route.
    if (states.every((state) => state === 'satisfied')) proven.add(resourceId);
  }
  const missingRoutes = [...used.values()]
    .filter((entry) => !proven.has(entry.resourceId))
    .sort((left, right) => compareStrings(left.resourceId, right.resourceId));
  const rows = ledger?.rows ?? [];
  return {
    summary: {
      served: routes.filter((route) => isServed(route, mountProvenanceEmitted)).length,
      used: used.size,
      proven: proven.size,
      missing: missingRoutes.length,
      unmatched: rows.filter(
        (entry) =>
          entry.kind === 'api' &&
          entry.resolution === 'nomatch' &&
          (entry.status === 404 || entry.status === 405),
      ).length,
      ambiguous: rows.filter((entry) => entry.kind === 'api' && entry.resolution === 'ambiguous').length,
      ...((ledger?.summary.inventory ?? (routes.length === 0 ? 'unavailable' : 'complete')) === 'complete'
        ? {}
        : { inventory: ledger?.summary.inventory ?? 'unavailable' }),
    },
    findings: callFindings(ledger, input.unresolvedCallSites ?? []),
    missingRoutes,
  };
}

/**
 * Projects the call findings onto the report's existing finding channel
 * (`kind: 'finding'`, typed cause, the shared next action), so text, json
 * and SARIF render them like every other finding.
 *
 * The CHANNEL is the caller's decision (the owner's `http.callFindings`):
 * this function only shapes the entries.
 *
 * Args:
 *   findings: the run's call findings.
 *
 * Returns:
 *   BlockingEntry[]: one entry per finding, deterministically ordered.
 */
export function httpCallFindingEntries(findings: readonly HttpCallFinding[]): BlockingEntry[] {
  return findings.map((finding) => ({
    kind: 'finding' as const,
    resourceId: finding.resourceId,
    name: null,
    detail: `${finding.code}: ${finding.detail}`,
    location: finding.location,
    cause: finding.code as CauseCode,
    nextAction: CAUSE_NEXT_ACTIONS[finding.code as CauseCode],
  }));
}

/**
 * Projects the witness's body-shape findings (0.14 WP4) onto the finding
 * channel: one entry per mismatched or refused exchange, in ledger order.
 * `ok` and `unchecked` rows are not findings. The CHANNEL is the caller's
 * decision (`http.responseShape: report` surfaces them as advisories; the
 * `block` setting fails through the body obligation instead).
 *
 * Args:
 *   rows: the run's ledger rows.
 *
 * Returns:
 *   BlockingEntry[]: one entry per mismatch or refusal.
 */
export function httpResponseShapeEntries(rows: readonly HttpLedgerRow[]): BlockingEntry[] {
  return rows
    .filter((row) => row.kind === 'api' && (row.shape === 'mismatch' || row.shape === 'refused'))
    .map((row) => {
      const cause: CauseCode = row.shape === 'mismatch' ? 'HTTP_RESPONSE_SHAPE_MISMATCH' : 'HTTP_BODY_TOO_LARGE';
      return {
        kind: 'finding' as const,
        resourceId: row.route,
        name: null,
        detail: `${cause}: ${row.testId} ${row.method} ${row.path} (status ${row.status}): ${row.shapeDetail ?? ''}`,
        location: null,
        cause,
        nextAction: CAUSE_NEXT_ACTIONS[cause],
      };
    });
}