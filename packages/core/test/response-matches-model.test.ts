/**
 * WP4 step 4: `http:response-matches-model` grades the witness's
 * per-exchange body verdict (`shape`) against the app's declared model.
 * The request contracts never read `shape`; the body contract never
 * reads status or route alone. Under `report` the mismatches and refusals
 * surface as advisories from the ledger; the config default is `off`.
 */
import { describe, expect, it } from 'vitest';
import { evaluateObligation } from '../src/verdict/evaluate.js';
import { buildHttpLedger } from '../src/verdict/http-ledger.js';
import { httpResponseShapeEntries } from '../src/verdict/http-coverage.js';
import { recordIdOf } from '../src/provenance.js';
import type { Classification } from '../src/schemas/classification.js';
import type { Obligation } from '../src/schemas/obligation.js';
import type { HttpRouteCandidate } from '../src/verdict/registry.js';

const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const CLASSIFICATION: Classification = {
  exposure: 'user-facing',
  plane: 'tenant',
  primaryKey: ['id'],
  lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  evidenceAdapter: 'accounts',
};

const BODY_OBLIGATION: Obligation = {
  schemaVersion: 1,
  id: 'tenant.accounts:http:response-matches-model',
  resourceId: 'tenant.accounts',
  contract: 'http:response-matches-model',
  policyId: 'p',
  lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
};

const REQUEST_OBLIGATION: Obligation = {
  ...BODY_OBLIGATION,
  id: 'tenant.accounts:http:request-observed',
  contract: 'http:request-observed',
};

const INVENTORY: readonly HttpRouteCandidate[] = [
  { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
];

const MISMATCH = { verdict: 'mismatch', errors: [{ pointer: '/total', message: 'must be number' }] };
const OK = { verdict: 'ok' };
const UNCHECKED = { verdict: 'unchecked', why: 'no-response-schema' };
const REFUSED = { verdict: 'refused', why: 'HTTP_BODY_TOO_LARGE' };

/** One witnessed Observe-channel `http.observed` record for an obligation. */
function observedRecord(obligationId: string, exchanges: readonly Record<string, unknown>[]): Record<string, unknown> {
  const payload = { channel: 'observe', sessionId: 'sess-1', exchanges };
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    trust: 'witnessed',
    origin: 'engine-observed',
    obligationId,
    testId: 'test-1',
    kind: 'http.observed',
    payload,
    recordId: recordIdOf({
      runId: RUN_ID,
      obligationId,
      kind: 'http.observed',
      testId: 'test-1',
      origin: 'engine-observed',
      payload,
    }),
  };
}

/** One witnessed `http.exchanges` record (the ledger's input). */
function exchangesRecord(exchanges: readonly Record<string, unknown>[]): Record<string, unknown> {
  const payload = { channel: 'observe', sessionId: 'sess-1', exchanges };
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    trust: 'witnessed',
    origin: 'engine-observed',
    obligationId: 'sess-1',
    testId: 'tests/a#one',
    kind: 'http.exchanges',
    payload,
    recordId: recordIdOf({
      runId: RUN_ID,
      obligationId: 'sess-1',
      kind: 'http.exchanges',
      testId: 'tests/a#one',
      origin: 'engine-observed',
      payload,
    }),
  };
}

function grade(obligation: Obligation, records: readonly Record<string, unknown>[]) {
  return evaluateObligation(obligation, {
    claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
    records,
    waivers: [],
    classification: CLASSIFICATION,
    httpRoutes: INVENTORY,
    now: '2026-01-01T00:00:00.000Z',
  });
}

const GET_456 = { method: 'GET', url: '/accounts/456', status: 200, fetchDest: 'empty' };

describe('http:response-matches-model grades the witnessed body verdict', () => {
  it('a mismatched body fails the claim and names the first pointer', () => {
    const outcome = grade(BODY_OBLIGATION, [
      observedRecord(BODY_OBLIGATION.id, [{ ...GET_456, shape: MISMATCH }]),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('/total');
  });

  it('an ok body and an unchecked body both satisfy the claim', () => {
    expect(grade(BODY_OBLIGATION, [observedRecord(BODY_OBLIGATION.id, [{ ...GET_456, shape: OK }])]).verdict).toBe(
      'satisfied',
    );
    expect(
      grade(BODY_OBLIGATION, [observedRecord(BODY_OBLIGATION.id, [{ ...GET_456, shape: UNCHECKED }])]).verdict,
    ).toBe('satisfied');
  });

  it('a refused (over-cap) body fails the claim with HTTP_BODY_TOO_LARGE', () => {
    const outcome = grade(BODY_OBLIGATION, [
      observedRecord(BODY_OBLIGATION.id, [{ ...GET_456, shape: REFUSED }]),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('HTTP_BODY_TOO_LARGE');
  });

  it('an exchange with no shape verdict is missing, never satisfied', () => {
    const anchor = {
      ...observedRecord(BODY_OBLIGATION.id, []),
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'acc-1' },
      recordId: recordIdOf({
        runId: RUN_ID,
        obligationId: BODY_OBLIGATION.id,
        kind: 'ui.action',
        testId: 'test-1',
        origin: 'suite-submitted',
        payload: { operation: 'read', entityId: 'acc-1' },
      }),
    };
    const outcome = grade(BODY_OBLIGATION, [anchor, observedRecord(BODY_OBLIGATION.id, [GET_456])]);
    // The transport rule keeps the lexically first of the two missing reasons
    // (anchored vs Observe channel), so this asserts the fail-closed verdict only.
    expect(outcome.verdict).toBe('missing');
  });

  it('an engine-only http.request (no witness shape) is missing for the body contract', () => {
    const anchor = {
      ...observedRecord(BODY_OBLIGATION.id, []),
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'acc-1' },
      recordId: recordIdOf({
        runId: RUN_ID,
        obligationId: BODY_OBLIGATION.id,
        kind: 'ui.action',
        testId: 'test-1',
        origin: 'suite-submitted',
        payload: { operation: 'read', entityId: 'acc-1' },
      }),
    };
    const request = {
      ...observedRecord(BODY_OBLIGATION.id, []),
      kind: 'http.request',
      origin: 'engine-observed',
      payload: { method: 'GET', url: '/accounts/456', status: 200 },
      recordId: recordIdOf({
        runId: RUN_ID,
        obligationId: BODY_OBLIGATION.id,
        kind: 'http.request',
        testId: 'test-1',
        origin: 'engine-observed',
        payload: { method: 'GET', url: '/accounts/456', status: 200 },
      }),
    };
    const outcome = grade(BODY_OBLIGATION, [anchor, request]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('no response-shape verdict');
  });

  it('the request contract ignores the body verdict: a mismatched exchange still satisfies it', () => {
    const outcome = grade(REQUEST_OBLIGATION, [
      observedRecord(REQUEST_OBLIGATION.id, [{ ...GET_456, shape: MISMATCH }]),
    ]);
    expect(outcome.verdict).toBe('satisfied');
  });
});

describe('report advisories and the ledger carry the body verdict', () => {
  it('a ledger row records the shape verdict; mismatch and refused become advisories, ok does not', () => {
    const ledger = buildHttpLedger(
      [
        exchangesRecord([
          { ...GET_456, shape: MISMATCH },
          { ...GET_456, status: 201, shape: REFUSED },
          { ...GET_456, status: 202, shape: OK },
        ]),
      ],
      INVENTORY,
    );
    const byStatus = new Map(ledger.rows.map((row) => [row.status, row]));
    expect(byStatus.get(200)?.shape).toBe('mismatch');
    expect(byStatus.get(200)?.shapeDetail).toContain('/total');
    expect(byStatus.get(201)?.shape).toBe('refused');
    expect(byStatus.get(202)?.shape).toBe('ok');

    const entries = httpResponseShapeEntries(ledger.rows);
    expect(entries.map((entry) => entry.cause)).toEqual(['HTTP_RESPONSE_SHAPE_MISMATCH', 'HTTP_BODY_TOO_LARGE']);
    expect(entries[0]?.detail).toContain('/total');
    expect(entries[0]?.kind).toBe('finding');
  });
});
