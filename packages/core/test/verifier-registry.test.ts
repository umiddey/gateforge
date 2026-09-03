/**
 * Semantic-verifier registry tests (ADR 0004 D8, plan phase 5):
 * registration cannot override a namespace, unknown namespaces stay
 * fail-closed, fake generic evidence cannot satisfy pack contracts, the
 * http verifier honors the claimed/witnessed trust boundary, observed
 * paths match the obligation's canonical endpoint shape positionally
 * (ADR 0004 D2/D3), and domain checks grade the WITNESS-DERIVED outcome
 * of the observed HTTP exchange (never caller-asserted booleans).
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
import { pathMatchesShape } from '../src/verdict/pack-verifiers.js';

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

/** Fixed witness-derived response digest baked into every check payload. */
const RESPONSE_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function claim(obligationId: string = OBLIGATION.id): Record<string, unknown> {
  return { schemaVersion: 1, obligationId, testId: 'test-1' };
}

/** A full witness-derived domain-check payload (the witness contract):
 * the witness observed the exchange itself and DERIVED the outcome from
 * the status. Tests pass overrides to vary individual fields. */
function checkPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scenario: 'role-denied',
    outcome: 'rejected',
    method: 'POST',
    url: '/api/v1/accounts',
    status: 403,
    responseSha256: RESPONSE_SHA256,
    responseBytes: 42,
    ...overrides,
  };
}

/** Copies a payload without the named keys (absent, not undefined:
 * record ids hash canonical JSON, where undefined members cannot exist). */
function withoutKeys(payload: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const copy = { ...payload };
  for (const key of keys) delete copy[key];
  return copy;
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
    payload: checkPayload(),
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

/** The provenanced claimed `ui.action` anchor from the declaring test. */
function anchorRecord(obligationId: string, operation: string): Record<string, unknown> {
  return record(obligationId, {
    kind: 'ui.action',
    origin: 'suite-submitted',
    trust: 'claimed',
    payload: { operation, entityId: 'acc-1' },
  });
}

/** Grades the fixture obligation through the real engine. */
function grade(
  records: unknown[],
  claims: unknown[] = [claim()],
  resource?: { kind: string; attributes: Record<string, unknown> } | null,
) {
  return evaluateObligation(OBLIGATION, {
    claims,
    records,
    waivers: [],
    classification: CLASSIFICATION,
    ...(resource !== undefined ? { resource } : {}),
    now: '2026-01-01T00:00:00.000Z',
  });
}

/** Grades one obligation plus its own claim/records through the engine. */
function gradeFor(
  obligation: Obligation,
  records: unknown[],
  resource?: { kind: string; attributes: Record<string, unknown> } | null,
) {
  return evaluateObligation(obligation, {
    claims: [claim(obligation.id)],
    records,
    waivers: [],
    classification: CLASSIFICATION,
    ...(resource !== undefined ? { resource } : {}),
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
    const anchorOnly = anchorRecord(OBLIGATION.id, 'read');
    const outcome = grade([claimed, anchorOnly]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('suite-submitted');
  });

  it('a witnessed pack check with a contradicting scenario grades invalid', () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const wrong = record(OBLIGATION.id, {
      payload: checkPayload({
        scenario: 'role-allowed',
        outcome: 'accepted',
        method: 'GET',
        status: 200,
      }),
    });
    const outcome = grade([anchor, wrong]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain("'auth:role-denied' requires 'role-denied'");
  });

  it('a witnessed rejected-class check with a provenanced ui anchor satisfies', () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const check = record(OBLIGATION.id);
    const outcome = grade([anchor, check]);
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.recordIds).toEqual([String(check['recordId'])]);
  });

  it('an unknown scenario stays fail-closed missing', () => {
    const unknown: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:auth:not-a-scenario',
      contract: 'auth:not-a-scenario',
    };
    const anchor = anchorRecord(unknown.id, 'read');
    const check = record(unknown.id);
    const outcome = gradeFor(unknown, [anchor, check]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("no semantic verifier is registered for contract 'auth:not-a-scenario'");
  });
});

describe('witness-derived domain-check grading', () => {
  it("an 'accepted' outcome can never evidence a rejected-class scenario", () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const wrong = record(OBLIGATION.id, {
      payload: checkPayload({ outcome: 'accepted', status: 200 }),
    });
    const outcome = grade([anchor, wrong]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain(
      "witness-derived outcome 'accepted' cannot evidence 'auth:role-denied'",
    );
  });

  it('a rejected-class scenario whose observed status is 2xx grades invalid', () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const wrong = record(OBLIGATION.id, { payload: checkPayload({ status: 200 }) });
    const outcome = grade([anchor, wrong]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain("observed status '200'");
    expect(outcome.reason).toContain('rejected scenarios require 400-499');
  });

  it('a rejected-class scenario whose observed status is 5xx grades invalid', () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const wrong = record(OBLIGATION.id, { payload: checkPayload({ status: 500 }) });
    const outcome = grade([anchor, wrong]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain("observed status '500'");
  });

  it('an accepted-class scenario with a 2xx observed status satisfies', () => {
    const allowed: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:auth:role-allowed',
      contract: 'auth:role-allowed',
    };
    const anchor = anchorRecord(allowed.id, 'read');
    const check = record(allowed.id, {
      payload: checkPayload({
        scenario: 'role-allowed',
        outcome: 'accepted',
        method: 'GET',
        status: 200,
      }),
    });
    const outcome = gradeFor(allowed, [anchor, check]);
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.recordIds).toEqual([String(check['recordId'])]);
  });

  it('a payload without a usable method/url pair grades invalid', () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const wrong = record(OBLIGATION.id, {
      payload: withoutKeys(checkPayload(), 'url', 'method'),
    });
    const outcome = grade([anchor, wrong]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('carries no witnessed method/url pair');
  });

  it('a missing or malformed responseSha256 grades invalid', () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const missing = record(OBLIGATION.id, {
      payload: withoutKeys(checkPayload(), 'responseSha256'),
    });
    const outcome = grade([anchor, missing]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('carries no witness-derived response evidence');

    const uppercaseHex = record(OBLIGATION.id, {
      payload: checkPayload({ responseSha256: RESPONSE_SHA256.toUpperCase() }),
    });
    const outcome2 = grade([anchor, uppercaseHex]);
    expect(outcome2.verdict).toBe('invalid');
    expect(outcome2.reason).toContain('carries no witness-derived response evidence');

    const fractionalBytes = record(OBLIGATION.id, {
      payload: checkPayload({ responseBytes: 1.5 }),
    });
    const outcome3 = grade([anchor, fractionalBytes]);
    expect(outcome3.verdict).toBe('invalid');
    expect(outcome3.reason).toContain('carries no witness-derived response evidence');
  });

  it('the dual-observation scenario replay-idempotent demands exactly two observations', () => {
    const webhook: Obligation = {
      ...OBLIGATION,
      id: 'tenant.webhooks:webhook:replay-idempotent',
      resourceId: 'tenant.webhooks',
      contract: 'webhook:replay-idempotent',
    };
    const anchor = anchorRecord(webhook.id, 'update');
    const payload = checkPayload({
      scenario: 'replay-idempotent',
      outcome: 'accepted',
      method: 'POST',
      url: '/api/v1/hooks',
      status: 200,
    });

    const one = record(webhook.id, {
      kind: 'webhook.check',
      payload: { ...payload, observations: 1 },
    });
    const oneOutcome = gradeFor(webhook, [anchor, one]);
    expect(oneOutcome.verdict).toBe('invalid');
    expect(oneOutcome.reason).toContain('requires two witnessed observations of the exchange');

    const absent = record(webhook.id, { kind: 'webhook.check', payload });
    const absentOutcome = gradeFor(webhook, [anchor, absent]);
    expect(absentOutcome.verdict).toBe('invalid');
    expect(absentOutcome.reason).toContain('requires two witnessed observations of the exchange');

    const dual = record(webhook.id, {
      kind: 'webhook.check',
      payload: { ...payload, observations: 2 },
    });
    const satisfied = gradeFor(webhook, [anchor, dual]);
    expect(satisfied.verdict).toBe('satisfied');
    expect(satisfied.recordIds).toEqual([String(dual['recordId'])]);
  });

  it('the task-namespace dual scenario idempotent demands two observations too', () => {
    const task: Obligation = {
      ...OBLIGATION,
      id: 'tenant.tasks:task:idempotent',
      resourceId: 'tenant.tasks',
      contract: 'task:idempotent',
    };
    const anchor = anchorRecord(task.id, 'create');
    const absent = record(task.id, {
      kind: 'task.check',
      payload: checkPayload({
        scenario: 'idempotent',
        outcome: 'accepted',
        method: 'POST',
        url: '/api/v1/tasks',
        status: 201,
      }),
    });
    const outcome = gradeFor(task, [anchor, absent]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('requires two witnessed observations of the exchange');
  });

  it('a domain check bound to a resource must match the endpoint shape and method', () => {
    const ACCOUNT_RESOURCE = {
      kind: 'http.endpoint',
      attributes: { method: 'POST', canonicalPath: '/api/v1/accounts' },
    };
    const anchor = anchorRecord(OBLIGATION.id, 'read');

    const wrongShape = record(OBLIGATION.id, {
      payload: checkPayload({ url: '/api/v2/accounts' }),
    });
    const wrongOutcome = grade([anchor, wrongShape], [claim()], ACCOUNT_RESOURCE);
    expect(wrongOutcome.verdict).toBe('invalid');
    expect(wrongOutcome.reason).toContain('observed POST /api/v2/accounts');
    expect(wrongOutcome.reason).toContain('does not match endpoint shape POST /api/v1/accounts');

    const wrongMethod = record(OBLIGATION.id, {
      payload: checkPayload({ method: 'GET' }),
    });
    const methodOutcome = grade([anchor, wrongMethod], [claim()], ACCOUNT_RESOURCE);
    expect(methodOutcome.verdict).toBe('invalid');
    expect(methodOutcome.reason).toContain('observed GET /api/v1/accounts');

    // Shape satisfaction also holds behind a positional segment.
    const parameterized = {
      kind: 'http.endpoint',
      attributes: { method: 'POST', canonicalPath: '/api/v1/accounts/{}' },
    };
    const concrete = record(OBLIGATION.id, {
      payload: checkPayload({ url: '/api/v1/accounts/acc-42' }),
    });
    const satisfied = grade([anchor, concrete], [claim()], parameterized);
    expect(satisfied.verdict).toBe('satisfied');
  });
});

describe('positional path matching (pathMatchesShape)', () => {
  it('literal shapes match only the identical path, case-sensitively', () => {
    expect(pathMatchesShape('/api/v1/accounts', '/api/v1/accounts')).toBe(true);
    expect(pathMatchesShape('/api/v2/accounts', '/api/v1/accounts')).toBe(false);
    expect(pathMatchesShape('/Api/V1/Accounts', '/api/v1/accounts')).toBe(false);
    expect(pathMatchesShape('/api/v1/accounts/extra', '/api/v1/accounts')).toBe(false);
    expect(pathMatchesShape('/api/v1', '/api/v1/accounts')).toBe(false);
  });

  it('{} matches exactly one non-empty segment', () => {
    expect(pathMatchesShape('/accounts/123', '/accounts/{}')).toBe(true);
    expect(pathMatchesShape('/accounts/-', '/accounts/{}')).toBe(true);
    expect(pathMatchesShape('/accounts', '/accounts/{}')).toBe(false);
    expect(pathMatchesShape('/accounts/123/extra', '/accounts/{}')).toBe(false);
  });

  it('a trailing {*} matches one or more trailing segments', () => {
    expect(pathMatchesShape('/files/a', '/files/{*}')).toBe(true);
    expect(pathMatchesShape('/files/a/b/c', '/files/{*}')).toBe(true);
    expect(pathMatchesShape('/files', '/files/{*}')).toBe(false);
    expect(pathMatchesShape('/documents/a/b', '/files/{*}')).toBe(false);
  });

  it('non-trailing wildcards and mixed shapes never match (fail closed)', () => {
    expect(pathMatchesShape('/a/x/c', '/a/{*}/c')).toBe(false);
    expect(pathMatchesShape('/a/x/b/c', '/a/{*}/c')).toBe(false);
    expect(pathMatchesShape('/a/x/y', '/a/{}/y')).toBe(true);
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

  function httpOutcome(
    obligation: Obligation,
    records: unknown[],
    resource?: { kind: string; attributes: Record<string, unknown> } | null,
  ) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
      records,
      waivers: [],
      classification: CLASSIFICATION,
      ...(resource !== undefined ? { resource } : {}),
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  const anchor = record(httpObligation.id, {
    kind: 'ui.action',
    origin: 'suite-submitted',
    trust: 'claimed',
    payload: { operation: 'create', entityId: 'acc-1' },
  });

  /** The obligation's graph resource, as the real CLI supplies it. */
  const ENDPOINT_RESOURCE = {
    kind: 'http.endpoint',
    attributes: { method: 'POST', canonicalPath: '/api/v1/contracts' },
  };

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

  it('a witnessed observation from a different endpoint can never satisfy a bound obligation', () => {
    const observed = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/health' },
    });
    const outcome = httpOutcome(httpObligation, [anchor, observed], ENDPOINT_RESOURCE);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('/health');
    expect(outcome.reason).toContain('/api/v1/contracts');
    expect(outcome.reason).toContain('different endpoint');
  });

  it('a witnessed observation with the wrong method grades invalid', () => {
    const observed = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/api/v1/contracts' },
    });
    const outcome = httpOutcome(httpObligation, [anchor, observed], ENDPOINT_RESOURCE);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('GET /api/v1/contracts');
    expect(outcome.reason).toContain('POST /api/v1/contracts');
  });

  it('query strings and trailing slashes normalize before the identity match', () => {
    const withQuery = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/v1/contracts?x=1' },
    });
    expect(httpOutcome(httpObligation, [anchor, withQuery], ENDPOINT_RESOURCE).verdict).toBe(
      'satisfied',
    );
    const trailingSlash = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/v1/contracts/' },
    });
    expect(httpOutcome(httpObligation, [anchor, trailingSlash], ENDPOINT_RESOURCE).verdict).toBe(
      'satisfied',
    );
  });

  it('without a bound resource the verifier keeps its historical any-endpoint behavior', () => {
    const observed = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/health' },
    });
    expect(httpOutcome(httpObligation, [anchor, observed]).verdict).toBe('satisfied');
  });

  it('a concrete path satisfies the endpoint shape positionally (P1)', () => {
    const ACCOUNTS_RESOURCE = {
      kind: 'http.endpoint',
      attributes: { method: 'GET', canonicalPath: '/accounts/{}' },
    };
    const accountsAnchor = record(httpObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: '123' },
    });
    const observed = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/accounts/123' },
    });
    const outcome = httpOutcome(httpObligation, [accountsAnchor, observed], ACCOUNTS_RESOURCE);
    expect(outcome.verdict).toBe('satisfied');

    // An extra segment is a different endpoint shape, never a match.
    const extra = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/accounts/123/extra' },
    });
    const extraOutcome = httpOutcome(httpObligation, [accountsAnchor, extra], ACCOUNTS_RESOURCE);
    expect(extraOutcome.verdict).toBe('invalid');
    expect(extraOutcome.reason).toContain('observed GET /accounts/123/extra');
    expect(extraOutcome.reason).toContain('does not match endpoint shape GET /accounts/{}');
  });

  it('a trailing wildcard shape matches deep paths but not the bare prefix', () => {
    const FILES_RESOURCE = {
      kind: 'http.endpoint',
      attributes: { method: 'GET', canonicalPath: '/files/{*}' },
    };
    const filesAnchor = record(httpObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'a/b/c' },
    });
    const deep = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/files/a/b/c' },
    });
    expect(httpOutcome(httpObligation, [filesAnchor, deep], FILES_RESOURCE).verdict).toBe(
      'satisfied',
    );

    const bare = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/files' },
    });
    const bareOutcome = httpOutcome(httpObligation, [filesAnchor, bare], FILES_RESOURCE);
    expect(bareOutcome.verdict).toBe('invalid');
    expect(bareOutcome.reason).toContain('does not match endpoint shape GET /files/{*}');
  });

  it('a literal segment mismatch in the shape grades invalid', () => {
    const V1_RESOURCE = {
      kind: 'http.endpoint',
      attributes: { method: 'GET', canonicalPath: '/api/v1/accounts' },
    };
    const v1Anchor = record(httpObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'acc-1' },
    });
    const observed = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/api/v2/accounts' },
    });
    const outcome = httpOutcome(httpObligation, [v1Anchor, observed], V1_RESOURCE);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('observed GET /api/v2/accounts');
    expect(outcome.reason).toContain('does not match endpoint shape GET /api/v1/accounts');
  });
});
