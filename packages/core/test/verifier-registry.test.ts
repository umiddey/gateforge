/**
 * Semantic-verifier registry tests (ADR 0004 D8, plan phase 5):
 * registration cannot override a namespace, unknown namespaces stay
 * fail-closed, fake generic evidence cannot satisfy pack contracts, and
 * the http verifier honors the claimed/witnessed trust boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateObligation,
  recordIdOf,
  registerContractVerifier,
  registeredNamespaces,
  type Classification,
  type Obligation,
} from '../src/index.js';

const OBLIGATION: Obligation = {
  schemaVersion: 1,
  id: 'tenant.accounts:auth:role-denied',
  resourceId: 'tenant.accounts',
  contract: 'auth:role-denied',
  policyId: 'p',
  lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
};

const CLASSIFICATION: Classification = {
  exposure: 'user-facing',
  plane: 'tenant',
  primaryKey: ['id'],
  lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  evidenceAdapter: 'accounts',
};

function claim(): Record<string, unknown> {
  return { schemaVersion: 1, obligationId: OBLIGATION.id, testId: 'test-1' };
}

function record(obligationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    trust: 'witnessed',
    obligationId,
    testId: 'test-1',
    kind: 'auth.check',
    origin: 'engine-observed',
    payload: { scenario: 'role-denied', allowed: false },
    ...overrides,
  };
  base['recordId'] = recordIdOf({
    runId: base['runId'] as string,
    obligationId: base['obligationId'] as string,
    kind: base['kind'] as string,
    testId: base['testId'] as string,
    origin: base['origin'] as 'engine-observed' | 'suite-submitted',
    payload: base['payload'],
  });
  return base;
}

/** Grades the fixture obligation through the real engine. */
function grade(records: unknown[], claims: unknown[] = [claim()]) {
  return evaluateObligation(OBLIGATION, {
    claims,
    records,
    waivers: [],
    classification: CLASSIFICATION,
    now: '2026-01-01T00:00:00.000Z',
  });
}

describe('verifier registry', () => {
  it('registers every built-in pack namespace exactly once', () => {
    expect(registeredNamespaces()).toEqual([
      'auth',
      'crud',
      'http',
      'persistence',
      'task',
      'validation',
      'webhook',
      'workflow',
    ]);
  });

  it('rejects re-registration of an existing namespace', () => {
    expect(() =>
      registerContractVerifier('persistence', () => ({ status: 'satisfied', recordIds: [] })),
    ).toThrow(/cannot override another namespace/);
  });
});

describe('pack contract grading (fail-closed by default)', () => {
  it('no evidence: the pack contract stays missing', () => {
    const outcome = grade([]);
    expect(outcome.verdict).toBe('missing');
  });

  it('a fake generic evidence record cannot satisfy a semantic contract', () => {
    // A generic boolean "passed" record with the right hash is still not
    // a pack check: no anchor, wrong kind.
    const fake = record(OBLIGATION.id, { kind: 'test.passed', payload: { passed: true } });
    const outcome = grade([fake]);
    expect(outcome.verdict).toBe('missing');
  });

  it('claimed-tier pack checks cannot satisfy — independent evidence is owed', () => {
    const claimed = record(OBLIGATION.id, { origin: 'suite-submitted', trust: 'claimed' });
    const anchorOnly = record(OBLIGATION.id, { kind: 'ui.action', origin: 'suite-submitted', trust: 'claimed', payload: { operation: 'read', entityId: 'acc-1' } });
    const outcome = grade([claimed, anchorOnly]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('suite-submitted');
  });

  it('a witnessed pack check with a contradicting scenario grades invalid', () => {
    const anchor = record(OBLIGATION.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'acc-1' },
    });
    const wrong = record(OBLIGATION.id, { payload: { scenario: 'role-allowed', allowed: true } });
    const outcome = grade([anchor, wrong]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain("'auth:role-denied' requires 'role-denied'");
  });

  it('a witnessed negative-outcome check with a provenanced ui anchor satisfies', () => {
    const anchor = record(OBLIGATION.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'acc-1' },
    });
    const check = record(OBLIGATION.id);
    const outcome = grade([anchor, check]);
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.recordIds).toEqual([String(check['recordId'])]);
  });
});

describe('http contract grading', () => {
  const httpObligation: Obligation = {
    ...OBLIGATION,
    id: 'tenant.accounts:http:frontend-request-observed',
    contract: 'http:frontend-request-observed',
  };
  const statusObligation: Obligation = {
    ...httpObligation,
    id: 'tenant.accounts:http:response-status-ok',
    contract: 'http:response-status-ok',
  };

  function httpOutcome(obligation: Obligation, records: unknown[]) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
      records,
      waivers: [],
      classification: CLASSIFICATION,
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  const anchor = record(httpObligation.id, {
    kind: 'ui.action',
    origin: 'suite-submitted',
    trust: 'claimed',
    payload: { operation: 'create', entityId: 'acc-1' },
  });

  it('a suite-forged network record can never become satisfaction', () => {
    const forged = record(httpObligation.id, {
      kind: 'http.request',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { method: 'POST', url: '/api/accounts' },
    });
    const outcome = httpOutcome(httpObligation, [anchor, forged]);
    if (outcome.verdict !== 'invalid') throw new Error(`got ${outcome.verdict}: ${outcome.reason}`);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('HTTP_OBSERVATION_UNTRUSTED');
  });

  it('witnessed observation plus claimed anchor satisfies frontend-request-observed', () => {
    const observed = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/accounts' },
    });
    const outcome = httpOutcome(httpObligation, [anchor, observed]);
    expect(outcome.verdict).toBe('satisfied');
  });

  it('a 5xx observed status keeps response-status-ok blocking', () => {
    const statusAnchor = record(statusObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'create', entityId: 'acc-1' },
    });
    const observed = record(statusObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/accounts', status: 500 },
    });
    const failing = httpOutcome(statusObligation, [statusAnchor, observed]);
    expect(failing.verdict).toBe('invalid');
    expect(failing.reason).toContain('2xx');
  });

  it('no observation channel record leaves the obligation missing', () => {
    const outcome = httpOutcome(httpObligation, [anchor]);
    expect(outcome.verdict).toBe('missing');
  });
});
