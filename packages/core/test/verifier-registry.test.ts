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
