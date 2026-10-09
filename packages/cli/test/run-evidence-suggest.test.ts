/**
 * Evidence-backed `tests suggest --from-run` (unit): the pure matcher and
 * aggregation over observed run exchanges. E2E command behavior lives in
 * run-evidence-suggest-e2e.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { TestCatalog } from '@gate-forge/core';
import {
  exchangesFromRecords,
  routeForExchange,
  suggestFromRunEvidence,
  testKeyResolver,
  type InventoryRoute,
  type RunExchange,
} from '../src/run-evidence.js';

/** Convenience route builder (canonical `{}` slot as the compiler emits). */
function route(resourceId: string, method: InventoryRoute['method'], canonicalPath: string): InventoryRoute {
  return { resourceId, method, canonicalPath };
}

/** One observed-channel page.observed record with the given apiStatuses. */
function pageRecord(testId: string, apiStatuses: Array<Record<string, unknown>>, channel = 'observed'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordId: 'a'.repeat(64),
    runId: '4d813a14-807d-42e7-a6b4-3264f1645790',
    trust: 'witnessed',
    obligationId: 'tenant.page-items:page:loads',
    kind: 'page.observed',
    origin: 'engine-observed',
    testId,
    payload: {
      channel,
      routeId: 'tenant.page-items',
      finalUrl: 'http://127.0.0.1:13001/items',
      apiStatuses,
    },
  };
}

describe('routeForExchange — router semantics over the endpoint inventory', () => {
  it('a literal segment beats a parameter match', () => {
    const routes = [route('tenant.param', 'GET', '/api/items/{}'), route('tenant.literal', 'GET', '/api/items')];
    expect(routeForExchange(routes, 'GET', '/api/items')).toEqual({
      kind: 'matched',
      route: route('tenant.literal', 'GET', '/api/items'),
    });
  });

  it('a parameter route matches a concrete path when no literal exists', () => {
    const routes = [route('tenant.param', 'GET', '/api/items/{}')];
    expect(routeForExchange(routes, 'GET', '/api/items/42')).toEqual({
      kind: 'matched',
      route: route('tenant.param', 'GET', '/api/items/{}'),
    });
  });

  it('a trailing wildcard route absorbs remaining segments as a parameter match', () => {
    const routes = [route('tenant.files', 'GET', '/api/files/{*}')];
    expect(routeForExchange(routes, 'GET', '/api/files/a/b')).toEqual({
      kind: 'matched',
      route: route('tenant.files', 'GET', '/api/files/{*}'),
    });
  });

  it('the method must match exactly', () => {
    const routes = [route('tenant.items', 'GET', '/api/items')];
    expect(routeForExchange(routes, 'POST', '/api/items')).toEqual({ kind: 'unmatched' });
  });

  it('more than one equal match is ambiguous and never guessed', () => {
    const slot = route('tenant.slot', 'GET', '/api/x/{}');
    const wildcard = route('tenant.wild', 'GET', '/api/x/{*}');
    expect(routeForExchange([slot, wildcard], 'GET', '/api/x/7')).toEqual({
      kind: 'ambiguous',
      candidates: [slot, wildcard],
    });
    const a = route('tenant.a', 'GET', '/api/same');
    const b = route('tenant.b', 'GET', '/api/same');
    expect(routeForExchange([a, b], 'GET', '/api/same')).toEqual({
      kind: 'ambiguous',
      candidates: [a, b],
    });
  });

  it('ANY routes never join', () => {
    expect(routeForExchange([route('tenant.any', 'ANY', '/api/items')], 'GET', '/api/items')).toEqual({
      kind: 'unmatched',
    });
  });
});

describe('exchangesFromRecords — observed-channel evidence collection', () => {
  it('keeps same-origin (or proxied) exchanges under 400 with their method, query dropped', () => {
    const exchanges = exchangesFromRecords([
      pageRecord('items-1', [
        { method: 'GET', url: 'http://127.0.0.1:13001/api/items?a=1', status: 200, remoteAddress: '127.0.0.1', proxied: true },
        { method: 'POST', url: 'http://127.0.0.1:13001/api/items', status: 201, remoteAddress: '127.0.0.1', proxied: false },
        // Different origin, never proxied: not an app API call of this page.
        { method: 'GET', url: 'https://cdn.example.com/api/items', status: 200, remoteAddress: null, proxied: false },
        // 5xx is a server answer about a broken endpoint, not usage evidence.
        { method: 'GET', url: 'http://127.0.0.1:13001/api/items', status: 503, remoteAddress: null, proxied: false },
        // A pre-0.13.2 run wrote no method: unusable for endpoint matching.
        { url: 'http://127.0.0.1:13001/api/items', status: 200, remoteAddress: null, proxied: false },
      ]),
      // The sweep referee is never a test's evidence.
      pageRecord('page-sweep', [
        { method: 'GET', url: 'http://127.0.0.1:13001/api/items', status: 200, remoteAddress: null, proxied: false },
      ], 'swept'),
      // The loads/data-ok record pair shares ONE visit payload.
      pageRecord('items-2', [
        { method: 'GET', url: 'http://127.0.0.1:13001/api/items', status: 200, remoteAddress: null, proxied: false },
      ]),
      pageRecord('items-2', [
        { method: 'GET', url: 'http://127.0.0.1:13001/api/items', status: 200, remoteAddress: null, proxied: false },
      ]),
    ]);
    expect(exchanges.records).toBe(3);
    expect(exchanges.exchanges).toEqual([
      { testId: 'items-1', method: 'GET', path: '/api/items', status: 200 },
      { testId: 'items-1', method: 'POST', path: '/api/items', status: 201 },
      { testId: 'items-2', method: 'GET', path: '/api/items', status: 200 },
    ]);
  });
});

describe('suggestFromRunEvidence — obligation grouping and exact commands', () => {
  const runId = '4d813a14-807d-42e7-a6b4-3264f1645790';
  const routes = [route('tenant.get-items', 'GET', '/api/items'), route('tenant.post-items', 'POST', '/api/items')];
  const obligations = [
    { id: 'tenant.get-items:http:request-observed', resourceId: 'tenant.get-items', contract: 'http:request-observed' },
    { id: 'tenant.get-items:http:response-status-ok', resourceId: 'tenant.get-items', contract: 'http:response-status-ok' },
    { id: 'tenant.post-items:http:request-observed', resourceId: 'tenant.post-items', contract: 'http:request-observed' },
    { id: 'tenant.post-items:http:response-status-ok', resourceId: 'tenant.post-items', contract: 'http:response-status-ok' },
  ];
  const testKeyOf = (testId: string): string | null => (testId === 'items-1' ? 'playwright:chromium:specs/items.spec.js:items page loads' : null);

  it('a 2xx exchange claims both observation obligations with the exact mark command', () => {
    const exchanges: RunExchange[] = [
      { testId: 'items-1', method: 'GET', path: '/api/items', status: 200 },
    ];
    const result = suggestFromRunEvidence({
      runId, routes, obligations, exchanges,
      satisfiedObligationIds: new Set(), mappedObligationIds: new Set(),
      testKeyOf,
    });
    expect(result.suggestions).toHaveLength(1);
    const suggestion = result.suggestions[0]!;
    expect(suggestion.resourceId).toBe('tenant.get-items');
    expect(suggestion.route).toBe('GET /api/items');
    expect(suggestion.obligationIds).toEqual([
      'tenant.get-items:http:request-observed',
      'tenant.get-items:http:response-status-ok',
    ]);
    expect(suggestion.evidence).toEqual([
      { testId: 'items-1', testResolved: 'playwright:chromium:specs/items.spec.js:items page loads', method: 'GET', path: '/api/items', status: 200 },
    ]);
    expect(suggestion.command).toBe(
      "gateforge tests mark --test 'playwright:chromium:specs/items.spec.js:items page loads' " +
      '--kind observed-e2e ' +
      "--obligation 'tenant.get-items:http:request-observed' " +
      "--obligation 'tenant.get-items:http:response-status-ok' " +
      `--reason 'observed in run ${runId}: GET /api/items -> 200'`,
    );
  });

  it('a non-2xx exchange only claims request-observed', () => {
    const result = suggestFromRunEvidence({
      runId, routes, obligations,
      exchanges: [{ testId: 'items-1', method: 'POST', path: '/api/items', status: 302 }],
      satisfiedObligationIds: new Set(), mappedObligationIds: new Set(),
      testKeyOf,
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.obligationIds).toEqual(['tenant.post-items:http:request-observed']);
    expect(result.suggestions[0]?.command).toContain('POST /api/items -> 302');
  });

  it('satisfied and already-mapped obligations are never suggested', () => {
    const result = suggestFromRunEvidence({
      runId, routes, obligations,
      exchanges: [
        { testId: 'items-1', method: 'GET', path: '/api/items', status: 200 },
        { testId: 'items-1', method: 'POST', path: '/api/items', status: 201 },
      ],
      satisfiedObligationIds: new Set(['tenant.get-items:http:request-observed', 'tenant.get-items:http:response-status-ok']),
      mappedObligationIds: new Set(['tenant.post-items:http:request-observed', 'tenant.post-items:http:response-status-ok']),
      testKeyOf,
    });
    expect(result.suggestions).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it('unmatched and ambiguous exchanges land in their own advisory sections', () => {
    const mixed = [...routes, route('tenant.slot', 'GET', '/api/x/{}'), route('tenant.wild', 'GET', '/api/x/{*}')];
    const result = suggestFromRunEvidence({
      runId,
      routes: mixed,
      obligations: [],
      exchanges: [
        { testId: 'items-1', method: 'GET', path: '/api/widgets', status: 200 },
        { testId: 'items-1', method: 'GET', path: '/api/x/7', status: 200 },
        { testId: 'items-1', method: 'GET', path: '/api/items', status: 200 },
      ],
      satisfiedObligationIds: new Set(), mappedObligationIds: new Set(),
      testKeyOf,
    });
    expect(result.suggestions).toEqual([]);
    expect(result.unmatched).toEqual([
      { testId: 'items-1', testResolved: 'playwright:chromium:specs/items.spec.js:items page loads', method: 'GET', path: '/api/widgets', status: 200 },
    ]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]?.path).toBe('/api/x/7');
    expect(result.ambiguous[0]?.candidates).toEqual(['GET /api/x/{*}', 'GET /api/x/{}']);
    expect(result.considered).toBe(3);
  });
});

describe('commandFor — the printed command survives a POSIX shell', () => {
  /**
   * Splits one printed gateforge command the way a shell would: the
   * `gateforge` word is replaced by a printf that echoes every parsed
   * argument, so the list below IS the argv a paste would produce.
   */
  function shellWords(command: string): string[] {
    const run = spawnSync('bash', ['-c', command.replace(/^gateforge /, "printf '%s\\n' ")], { encoding: 'utf8' });
    if (run.error !== undefined || run.status !== 0) throw new Error(`shell parse failed: ${String(run.stderr)}`);
    return run.stdout.trimEnd().split('\n');
  }

  it("a key with a single quote and a path with shell metacharacters round-trip intact", () => {
    const key = "playwright:chromium:specs/admin.spec.js:admin's invoice";
    const runId = '4d813a14-807d-42e7-a6b4-3264f1645790';
    const result = suggestFromRunEvidence({
      runId,
      routes: [route('tenant.inv', 'GET', '/api/invoices/{}')],
      obligations: [{ id: 'tenant.inv:http:request-observed', resourceId: 'tenant.inv', contract: 'http:request-observed' }],
      exchanges: [{ testId: 'items-1', method: 'GET', path: '/api/invoices/$1', status: 200 }],
      satisfiedObligationIds: new Set(),
      mappedObligationIds: new Set(),
      testKeyOf: (testId) => (testId === 'items-1' ? key : null),
    });
    const command = result.suggestions[0]!.command;
    expect(command).not.toBeNull();
    const words = shellWords(command!);
    // `--test` and its value stay two words; the key arrives intact.
    expect(words[words.indexOf('--test') + 1]).toBe(key);
    // The reason arrives as ONE argument, byte-identical (no `$1` expansion).
    expect(words[words.indexOf('--reason') + 1]).toBe(`observed in run ${runId}: GET /api/invoices/$1 -> 200`);
  });
});

describe('testKeyResolver — testId to catalog logical key', () => {
  const catalog = {
    entries: [
      {
        logicalKey: 'playwright:chromium:specs/items.spec.js:items page loads',
        project: 'chromium',
        file: 'specs/items.spec.js',
        titlePath: ['items page loads'],
        runner: 'playwright',
      },
    ],
  } as unknown as TestCatalog;

  it('resolves through the run outcome identity, a reconciliation key, or a direct logical key', () => {
    const resolve = testKeyResolver(catalog, [
      { testId: 'items-1', file: 'specs/items.spec.js', titlePath: ['items page loads'], project: 'chromium' },
    ]);
    expect(resolve('items-1')).toBe('playwright:chromium:specs/items.spec.js:items page loads');
    expect(resolve('specs/items.spec.js#items page loads')).toBe('playwright:chromium:specs/items.spec.js:items page loads');
    expect(resolve('playwright:chromium:specs/items.spec.js:items page loads')).toBe(
      'playwright:chromium:specs/items.spec.js:items page loads',
    );
    expect(resolve('unknown-id')).toBeNull();
  });
});
