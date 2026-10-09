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
  bindQueueObserver,
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
  CAUSE_NEXT_ACTIONS,
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
  it('auth: a perfectly-formed witnessed check record grades missing without a compiled case set', () => {
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const check = record(OBLIGATION.id);
    const outcome = grade([anchor, check]);
    expect(outcome.verdict).toBe('missing');
    // Implemented contracts grade only across approved required cases;
    // the per-claim fallback names the missing case set, and transport
    // evidence still cannot satisfy them.
    expect(outcome.reason).toContain(
      "contract 'auth:role-denied' has no compiled required-case set",
    );
    expect(outcome.reason).toContain('transport evidence cannot satisfy them');
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
      "contract 'workflow:persisted-final-state' has no compiled required-case set",
    );
    expect(outcome.reason).toContain('transport evidence cannot satisfy them');
    expect(outcome.reason).not.toContain('has no honest evidence channel');
    expect(outcome.reason).not.toContain('state-observing producer');
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
      "contract 'webhook:replay-idempotent' has no compiled required-case set",
    );
    expect(outcome.reason).toContain('transport evidence cannot satisfy them');
    expect(outcome.reason).not.toContain('has no honest evidence channel');
    expect(outcome.reason).not.toContain('state-observing producer');
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
      "contract 'task:idempotent' has no compiled required-case set",
    );
    expect(outcome.reason).toContain('transport evidence cannot satisfy them');
    expect(outcome.reason).not.toContain('has no honest evidence channel');
    expect(outcome.reason).not.toContain('state-observing producer');
  });

  it('validation: a perfectly-formed witnessed check record grades missing without a compiled case set', () => {
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
      "contract 'validation:error-message-explicit' has no compiled required-case set",
    );
    expect(outcome.reason).toContain('transport evidence cannot satisfy them');
  });

  it('a forged-looking witnessed check can never satisfy: missing, never satisfied or invalid', () => {
    // The strongest possible transport evidence — a provenanced witnessed
    // check record, a provenanced anchor, and the bound endpoint resource
    // — still yields only the honest missing verdict (no compiled case set).
    const anchor = anchorRecord(OBLIGATION.id, 'read');
    const check = record(OBLIGATION.id);
    const outcome = grade([anchor, check], [claim()], {
      kind: 'http.endpoint',
      attributes: { method: 'POST', canonicalPath: '/api/v1/accounts' },
    });
    expect(outcome.verdict).not.toBe('satisfied');
    expect(outcome.verdict).not.toBe('invalid');
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('has no compiled required-case set');
  });

  it('ui anchors do not change the fail-closed outcome', () => {
    const withAnchor = grade([anchorRecord(OBLIGATION.id, 'read'), record(OBLIGATION.id)]);
    const withoutAnchor = grade([record(OBLIGATION.id)]);
    const anchorOnly = grade([anchorRecord(OBLIGATION.id, 'read')]);
    expect(withAnchor.verdict).toBe('missing');
    expect(withoutAnchor.verdict).toBe('missing');
    expect(anchorOnly.verdict).toBe('missing');
    expect(withAnchor.reason).toBe(withoutAnchor.reason);
    expect(withAnchor.reason).toContain('has no compiled required-case set');
  });

  it('claimed-tier check records get the same honest-channel reason', () => {
    const claimed = record(OBLIGATION.id, { origin: 'suite-submitted', trust: 'claimed' });
    const outcome = grade([claimed]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('has no compiled required-case set');
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
    expect(outcome.reason).toContain('has no compiled required-case set');
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

  it('a named parameter segment matches exactly one non-empty segment', () => {
    // The host declares its routes in its own grammar (Express `:id`,
    // FastAPI/other `{id}`); the grader must resolve an observed path
    // against that SAME declaration, exactly as the witness-side route
    // inventory does. A route whose id never resolves can never be
    // proven — a silent failure, not a fail-closed one.
    expect(pathMatchesShape('/admin/accounts/acc-3', '/admin/accounts/:id')).toBe(true);
    expect(pathMatchesShape('/api/accounts/acc-3', '/api/accounts/{id}')).toBe(true);
    // A named parameter is positional: never zero segments, never many.
    expect(pathMatchesShape('/admin/accounts', '/admin/accounts/:id')).toBe(false);
    expect(pathMatchesShape('/admin/accounts/acc-3/edit', '/admin/accounts/:id')).toBe(false);
    // Everything else in the shape stays literal and case-sensitive.
    expect(pathMatchesShape('/admin/Accounts/acc-3', '/admin/accounts/:id')).toBe(false);
    expect(pathMatchesShape('/admin/accounts/acc-3', '/admin/Accounts/:id')).toBe(false);
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

  it('an http.exchanges record alone leaves an http obligation missing (never satisfies)', () => {
    // The session-wide ledger kind (0.14 WP2) feeds the REPORT-ONLY
    // httpLedger. Even witnessed, provenance-valid, and carrying an
    // exchange that WOULD attribute to the obligation's own endpoint,
    // it can never satisfy a claim — only `http.request` and
    // Observe-channel `http.observed` records grade.
    const sessionExchanges = record(transportObligation.id, {
      kind: 'http.exchanges',
      payload: {
        channel: 'observe',
        sessionId: 'sess-1',
        exchanges: [{ method: 'POST', url: '/api/accounts', status: 200 }],
      },
    });
    const outcome = httpOutcome(transportObligation, [anchor, sessionExchanges], undefined, 'test-1', routes({
      method: 'POST',
      canonicalPath: '/api/accounts',
    }));
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('witness observed no matching HTTP exchange');
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

/**
 * Plan 0.9.2 item D: the transport contracts accept the OBSERVE
 * channel, so a normal suite-driven test mapped `observed-e2e` can
 * discharge `http:request-observed` / `http:response-status-ok` from
 * the exchange the witness proxied in its own session. The invariants
 * pinned here are the ones that keep this from weakening anything:
 * I1 the frontend contract stays unprovable, I3 admission is trust AND
 * channel gated, I4 one shared matcher, I6 the engine-browser anchor
 * path stays preferred and unchanged.
 */
describe('transport Observe channel (plan 0.9.2 item D)', () => {
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
  const frontendObligation: Obligation = {
    ...transportObligation,
    id: 'tenant.accounts:http:frontend-request-observed',
    contract: 'http:frontend-request-observed',
  };

  const INVENTORY: readonly HttpRouteCandidate[] = [
    { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
  ];

  function httpOutcome(
    obligation: Obligation,
    records: unknown[],
    httpRoutes: readonly HttpRouteCandidate[] | null = INVENTORY,
  ) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
      records,
      waivers: [],
      classification: CLASSIFICATION,
      httpRoutes,
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  /** The complete comparable result: verdict, reason, and selected ids. */
  function complete(outcome: { verdict: string; reason: string | null; recordIds: string[] }) {
    return { verdict: outcome.verdict, reason: outcome.reason, recordIds: outcome.recordIds };
  }

  /**
   * The GRADE alone: a blocking outcome still lists the evidence it
   * read, so comparing record ids across two different evidence sets
   * says nothing about whether the grading changed.
   */
  function grading(outcome: { verdict: string; reason: string | null }) {
    return { verdict: outcome.verdict, reason: outcome.reason };
  }

  const anchor = record(transportObligation.id, {
    kind: 'ui.action',
    origin: 'suite-submitted',
    trust: 'claimed',
    payload: { operation: 'read', entityId: 'acc-1' },
  });

  /**
   * A witnessed Observe-channel record: exactly what the witness's
   * observe finalize stamps — the session's own proxied exchanges,
   * deduplicated and capped witness-side, admitted core-side only when
   * it carries BOTH `witnessed` trust and the `observe` channel stamp.
   */
  function observedRecord(
    obligationId: string,
    payload: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return record(obligationId, {
      kind: 'http.observed',
      payload: { channel: 'observe', sessionId: 'sess-1', exchanges: [], ...payload },
      ...overrides,
    });
  }

  const MATCHING = [{ method: 'GET', url: '/accounts/456', status: 200 }];

  it('I6 (a): a satisfied engine path is returned verbatim, observe record present or not', () => {
    const request = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/accounts/123', status: 200 },
    });
    const engineOnly = complete(httpOutcome(transportObligation, [anchor, request]));
    expect(engineOnly.verdict).toBe('satisfied');
    expect(engineOnly.recordIds).toContain(String(anchor['recordId']));
    expect(engineOnly.recordIds).toContain(String(request['recordId']));
    // An observe record changes nothing — not the verdict, not the ids.
    const observed = observedRecord(transportObligation.id, { exchanges: MATCHING });
    expect(complete(httpOutcome(transportObligation, [anchor, request, observed]))).toEqual(engineOnly);
    expect(engineOnly.recordIds).not.toContain(String(observed['recordId']));
  });

  it('I6 (b): an engine-found ERROR is final — a matching observe record never masks it', () => {
    // The engine observed the request and the response was not 2xx. The
    // Observe channel carries a 200 for the same endpoint, and it must
    // not turn a witness-observed failure into a pass.
    const statusAnchor = record(statusObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'acc-1' },
    });
    const failing = record(statusObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/accounts/123', status: 500 },
    });
    const matching = observedRecord(statusObligation.id, { exchanges: MATCHING });
    const engineOnly = grading(httpOutcome(statusObligation, [statusAnchor, failing]));
    expect(engineOnly.verdict).toBe('invalid');
    expect(grading(httpOutcome(statusObligation, [statusAnchor, failing, matching]))).toEqual(engineOnly);
    expect(engineOnly.reason).toContain('2xx');

    // The same rule for a wrong-endpoint exchange, not only a status.
    const wrongRoute = record(transportObligation.id, {
      kind: 'http.request',
      payload: { method: 'GET', url: '/health', status: 200 },
    });
    const mismatchOnly = grading(httpOutcome(transportObligation, [anchor, wrongRoute]));
    expect(mismatchOnly.verdict).toBe('invalid');
    expect(
      grading(
        httpOutcome(transportObligation, [
          anchor,
          wrongRoute,
          observedRecord(transportObligation.id, { exchanges: MATCHING }),
        ]),
      ),
    ).toEqual(mismatchOnly);
  });

  it('I6 (c): the Observe channel discharges the obligation when the engine path is missing', () => {
    // A suite-driven test mapped observed-e2e has no engine-owned
    // `http.request` record and may declare no UI action at all: the
    // Observe channel exists exactly so this claim is not unsatisfiable.
    const observed = observedRecord(transportObligation.id, { exchanges: MATCHING });
    expect(httpOutcome(transportObligation, [observed]).verdict).toBe('satisfied');
    expect(complete(httpOutcome(transportObligation, [observed])).recordIds).toEqual([
      String(observed['recordId']),
    ]);
  });

  it('does not credit an Observe exchange initiated by evaluated test code', () => {
    const testInitiated = observedRecord(transportObligation.id, {
      exchanges: [{ method: 'GET', url: '/accounts/456', status: 200, initiator: 'test-code' }],
    });
    const outcome = httpOutcome(transportObligation, [testInitiated]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toBe(
      "'tenant.accounts:http:request-observed': the request was started by test code running in the page " +
        "(page.evaluate / injected script), not by the app's UI. Drive the operation through the UI.",
    );
    const appRequest = observedRecord(transportObligation.id, {
      exchanges: [
        { method: 'GET', url: '/accounts/456', status: 200, initiator: 'test-code' },
        { method: 'GET', url: '/accounts/456', status: 200 },
      ],
    });
    expect(httpOutcome(transportObligation, [appRequest]).verdict).toBe('satisfied');
  });

  it('I6 (d): an engine-only claim grades the same whatever the observe records are', () => {
    // The channel that says nothing cannot reword the channel that did:
    // with no admissible `http.observed` record the anchor outcome is
    // returned verbatim, exactly as before this channel existed.
    const missingOnly = complete(httpOutcome(transportObligation, [anchor]));
    expect(missingOnly.verdict).toBe('missing');
    expect(missingOnly.reason).toContain('witness observed no matching HTTP exchange');
    expect(
      grading(
        httpOutcome(transportObligation, [
          anchor,
          // A suite-asserted record, and a witnessed one stamped with
          // another channel: neither is admissible anywhere.
          observedRecord(
            transportObligation.id,
            { exchanges: MATCHING },
            { origin: 'suite-submitted', trust: 'claimed' },
          ),
          observedRecord(transportObligation.id, { exchanges: MATCHING, channel: 'server' }),
        ]),
      ),
    ).toEqual(grading(missingOnly));
  });

  it('I4: the Observe channel runs the SAME endpoint matcher as the anchor path', () => {
    const normalized = observedRecord(transportObligation.id, {
      exchanges: [{ method: 'GET', url: '/accounts/123/?page=2', status: 200 }],
    });
    expect(httpOutcome(transportObligation, [normalized]).verdict).toBe('satisfied');

    // A different endpoint never satisfies, and the reason says which
    // channel produced it.
    const wrong = observedRecord(transportObligation.id, {
      exchanges: [{ method: 'GET', url: '/health', status: 200 }],
    });
    const wrongOutcome = httpOutcome(transportObligation, [anchor, wrong]);
    expect(wrongOutcome.verdict).toBe('invalid');
    expect(wrongOutcome.reason).toContain("observe-channel exchange in witnessed 'http.observed' record");
    expect(wrongOutcome.reason).toContain('matches none of the 1 inventoried routes');

    // The same literal-vs-parameter ambiguity the anchor path blocks on
    // blocks here: one matcher, one verdict.
    const ambiguous = httpOutcome(
      transportObligation,
      [observedRecord(transportObligation.id, { exchanges: [{ method: 'GET', url: '/accounts/export', status: 200 }] })],
      [
        { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
        { resourceId: 'tenant.accounts.export', method: 'GET', canonicalPath: '/accounts/export' },
      ],
    );
    expect(ambiguous.verdict).toBe('invalid');
    expect(ambiguous.reason).toContain('ambiguous route attribution');

    // No route inventory is no endpoint-specific pass, on this channel
    // exactly as on the anchor path.
    const noContext = httpOutcome(
      transportObligation,
      [
        anchor,
        record(transportObligation.id, {
          kind: 'http.request',
          payload: { method: 'GET', url: '/accounts/123', status: 200 },
        }),
        observedRecord(transportObligation.id, { exchanges: MATCHING }),
      ],
      null,
    );
    expect(noContext.verdict).toBe('missing');
    expect(noContext.reason).toContain('no route inventory context');
  });

  it("names the obligation's own blocked exchange, not an unrelated endpoint the same test also called", () => {
    // A test logs in, then calls the obligation's route. That call is
    // ambiguous (literal sibling), so the claim blocks either way, but
    // the reason must name the overlap, not the login exchange.
    const routes: readonly HttpRouteCandidate[] = [
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
      { resourceId: 'tenant.accounts.export', method: 'GET', canonicalPath: '/accounts/export' },
      { resourceId: 'tenant.auth.login', method: 'POST', canonicalPath: '/auth/login' },
    ];
    const login = { method: 'POST', url: '/auth/login', status: 200 };
    const own = { method: 'GET', url: '/accounts/export', status: 200 };

    const oneRecord = complete(
      httpOutcome(transportObligation, [observedRecord(transportObligation.id, { exchanges: [login, own] })], routes),
    );
    expect(oneRecord.verdict).toBe('invalid');
    expect(oneRecord.reason).toContain('ambiguous route attribution');
    expect(oneRecord.reason).not.toContain('POST /auth/login');

    // Across records too: a record holding only the login exchange never
    // outranks the record holding the obligation's own blocked exchange.
    const twoRecords = complete(
      httpOutcome(
        transportObligation,
        [
          observedRecord(transportObligation.id, { exchanges: [login], sessionId: 'sess-a' }),
          observedRecord(transportObligation.id, { exchanges: [own], sessionId: 'sess-b' }),
        ],
        routes,
      ),
    );
    expect(twoRecords.verdict).toBe('invalid');
    expect(twoRecords.reason).toContain('ambiguous route attribution');

    // A non-2xx on the obligation's own route outranks an unrelated
    // endpoint as well.
    const failing = complete(
      httpOutcome(
        statusObligation,
        [
          observedRecord(statusObligation.id, {
            exchanges: [login, { method: 'GET', url: '/accounts/7', status: 500 }],
          }),
        ],
        routes,
      ),
    );
    expect(failing.verdict).toBe('invalid');
    expect(failing.reason).toContain("observed status '500' is not a 2xx response");
  });

  it('I4: response-status-ok still requires a 2xx on the Observe channel', () => {
    const failing = observedRecord(statusObligation.id, {
      exchanges: [{ method: 'GET', url: '/accounts/456', status: 500 }],
    });
    const bad = httpOutcome(statusObligation, [failing]);
    expect(bad.verdict).toBe('invalid');
    expect(bad.reason).toContain("observed status '500' is not a 2xx response");

    const passing = observedRecord(statusObligation.id, {
      exchanges: [
        { method: 'GET', url: '/accounts/456', status: 500 },
        { method: 'GET', url: '/accounts/789', status: 204 },
      ],
    });
    expect(httpOutcome(statusObligation, [passing]).verdict).toBe('satisfied');
  });

  it('I3: only a witnessed channel:observe record is admitted', () => {
    const claimed = observedRecord(
      transportObligation.id,
      { exchanges: MATCHING },
      { origin: 'suite-submitted', trust: 'claimed' },
    );
    const suiteAsserted = httpOutcome(transportObligation, [anchor, claimed]);
    expect(suiteAsserted.verdict).toBe('missing');
    expect(suiteAsserted.reason).not.toContain('http.observed');

    // A witnessed record WITHOUT the observe stamp is admissible
    // nowhere — never transport-satisfying, never invalidating.
    const unstamped = observedRecord(transportObligation.id, {
      exchanges: MATCHING,
      channel: 'server',
    });
    const otherChannel = httpOutcome(transportObligation, [anchor, unstamped]);
    expect(otherChannel.verdict).toBe('missing');
    expect(otherChannel.reason).not.toContain('http.observed');
  });

  it('I1: frontend-request-observed stays unprovable with a matching Observe record present', () => {
    const frontendAnchor = record(frontendObligation.id, {
      kind: 'ui.action',
      origin: 'suite-submitted',
      trust: 'claimed',
      payload: { operation: 'read', entityId: 'acc-1' },
    });
    const observed = observedRecord(frontendObligation.id, { exchanges: MATCHING });
    const outcome = httpOutcome(frontendObligation, [frontendAnchor, observed]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('by ORIGIN, not by browser');
  });

  it('an http.observed record with no, empty or malformed exchanges never satisfies', () => {
    const malformed = [
      observedRecord(transportObligation.id, { exchanges: 'not-a-list' }),
      observedRecord(transportObligation.id, { exchanges: [] }),
      observedRecord(transportObligation.id, { exchanges: [null] }),
      observedRecord(transportObligation.id, { exchanges: [{ method: 'GET' }] }),
    ];
    for (const bad of malformed) {
      const outcome = httpOutcome(transportObligation, [anchor, bad]);
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain("observe-channel exchange in witnessed 'http.observed' record");
    }
  });

  it('the Observe channel selects one record deterministically in any input order', () => {
    const first = observedRecord(transportObligation.id, {
      exchanges: [{ method: 'GET', url: '/accounts/1', status: 200 }],
    });
    const second = observedRecord(transportObligation.id, {
      exchanges: [{ method: 'GET', url: '/accounts/2', status: 200 }],
    });
    const forward = complete(httpOutcome(transportObligation, [first, second]));
    const reverse = complete(httpOutcome(transportObligation, [second, first]));
    expect(forward.verdict).toBe('satisfied');
    expect(reverse).toEqual(forward);
    expect(forward.recordIds).toEqual(
      [String(first['recordId']), String(second['recordId'])].sort().slice(0, 1),
    );
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

describe('registration-order precedence over ambiguous attribution (0.14)', () => {
  // Starlette/FastAPI match routes in REGISTRATION order: include_router
  // copies a router's routes at the call, depth-first in call order, and a
  // router's own routes keep decorator source order. When the detectors
  // prove that order (same scope, distinct orders, no typed convertor
  // ahead of the winner), the smallest order IS the serving route and the
  // ambiguity that used to block the claim resolves.
  const SCOPE = 'app.main:app';

  const PARAM_OBLIGATION: Obligation = {
    schemaVersion: 1,
    id: 'tenant.accounts:http:request-observed',
    resourceId: 'tenant.accounts',
    contract: 'http:request-observed',
    policyId: 'p',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  };

  function exportObligation(): Obligation {
    return {
      ...PARAM_OBLIGATION,
      id: 'tenant.accounts-export:http:request-observed',
      resourceId: 'tenant.accounts-export',
    };
  }

  function registered(
    resourceId: string,
    canonicalPath: string,
    order: number,
    options: { scope?: string; typedPathParams?: boolean } = {},
  ): HttpRouteCandidate {
    return {
      resourceId,
      method: 'GET',
      canonicalPath,
      registration: { scope: options.scope ?? SCOPE, order },
      ...(options.typedPathParams ? { typedPathParams: true } : {}),
    };
  }

  function outcomeFor(
    obligation: Obligation,
    inventory: readonly HttpRouteCandidate[],
  ) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
      records: [
        anchorRecord(obligation.id, 'read'),
        record(obligation.id, {
          kind: 'http.request',
          payload: { method: 'GET', url: '/accounts/export', status: 200 },
        }),
      ],
      waivers: [],
      classification: CLASSIFICATION,
      httpRoutes: inventory,
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  it('literal declared first wins: the literal obligation satisfies', () => {
    const outcome = outcomeFor(exportObligation(), [
      registered('tenant.accounts-export', '/accounts/export', 0),
      registered('tenant.accounts', '/accounts/{}', 1),
    ]);
    expect(outcome.verdict).toBe('satisfied');
  });

  it('literal declared first: the parameter obligation grades invalid on the literal route', () => {
    const outcome = outcomeFor(PARAM_OBLIGATION, [
      registered('tenant.accounts-export', '/accounts/export', 0),
      registered('tenant.accounts', '/accounts/{}', 1),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain(
      'uniquely matches route GET /accounts/export (tenant.accounts-export)',
    );
    expect(outcome.reason).toContain("requires endpoint 'tenant.accounts'");
  });

  it('parameter declared first wins: the literal obligation grades invalid on the param route', () => {
    const outcome = outcomeFor(exportObligation(), [
      registered('tenant.accounts', '/accounts/{}', 0),
      registered('tenant.accounts-export', '/accounts/export', 1),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('uniquely matches route GET /accounts/{} (tenant.accounts)');
    expect(outcome.reason).toContain("requires endpoint 'tenant.accounts-export'");
  });

  it('mixed scopes stay ambiguous', () => {
    const outcome = outcomeFor(PARAM_OBLIGATION, [
      registered('tenant.accounts-export', '/accounts/export', 0, { scope: 'app.admin:admin' }),
      registered('tenant.accounts', '/accounts/{}', 1),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('ambiguous route attribution');
  });

  it('a missing registration on one candidate stays ambiguous', () => {
    const outcome = outcomeFor(PARAM_OBLIGATION, [
      registered('tenant.accounts-export', '/accounts/export', 0),
      { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('ambiguous route attribution');
  });

  it('a typed convertor ordered before the winner stays ambiguous', () => {
    // `/accounts/{n:int}` at order 0 matches the canonical shape but its
    // convertor may reject the observed segment, letting the later
    // literal serve — precedence is not certain, fail closed.
    const outcome = outcomeFor(exportObligation(), [
      registered('tenant.accounts', '/accounts/{}', 0, { typedPathParams: true }),
      registered('tenant.accounts-export', '/accounts/export', 1),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('ambiguous route attribution');
  });

  it('a typed convertor ordered after the literal winner does not block attribution', () => {
    const outcome = outcomeFor(exportObligation(), [
      registered('tenant.accounts-export', '/accounts/export', 0),
      registered('tenant.accounts', '/accounts/{}', 1, { typedPathParams: true }),
    ]);
    expect(outcome.verdict).toBe('satisfied');
  });
});

describe('slash-variant merged registration (two decorators, one handler)', () => {
  // A FastAPI handler under TWO decorators — `@router.get("/x/resolve",
  // include_in_schema=False)` over `@router.get("/x/resolve/")` —
  // registers TWO raw routes at adjacent flattened positions, and the
  // endpoint compiler folds both into ONE endpoint. That merged endpoint
  // carries the RANGE of its raw routes' proven orders as
  // `registration: {scope, order, orderMax}`. The serving route for a
  // normalized observation is whichever raw variant the request URL
  // hit — the resolver cannot see a dropped trailing slash — so the
  // literal wins only when its LATEST order beats every competitor,
  // the competitor wins only when it beats the literal's EARLIEST
  // order, and any interleaving or tie stays ambiguous (fail closed).
  const SCOPE = 'app.main:app';

  const PARAM_OBLIGATION: Obligation = {
    schemaVersion: 1,
    id: 'tenant.accounts:http:request-observed',
    resourceId: 'tenant.accounts',
    contract: 'http:request-observed',
    policyId: 'p',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  };

  function exportObligation(): Obligation {
    return {
      ...PARAM_OBLIGATION,
      id: 'tenant.accounts-export:http:request-observed',
      resourceId: 'tenant.accounts-export',
    };
  }

  function slashRegistered(
    resourceId: string,
    canonicalPath: string,
    order: number,
    orderMax?: number,
  ): HttpRouteCandidate {
    return {
      resourceId,
      method: 'GET',
      canonicalPath,
      registration:
        orderMax === undefined
          ? { scope: SCOPE, order }
          : { scope: SCOPE, order, orderMax },
    };
  }

  function outcomeFor(
    obligation: Obligation,
    inventory: readonly HttpRouteCandidate[],
  ) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
      records: [
        anchorRecord(obligation.id, 'read'),
        record(obligation.id, {
          kind: 'http.request',
          payload: { method: 'GET', url: '/accounts/export', status: 200 },
        }),
      ],
      waivers: [],
      classification: CLASSIFICATION,
      httpRoutes: inventory,
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  it('a two-decorator literal registered before the parameter resolves to the literal', () => {
    const outcome = outcomeFor(exportObligation(), [
      slashRegistered('tenant.accounts-export', '/accounts/export', 2, 3),
      slashRegistered('tenant.accounts', '/accounts/{}', 7),
    ]);
    expect(outcome.verdict).toBe('satisfied');
  });

  it('a parameter ordered before the whole literal range serves: the literal grades invalid on it', () => {
    const outcome = outcomeFor(exportObligation(), [
      slashRegistered('tenant.accounts', '/accounts/{}', 1),
      slashRegistered('tenant.accounts-export', '/accounts/export', 2, 3),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('uniquely matches route GET /accounts/{} (tenant.accounts)');
    expect(outcome.reason).toContain("requires endpoint 'tenant.accounts-export'");
  });

  it('a parameter order inside the literal range stays ambiguous (interleaved raw routes)', () => {
    // Raw route 1 at order 5, raw route 2 at order 8, parameter at 6:
    // a request whose URL carries the trailing slash is served by the
    // parameter, one without by the literal — and the normalized
    // observation cannot tell them apart. Attribution must fail closed.
    const exportOutcome = outcomeFor(exportObligation(), [
      slashRegistered('tenant.accounts-export', '/accounts/export', 5, 8),
      slashRegistered('tenant.accounts', '/accounts/{}', 6),
    ]);
    expect(exportOutcome.verdict).toBe('invalid');
    expect(exportOutcome.reason).toContain('ambiguous route attribution');
    const paramOutcome = outcomeFor(PARAM_OBLIGATION, [
      slashRegistered('tenant.accounts-export', '/accounts/export', 5, 8),
      slashRegistered('tenant.accounts', '/accounts/{}', 6),
    ]);
    expect(paramOutcome.verdict).toBe('invalid');
    expect(paramOutcome.reason).toContain('ambiguous route attribution');
  });

  it('a tie on the literal latest order stays ambiguous', () => {
    const outcome = outcomeFor(exportObligation(), [
      slashRegistered('tenant.accounts-export', '/accounts/export', 2, 3),
      slashRegistered('tenant.accounts', '/accounts/{}', 3),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('ambiguous route attribution');
  });

  it('a malformed orderMax keeps the whole overlap ambiguous', () => {
    const outcome = outcomeFor(exportObligation(), [
      slashRegistered('tenant.accounts-export', '/accounts/export', 2, 0),
      slashRegistered('tenant.accounts', '/accounts/{}', 7),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('ambiguous route attribution');
  });
});

describe('hook-scope setup exchanges (0.13.9 diagnosis)', () => {
  // A spec that creates its API context in `beforeAll` and calls
  // endpoints from test bodies drives every call through a context that
  // talks to the app DIRECTLY — the witness never credits setup traffic,
  // so the claim is missing. When the RUN recorded hook-scope exchanges
  // (the fixture reports them) and one of them attributes to the
  // obligation's endpoint, the verdict must NAME that cause instead of
  // the bare anchor refusal — and a genuinely absent call must keep the
  // old reason byte-identical. A setup record can never SATISFY.
  const HOOK_OBLIGATION: Obligation = {
    schemaVersion: 1,
    id: 'tenant.accounts:http:request-observed',
    resourceId: 'tenant.accounts',
    contract: 'http:request-observed',
    policyId: 'p',
    lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
  };

  function exportHookObligation(): Obligation {
    return {
      ...HOOK_OBLIGATION,
      id: 'tenant.accounts-export:http:request-observed',
      resourceId: 'tenant.accounts-export',
    };
  }

  function setupRecord(obligationId: string, exchanges: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
    return record(obligationId, {
      kind: 'http.observed',
      payload: { channel: 'direct', exchanges: [...exchanges] },
    });
  }

  function outcomeWithSetup(
    obligation: Obligation,
    extraRecords: readonly Record<string, unknown>[],
  ) {
    return evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 'test-1' }],
      records: [
        record(obligation.id, {
          kind: 'http.request',
          payload: { method: 'GET', url: '/accounts/nowhere', status: 404 },
        }),
        ...extraRecords,
      ],
      waivers: [],
      classification: CLASSIFICATION,
      httpRoutes: [
        { resourceId: 'tenant.accounts', method: 'GET', canonicalPath: '/accounts/{}' },
        { resourceId: 'tenant.accounts-export', method: 'GET', canonicalPath: '/accounts/export' },
      ],
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  const OLD_REASON = `'${HOOK_OBLIGATION.id}': no 'ui.action' anchor from the declaring test`;

  it('a direct exchange matching the endpoint names the cause without counting as evidence', () => {
    const outcome = outcomeWithSetup(HOOK_OBLIGATION, [
      setupRecord(HOOK_OBLIGATION.id, [
        { method: 'GET', url: 'http://localhost:13001/accounts/77', status: 200 },
      ]),
    ]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toBe(
      `'${HOOK_OBLIGATION.id}': the test called this endpoint directly from test code (Playwright API request), not through the app's UI. API calls from test code are never E2E evidence: drive the operation through the UI so the app makes the call.`,
    );
  });

  it('a genuinely absent call keeps the old reason byte-identical', () => {
    const outcome = outcomeWithSetup(HOOK_OBLIGATION, [
      setupRecord(HOOK_OBLIGATION.id, [
        { method: 'GET', url: 'http://localhost:13001/accounts/77', status: 200 },
      ]),
    ]);
    // The parameter endpoint: the hook traffic names /accounts/77,
    // which attributes to tenant.accounts — the EXPORT obligation has
    // no matching hook exchange, so its reason is today's verbatim.
    const untouched = outcomeWithSetup(exportHookObligation(), [
      setupRecord(HOOK_OBLIGATION.id, [
        { method: 'GET', url: 'http://localhost:13001/accounts/77', status: 200 },
      ]),
    ]);
    expect(untouched.verdict).toBe('missing');
    expect(untouched.reason).toBe(
      `'${exportHookObligation().id}': no 'ui.action' anchor from the declaring test`,
    );
  });

  it('a setup record without any exchange keeps the old reason', () => {
    const outcome = outcomeWithSetup(HOOK_OBLIGATION, [
      setupRecord(HOOK_OBLIGATION.id, []),
    ]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toBe(OLD_REASON);
  });

  it('a setup exchange never satisfies the claim', () => {
    const outcome = outcomeWithSetup(HOOK_OBLIGATION, [
      setupRecord(HOOK_OBLIGATION.id, [
        { method: 'GET', url: 'http://localhost:13001/accounts/77', status: 200 },
      ]),
    ]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.verdict).not.toBe('satisfied');
  });

  it('a claimed-tier setup record diagnoses nothing', () => {
    const forged = setupRecord(HOOK_OBLIGATION.id, [
      { method: 'GET', url: 'http://localhost:13001/accounts/77', status: 200 },
    ]);
    forged['trust'] = 'claimed';
    const outcome = outcomeWithSetup(HOOK_OBLIGATION, [forged]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toBe(OLD_REASON);
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
      'page',
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
    expect(http?.contracts).toEqual([
      'http:request-observed',
      'http:response-status-ok',
      'http:effect-verified',
      'http:read-result-verified',
      'http:response-matches-model',
    ]);
    expect(http?.testKinds).toEqual(['browser-e2e', 'api-e2e']);
    expect(http?.observer).toContain('behavior.case');
    const frontend = http?.unavailableContracts.find(
      (entry) => entry.contract === 'http:frontend-request-observed',
    );
    expect(frontend?.reason).toContain('no independent browser/test observation channel');
    // The decision is pinned: the session channel binds by ORIGIN, not by
    // browser, so the contract stays fail-closed rather than silently
    // change meaning.
    expect(frontend?.reason).toContain('by ORIGIN, not by browser');
    // Phase 5: strong HTTP contracts are available — genuine
    // witness-produced case evidence exercises the required-case grader.
    expect(
      http?.unavailableContracts.find((entry) => entry.contract === 'http:effect-verified'),
    ).toBe(undefined);
  });

  it('persistence: available via the witness persistence adapter with the exact-value echo requirement', () => {
    const persistence = capabilityFor('persistence:update');
    expect(persistence?.availability.status).toBe('available');
    expect(persistence?.observer).toContain('witness persistence adapter');
    expect(persistence?.observer).toContain('EVIDENCE_VALUE_MISMATCH');
    expect(persistence?.observer).toContain('same entity');
    // server-e2e: the server-witnessed channel (the witness's own adapter
    // probe) is a second honest proof channel for persistence contracts.
    // observed-e2e: the Observe channel (session-proxy traffic + witness
    // adapter reads) is the third — suite-driven, weaker by design.
    expect(persistence?.testKinds).toEqual(['browser-e2e', 'observed-e2e', 'server-e2e', 'api-e2e']);
    expect(persistence?.observer).toContain("channel: 'observe'");
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
  });

  it('page: exactly the two page promises, proven by witnessed visits or the engine sweep', () => {
    const page = capabilityFor('page:loads');
    expect(page?.namespace).toBe('page');
    expect(page?.availability.status).toBe('available');
    // EXACTLY the two page contracts: any other `page:*` name stays
    // unimplemented, so it keeps the unsupported cause — the capability
    // never pretends a proof channel exists for a contract the page
    // grader does not grade.
    expect(page?.contracts).toEqual(['page:loads', 'page:data-ok']);
    expect(page?.unavailableContracts).toEqual([]);
    expect(page?.testKinds).toEqual(['browser-e2e', 'observed-e2e']);
    expect(page?.observer).toContain('witness');
    expect(page?.observer).toContain('sweep');
    // The strict preflight agrees: an available, implemented contract
    // produces no capability gap.
    expect(capabilityGap('page:loads')).toBeNull();
    expect(capabilityGap('page:data-ok')).toBeNull();
    expect(capabilityGap('page:never')?.cause).toBe('VERIFIER_UNSUPPORTED');
    expect(strictCapabilityGaps([{ id: 'p:page:loads', contract: 'page:loads' }])).toEqual([]);
  });

  it('domain namespaces keep their channels, availability, and exact contract lists', () => {
    for (const [namespace, channel, available, contracts] of [
      [
        'auth',
        'identity/role material',
        true,
        [
          'auth:role-allowed',
          'auth:role-denied',
          'auth:tenant-isolated',
          'auth:denied-no-side-effect',
          'auth:forged-token-rejected',
        ],
      ],
      [
        'task',
        'queue/job delivery state',
        // Task contracts are claims about a
        // background queue, so the namespace is unavailable until the
        // owner configures the engine's own queue observer
        // (see test/task-queue-grade.test.ts for the bound case).
        false,
        [
          'task:retry-policy-enforced',
          'task:idempotent',
          'task:terminal-handled',
          'task:observability-recorded',
          'task:duplicate-delivery-handled',
        ],
      ],
      [
        'validation',
        'boundary semantics',
        true,
        [
          'validation:boundary-accepted',
          'validation:boundary-rejected',
          'validation:no-side-effect-on-reject',
          'validation:error-message-explicit',
          'validation:envelope-shape-stable',
        ],
      ],
      [
        'webhook',
        'signature/replay verification',
        true,
        [
          'webhook:signature-accepted',
          'webhook:signature-rejected',
          'webhook:malformed-rejected',
          'webhook:replay-idempotent',
          'webhook:retry-bounded',
        ],
      ],
      [
        'workflow',
        'workflow state machine',
        true,
        [
          'workflow:transition-allowed',
          'workflow:transition-rejected',
          'workflow:terminal-immutable',
          'workflow:audit-emitted',
          'workflow:persisted-final-state',
        ],
      ],
    ] as const) {
      const capability = capabilityFor(`${namespace}:${contracts[0]!.split(':')[1]}`);
      expect(capability?.availability.status, namespace).toBe(available ? 'available' : 'unavailable');
      expect(capability?.contracts, namespace).toEqual(contracts);
      expect(capability?.observer, namespace).toContain(channel);
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
      'http:effect-verified',
      'http:read-result-verified',
      'http:response-matches-model',
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
    expect(mapped.nextAction).toBe(CAUSE_NEXT_ACTIONS['VERIFIER_UNSUPPORTED']);
  });

  it('an unconfigured task namespace maps a missing verdict to the unsupported cause', () => {
    // Without the engine's own queue observer there is no honest
    // producer for a background job's state, so the namespace is
    // advertised as unsupported and the cause says so.
    bindQueueObserver(null);
    const mapped = causeForVerdict({
      obligationId: 'tenant.accounts:task:idempotent',
      contract: 'task:idempotent',
      verdict: 'missing',
      reason: 'has no compiled required-case set',
    });
    expect(mapped.cause).toBe('VERIFIER_UNSUPPORTED');
  });

  it('Phase 8 namespaces are available through behavior.case, so missing case sets do not map to unsupported', () => {
    bindQueueObserver({
      kind: 'bullmq',
      connection: { host: ['127', '0', '0', '1'].join('.'), port: 6379 },
      queues: [{ name: 'mailer', taskResourceId: 'task.email.send' }],
    });
    for (const contract of [
      'workflow:persisted-final-state',
      'webhook:replay-idempotent',
      'task:idempotent',
    ]) {
      const mapped = causeForVerdict({
        obligationId: `tenant.accounts:${contract}`,
        contract,
        verdict: 'missing',
        reason: 'has no compiled required-case set',
      });
      expect(mapped.cause).toBeNull();
      expect(mapped.nextAction).toBeNull();
    }
  });
  it('a missing page promise maps to EVIDENCE_NOT_COLLECTED with the page visit/sweep action', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.page-orders:page:loads',
      contract: 'page:loads',
      verdict: 'missing',
      reason: "no clean witness-observed page visit from a passing test exists for 'tenant.page-orders'",
    });
    expect(mapped.cause).toBe('EVIDENCE_NOT_COLLECTED');
    expect(mapped.nextAction).toContain('witnessed page visit');
    expect(mapped.nextAction).toContain('sweep');
    expect(mapped.nextAction).not.toBe(CAUSE_NEXT_ACTIONS['VERIFIER_UNSUPPORTED']);
    const dataOk = causeForVerdict({
      obligationId: 'tenant.page-orders:page:data-ok',
      contract: 'page:data-ok',
      verdict: 'missing',
      reason: "no clean witness-observed page visit from a passing test exists for 'tenant.page-orders'",
    });
    expect(dataOk.cause).toBe('EVIDENCE_NOT_COLLECTED');
  });

  it('an unknown page:* contract keeps VERIFIER_UNSUPPORTED (no pretended proof channel)', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.page-orders:page:never',
      contract: 'page:never',
      verdict: 'missing',
      reason: 'no clean witness-observed page visit from a passing test exists',
    });
    expect(mapped.cause).toBe('VERIFIER_UNSUPPORTED');
    expect(mapped.nextAction).toBe(CAUSE_NEXT_ACTIONS['VERIFIER_UNSUPPORTED']);
  });

  it('a refused page observation keeps its precise reason unmapped (no guessed cause)', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.page-orders:page:loads',
      contract: 'page:loads',
      verdict: 'invalid',
      reason: 'witness refused page observation: PAGE_BOUNCED_TO_LOGIN',
    });
    expect(mapped.cause).toBeNull();
    expect(mapped.nextAction).toBeNull();
  });

  it('crud precise reasons remain unmapped while the browser channel is available', () => {
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
    expect(mapped.nextAction).toContain('Do not add tests');
  });

  it('evidence absence for a connected test → EVIDENCE_NOT_COLLECTED', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.accounts:persistence:read',
      contract: 'persistence:read',
      verdict: 'missing',
      reason: "claim 'suite-test' declares 'tenant.accounts:persistence:read' but produced no evidence records",
    });
    expect(mapped.cause).toBe('EVIDENCE_NOT_COLLECTED');
    expect(mapped.nextAction).toBe(CAUSE_NEXT_ACTIONS['EVIDENCE_NOT_COLLECTED']);
  });

  it('no claim connected → TEST_MAPPING_MISSING (placeholder refined by Phase 2-3)', () => {
    const mapped = causeForVerdict({
      obligationId: 'tenant.accounts:persistence:read',
      contract: 'persistence:read',
      verdict: 'missing',
      reason: "no claim declares 'tenant.accounts:persistence:read'",
    });
    expect(mapped.cause).toBe('TEST_MAPPING_MISSING');
    expect(mapped.nextAction).toBe(CAUSE_NEXT_ACTIONS['TEST_MAPPING_MISSING']);
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
    expect(gap?.observer).toContain('behavior.case');
    expect(gap?.nextAction).toBe(CAUSE_NEXT_ACTIONS['VERIFIER_UNSUPPORTED']);
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

  it('strictCapabilityGaps maps only genuinely unsupported obligations and sorts by id', () => {
    const gaps = strictCapabilityGaps([
      { id: 'tenant.accounts:http:frontend-request-observed', contract: 'http:frontend-request-observed' },
      { id: 'tenant.accounts:persistence:read', contract: 'persistence:read' },
      // Phase 8 domain contracts are available through behavior.case; a
      // missing required-case declaration blocks at verdict time instead.
      { id: 'tenant.orders:workflow:persisted-final-state', contract: 'workflow:persisted-final-state' },
    ]);
    expect(gaps.map((gap) => gap.obligationId)).toEqual([
      'tenant.accounts:http:frontend-request-observed',
    ]);
    expect(gaps.every((gap) => gap.cause === 'VERIFIER_UNSUPPORTED')).toBe(true);
    expect(gaps[0]?.detail).toContain("obligation 'tenant.accounts:http:frontend-request-observed'");
  });
});
