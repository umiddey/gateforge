/**
 * The verdict-time exchange ledger (WP2 step 3): rows built from every
 * witnessed `http.exchanges` record through the ONE resolver
 * (`matchHttpRoute`) over the run's complete route inventory, plus the
 * report-only placement in the run report JSON (`httpLedger`). The
 * ledger never changes a verdict — pinned here with a full fixture.
 */
import { describe, expect, it } from 'vitest';
import type { HttpRouteCandidate } from '../src/verdict/registry.js';
import { buildHttpLedger } from '../src/verdict/http-ledger.js';
import { renderRun } from '../src/report/index.js';
import { evaluateObligations } from '../src/verdict/evaluate.js';
import { recordIdOf } from '../src/provenance.js';
import type { Obligation } from '../src/schemas/obligation.js';

const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** One route candidate with the given identity, method, and shape. */
function route(resourceId: string, canonicalPath: string, method = 'GET'): HttpRouteCandidate {
  return { resourceId, method, canonicalPath };
}

const INVENTORY: readonly HttpRouteCandidate[] = [
  route('http.endpoint:GET /x', '/x'),
  route('http.endpoint:GET /items/{}', '/items/{}'),
  route('http.endpoint:GET /items/actions', '/items/actions'),
];

/** One transport-snapshot exchange entry. */
interface ExchangeFixture {
  method: string;
  url: string;
  status: number;
}

/** One witnessed, provenance-valid http.exchanges record. */
function exchangesRecord(testId: string, exchanges: ExchangeFixture[], sessionId = 'sess-1'): Record<string, unknown> {
  const payload = { channel: 'observe', sessionId, exchanges };
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    trust: 'witnessed',
    origin: 'engine-observed',
    obligationId: sessionId,
    testId,
    kind: 'http.exchanges',
    payload,
    recordId: recordIdOf({
      runId: RUN_ID,
      obligationId: sessionId,
      kind: 'http.exchanges',
      testId,
      origin: 'engine-observed',
      payload,
    }),
  };
}

describe('buildHttpLedger — every witnessed exchange becomes one row', () => {
  it('attributes a served path through the one resolver and reports unserved as nomatch', () => {
    const ledger = buildHttpLedger(
      [
        exchangesRecord('tests/a#one', [
          { method: 'GET', url: '/x?tracked=1', status: 200 },
          { method: 'GET', url: '/nowhere', status: 404 },
        ]),
      ],
      INVENTORY,
    );
    expect(ledger.rows).toEqual([
      { testId: 'tests/a#one', method: 'GET', path: '/nowhere', status: 404, route: null, resolution: 'nomatch' },
      { testId: 'tests/a#one', method: 'GET', path: '/x', status: 200, route: 'http.endpoint:GET /x', resolution: 'match' },
    ]);
    expect(ledger.summary).toEqual({ exchanges: 2, matched: 1, unmatched: 1, ambiguous: 0, incomplete: 0 });
  });

  it('sorts rows deterministically by (testId, method, path, status) across records', () => {
    const ledger = buildHttpLedger(
      [
        exchangesRecord('tests/b#two', [{ method: 'POST', url: '/x', status: 500 }], 'sess-2'),
        exchangesRecord('tests/a#one', [{ method: 'GET', url: '/x', status: 200 }]),
      ],
      INVENTORY,
    );
    expect(ledger.rows.map((row) => [row.testId, row.method, row.path, row.status])).toEqual([
      ['tests/a#one', 'GET', '/x', 200],
      ['tests/b#two', 'POST', '/x', 500],
    ]);
  });

  it('resolves overlaps by registration order and reports candidates when ambiguous', () => {
    const ordered: readonly HttpRouteCandidate[] = [
      { resourceId: 'http.endpoint:GET /items/actions', method: 'GET', canonicalPath: '/items/actions', registration: { scope: 'app', order: 0 } },
      { resourceId: 'http.endpoint:GET /items/{}', method: 'GET', canonicalPath: '/items/{}', registration: { scope: 'app', order: 1 } },
    ];
    const matched = buildHttpLedger([exchangesRecord('tests/a#one', [{ method: 'GET', url: '/items/actions', status: 200 }])], ordered);
    expect(matched.rows[0]).toMatchObject({ route: 'http.endpoint:GET /items/actions', resolution: 'match' });

    const unordered: readonly HttpRouteCandidate[] = [
      route('http.endpoint:GET /items/{}', '/items/{}'),
      route('http.endpoint:GET /items/{*}', '/items/{*}'),
    ];
    const ambiguous = buildHttpLedger([exchangesRecord('tests/a#one', [{ method: 'GET', url: '/items/actions', status: 200 }])], unordered);
    expect(ambiguous.rows[0]).toMatchObject({ resolution: 'ambiguous', route: null });
    if (ambiguous.rows[0]?.resolution === 'ambiguous') {
      expect(ambiguous.rows[0].candidates).toEqual([
        'GET /items/{*} (http.endpoint:GET /items/{*})',
        'GET /items/{} (http.endpoint:GET /items/{})',
      ]);
    }
    expect(ambiguous.summary).toEqual({ exchanges: 1, matched: 0, unmatched: 0, ambiguous: 1, incomplete: 0 });
  });

  it('ignores records of other kinds, non-witnessed ledger records, and malformed entries', () => {
    const observed = exchangesRecord('tests/a#one', [{ method: 'GET', url: '/x', status: 200 }]);
    const exchanges = (observed['payload'] as Record<string, unknown>)['exchanges'];
    // A deliberately malformed entry: the builder skips it, never guesses.
    const malformed = { method: 42, url: '/y', status: 200 } as unknown as ExchangeFixture;
    const ledger = buildHttpLedger(
      [
        observed,
        { ...observed, kind: 'http.observed', payload: { channel: 'observe', exchanges }, recordId: 'x'.repeat(64) },
        { ...observed, trust: 'claimed', recordId: 'x'.repeat(64) },
        { ...observed, testId: undefined, recordId: 'x'.repeat(64) },
        exchangesRecord('tests/a#one', [{ method: 'GET', url: '/x', status: 200 }, malformed]),
      ],
      INVENTORY,
    );
    // Only the two well-formed witnessed http.exchanges entries count
    // (the malformed entry of the last record is skipped).
    expect(ledger.summary.exchanges).toBe(2);
  });

  it('grades an unattributable inventory incomplete and an empty inventory nomatch', () => {
    const incomplete = buildHttpLedger(
      [exchangesRecord('tests/a#one', [{ method: 'GET', url: '/x', status: 200 }])],
      [route('http.endpoint:ANY /x', '/x', 'ANY')],
    );
    expect(incomplete.rows[0]).toMatchObject({ resolution: 'incomplete', route: null });
    expect(incomplete.summary).toEqual({ exchanges: 1, matched: 0, unmatched: 0, ambiguous: 0, incomplete: 1 });

    const noInventory = buildHttpLedger(
      [exchangesRecord('tests/a#one', [{ method: 'GET', url: '/x', status: 200 }])],
      null,
    );
    expect(noInventory.rows[0]).toMatchObject({ resolution: 'nomatch', route: null });
  });
});

describe('httpLedger is report-only', () => {
  const obligation = {
    schemaVersion: 1,
    id: 'tenant.x:http:request-observed',
    resourceId: 'tenant.x',
    contract: 'http:request-observed',
    policyId: 'p',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  } as unknown as Obligation;

  function fullFixtureRecords(): Record<string, unknown>[] {
    const anchorPayload = { operation: 'create', entityId: 'x-1' };
    const anchor = {
      schemaVersion: 1,
      runId: RUN_ID,
      trust: 'claimed',
      origin: 'suite-submitted',
      obligationId: obligation.id,
      testId: 'test-1',
      kind: 'ui.action',
      payload: anchorPayload,
    };
    const observedPayload = { method: 'GET', url: '/x', status: 200 };
    const observed = {
      schemaVersion: 1,
      runId: RUN_ID,
      trust: 'witnessed',
      origin: 'engine-observed',
      obligationId: obligation.id,
      testId: 'test-1',
      kind: 'http.request',
      payload: observedPayload,
    };
    const records: Record<string, unknown>[] = [anchor, observed];
    for (const entry of records) {
      entry['recordId'] = recordIdOf({
        runId: RUN_ID,
        obligationId: obligation.id,
        kind: entry['kind'] as string,
        testId: 'test-1',
        origin: entry['origin'] as 'engine-observed' | 'suite-submitted',
        payload: entry['payload'],
      });
    }
    return records;
  }

  it('a full verdict fixture produces identical verdicts with and without ledger records', () => {
    // Obligation resource ids never carry ':'; the route inventory
    // resolves the obligation by its OWN resource id.
    const context = {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
      waivers: [],
      classification: {
        exposure: 'user-facing',
        plane: 'tenant',
        primaryKey: ['id'],
        lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
        evidenceAdapter: 'xs',
      },
      httpRoutes: [route('tenant.x', '/x')],
      now: '2026-01-01T00:00:00.000Z',
    };
    const without = evaluateObligations([obligation], { ...context, records: fullFixtureRecords() });
    const with_ = evaluateObligations([obligation], {
      ...context,
      records: [...fullFixtureRecords(), exchangesRecord('test-1', [{ method: 'GET', url: '/x', status: 200 }])],
    });
    expect(JSON.parse(JSON.stringify(with_))).toEqual(JSON.parse(JSON.stringify(without)));
    expect(without[0]?.verdict).toBe('satisfied');
  });

  it('renderRun embeds httpLedger only when the caller supplies it', () => {
    const ledger = buildHttpLedger(
      [exchangesRecord('tests/a#one', [{ method: 'GET', url: '/nowhere', status: 404 }])],
      INVENTORY,
    );
    const verdicts = evaluateObligations([obligation], {
      claims: [],
      records: [],
      waivers: [],
      classification: null,
      now: '2026-01-01T00:00:00.000Z',
    });
    const withoutLedger = renderRun(verdicts, { format: 'json' });
    expect(JSON.parse(withoutLedger)['httpLedger']).toBeUndefined();

    const report = JSON.parse(renderRun(verdicts, { format: 'json', httpLedger: ledger })) as {
      httpLedger?: { rows: unknown[]; summary: Record<string, number> };
    };
    expect(report.httpLedger?.summary).toEqual({ exchanges: 1, matched: 0, unmatched: 1, ambiguous: 0, incomplete: 0 });
    expect(report.httpLedger?.rows).toHaveLength(1);
  });
});
