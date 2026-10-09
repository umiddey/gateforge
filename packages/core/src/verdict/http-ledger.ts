/**
 * The verdict-time exchange ledger (0.14 WP2, plan §4.1): every
 * witnessed `http.exchanges` record becomes rows
 * `{testId, method, path (query stripped), status, route, resolution}`
 * resolved through the ONE resolver (`matchHttpRoute`) over the run's
 * complete route inventory — the same inventory
 * `resolveHttpRoute`/the transport verifiers grade against. The ledger
 * is REPORT-ONLY: it never changes a verdict (the satisfaction path
 * never reads `http.exchanges`), and this module is the only consumer
 * of the session-wide kind.
 */
import { compareStrings } from '../graph/util.js';
import { isProvenancedRecord } from '../provenance.js';
import { HTTP_EXCHANGES_KIND, interpretObservedPath, matchHttpRoute } from './pack-verifiers.js';
import type { HttpRouteCandidate } from './registry.js';

/** How the ONE resolver placed one witnessed exchange. */
export type HttpLedgerResolution = 'match' | 'nomatch' | 'ambiguous' | 'incomplete';

/** One ledger row: one witnessed exchange, attributed. */
export interface HttpLedgerRow {
  /** The test the exchange belongs to (`page-sweep` for sweep sessions). */
  testId: string;
  /** Uppercase request method. */
  method: string;
  /** The observed path, query stripped (the interpreted path). */
  path: string;
  /** The observed response status. */
  status: number;
  /** The serving route's resource id, or null when unresolved. */
  route: string | null;
  /** The ONE resolver's placement of the exchange. */
  resolution: HttpLedgerResolution;
  /** The equal candidates' identity texts, when the placement is ambiguous. */
  candidates?: string[];
}

/** Row counts by resolution (exchanges equals the row count). */
export interface HttpLedgerSummary {
  exchanges: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  incomplete: number;
}

/** The whole-run ledger embedded report-only in the run report JSON. */
export interface HttpLedger {
  rows: HttpLedgerRow[];
  summary: HttpLedgerSummary;
}

/** Lenient record view — the same fields the verdict engine reads. */
interface LedgerRecordLike {
  readonly trust: unknown;
  readonly testId: unknown;
  readonly kind: unknown;
  readonly payload: unknown;
}

/**
 * Reads one entry into the lenient view; non-objects are ignored (a
 * hostile reporter may emit anything).
 */
function asLedgerRecord(value: unknown): LedgerRecordLike | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    trust: record['trust'],
    testId: record['testId'],
    kind: record['kind'],
    payload: record['payload'],
  };
}

/**
 * Builds the run's exchange ledger from the run's records (the same
 * authorized set the verdict engine grades) and the complete route
 * inventory.
 *
 * Only WITNESSED `http.exchanges` records count (`witnessed` tier with
 * verifying provenance — the same rule `trustOf` applies elsewhere);
 * every well-formed exchange entry of theirs becomes one row, resolved
 * by `matchHttpRoute`. Malformed entries and non-ledger records are
 * skipped, never guessed.
 *
 * Args:
 *   records: the run's records (untrusted, lenient).
 *   httpRoutes: the complete host-derived route inventory (the same
 *     input core passes to `resolveHttpRoute`); null/undefined resolves
 *     every row `nomatch` — an empty inventory matches nothing.
 *
 * Returns:
 *   HttpLedger: rows sorted by (testId, method, path, status) and the
 *   resolution summary.
 */
export function buildHttpLedger(
  records: readonly unknown[],
  httpRoutes: readonly HttpRouteCandidate[] | null | undefined,
): HttpLedger {
  const rows: HttpLedgerRow[] = [];
  for (const raw of Array.isArray(records) ? records : []) {
    const record = asLedgerRecord(raw);
    if (record === null) continue;
    if (record.kind !== HTTP_EXCHANGES_KIND) continue;
    if (typeof record.testId !== 'string' || record.testId.length === 0) continue;
    // Ledger evidence is witness-issued only: the same provenance rule
    // the verdict engine applies before it trusts a record's tier.
    if (!(record.trust === 'witnessed' && isProvenancedRecord(raw))) continue;
    if (typeof record.payload !== 'object' || record.payload === null) continue;
    const exchanges = (record.payload as Record<string, unknown>)['exchanges'];
    if (!Array.isArray(exchanges)) continue;
    for (const entry of exchanges) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const exchange = entry as Record<string, unknown>;
      const method = exchange['method'];
      const url = exchange['url'];
      const status = exchange['status'];
      if (typeof method !== 'string' || method.length === 0) continue;
      if (typeof url !== 'string' || url.length === 0) continue;
      if (typeof status !== 'number' || !Number.isInteger(status)) continue;
      // The same path interpretation the transport verifiers run;
      // an uninterpretable URL degrades to its query-stripped text.
      const interpreted = interpretObservedPath(url);
      const path = interpreted.ok ? interpreted.path : (url.split(/[?#]/, 1)[0] ?? url);
      const resolution = matchHttpRoute(method, path, httpRoutes ?? []);
      rows.push({
        testId: record.testId,
        method: method.toUpperCase(),
        path,
        status,
        route: resolution.status === 'match' ? resolution.matched.resourceId : null,
        resolution: resolution.status,
        ...(resolution.status === 'ambiguous' ? { candidates: [...resolution.candidates] } : {}),
      });
    }
  }
  rows.sort(
    (left, right) =>
      compareStrings(left.testId, right.testId) ||
      compareStrings(left.method, right.method) ||
      compareStrings(left.path, right.path) ||
      compareStrings(String(left.status), String(right.status)),
  );
  const summary: HttpLedgerSummary = { exchanges: rows.length, matched: 0, unmatched: 0, ambiguous: 0, incomplete: 0 };
  for (const row of rows) {
    if (row.resolution === 'match') summary.matched += 1;
    else if (row.resolution === 'nomatch') summary.unmatched += 1;
    else if (row.resolution === 'ambiguous') summary.ambiguous += 1;
    else summary.incomplete += 1;
  }
  return { rows, summary };
}
