/**
 * Observe-channel tests (core verifier side, Phase 2): a
 * `channel: 'observe'` WITNESSED `persistence.observed` record satisfies
 * `persistence:*` obligations WITHOUT the `ui.action` browser anchor —
 * while the browser channel stays byte-identical and server records
 * keep their own lane. The witness-observed request fields echo exactly
 * (EVIDENCE_VALUE_MISMATCH on mismatch); postcondition failures upgrade
 * a bare browser missing to invalid; forgery and channel confusion
 * grade fail closed.
 */
import { describe, expect, it } from 'vitest';
import {
  ObligationSchema,
  evaluateObligation,
  recordIdOf,
  type Claim,
  type Obligation,
} from '../src/index.js';

const NOW = '2026-08-30T12:00:00.000Z';
const RUN_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TEST_ID = 'playwright:chromium:e2e/accounts.spec.js:creates an account';

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard',
  updateableFields: ['first_name', 'last_name', 'status'],
} as const;

function makeObligation(overrides: Record<string, unknown> = {}): Obligation {
  const merged = {
    schemaVersion: 1,
    resourceId: 'tenant.accounts',
    contract: 'persistence:update',
    policyId: 'user-facing-sqlalchemy-lifecycle',
    lifecycle: LIFECYCLE,
    ...overrides,
  };
  return ObligationSchema.parse({ ...merged, id: `${merged.resourceId}:${merged.contract}` });
}

const classification = {
  exposure: 'user-facing',
  plane: 'tenant',
  lifecycle: LIFECYCLE,
  primaryKey: ['id'],
  evidenceAdapter: 'tenant.accounts',
};

function makeClaim(obligationId: string, testId: string = TEST_ID): Claim {
  return { schemaVersion: 1, obligationId, testId };
}

/**
 * Builds a record with service-issued provenance: the recordId
 * recomputes from the identity (the exact predicate the engine
 * verifies). `recordId` in overrides is honored verbatim (forgery
 * cases).
 */
function makeRecord(obligation: Obligation, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    runId: RUN_ID,
    trust: 'witnessed',
    obligationId: obligation.id,
    testId: TEST_ID,
    kind: 'persistence.observed',
    origin: 'engine-observed',
    payload: {},
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
  // A `recordId` override is honored verbatim (forgery cases): the id
  // then fails provenance and the record demotes to claimed-tier.
  if (Object.prototype.hasOwnProperty.call(overrides, 'recordId')) {
    base['recordId'] = overrides['recordId'];
  }
  return base;
}

/** An observe record as the finalize path issues it (update-shaped default). */
function observeRecord(
  obligation: Obligation,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeRecord(obligation, {
    kind: 'persistence.observed',
    origin: 'engine-observed',
    payload: {
      resourceId: obligation.resourceId,
      entityId: 'acc-1',
      found: true,
      fields: { first_name: 'Augusta', last_name: 'King', status: 'active' },
      before: { found: true, fields: { first_name: 'Ada', last_name: 'Lovelace', status: 'active' } },
      observedFields: { first_name: 'Augusta' },
      exchange: { method: 'PATCH', path: '/api/accounts/acc-1', status: 200, seq: 7 },
      sessionId: 'session-1',
      channel: 'observe',
      ...payload,
    },
    ...overrides,
  });
}

/** A browser-path ui.action anchor (suite-asserted, provenanced). */
function browserAction(obligation: Obligation, operation: string): Record<string, unknown> {
  return makeRecord(obligation, {
    kind: 'ui.action',
    origin: 'suite-submitted',
    trust: 'claimed',
    payload: { operation, entityId: 'acc-1', fields: { first_name: 'Augusta' } },
  });
}

/** A browser-path witnessed persistence record for the same entity. */
function browserPersistence(obligation: Obligation): Record<string, unknown> {
  return makeRecord(obligation, {
    kind: 'persistence.entity',
    origin: 'engine-observed',
    payload: {
      entityId: 'acc-1',
      found: true,
      fields: { first_name: 'Augusta', last_name: 'King', status: 'active' },
      before: { found: true, fields: { first_name: 'Ada', last_name: 'Lovelace', status: 'active' } },
    },
  });
}

function evaluate(obligation: Obligation, records: unknown[], claimTestId: string = TEST_ID) {
  return evaluateObligation(obligation, {
    claims: [makeClaim(obligation.id, claimTestId)],
    records,
    waivers: [],
    classification,
    now: NOW,
  });
}

describe('observe channel (core verifier)', () => {
  it('satisfies update without a ui.action anchor: witnessed delta + exact echo', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    const outcome = evaluate(obligation, [observeRecord(obligation, {})]);
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.reason).toBeNull();
    expect(outcome.recordIds).toHaveLength(1);
  });

  it('satisfies create on absent-before + present-after with echo', () => {
    const obligation = makeObligation({ contract: 'persistence:create' });
    const outcome = evaluate(obligation, [
      observeRecord(obligation, {
        entityId: '2',
        found: true,
        fields: { first_name: 'Grace', last_name: 'Hopper', status: 'active' },
        before: { entityAbsent: true },
        observedFields: { first_name: 'Grace', last_name: 'Hopper' },
        exchange: { method: 'POST', path: '/api/accounts', status: 201, seq: 3 },
      }),
    ]);
    expect(outcome.verdict).toBe('satisfied');
  });

  it('satisfies read on presence and hard delete on absence', () => {
    const read = makeObligation({ contract: 'persistence:read' });
    const readPayload = {
      entityId: 'acc-1',
      found: true,
      fields: { first_name: 'Ada', last_name: 'Lovelace', status: 'active' },
      observedFields: {},
      exchange: { method: 'GET', path: '/api/accounts/acc-1', status: 200, seq: 5 },
      sessionId: 'session-1',
      channel: 'observe',
      resourceId: 'tenant.accounts',
    };
    expect(evaluate(read, [observeRecord(read, readPayload)]).verdict).toBe('satisfied');
    const del = makeObligation({ contract: 'persistence:delete' });
    const deletePayload = {
      entityId: 'acc-9',
      found: false,
      observedFields: {},
      exchange: { method: 'POST', path: '/api/accounts/acc-9/archive', status: 200, seq: 6 },
      sessionId: 'session-1',
      channel: 'observe',
      resourceId: 'tenant.accounts',
    };
    // Hard delete (deleteSemantics 'hard' here): absence satisfies.
    expect(evaluate(del, [observeRecord(del, deletePayload)]).verdict).toBe('satisfied');
  });

  it('echo mismatch is invalid EVIDENCE_VALUE_MISMATCH even with the row present', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    const outcome = evaluate(obligation, [
      observeRecord(obligation, { observedFields: { first_name: 'Mallory' } }),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
    expect(outcome.reason).toContain('Mallory');
  });

  it('a postcondition failure upgrades a bare browser missing to invalid', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    // No delta: before and after agree on every field.
    const outcome = evaluate(obligation, [
      observeRecord(obligation, {
        fields: { first_name: 'Ada', last_name: 'Lovelace', status: 'active' },
        before: { found: true, fields: { first_name: 'Ada', last_name: 'Lovelace', status: 'active' } },
      }),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('delta');
  });

  it('a claimed-tier observe record satisfies nothing (GF-23 demotion)', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    const outcome = evaluate(obligation, [observeRecord(obligation, {}, { trust: 'claimed' })]);
    expect(outcome.verdict).toBe('missing');
  });

  it('a forged observe recordId demotes to claimed and stays missing', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    const outcome = evaluate(obligation, [observeRecord(obligation, {}, { recordId: 'f'.repeat(64) })]);
    expect(outcome.verdict).toBe('missing');
  });

  it('a persistence.observed record without the observe channel grades missing, never satisfied', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    const outcome = evaluate(obligation, [
      observeRecord(obligation, { channel: 'server', declaredKind: 'server-e2e' }),
    ]);
    // The server lane needs its own stamp (declaredKind) and postcondition
    // shape; this record qualifies for NEITHER lane here — and the
    // browser lane has no anchor — so the claim stays missing.
    expect(outcome.verdict).toBe('missing');
  });

  it('browser satisfaction wins over observe (stricter channel first)', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    const action = browserAction(obligation, 'update');
    const persisted = browserPersistence(obligation);
    const observed = observeRecord(obligation, { entityId: 'acc-9' });
    const outcome = evaluate(obligation, [action, persisted, observed]);
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.recordIds).toHaveLength(2);
    expect(outcome.recordIds).not.toContain(observed['recordId']);
  });

  it('server satisfaction wins over observe', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    const server = makeRecord(obligation, {
      kind: 'persistence.entity',
      origin: 'engine-observed',
      payload: {
        resourceId: obligation.resourceId,
        entityId: 'acc-1',
        found: true,
        fields: { first_name: 'Augusta', status: 'active' },
        before: { found: true, fields: { first_name: 'Ada', status: 'active' } },
        channel: 'server',
        declaredKind: 'server-e2e',
      },
    });
    const observed = observeRecord(obligation, {});
    const outcome = evaluate(obligation, [server, observed]);
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.recordIds).toEqual([server['recordId']]);
  });

  it('an observe record never satisfies a crud:* contract (engine browser only)', () => {
    const obligation = makeObligation({ contract: 'crud:update' });
    const outcome = evaluate(obligation, [observeRecord(obligation, {})]);
    expect(outcome.verdict).not.toBe('satisfied');
  });
});
