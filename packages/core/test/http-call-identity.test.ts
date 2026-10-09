/**
 * The identity of an HTTP call finding (0.14 WP5, plan §4.5 and §8
 * decision 2). A finding that is adopted as recorded debt must still be
 * the SAME finding on the next run, or the receipt forgives nothing and
 * blocks everything. So the identity is the call, never where it happened
 * to land:
 * - UNMATCHED / AMBIGUOUS: (code, method, path shape, test id). The path
 *   shape drops the query and collapses numeric, UUID and long-hex
 *   segments, so `/items/42` and `/items/97` are one call shape. The HTTP
 *   status is NOT identity: a 404 and a 500 for the same call are one call.
 * - UNRESOLVED: (code, file, detail). The `— file:line` tail is not
 *   identity, so moving the call down a file keeps its debt.
 *
 * The key is a readable name for the finding; the fingerprint is the
 * stable 64-hex value the receipt records and the debt is counted by.
 */
import { describe, expect, it } from 'vitest';
import { evaluateHttpCoverage, type HttpCallFinding } from '../src/verdict/http-coverage.js';
import type { HttpLedger } from '../src/verdict/http-ledger.js';

/** One ledger row; a row with no route is a call that matched nothing. */
function row(partial: Partial<HttpLedger['rows'][number]> & { testId: string; path: string }): HttpLedger['rows'][number] {
  return { method: 'GET', status: 404, kind: 'api', route: null, resolution: 'nomatch', ...partial };
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

/** The call findings a single ledger produces. */
function findingsOf(rows: HttpLedger['rows']): HttpCallFinding[] {
  return evaluateHttpCoverage({ routes: [], ledger: ledger(rows) }).findings;
}

/** The one finding a single-row ledger produces; its fingerprint must be a real hash. */
function onlyFinding(rows: HttpLedger['rows']): HttpCallFinding {
  const findings = findingsOf(rows);
  expect(findings).toHaveLength(1);
  const finding = findings[0] as HttpCallFinding;
  expect(finding.fingerprint).toMatch(SHA256_HEX);
  return finding;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe('the identity of an HTTP call finding (0.14 WP5 D1)', () => {
  it('gives every call finding a readable key and a 64-hex fingerprint', () => {
    const finding = onlyFinding([row({ testId: 'journey', path: '/nowhere' })]);
    expect(finding.code).toBe('HTTP_CALL_UNMATCHED');
    expect(finding.key).toContain('HTTP_CALL_UNMATCHED');
    expect(finding.key).toContain('journey');
    expect(finding.fingerprint).toMatch(SHA256_HEX);
  });

  it('keeps the fingerprint when the same call returns a different HTTP status', () => {
    // Only 404/405 make an unmatched call a finding (any other status is the
    // report-only HTTP_ROUTE_NOT_INVENTORIED), so status churn means 404 ↔ 405.
    const notFound = onlyFinding([row({ testId: 'journey', path: '/nowhere', status: 404 })]);
    const notAllowed = onlyFinding([row({ testId: 'journey', path: '/nowhere', status: 405 })]);
    expect(notAllowed.fingerprint).toBe(notFound.fingerprint);
    expect(notAllowed.key).toBe(notFound.key);
  });

  it('drops the query string from the path shape', () => {
    const plain = onlyFinding([row({ testId: 'journey', path: '/nowhere' })]);
    const withQuery = onlyFinding([row({ testId: 'journey', path: '/nowhere?page=2&sort=asc' })]);
    expect(withQuery.fingerprint).toBe(plain.fingerprint);
  });

  it('collapses numeric path segments, so two ids are one call shape', () => {
    const first = onlyFinding([row({ testId: 'journey', path: '/items/42' })]);
    const second = onlyFinding([row({ testId: 'journey', path: '/items/97' })]);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('collapses UUID path segments into the same call shape', () => {
    const first = onlyFinding([row({ testId: 'journey', path: '/items/0b6f2e0a-1c3d-4e5f-8a9b-0c1d2e3f4a5b' })]);
    const second = onlyFinding([row({ testId: 'journey', path: '/items/9f8e7d6c-5b4a-4f3e-9d2c-1b0a9f8e7d6c' })]);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('keeps distinct literal segments distinct', () => {
    const items = onlyFinding([row({ testId: 'journey', path: '/items/actions' })]);
    const orders = onlyFinding([row({ testId: 'journey', path: '/orders/actions' })]);
    expect(orders.fingerprint).not.toBe(items.fingerprint);
  });

  it('changes the fingerprint when the test id changes', () => {
    const journey = onlyFinding([row({ testId: 'journey', path: '/nowhere' })]);
    const other = onlyFinding([row({ testId: 'other-journey', path: '/nowhere' })]);
    expect(other.fingerprint).not.toBe(journey.fingerprint);
  });

  it('changes the fingerprint when the method changes', () => {
    const get = onlyFinding([row({ testId: 'journey', path: '/nowhere', method: 'GET' })]);
    const post = onlyFinding([row({ testId: 'journey', path: '/nowhere', method: 'POST' })]);
    expect(post.fingerprint).not.toBe(get.fingerprint);
  });

  it('gives AMBIGUOUS its own identity, distinct from UNMATCHED for the same call', () => {
    const unmatched = onlyFinding([row({ testId: 'journey', path: '/items/42' })]);
    const ambiguous = onlyFinding([
      row({
        testId: 'journey',
        path: '/items/42',
        resolution: 'ambiguous',
        candidates: ['http.endpoint:GET /items/{}', 'http.endpoint:GET /items/{id}'],
      }),
    ]);
    expect(ambiguous.code).toBe('HTTP_CALL_AMBIGUOUS');
    expect(ambiguous.fingerprint).toMatch(SHA256_HEX);
    expect(ambiguous.fingerprint).not.toBe(unmatched.fingerprint);
  });

  it('keeps an UNRESOLVED call identity when the call moves to another line', () => {
    const unresolved = (line: number, file = 'frontend/api.ts'): HttpCallFinding =>
      onlyUnresolved({
        code: 'FRONTEND_CALL_TARGET_UNRESOLVED',
        detail: 'target is a computed expression',
        location: { file, line, col: 2 },
      });
    const before = unresolved(12);
    const after = unresolved(40);
    expect(after.code).toBe('HTTP_CALL_UNRESOLVED');
    expect(after.fingerprint).toMatch(SHA256_HEX);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.key).toBe(before.key);
  });

  it('changes the UNRESOLVED fingerprint when the call moves to another file', () => {
    const here = onlyUnresolved({
      code: 'FRONTEND_CALL_TARGET_UNRESOLVED',
      detail: 'target is a computed expression',
      location: { file: 'frontend/api.ts', line: 12, col: 2 },
    });
    const there = onlyUnresolved({
      code: 'FRONTEND_CALL_TARGET_UNRESOLVED',
      detail: 'target is a computed expression',
      location: { file: 'frontend/other.ts', line: 12, col: 2 },
    });
    expect(there.fingerprint).not.toBe(here.fingerprint);
  });
});

/** The one UNRESOLVED finding a graph entry produces. */
function onlyUnresolved(entry: {
  code: string;
  detail: string;
  location: { file: string; line: number; col: number };
}): HttpCallFinding {
  const findings = evaluateHttpCoverage({ routes: [], ledger: null, unresolvedCallSites: [entry] }).findings;
  expect(findings).toHaveLength(1);
  const finding = findings[0] as HttpCallFinding;
  expect(finding.fingerprint).toMatch(SHA256_HEX);
  return finding;
}
