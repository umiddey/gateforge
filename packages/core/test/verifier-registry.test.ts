/**
 * Semantic-verifier registry tests (ADR 0004 D8, plan phase 5):
 * registration cannot override a namespace, unknown namespaces stay
 * fail-closed, fake generic evidence cannot satisfy pack contracts, the
 * http verifier honors the claimed/witnessed trust boundary, observed
 * paths match the obligation's canonical endpoint shape positionally
 * (ADR 0004 D2/D3), and the domain namespaces (auth, task, validation,
 * webhook, workflow) fail closed for EVERY contract of the namespace:
 * no transport-grade evidence — however perfectly formed or witnessed —
 * can stand in for the engine-owned state-observing producer their
 * semantics require.
 */
import { describe, expect, it } from 'vitest';
import {
  capabilityFor,
  allCapabilities,
  capabilityGap,
  causeForVerdict,
  evaluateObligation,
  recordIdOf,
  registerContractCapabilities,
  registerContractVerifier,
  registeredNamespaces,
  strictCapabilityGaps,
  type Classification,
  type ContractCapability,
  type HttpRouteCandidate,
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

function record(obligationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    trust: 'witnessed',
    obligationId,
    testId: 'test-1',
    kind: 'auth.check',
    origin: 'engine-observed',
    payload: legacyCheckPayload(),
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

/**
 * The RETIRED transport-grading payload (suite-chosen `scenario`, the
 * witness-derived status-class `outcome`, observed method/url/status,
 * response digest): kept here PERFECTLY FORMED on purpose — the domain
 * tests below prove that even flawless witnessed evidence of this shape
 * can no longer satisfy a domain contract.
 */
function legacyCheckPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

  it('an unknown namespace stays fail-closed missing', () => {
    const unknown: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:notapack:thing',
      contract: 'notapack:thing',
    };
    const outcome = gradeFor(unknown, []);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain(
      "no semantic verifier is registered for contract 'notapack:thing'",
    );
  });
});

describe('domain namespaces fail closed (no honest evidence channel)', () => {
  it('auth: a perfectly-formed witnessed check record grades missing', () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const check = record(OBLIGATION.id);
    const outcome = grade([anchor, check]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain(
      "contract 'auth:role-denied' has no honest evidence channel: proving 'role-denied'",
    );
    expect(outcome.reason).toContain('identity/role material and tenant-scoped application state');
    expect(outcome.reason).toContain("'tenant.accounts:auth:role-denied' stays blocking");
    expect(outcome.reason).toContain('state-observing producer');
  });

  it('workflow: a perfectly-formed witnessed check record grades missing', () => {
    const workflow: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:workflow:persisted-final-state',
      contract: 'workflow:persisted-final-state',
    };
    const anchor = anchorRecord(workflow.id, 'create');
    const check = record(workflow.id, {
      kind: 'workflow.check',
      payload: legacyCheckPayload({
        scenario: 'persisted-final-state',
        outcome: 'accepted',
        status: 200,
      }),
    });
    const outcome = gradeFor(workflow, [anchor, check]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain(
      "contract 'workflow:persisted-final-state' has no honest evidence channel: " +
        "proving 'persisted-final-state'",
    );
    expect(outcome.reason).toContain('the workflow state machine and its audit log');
    expect(outcome.reason).toContain('state-observing producer');
  });

  it('webhook: a perfectly-formed dual-observation check record grades missing', () => {
    const webhook: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:webhook:replay-idempotent',
      contract: 'webhook:replay-idempotent',
    };
    const anchor = anchorRecord(webhook.id, 'update');
    const check = record(webhook.id, {
      kind: 'webhook.check',
      payload: legacyCheckPayload({
        scenario: 'replay-idempotent',
        outcome: 'accepted',
        status: 200,
        observations: 2,
      }),
    });
    const outcome = gradeFor(webhook, [anchor, check]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain(
      "contract 'webhook:replay-idempotent' has no honest evidence channel: " +
        "proving 'replay-idempotent'",
    );
    expect(outcome.reason).toContain(
      'signature/replay verification over application-received deliveries',
    );
    expect(outcome.reason).toContain('state-observing producer');
  });

  it('task: a perfectly-formed dual-observation check record grades missing', () => {
    const task: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:task:idempotent',
      contract: 'task:idempotent',
    };
    const anchor = anchorRecord(task.id, 'create');
    const check = record(task.id, {
      kind: 'task.check',
      payload: legacyCheckPayload({
        scenario: 'idempotent',
        outcome: 'accepted',
        status: 201,
        observations: 2,
      }),
    });
    const outcome = gradeFor(task, [anchor, check]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain(
      "contract 'task:idempotent' has no honest evidence channel: proving 'idempotent'",
    );
    expect(outcome.reason).toContain('queue/job delivery state');
    expect(outcome.reason).toContain('state-observing producer');
  });

  it('validation: a perfectly-formed witnessed check record grades missing', () => {
    const validation: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:validation:error-message-explicit',
      contract: 'validation:error-message-explicit',
    };
    const anchor = anchorRecord(validation.id, 'read');
    const check = record(validation.id, {
      kind: 'validation.check',
      payload: legacyCheckPayload({
        scenario: 'error-message-explicit',
        outcome: 'accepted',
        status: 200,
      }),
    });
    const outcome = gradeFor(validation, [anchor, check]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain(
      "contract 'validation:error-message-explicit' has no honest evidence channel: " +
        "proving 'error-message-explicit'",
    );
    expect(outcome.reason).toContain(
      'boundary semantics over application state and the response envelope',
    );
    expect(outcome.reason).toContain('state-observing producer');
  });

  it('a forged-looking witnessed check can never satisfy: missing, never satisfied or invalid', () => {
    // The strongest possible transport evidence — a provenanced witnessed
    // check record, a provenanced anchor, and the bound endpoint resource
    // — still yields only the honest-channel missing verdict.
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const check = record(OBLIGATION.id);
    const outcome = grade([anchor, check], [claim()], {
      kind: 'http.endpoint',
      attributes: { method: 'POST', canonicalPath: '/api/v1/accounts' },
    });
    expect(outcome.verdict).not.toBe('satisfied');
    expect(outcome.verdict).not.toBe('invalid');
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('has no honest evidence channel');
  });

  it('ui anchors do not change the fail-closed outcome', () => {
    const withAnchor = grade([anchorRecord(OBLIGATION.id, 'read'), record(OBLIGATION.id)]);
    const withoutAnchor = grade([record(OBLIGATION.id)]);
    const anchorOnly = grade([anchorRecord(OBLIGATION.id, 'read')]);
    expect(withAnchor.verdict).toBe('missing');
    expect(withoutAnchor.verdict).toBe('missing');
    expect(anchorOnly.verdict).toBe('missing');
    expect(withAnchor.reason).toBe(withoutAnchor.reason);
    expect(withAnchor.reason).toContain('has no honest evidence channel');
  });

  it('claimed-tier check records get the same honest-channel reason', () => {
    const claimed = record(OBLIGATION.id, { origin: 'suite-submitted', trust: 'claimed' });
    const outcome = grade([claimed]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('has no honest evidence channel');
    expect(outcome.reason).toContain('state-observing producer');
  });

  it('a witnessed check with a contradicting scenario still grades missing (never invalid)', () => {
    const wrong = record(OBLIGATION.id, {
      payload: legacyCheckPayload({
        scenario: 'role-allowed',
        outcome: 'accepted',
        method: 'GET',
        status: 200,
      }),
    });
    const outcome = grade([anchorRecord(OBLIGATION.id, 'read'), wrong]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.verdict).not.toBe('invalid');
    expect(outcome.reason).toContain('has no honest evidence channel');
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
  const transportObligation: Obligation = {
    ...OBLIGATION,
    id: 'tenant.accounts:http:request-observed',
    contract: 'http:request-observed',
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
    claimTestId: string = 'test-1',
    httpRoutes?: readonly HttpRouteCandidate[] | null,
  ) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: claimTestId }],
      records,
      waivers: [],
      classification: CLASSIFICATION,
      ...(resource !== undefined ? { resource } : {}),
      ...(httpRoutes !== undefined ? { httpRoutes } : {}),
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  /**
   * Builds the route inventory for the transport obligation under test:
   * the obligation's own endpoint (resourceId `tenant.accounts`) plus
   * optional siblings. The obligation matches only when it is the
   * UNIQUE match within this complete set (plan §9, D2).
   *
   * Args:
   *   own: the obligation's own endpoint shape.
   *   siblings: additional inventory entries (unconsumed routes still
   *     participate in ambiguity detection).
   *
   * Returns:
   *   readonly HttpRouteCandidate[]: the complete candidate list.
   */
  function routes(
    own: { method: string; canonicalPath: string },
    siblings: readonly HttpRouteCandidate[] = [],
  ): readonly HttpRouteCandidate[] {
    return [{ resourceId: 'tenant.accounts', ...own }, ...siblings];
  }

  const anchor = record(transportObligation.id, {
    kind: 'ui.action',
    origin: 'suite-submitted',
    trust: 'claimed',
    payload: { operation: 'create', entityId: 'acc-1' },
  });
  const frontendAnchor = record(httpObligation.id, {
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
    const forged = record(transportObligation.id, {
      kind: 'http.request',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { method: 'POST', url: '/api/accounts' },
    });
    const outcome = httpOutcome(transportObligation, [anchor, forged]);
    if (outcome.verdict !== 'invalid') throw new Error(`got ${outcome.verdict}: ${outcome.reason}`);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('HTTP_OBSERVATION_UNTRUSTED');
    expect(outcome.reason).toContain('witness-observed HTTP exchange');
    expect(outcome.reason).toContain('suite-claimed');
  });

  it('witnessed observation plus claimed anchor satisfies request-observed (transport only)', () => {
    const observed = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/accounts' },
    });
    const outcome = httpOutcome(transportObligation, [anchor, observed], undefined, 'test-1', routes({
      method: 'POST',
      canonicalPath: '/api/accounts',
    }));
    expect(outcome.verdict).toBe('satisfied');
  });

  it('F1: perfect witnessed evidence still leaves frontend-request-observed missing', () => {
    const observed = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/accounts', status: 201 },
    });
    const outcome = httpOutcome(httpObligation, [frontendAnchor, observed]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("'http:frontend-request-observed'");
    expect(outcome.reason).toContain('no independent browser/test observation channel');
    expect(outcome.reason).toContain('suite-claimed');
    // The precise 2026-09-13 decision: the session channel binds by
    // ORIGIN, not by browser, so the contract stays fail-closed.
    expect(outcome.reason).toContain('by ORIGIN, not by browser');
    expect(outcome.reason).toContain("'http:request-observed'");
  });

  it('F1: frontend-request-observed with no evidence names the missing channel', () => {
    const outcome = httpOutcome(httpObligation, []);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("'http:frontend-request-observed'");
    expect(outcome.reason).toContain('no independent browser/test observation channel');
  });

  it('F1: even session-bound exchange evidence cannot satisfy frontend-request-observed', () => {
    // The strongest possible evidence under the NEW session channel — a
    // session-bound witnessed exchange plus a session-bound anchor —
    // still cannot satisfy the frontend contract: the decision text must
    // stay pinned against regressions in either direction.
    const sessionAnchor = record(httpObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'create', entityId: 'acc-1', sessionId: 'sess-1' },
    });
    const sessionObserved = record(httpObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/accounts', status: 201, sessionId: 'sess-1' },
    });
    const outcome = httpOutcome(
      httpObligation,
      [sessionAnchor, sessionObserved],
      undefined,
      'test-1',
      routes({ method: 'POST', canonicalPath: '/api/accounts' }),
    );
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('by ORIGIN, not by browser');
  });

  it('F1: a claim cannot borrow another testId’s witnessed exchange (suite-claimed attribution)', () => {
    const otherTestRecord = record(transportObligation.id, {
      kind: 'http.request',
      testId: 'test-A',
      payload: { method: 'POST', url: '/api/accounts' },
    });
    const otherTestAnchor = record(transportObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      testId: 'test-A',
      payload: { operation: 'create', entityId: 'acc-1' },
    });
    // Test B declares the obligation but only test A's records exist:
    // attribution is suite-claimed, so B stays missing.
    const outcome = httpOutcome(transportObligation, [otherTestRecord, otherTestAnchor], undefined, 'test-B');
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("no 'ui.action' anchor from the declaring test");
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
    const failing = httpOutcome(statusObligation, [statusAnchor, observed], undefined, 'test-1', routes({
      method: 'POST',
      canonicalPath: '/api/accounts',
    }));
    expect(failing.verdict).toBe('invalid');
    expect(failing.reason).toContain('2xx');
  });

  it('no observation channel record leaves the obligation missing', () => {
    const outcome = httpOutcome(transportObligation, [anchor]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('witness observed no matching HTTP exchange');
    expect(outcome.reason).toContain('suite-claimed');
  });

  it('a witnessed observation from a different endpoint can never satisfy a bound obligation', () => {
    const observed = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/health' },
    });
    const outcome = httpOutcome(transportObligation, [anchor, observed], ENDPOINT_RESOURCE, 'test-1', routes({
      method: 'POST',
      canonicalPath: '/api/v1/contracts',
    }));
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('matches none of the 1 inventoried routes');
    expect(outcome.reason).toContain('different endpoint');
  });

  it('a witnessed observation with the wrong method grades invalid', () => {
    const observed = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/api/v1/contracts' },
    });
    const outcome = httpOutcome(transportObligation, [anchor, observed], ENDPOINT_RESOURCE, 'test-1', routes({
      method: 'POST',
      canonicalPath: '/api/v1/contracts',
    }));
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('observed GET /api/v1/contracts');
    expect(outcome.reason).toContain('matches none of the 1 inventoried routes');
  });

  it('query strings and trailing slashes normalize before the identity match', () => {
    const inventory = routes({ method: 'POST', canonicalPath: '/api/v1/contracts' });
    const withQuery = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/v1/contracts?x=1' },
    });
    expect(httpOutcome(transportObligation, [anchor, withQuery], ENDPOINT_RESOURCE, 'test-1', inventory).verdict).toBe(
      'satisfied',
    );
    const trailingSlash = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/v1/contracts/' },
    });
    expect(httpOutcome(transportObligation, [anchor, trailingSlash], ENDPOINT_RESOURCE, 'test-1', inventory).verdict).toBe(
      'satisfied',
    );
  });

  it('F4: missing route context blocks — no any-endpoint fallback', () => {
    // The historical any-endpoint fallback is removed (plan §9): a
    // perfectly witnessed exchange with no inventory context stays
    // blocking `missing`, never an authoritative pass.
    const observed = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/accounts' },
    });
    const outcome = httpOutcome(transportObligation, [anchor, observed]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('no route inventory context');
    expect(outcome.reason).toContain("'http:request-observed'");
  });

  it('a concrete path satisfies the endpoint shape positionally (P1)', () => {
    const ACCOUNTS_RESOURCE = {
      kind: 'http.endpoint',
      attributes: { method: 'GET', canonicalPath: '/accounts/{}' },
    };
    const inventory = routes({ method: 'GET', canonicalPath: '/accounts/{}' });
    const accountsAnchor = record(transportObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: '123' },
    });
    const observed = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/accounts/123' },
    });
    const outcome = httpOutcome(transportObligation, [accountsAnchor, observed], ACCOUNTS_RESOURCE, 'test-1', inventory);
    expect(outcome.verdict).toBe('satisfied');

    // An extra segment is a different endpoint shape, never a match.
    const extra = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/accounts/123/extra' },
    });
    const extraOutcome = httpOutcome(transportObligation, [accountsAnchor, extra], ACCOUNTS_RESOURCE, 'test-1', inventory);
    expect(extraOutcome.verdict).toBe('invalid');
    expect(extraOutcome.reason).toContain('observed GET /accounts/123/extra');
    expect(extraOutcome.reason).toContain('matches none of the 1 inventoried routes');
  });

  it('F3: an unknown http contract with perfect witnessed evidence stays missing', () => {
    const unknown: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:http:does-not-exist',
      contract: 'http:does-not-exist',
    };
    const unknownAnchor = record(unknown.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'create', entityId: 'acc-1' },
    });
    const observed = record(unknown.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/accounts' },
    });
    const outcome = httpOutcome(unknown, [unknownAnchor, observed]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("'http:does-not-exist'");
  });

  it('F3: a typo http contract with perfect witnessed evidence stays missing', () => {
    const typo: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:http:response-staus-ok',
      contract: 'http:response-staus-ok',
    };
    const typoAnchor = record(typo.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'create', entityId: 'acc-1' },
    });
    const observed = record(typo.id, {
      kind: 'http.request',
      payload: { method: 'POST', url: '/api/accounts', status: 200 },
    });
    const outcome = httpOutcome(typo, [typoAnchor, observed]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("'http:response-staus-ok'");
  });

  it('F3: an unknown http contract with no evidence names the contract', () => {
    const unknown: Obligation = {
      ...OBLIGATION,
      id: 'tenant.accounts:http:does-not-exist',
      contract: 'http:does-not-exist',
    };
    const outcome = httpOutcome(unknown, []);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("'http:does-not-exist'");
  });

  it('a trailing wildcard shape matches deep paths but not the bare prefix', () => {
    const FILES_RESOURCE = {
      kind: 'http.endpoint',
      attributes: { method: 'GET', canonicalPath: '/files/{*}' },
    };
    const inventory = routes({ method: 'GET', canonicalPath: '/files/{*}' });
    const filesAnchor = record(transportObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'a/b/c' },
    });
    const deep = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/files/a/b/c' },
    });
    expect(httpOutcome(transportObligation, [filesAnchor, deep], FILES_RESOURCE, 'test-1', inventory).verdict).toBe(
      'satisfied',
    );

    const bare = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/files' },
    });
    const bareOutcome = httpOutcome(transportObligation, [filesAnchor, bare], FILES_RESOURCE, 'test-1', inventory);
    expect(bareOutcome.verdict).toBe('invalid');
    expect(bareOutcome.reason).toContain('matches none of the 1 inventoried routes');
  });

  it('a literal segment mismatch in the shape grades invalid', () => {
    const V1_RESOURCE = {
      kind: 'http.endpoint',
      attributes: { method: 'GET', canonicalPath: '/api/v1/accounts' },
    };
    const v1Anchor = record(transportObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'acc-1' },
    });
    const observed = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/api/v2/accounts' },
    });
    const outcome = httpOutcome(
      transportObligation,
      [v1Anchor, observed],
      V1_RESOURCE,
      'test-1',
      routes({ method: 'GET', canonicalPath: '/api/v1/accounts' }),
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('observed GET /api/v2/accounts');
    expect(outcome.reason).toContain('matches none of the 1 inventoried routes');
  });
});

describe('F4 route attribution over the complete inventory (plan §9, D2)', () => {
  const transportObligation: Obligation = {
    schemaVersion: 1,
    id: 'tenant.accounts:http:request-observed',
    resourceId: 'tenant.accounts',
    contract: 'http:request-observed',
    policyId: 'p',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  };

  function httpOutcome(
    obligation: Obligation,
    records: unknown[],
    httpRoutes?: readonly HttpRouteCandidate[] | null,
    claimTestId: string = 'test-1',
  ) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: claimTestId }],
      records,
      waivers: [],
      classification: CLASSIFICATION,
      ...(httpRoutes !== undefined ? { httpRoutes } : {}),
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  function anchor(obligationId: string): Record<string, unknown> {
    return anchorRecord(obligationId, 'read');
  }

  function observed(
    obligationId: string,
    method: string,
    url: string,
    status = 200,
  ): Record<string, unknown> {
    return record(obligationId, {
      kind: 'http.request',
      payload: { method, url, status },
    });
  }

  const LITERAL_SIBLING: HttpRouteCandidate = {
    resourceId: 'tenant.accounts-export',
    method: 'GET',
    canonicalPath: '/accounts/export',
  };

  it('literal-only inventory: the literal observation satisfies', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/export' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/export')],
      inventory,
    );
    expect(outcome.verdict).toBe('satisfied');
  });

  it('param-only inventory: /accounts/123 satisfies the parameter endpoint', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/123')],
      inventory,
    );
    expect(outcome.verdict).toBe('satisfied');
  });

  it('both routes, literal observed: ambiguous — no literal-precedence shortcut', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
      LITERAL_SIBLING,
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/export')],
      inventory,
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('ambiguous route attribution');
    expect(outcome.reason).toContain('GET /accounts/export (tenant.accounts-export)');
    expect(outcome.reason).toContain('GET /accounts/{} (tenant.accounts)');
  });

  it('both routes, /accounts/123 observed: the unique parameter endpoint satisfies', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
      LITERAL_SIBLING,
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/123')],
      inventory,
    );
    expect(outcome.verdict).toBe('satisfied');
  });

  it('an unconsumed sibling with no obligation still forces ambiguity', () => {
    // The sibling carries no obligation of its own, but it is part of
    // the complete inventory — the literal observation matches both.
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
      LITERAL_SIBLING,
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/export')],
      inventory,
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('ambiguous route attribution');
  });

  it('same shape in two planes is ambiguous with sorted candidate identities', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
      { resourceId: 'master.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/123')],
      inventory,
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('ambiguous route attribution');
    const open = (outcome.reason ?? '').indexOf('[');
    const close = (outcome.reason ?? '').lastIndexOf(']');
    const listed = (outcome.reason ?? '').slice(open + 1, close).split('; ');
    expect(listed).toEqual([...listed].sort());
    expect(listed).toContain('GET /accounts/{} (master.accounts)');
    expect(listed).toContain('GET /accounts/{} (tenant.accounts)');
  });

  it('wrong method, extra segment, and missing segment never match', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
    ];
    for (const [method, url] of [
      ['POST', '/accounts/123'],
      ['GET', '/accounts/123/extra'],
      ['GET', '/accounts'],
    ] as const) {
      const outcome = httpOutcome(
        transportObligation,
        [anchor(transportObligation.id), observed(transportObligation.id, method, url)],
        inventory,
      );
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('matches none of the 1 inventoried routes');
    }
  });

  it('a unique match on a different endpoint is a mismatch, never credit', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.other', method: 'GET', canonicalPath: '/other' },
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
    ];
    const other: Obligation = {
      ...transportObligation,
      id: 'tenant.other:http:request-observed',
      resourceId: 'tenant.other',
    };
    const outcome = httpOutcome(
      other,
      [anchorRecord(other.id, 'read'), observed(other.id, 'GET', '/accounts/123')],
      inventory,
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('uniquely matches route GET /accounts/{} (tenant.accounts)');
    expect(outcome.reason).toContain("requires endpoint 'tenant.other'");
  });

  it('duplicate slashes are conservative: no accidental route substitution', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts//123')],
      inventory,
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('duplicate slash');
  });

  it('encoded slashes are never decoded into separators', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts%2F123')],
      inventory,
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('encoded slash');
  });

  it('a non-trailing wildcard makes the inventory incomplete (blocking missing)', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/a/{*}/c' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/a/x/c')],
      inventory,
    );
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('not attributable');
  });

  it('an ANY-method entry makes the inventory incomplete (blocking missing)', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'ANY', canonicalPath: '/accounts/{}' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/123')],
      inventory,
    );
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('not attributable');
  });

  it('repeated facts for the same resource identity dedupe to a unique match', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/123')],
      inventory,
    );
    expect(outcome.verdict).toBe('satisfied');
  });

  it('matching is case-sensitive: a differently-cased path never matches', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/export' },
    ];
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/Accounts/Export')],
      inventory,
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('matches none of the 1 inventoried routes');
  });

  it('null route context blocks with the missing-context reason', () => {
    const outcome = httpOutcome(
      transportObligation,
      [anchor(transportObligation.id), observed(transportObligation.id, 'GET', '/accounts/123')],
      null,
    );
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('no route inventory context');
  });
});

describe('F6 deterministic aggregation over repeated requests (plan §10)', () => {
  const transportObligation: Obligation = {
    schemaVersion: 1,
    id: 'tenant.accounts:http:request-observed',
    resourceId: 'tenant.accounts',
    contract: 'http:request-observed',
    policyId: 'p',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  };
  const statusObligation: Obligation = {
    ...transportObligation,
    id: 'tenant.accounts:http:response-status-ok',
    contract: 'http:response-status-ok',
  };

  function httpOutcome(
    obligation: Obligation,
    records: unknown[],
    httpRoutes: readonly HttpRouteCandidate[] | null,
    claimTestId: string = 'test-1',
  ) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: claimTestId }],
      records,
      waivers: [],
      classification: CLASSIFICATION,
      ...(httpRoutes !== undefined ? { httpRoutes } : {}),
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  function anchor(obligationId: string, entityId: string = 'acc-1'): Record<string, unknown> {
    return record(obligationId, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId },
    });
  }

  function observed(
    obligationId: string,
    method: string,
    url: string,
    status = 200,
  ): Record<string, unknown> {
    return record(obligationId, {
      kind: 'http.request',
      payload: { method, url, status },
    });
  }

  const INVENTORY: readonly HttpRouteCandidate[] = [
    { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
  ];

  /** The complete comparable result: verdict, reason, and selected ids. */
  function complete(outcome: { verdict: string; reason: string | null; recordIds: string[] }) {
    return { verdict: outcome.verdict, reason: outcome.reason, recordIds: outcome.recordIds };
  }

  it('unrelated-first and valid-first yield the same complete result', () => {
    const unrelated = observed(transportObligation.id, 'GET', '/other');
    const valid = observed(transportObligation.id, 'GET', '/accounts/123');
    const anchorRecord = anchor(transportObligation.id);
    const first = complete(httpOutcome(transportObligation, [anchorRecord, unrelated, valid], INVENTORY));
    const second = complete(httpOutcome(transportObligation, [anchorRecord, valid, unrelated], INVENTORY));
    expect(first.verdict).toBe('satisfied');
    expect(second).toEqual(first);
    expect(first.recordIds).toContain(String(valid['recordId']));
    expect(first.recordIds).not.toContain(String(unrelated['recordId']));
  });

  it('matching 500 plus matching 200 satisfies status-ok with the same IDs in both orders', () => {
    const statusAnchor = anchor(statusObligation.id);
    const bad = observed(statusObligation.id, 'GET', '/accounts/123', 500);
    const good = observed(statusObligation.id, 'GET', '/accounts/456', 200);
    const first = complete(httpOutcome(statusObligation, [statusAnchor, bad, good], INVENTORY));
    const second = complete(httpOutcome(statusObligation, [statusAnchor, good, bad], INVENTORY));
    expect(first.verdict).toBe('satisfied');
    expect(second).toEqual(first);
    expect(first.recordIds).toContain(String(good['recordId']));
    expect(first.recordIds).not.toContain(String(bad['recordId']));
  });

  it('two valid requests select the same record deterministically', () => {
    const anchorRecord = anchor(transportObligation.id);
    const first_valid = observed(transportObligation.id, 'GET', '/accounts/123');
    const second_valid = observed(transportObligation.id, 'GET', '/accounts/456');
    const first = complete(
      httpOutcome(transportObligation, [anchorRecord, first_valid, second_valid], INVENTORY),
    );
    const second = complete(
      httpOutcome(transportObligation, [anchorRecord, second_valid, first_valid], INVENTORY),
    );
    expect(first.verdict).toBe('satisfied');
    expect(second).toEqual(first);
    const expected = [String(first_valid['recordId']), String(second_valid['recordId'])].sort()[0] as string;
    expect(first.recordIds).toContain(expected);
  });

  it('claimed-only records never satisfy', () => {
    const forged = record(transportObligation.id, {
      kind: 'http.request',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { method: 'GET', url: '/accounts/123', status: 200 },
    });
    for (const records of [
      [anchor(transportObligation.id), forged],
      [forged, anchor(transportObligation.id)],
    ]) {
      const outcome = httpOutcome(transportObligation, records, INVENTORY);
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('HTTP_OBSERVATION_UNTRUSTED');
    }
  });

  it('malformed plus valid evidence behaves identically in either order', () => {
    const malformed = record(transportObligation.id, {
      kind: 'http.request',
      payload: { status: 200 },
    });
    const valid = observed(transportObligation.id, 'GET', '/accounts/123');
    const anchorRecord = anchor(transportObligation.id);
    const first = complete(httpOutcome(transportObligation, [anchorRecord, malformed, valid], INVENTORY));
    const second = complete(httpOutcome(transportObligation, [anchorRecord, valid, malformed], INVENTORY));
    expect(first.verdict).toBe('satisfied');
    expect(second).toEqual(first);
  });

  it('wrong-route plus valid evidence never selects the wrong-route record', () => {
    const inventory: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
      { resourceId: 'tenant.other', method: 'GET', canonicalPath: '/other' },
    ];
    const wrong = observed(transportObligation.id, 'GET', '/other');
    const valid = observed(transportObligation.id, 'GET', '/accounts/123');
    const anchorRecord = anchor(transportObligation.id);
    const first = complete(httpOutcome(transportObligation, [anchorRecord, wrong, valid], inventory));
    const second = complete(httpOutcome(transportObligation, [anchorRecord, valid, wrong], inventory));
    expect(first.verdict).toBe('satisfied');
    expect(second).toEqual(first);
    expect(first.recordIds).toContain(String(valid['recordId']));
    expect(first.recordIds).not.toContain(String(wrong['recordId']));
  });

  it('all-invalid populations return the stable smallest reason', () => {
    const first_bad = observed(transportObligation.id, 'GET', '/other-b');
    const second_bad = observed(transportObligation.id, 'GET', '/other-a');
    const anchorRecord = anchor(transportObligation.id);
    const first = complete(
      httpOutcome(transportObligation, [anchorRecord, first_bad, second_bad], INVENTORY),
    );
    const second = complete(
      httpOutcome(transportObligation, [anchorRecord, second_bad, first_bad], INVENTORY),
    );
    expect(first.verdict).toBe('invalid');
    expect(second).toEqual(first);
  });

  it('all-missing populations return a stable reason', () => {
    const broken = (url: string) => {
      const entry = observed(transportObligation.id, 'GET', url);
      return { ...entry, recordId: '0'.repeat(64) };
    };
    const anchorRecord = anchor(transportObligation.id);
    const first = complete(
      httpOutcome(transportObligation, [anchorRecord, broken('/accounts/123'), broken('/accounts/456')], INVENTORY),
    );
    const second = complete(
      httpOutcome(transportObligation, [anchorRecord, broken('/accounts/456'), broken('/accounts/123')], INVENTORY),
    );
    expect(first.verdict).toBe('missing');
    expect(second).toEqual(first);
  });

  it('duplicate records do not duplicate report IDs', () => {
    const anchorRecord = anchor(transportObligation.id);
    const valid = observed(transportObligation.id, 'GET', '/accounts/123');
    const outcome = httpOutcome(transportObligation, [anchorRecord, valid, { ...valid }], INVENTORY);
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.recordIds).toEqual([...new Set(outcome.recordIds)].sort());
    expect(outcome.recordIds).toHaveLength(2);
  });

  it('two qualifying anchors select the smallest anchor joined with the exchange', () => {
    const first_anchor = anchor(transportObligation.id, 'acc-1');
    const second_anchor = anchor(transportObligation.id, 'acc-2');
    const valid = observed(transportObligation.id, 'GET', '/accounts/123');
    const first = complete(
      httpOutcome(transportObligation, [first_anchor, second_anchor, valid], INVENTORY),
    );
    const second = complete(
      httpOutcome(transportObligation, [second_anchor, first_anchor, valid], INVENTORY),
    );
    expect(first.verdict).toBe('satisfied');
    expect(second).toEqual(first);
    const expectedAnchor = [String(first_anchor['recordId']), String(second_anchor['recordId'])].sort()[0] as string;
    expect(first.recordIds).toContain(expectedAnchor);
    expect(first.recordIds).toContain(String(valid['recordId']));
  });

  it('separate test IDs are still filtered per-claim (suite-claimed, not verified identity)', () => {
    const otherAnchor = record(transportObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      testId: 'test-A',
      payload: { operation: 'read', entityId: 'acc-1' },
    });
    const otherObserved = record(transportObligation.id, {
      kind: 'http.request',
      testId: 'test-A',
      payload: { method: 'GET', url: '/accounts/123', status: 200 },
    });
    const outcome = httpOutcome(transportObligation, [otherAnchor, otherObserved], INVENTORY, 'test-B');
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("no 'ui.action' anchor from the declaring test");
  });
});

describe('contract capability metadata (plan 2026-09-13 Phase 0 item 3, ADR 0005)', () => {
  it('registers capabilities alongside every verifier namespace', () => {
    expect(allCapabilities().map((capability) => capability.namespace)).toEqual([
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

  it('http: transport contracts available over the witness proxy; frontend contract unavailable', () => {
    const http = capabilityFor('http:request-observed');
    expect(http).not.toBeNull();
    expect(http?.availability.status).toBe('available');
    expect(http?.contracts).toEqual(['http:request-observed', 'http:response-status-ok']);
    expect(http?.testKinds).toEqual(['browser-e2e', 'api-e2e']);
    expect(http?.observer).toContain('witness HTTP proxy channel');
    const frontend = http?.unavailableContracts.find(
      (entry) => entry.contract === 'http:frontend-request-observed',
    );
    expect(frontend?.reason).toContain('no independent browser/test observation channel');
    // The decision is pinned: the session channel binds by ORIGIN, not by
    // browser, so the contract stays fail-closed rather than silently
    // change meaning.
    expect(frontend?.reason).toContain('by ORIGIN, not by browser');
  });

  it('persistence: available via the witness persistence adapter with the exact-value echo requirement', () => {
    const persistence = capabilityFor('persistence:update');
    expect(persistence?.availability.status).toBe('available');
    expect(persistence?.observer).toContain('witness persistence adapter');
    expect(persistence?.observer).toContain('EVIDENCE_VALUE_MISMATCH');
    expect(persistence?.observer).toContain('same entity');
    expect(persistence?.testKinds).toEqual(['browser-e2e', 'api-e2e']);
  });

  it('crud: AVAILABLE through the engine-owned browser channel (plan Phase 1 item 4)', () => {
    // The engine-owned browser action/observation channel is implemented
    // and tested: the engine drives its own Chromium, observes the
    // rendered action + captured exchange + visible result itself, and
    // issues engine-observed records. The namespace is available; the
    // per-rule reasons (not a capability hole) decide each claim.
    const crud = capabilityFor('crud:update');
    expect(crud?.availability.status).toBe('available');
    expect(crud?.contracts).toEqual(['crud:create', 'crud:read', 'crud:update', 'crud:delete']);
    expect(crud?.testKinds).toEqual(['browser-e2e']);
    expect(crud?.observer).toContain('ENGINE-OWNED browser');
    expect(crud?.observer).toContain('suite-submitted UI records');
    for (const [namespace, channel] of [
      ['auth', 'identity/role material'],
      ['task', 'queue/job delivery state'],
      ['validation', 'boundary semantics'],
      ['webhook', 'signature/replay verification'],
      ['workflow', 'workflow state machine'],
    ] as const) {
      const capability = capabilityFor(`${namespace}:anything`);
      expect(capability?.availability.status).toBe('unavailable');
      expect(capability?.contracts).toEqual([]);
      expect(capability?.observer).toContain(channel);
      if (capability?.availability.status === 'unavailable') {
        expect(capability.availability.reason).toContain('fail');
      }
    }
  });

  it('an unregistered namespace has no capability record', () => {
    expect(capabilityFor('notapack:thing')).toBeNull();
  });

  it('capability registration is first-wins: no override, even for a fresh verifier', () => {
    const duplicate: ContractCapability = {
      namespace: 'http',
      contracts: ['http:fake'],
      unavailableContracts: [],
      observer: 'fake observer',
      testKinds: [],
      availability: { status: 'available' },
    };
    expect(() => registerContractCapabilities(duplicate)).toThrow(
      /already registered; registration cannot override another namespace/,
    );
    // The original record survives untouched (no weakening by order).
    expect(capabilityFor('http:request-observed')?.contracts).toEqual([
      'http:request-observed',
      'http:response-status-ok',
    ]);
    // A NEW namespace can register; clean it up by registering a unique one.
    expect(() =>
      registerContractCapabilities({
        namespace: 'test-only-namespace',
        contracts: [],
        unavailableContracts: [],
        observer: 'test',
        testKinds: [],
        availability: { status: 'unavailable', reason: 'test-only' },
      }),
    ).not.toThrow();
  });
});

describe('cause mapping (plan 2026-09-13 §5.4)', () => {
  it('unsupported verifier: no capability record → VERIFIER_UNSUPPORTED', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.accounts:notapack:thing',
      contract: 'notapack:thing',
      verdict: 'missing',
      reason: "no semantic verifier is registered for contract 'notapack:thing'; 'x' stays blocking",
    });
    expect(mapped.cause).toBe('VERIFIER_UNSUPPORTED');
    expect(mapped.nextAction).toBe('Implement/configure the observer; do not add duplicate tests');
  });

  it('fail-closed namespaces → VERIFIER_UNSUPPORTED (crud is available, so it is not among them)', () => {
    for (const contract of [
      'auth:role-denied',
      'workflow:persisted-final-state',
    ]) {
      const mapped = causeForVerdict({
        obligationId: `tenant.accounts:${contract}`,
        contract,
        verdict: 'missing',
        reason: 'has no honest evidence channel',
      });
      expect(mapped.cause).toBe('VERIFIER_UNSUPPORTED');
    }
    // crud:update is AVAILABLE through the engine-owned browser channel
    // (plan Phase 1 item 4), so a crud block maps by its per-rule reason
    // — an unmapped precise reason carries no guessed cause.
    const crud = causeForVerdict({
      obligationId: 'tenant.accounts:crud:update',
      contract: 'crud:update',
      verdict: 'invalid',
      reason: 'some unmapped precise reason',
    });
    expect(crud.cause).toBeNull();
    expect(crud.nextAction).toBeNull();
  });

  it('crud session-channel rules map to per-rule causes (engine channel available)', () => {
    // With the engine-owned browser channel available, the verifier
    // grades evidence rule by rule, and each rule reason maps to its
    // per-evidence cause — the channel gap is gone.
    for (const [reason, cause] of [
      [
        "'t': no witnessed session-bound 'http.request' exchange was observed " +
          '(HTTP_OBSERVATION_UNTRUSTED): a direct API or Node-side mutation never enters the ' +
          'supervised session channel',
        'EVIDENCE_NOT_COLLECTED',
      ],
      [
        "no witnessed visible-result record for entity 'acc-1' of 't' " +
          '(EVIDENCE_NOT_COLLECTED): the journey must read the rendered result back',
        'EVIDENCE_NOT_COLLECTED',
      ],
      [
        "exact-value echo violation (EVIDENCE_VALUE_MISMATCH): the 'ui.action' declared input first_name=...",
        'EVIDENCE_VALUE_MISMATCH',
      ],
    ] as const) {
      const mapped = causeForVerdict({
        obligationId: 'tenant.accounts:crud:create',
        contract: 'crud:create',
        verdict: 'missing',
        reason,
      });
      expect(mapped.cause).toBe(cause);
    }
    // A borrowed cross-session exchange still fails the session binding
    // (invalid), and the inventory gap still names the setup hole.
    const borrowed = causeForVerdict({
      obligationId: 'tenant.accounts:crud:create',
      contract: 'crud:create',
      verdict: 'invalid',
      reason: "'t': witnessed 'http.request' record 'r' was observed on witness session 's2'",
    });
    expect(borrowed.cause).toBeNull();
    const inventory = causeForVerdict({
      obligationId: 'tenant.accounts:crud:create',
      contract: 'crud:create',
      verdict: 'missing',
      reason: "'t': no route inventory context for 'crud:",
    });
    expect(inventory.cause).toBe('VERIFIER_UNSUPPORTED');
  });

  it('a registered-but-unavailable contract (frontend-request-observed) → VERIFIER_UNSUPPORTED', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.accounts:http:frontend-request-observed',
      contract: 'http:frontend-request-observed',
      verdict: 'missing',
      reason: 'no independent browser/test observation channel',
    });
    expect(mapped.cause).toBe('VERIFIER_UNSUPPORTED');
    expect(mapped.nextAction).toContain('do not add duplicate tests');
  });

  it('evidence absence for a connected test → EVIDENCE_NOT_COLLECTED', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.accounts:persistence:read',
      contract: 'persistence:read',
      verdict: 'missing',
      reason: "claim 'suite-test' declares 'tenant.accounts:persistence:read' but produced no evidence records",
    });
    expect(mapped.cause).toBe('EVIDENCE_NOT_COLLECTED');
    expect(mapped.nextAction).toBe('Add observation hooks to that test');
  });

  it('no claim connected → TEST_MAPPING_MISSING (placeholder refined by Phase 2-3)', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.accounts:persistence:read',
      contract: 'persistence:read',
      verdict: 'missing',
      reason: "no claim declares 'tenant.accounts:persistence:read'",
    });
    expect(mapped.cause).toBe('TEST_MAPPING_MISSING');
    expect(mapped.nextAction).toBe('Inspect suggested existing tests first');
  });

  it('supported-contract blocks with other reasons carry no Phase 0 cause (later phases populate)', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.accounts:http:request-observed',
      contract: 'http:request-observed',
      verdict: 'invalid',
      reason: 'HTTP_OBSERVATION_UNTRUSTED: suite-submitted network record',
    });
    expect(mapped.cause).toBeNull();
    expect(mapped.nextAction).toBeNull();
  });

  it('clean verdicts never carry a cause', () => {
    for (const verdict of ['satisfied', 'waived'] as const) {
      const mapped = causeForVerdict({
        obligationId: 'tenant.accounts:persistence:read',
        contract: 'persistence:read',
        verdict,
        reason: null,
      });
      expect(mapped.cause).toBeNull();
    }
  });
});

describe('strict preflight capability gaps (plan 2026-09-13 Phase 0 item 4)', () => {
  it('a supported contract has no gap', () => {
    expect(capabilityGap('persistence:read')).toBeNull();
    expect(capabilityGap('http:request-observed')).toBeNull();
  });

  it('an unavailable contract yields a precise gap naming contract, observer, and next action', () => {
    const gap = capabilityGap('http:frontend-request-observed');
    expect(gap?.cause).toBe('VERIFIER_UNSUPPORTED');
    expect(gap?.contract).toBe('http:frontend-request-observed');
    expect(gap?.detail).toContain('no independent browser/test observation channel');
    expect(gap?.detail).toContain('by ORIGIN, not by browser');
    expect(gap?.observer).toContain('witness HTTP proxy channel');
    expect(gap?.nextAction).toBe('Implement/configure the observer; do not add duplicate tests');
    // The UI-semantic crud contracts are AVAILABLE through the
    // engine-owned browser channel (plan Phase 1 item 4) — no capability
    // gap names them; per-rule evidence reasons decide each claim.
    for (const contract of ['crud:create', 'crud:read', 'crud:update', 'crud:delete']) {
      expect(capabilityGap(contract)).toBeNull();
    }
    // An unknown crud name is unsupported as well.
    const unknownCrud = capabilityGap('crud:export');
    expect(unknownCrud?.cause).toBe('VERIFIER_UNSUPPORTED');
  });

  it('strictCapabilityGaps maps unsupported obligations precisely and sorts by id', () => {
    const gaps = strictCapabilityGaps([
      { id: 'tenant.accounts:http:frontend-request-observed', contract: 'http:frontend-request-observed' },
      { id: 'tenant.accounts:persistence:read', contract: 'persistence:read' },
      { id: 'tenant.orders:auth:role-denied', contract: 'auth:role-denied' },
    ]);
    expect(gaps.map((gap) => gap.obligationId)).toEqual([
      'tenant.accounts:http:frontend-request-observed',
      'tenant.orders:auth:role-denied',
    ]);
    expect(gaps.every((gap) => gap.cause === 'VERIFIER_UNSUPPORTED')).toBe(true);
    expect(gaps[0]?.detail).toContain("obligation 'tenant.accounts:http:frontend-request-observed'");
  });
});
