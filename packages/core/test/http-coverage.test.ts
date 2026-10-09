/**
 * The HTTP call rules R1-R5 (0.14 WP3, plan §4.3) on the exchange
 * ledger: what counts as USED (a ledger match or a static join), the
 * `HTTP_CALL_*` findings, and the one summary line.
 *
 * Two invariants are pinned here because a wrong refusal is as bad as a
 * missed fake:
 * - the rules never change a verdict (report or block), and
 * - a run with no witnessed exchanges still prints the summary line and
 *   changes nothing else.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateHttpCoverage,
  httpCallFindingEntries,
  type HttpCallFinding,
  type HttpCoverageRoute,
  type HttpCoverageVerdict,
} from '../src/verdict/http-coverage.js';
import type { HttpLedger } from '../src/verdict/http-ledger.js';

const X = 'http.endpoint:GET /x';
const ITEMS = 'http.endpoint:GET /items/{}';
const ACTIONS = 'http.endpoint:GET /items/actions';
const DEAD = 'http.endpoint:GET /dead';

/** One route of the served/used denominator. */
function route(partial: Partial<HttpCoverageRoute> & { resourceId: string }): HttpCoverageRoute {
  return { consumed: false, callSites: [], mountProvenances: [], ...partial };
}

/** One ledger row. */
function row(partial: Partial<HttpLedger['rows'][number]> & { testId: string; path: string }): HttpLedger['rows'][number] {
  return { method: 'GET', status: 200, route: null, resolution: 'nomatch', ...partial };
}

/** One ledger with the given rows. */
function ledger(rows: HttpLedger['rows']): HttpLedger {
  return {
    rows,
    summary: {
      exchanges: rows.length,
      matched: rows.filter((entry) => entry.resolution === 'match').length,
      unmatched: rows.filter((entry) => entry.resolution === 'nomatch').length,
      ambiguous: rows.filter((entry) => entry.resolution === 'ambiguous').length,
      incomplete: rows.filter((entry) => entry.resolution === 'incomplete').length,
    },
  };
}

/** The two transport obligations of a route, as graded. */
function transportVerdicts(resourceId: string, verdict: string): HttpCoverageVerdict[] {
  return [
    { resourceId, contract: 'http:request-observed', verdict },
    { resourceId, contract: 'http:response-status-ok', verdict },
  ];
}

const SERVED = [
  route({ resourceId: X, consumed: true, callSites: ['frontend/api.ts:12:2'] }),
  route({ resourceId: ITEMS }),
  route({ resourceId: ACTIONS }),
  route({ resourceId: DEAD, consumed: true, callSites: ['frontend/dead.ts:3:0'] }),
];

/**
 * The same table once a detector emits mount provenance (plan finding
 * 13): every route carries a proof except `DEAD`, whose router is proven
 * unmounted, so it leaves the served denominator.
 */
const MOUNTED_TABLE = [
  ...SERVED.slice(0, 3).map((entry) => ({ ...entry, mountProvenances: ['app.include_router(api_router)'] })),
  SERVED[3] as HttpCoverageRoute,
];

describe('R1/R5 — used is a ledger match or a static join; served is the route table', () => {
  it('counts served, used, proven and missing over the route table', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([row({ testId: 'tests/a#one', path: '/x', route: X, resolution: 'match' })]),
      verdicts: transportVerdicts(X, 'satisfied'),
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(result.summary).toEqual({
      served: 4,
      used: 2,
      proven: 1,
      missing: 1,
      unmatched: 0,
      ambiguous: 0,
    });
    // The statically consumed DEAD route owes its obligations and has not
    // proved them: R5 counts it, it is never a finding.
    expect(result.missingRoutes.map((entry) => entry.resourceId)).toEqual([DEAD]);
  });

  it('counts a statically consumed route as used and names its static call site as caller', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([]),
      verdicts: transportVerdicts(X, 'missing'),
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(result.summary.used).toBe(2);
    expect(result.summary.proven).toBe(0);
    expect(result.summary.missing).toBe(2);
    expect(result.missingRoutes).toContainEqual({
      resourceId: X,
      ledgerCallers: [],
      callSites: ['frontend/api.ts:12:2'],
    });
  });

  it('names the witnessing test as caller for a route the ledger matched', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([
        row({ testId: 'tests/a#one', path: '/x', route: X, resolution: 'match' }),
        row({ testId: 'tests/b#two', path: '/x', route: X, resolution: 'match' }),
      ]),
      verdicts: transportVerdicts(DEAD, 'satisfied'),
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(result.missingRoutes).toContainEqual({
      resourceId: X,
      ledgerCallers: ['tests/a#one', 'tests/b#two'],
      callSites: ['frontend/api.ts:12:2'],
    });
    // No transport verdict at all for X is unproven, never silently proven.
    expect(result.summary.proven).toBe(1);
    expect(result.summary.missing).toBe(1);
  });

  it('proves a route only when BOTH transport obligations are satisfied', () => {
    const halfProven = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([row({ testId: 'tests/a#one', path: '/x', route: X, resolution: 'match' })]),
      verdicts: [
        { resourceId: X, contract: 'http:request-observed', verdict: 'satisfied' },
        { resourceId: X, contract: 'http:response-status-ok', verdict: 'missing' },
        ...transportVerdicts(DEAD, 'satisfied'),
      ],
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(halfProven.summary).toMatchObject({ used: 2, proven: 1, missing: 1 });

    const waived = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([row({ testId: 'tests/a#one', path: '/x', route: X, resolution: 'match' })]),
      verdicts: [...transportVerdicts(X, 'waived'), ...transportVerdicts(DEAD, 'satisfied')],
      unresolvedCallSites: [],
      mode: 'report',
    });
    // A waiver is a recorded forgiveness, not proof.
    expect(waived.summary).toMatchObject({ proven: 1, missing: 1 });
  });

  it('subtracts a proven-unmounted route only once the detector emits the fact', () => {
    const withoutTheFact = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([row({ testId: 'tests/a#one', path: '/dead', route: DEAD, resolution: 'match' })]),
      verdicts: transportVerdicts(DEAD, 'satisfied'),
      unresolvedCallSites: [],
      mode: 'report',
    });
    // No detector emits mount provenance yet: an absent proof is unknown
    // served-ness, never proof that the router is dead code.
    expect(withoutTheFact.summary.served).toBe(4);

    const withTheFact = evaluateHttpCoverage({
      routes: MOUNTED_TABLE,
      ledger: ledger([row({ testId: 'tests/a#one', path: '/dead', route: DEAD, resolution: 'match' })]),
      verdicts: transportVerdicts(DEAD, 'satisfied'),
      unresolvedCallSites: [],
      mountProvenanceEmitted: true,
      mode: 'report',
    });
    // The proven-unmounted route leaves the denominator entirely; only
    // the mounted, statically consumed X remains used (and unproven).
    expect(withTheFact.summary).toMatchObject({ served: 3, used: 1, proven: 0, missing: 1 });
    expect(withTheFact.missingRoutes.map((entry) => entry.resourceId)).toEqual([X]);
  });
});

describe('R2/R3 — an unmatched or ambiguous witnessed call is a finding', () => {
  it('names the test, method, path and status of an unmatched call', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([
        row({ testId: 'tests/a#one', method: 'POST', path: '/nowhere', status: 404 }),
      ]),
      verdicts: [],
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(result.summary).toMatchObject({ unmatched: 1, ambiguous: 0 });
    expect(result.findings).toEqual([
      {
        code: 'HTTP_CALL_UNMATCHED',
        resourceId: null,
        location: null,
        detail:
          "test 'tests/a#one' called 'POST /nowhere' which matched no route in the run's inventory (HTTP 404)",
      },
    ]);
  });

  it('collapses repeated identical calls into one finding listing every status', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([
        row({ testId: 'tests/a#one', method: 'GET', path: '/nowhere', status: 404 }),
        row({ testId: 'tests/a#one', method: 'GET', path: '/nowhere', status: 500 }),
      ]),
      verdicts: [],
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.detail).toContain('HTTP 404, 500');
  });

  it('names the candidates of an ambiguous call', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([
        row({
          testId: 'tests/a#one',
          path: '/items/actions',
          resolution: 'ambiguous',
          candidates: ['GET /items/actions (http.endpoint:GET /items/actions)', 'GET /items/{} (http.endpoint:GET /items/{})'],
        }),
      ]),
      verdicts: [],
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(result.summary).toMatchObject({ unmatched: 0, ambiguous: 1 });
    expect(result.findings[0]).toMatchObject({ code: 'HTTP_CALL_AMBIGUOUS' });
    expect(result.findings[0]?.detail).toContain('GET /items/actions (http.endpoint:GET /items/actions)');
  });

  it('never turns an incomplete placement into a finding', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([
        row({ testId: 'tests/a#one', path: '/items/actions', resolution: 'incomplete' }),
      ]),
      verdicts: [],
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(result.findings).toEqual([]);
    expect(result.summary).toMatchObject({ unmatched: 0, ambiguous: 0 });
  });
});

describe('R4 — a static call site the join could not resolve', () => {
  it('carries the file:line of an unresolved call target', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([]),
      verdicts: [],
      unresolvedCallSites: [
        {
          code: 'FRONTEND_CALL_TARGET_UNRESOLVED',
          detail: 'call target cannot be resolved statically (fetch)',
          location: { file: 'frontend/api.ts', line: 42, col: 4 },
        },
      ],
      mode: 'report',
    });
    expect(result.findings).toEqual([
      {
        code: 'HTTP_CALL_UNRESOLVED',
        resourceId: null,
        location: { file: 'frontend/api.ts', line: 42, col: 4 },
        detail:
          'FRONTEND_CALL_TARGET_UNRESOLVED: call target cannot be resolved statically (fetch) — frontend/api.ts:42',
      },
    ]);
  });

  it('ignores unresolved entries that are not frontend call sites', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: ledger([]),
      verdicts: [],
      unresolvedCallSites: [
        {
          code: 'ENDPOINT_SEMANTICS_UNRESOLVED',
          detail: "endpoint 'DELETE /x' deletes 'items' with no positive semantics",
          location: { file: 'backend/routes.py', line: 9, col: 0 },
        },
      ],
      mode: 'report',
    });
    expect(result.findings).toEqual([]);
  });
});

describe('the call findings ride a channel the owner declares', () => {
  const findings: HttpCallFinding[] = [
    {
      code: 'HTTP_CALL_UNMATCHED',
      resourceId: null,
      location: null,
      detail: "test 'tests/a#one' called 'POST /nowhere' which matched no route in the run's inventory (HTTP 404)",
    },
  ];

  it('projects a finding as a typed blocking entry carrying its cause and next action', () => {
    const [entry] = httpCallFindingEntries(findings);
    expect(entry).toMatchObject({
      kind: 'finding',
      resourceId: null,
      name: null,
      cause: 'HTTP_CALL_UNMATCHED',
    });
    expect(entry?.nextAction).toBeTruthy();
    expect(entry?.detail).toContain('HTTP_CALL_UNMATCHED');
  });

  it('mints the same findings in both modes (only the channel differs)', () => {
    const input = {
      routes: SERVED,
      ledger: ledger([row({ testId: 'tests/a#one', method: 'POST', path: '/nowhere', status: 404 })]),
      verdicts: [],
      unresolvedCallSites: [],
    };
    expect(evaluateHttpCoverage({ ...input, mode: 'report' }).findings).toEqual(
      evaluateHttpCoverage({ ...input, mode: 'block' }).findings,
    );
  });
});

describe('a run with no witnessed exchanges', () => {
  it('still counts the served denominator and mints no finding', () => {
    const result = evaluateHttpCoverage({
      routes: SERVED,
      ledger: null,
      verdicts: [],
      unresolvedCallSites: [],
      mode: 'report',
    });
    expect(result.summary).toEqual({
      served: 4,
      used: 2,
      proven: 0,
      missing: 2,
      unmatched: 0,
      ambiguous: 0,
    });
    expect(result.findings).toEqual([]);
  });
});
describe('R1/R5 — a conditional route is mounted, so it stays served (finding 13b)', () => {
  it('counts a route whose declaration is env-gated as served, not unmounted', () => {
    // 13b marks a module-level-`if` route `conditional`: served-ness is
    // unknown statically. It is NOT unmounted — its router is included,
    // so the mount proof stands and the route stays in the denominator.
    // `conditional` is deliberately not an input to `isServed`: a route
    // the app may not serve in production is still a route the app owns.
    const conditional: HttpCoverageRoute = {
      ...route({ resourceId: X }),
      mountProvenances: ['include-chain:app.main:app'],
    };
    const result = evaluateHttpCoverage({
      routes: [
        conditional,
        // The contrast case: a route with NO proof at all. It — not X —
        // is the one that leaves the served denominator.
        route({ resourceId: DEAD, consumed: true, callSites: ['f.ts:1:0'] }),
      ],
      ledger: ledger([row({ testId: 't#one', path: '/dead', route: DEAD, resolution: 'match' })]),
      verdicts: transportVerdicts(DEAD, 'satisfied'),
      mountProvenanceEmitted: true,
      mode: 'report',
    });
    // The subtraction is decided by `mountProvenances` ALONE: the
    // conditional route stays IN the denominator; the proof-less one
    // leaves it even though it is statically consumed and witnessed.
    expect(result.summary).toMatchObject({ served: 1, used: 0, proven: 0 });
  });
});
