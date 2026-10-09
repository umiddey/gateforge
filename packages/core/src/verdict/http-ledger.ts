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

/** How the one resolver placed one witnessed exchange. */
export type HttpLedgerResolution = 'match' | 'nomatch' | 'ambiguous' | 'incomplete';

/** Whether the observed request represents API, page, asset or unknown traffic. */
export type HttpLedgerKind = 'api' | 'page' | 'asset' | 'unknown';

/** The witness's body-vs-model verdict as the ledger shows it (0.14 WP4). */
export type HttpLedgerShape = 'ok' | 'mismatch' | 'unchecked' | 'refused';

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
  /** Sec-Fetch-Dest classification; only `api` may produce R2/R3 findings. */
  kind: HttpLedgerKind;
  /** The serving route's resource id, or null when unresolved. */
  route: string | null;
  /** The ONE resolver's placement of the exchange. */
  resolution: HttpLedgerResolution;
  /** The equal candidates' identity texts, when the placement is ambiguous. */
  candidates?: string[];
  /** The witness's body-vs-model verdict, when the exchange carried one (0.14 WP4). */
  shape?: HttpLedgerShape;
  /** The first mismatch pointer and message, or the refusal cause. */
  shapeDetail?: string;
}

/** Row counts by resolution (exchanges equals the row count). */
export interface HttpLedgerSummary {
  exchanges: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  incomplete: number;
  inventory?: 'complete' | 'incomplete' | 'unavailable';
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
 * Reads the witness's body verdict for one exchange (0.14 WP4) into the
 * ledger's display fields. Absent or unrecognized input yields null, so
 * rows for exchanges without a body check keep their existing shape.
 */
function ledgerShapeOf(value: unknown): { shape: HttpLedgerShape; shapeDetail?: string } | null {
  if (typeof value !== 'object' || value === null || !('verdict' in value)) return null;
  const verdict: unknown = value.verdict;
  if (verdict === 'ok') return { shape: 'ok' };
  if (verdict === 'unchecked') return { shape: 'unchecked' };
  if (verdict === 'refused') return { shape: 'refused', shapeDetail: 'HTTP_BODY_TOO_LARGE' };
  if (verdict !== 'mismatch') return null;
  const errors: unknown = 'errors' in value ? value.errors : undefined;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const pointer: unknown =
    typeof first === 'object' && first !== null && 'pointer' in first ? first.pointer : undefined;
  const message: unknown =
    typeof first === 'object' && first !== null && 'message' in first ? first.message : undefined;
  const where = typeof pointer === 'string' && pointer !== '' ? pointer : '(document root)';
  const what = typeof message === 'string' ? message : 'does not match the declared schema';
  return { shape: 'mismatch', shapeDetail: `${where} ${what}` };
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
      const shape = ledgerShapeOf(exchange['shape']);
      const fetchDest = exchange['fetchDest'];
      const kind: HttpLedgerKind =
        fetchDest === 'empty'
          ? 'api'
          : fetchDest === 'document' || fetchDest === 'iframe'
            ? 'page'
            : fetchDest === null || fetchDest === undefined
              ? 'unknown'
              : 'asset';
      const resolution =
        httpRoutes === null || httpRoutes === undefined || httpRoutes.length === 0
          ? { status: 'incomplete' as const, reason: 'route inventory unavailable' }
          : matchHttpRoute(method, path, httpRoutes);
      rows.push({
        testId: record.testId,
        method: method.toUpperCase(),
        path,
        status,
        kind,
        route: resolution.status === 'match' ? resolution.matched.resourceId : null,
        resolution: resolution.status,
        ...(resolution.status === 'ambiguous' ? { candidates: [...resolution.candidates] } : {}),
        ...(shape === null ? {} : shape),
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
  const inventory =
    httpRoutes === null || httpRoutes === undefined || httpRoutes.length === 0
      ? 'unavailable'
      : rows.some((row) => row.resolution === 'incomplete')
        ? 'incomplete'
        : 'complete';
  const summary: HttpLedgerSummary = {
    exchanges: rows.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    incomplete: 0,
    ...(inventory === 'complete' ? {} : { inventory }),
  };
  for (const row of rows) {
    if (row.kind !== 'api') continue;
    if (row.resolution === 'match') summary.matched += 1;
    else if (row.resolution === 'nomatch') summary.unmatched += 1;
    else if (row.resolution === 'ambiguous') summary.ambiguous += 1;
    else summary.incomplete += 1;
  }
  return { rows, summary };
}
