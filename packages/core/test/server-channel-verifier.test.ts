/**
 * Server-witnessed persistence channel tests (core verifier side): a
 * `channel: 'server'` + `declaredKind: 'server-e2e'` WITNESSED
 * persistence record satisfies `persistence:*` obligations WITHOUT the
 * `ui.action` browser anchor (backend-only tables can never honestly
 * appear in a UI) — while the browser channel stays byte-identical:
 * the anchor is still required there, and server-channel records can
 * neither satisfy nor invalidate a browser-anchored claim. Forgery
 * (fabricated provenance) and kind-less channel stamps grade fail
 * closed.
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
const TEST_ID = 'pytest:backend-outbox-pytest:backend/tests/integration/test_x.py:test_commits';

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'hard',
  updateableFields: ['status', 'attempt'],
} as const;

function makeObligation(overrides: Record<string, unknown> = {}): Obligation {
  const merged = {
    schemaVersion: 1,
    resourceId: 'tenant.lead_push_outbox',
    contract: 'persistence:create',
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
  evidenceAdapter: 'tenant.lead_push_outbox',
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
    kind: 'persistence.entity',
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
  return base;
}

/** A server-witnessed record as the stamping witness issues it. */
function serverRecord(
  obligation: Obligation,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeRecord(obligation, {
    kind: 'persistence.entity',
    origin: 'engine-observed',
    payload: {
      resourceId: obligation.resourceId,
      entityId: 'ob-1',
      found: true,
      fields: {},
      channel: 'server',
      declaredKind: 'server-e2e',
      intent: { phase: 'post', expectation: 'expect-present', sequence: 2 },
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
    payload: { operation, entityId: 'ob-1', fields: { status: 'pending' } },
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

describe('server-witnessed persistence channel (core verifier)', () => {
  it('satisfies create without a ui.action anchor: witnessed absent-before + present-after', () => {
    const obligation = makeObligation({ contract: 'persistence:create' });
    const outcome = evaluate(obligation, [
      serverRecord(obligation, {
        entityId: 'ob-1',
        found: true,
        fields: { status: 'pending' },
        before: { entityAbsent: true },
      }),
    ]);
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.reason).toBeNull();
    expect(outcome.recordIds).toHaveLength(1);
  });

  it('satisfies update from the witness-consumed before/after delta on an updateable field', () => {
    const obligation = makeObligation({ contract: 'persistence:update' });
    const outcome = evaluate(obligation, [
      serverRecord(obligation, {
        found: true,
        fields: { status: 'delivered', attempt: 2 },
        before: { found: true, fields: { status: 'pending', attempt: 2 } },
      }),
    ]);
    expect(outcome.verdict).toBe('satisfied');
  });

  it('satisfies read on presence and hard delete on absence', () => {
    const read = makeObligation({ contract: 'persistence:read' });
    expect(evaluate(read, [serverRecord(read, { found: true, fields: { status: 'pending' } })]).verdict).toBe(
      'satisfied',
    );
    const hardDelete = makeObligation({ contract: 'persistence:delete' });
    expect(evaluate(hardDelete, [serverRecord(hardDelete, { found: false })]).verdict).toBe('satisfied');
  });

  it('keeps grading postconditions engine-owned: create-post still absent grades invalid', () => {
    const obligation = makeObligation({ contract: 'persistence:create' });
    const outcome = evaluate(obligation, [
      serverRecord(obligation, { found: false, before: { entityAbsent: true } }),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('create postcondition violated: entity still absent');
  });

  it('refuses a channel stamp without the server-e2e kind declaration (admissible nowhere)', () => {
    const obligation = makeObligation({ contract: 'persistence:create' });
    const unkind = serverRecord(obligation, { before: { entityAbsent: true } }, {});
    (unkind['payload'] as Record<string, unknown>)['declaredKind'] = 'browser-e2e';
    const outcome = evaluate(obligation, [unkind]);
    // Not server-satisfying, and excluded from the browser path: the
    // claim stays blocking with the browser-channel reason.
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("no 'ui.action' evidence");
  });

  it('still requires the ui.action anchor on the browser channel (byte-identical rules)', () => {
    const obligation = makeObligation({ contract: 'persistence:create' });
    // A browser-channel persistence record alone never satisfies.
    const browserPersistence = makeRecord(obligation, {
      payload: {
        resourceId: obligation.resourceId,
        entityId: 'ob-1',
        found: true,
        fields: { status: 'pending' },
        before: { entityAbsent: true },
      },
    });
    expect(evaluate(obligation, [browserPersistence]).verdict).toBe('missing');
    // With the anchor, the same evidence satisfies exactly as before.
    const outcome = evaluate(obligation, [browserAction(obligation, 'create'), browserPersistence]);
    expect(outcome.verdict).toBe('satisfied');
    // The browser channel ignores server-channel records entirely: a
    // failing server record cannot invalidate a satisfiable browser claim.
    const failingServer = serverRecord(obligation, { found: false });
    expect(evaluate(obligation, [browserAction(obligation, 'create'), browserPersistence, failingServer]).verdict).toBe(
      'satisfied',
    );
  });

  it('demotes forged server records to claimed: a spool-forged record never satisfies', () => {
    const obligation = makeObligation({ contract: 'persistence:create' });
    const forged = serverRecord(obligation, { found: false, before: { entityAbsent: true } });
    // Tamper with the stamped payload AFTER issuance: provenance breaks
    // and the engine demotes the record to claimed (GF-23) — a suite
    // that can write intents still cannot mint satisfaction.
    (forged['payload'] as Record<string, unknown>)['found'] = true;
    const outcome = evaluate(obligation, [forged]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("no 'ui.action' evidence");
  });

  it('binds server records to the claim by testId: another test cannot donate them', () => {
    const obligation = makeObligation({ contract: 'persistence:create' });
    const outcome = evaluate(
      obligation,
      [serverRecord(obligation, { before: { entityAbsent: true }, entityId: 'ob-1' })],
      'other-test-id',
    );
    expect(outcome.verdict).toBe('missing');
  });
});
