/**
 * Verdict-engine tests (pin #9, ADR 0001 D1–D4): per-verdict rules,
 * two-tier trust (GF-23), same-entity enforcement with composite keys,
 * waiver precedence (expired → invalid, stale owner → stale), and
 * determinism.
 */
import { describe, expect, it } from 'vitest';
import {
  GateforgeVerdictError,
  ObligationSchema,
  WaiverSchema,
  evaluateObligations,
  evaluateObligation,
  fingerprint,
  recordIdOf,
  sha256Canonical,
  type Claim,
  type Obligation,
  type Waiver,
  type WaiverRef,
} from '../src/index.js';

/** Injected clock: the only time source in these tests (invariant 7). */
const NOW = '2026-08-30T12:00:00.000Z';

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'archive',
  // Owner-declared archived state (audit round 5): graded by the engine,
  // never supplied by the suite.
  archiveFields: { status: 'archived' },
  // Owner-declared update relevance (audit round 6): the observed
  // before/after delta must touch at least one of these.
  updateableFields: ['first_name', 'last_name', 'name', 'status'],
} as const;

function makeObligation(overrides: Record<string, unknown> = {}): Obligation {
  const base = {
    schemaVersion: 1,
    resourceId: 'tenant.accounts',
    contract: 'persistence:update',
    policyId: 'user-facing-sqlalchemy-lifecycle',
    lifecycle: LIFECYCLE,
  };
  const merged = { ...base, ...overrides };
  return ObligationSchema.parse({
    ...merged,
    id: `${merged.resourceId}:${merged.contract}`,
  });
}

const obligation = makeObligation();
const FP = fingerprint({
  resourceId: obligation.resourceId,
  contract: obligation.contract,
  policyId: obligation.policyId,
  lifecycle: obligation.lifecycle,
});

const classification = {
  exposure: 'user-facing',
  plane: 'tenant',
  lifecycle: LIFECYCLE,
  primaryKey: ['id'],
  evidenceAdapter: 'accounts',
};

const compositeClassification = {
  exposure: 'user-facing',
  plane: 'tenant',
  lifecycle: LIFECYCLE,
  primaryKey: ['region', 'code'],
  evidenceAdapter: 'accounts',
};

function makeClaim(testId: string, obligationId: string = obligation.id): Claim {
  return {
    schemaVersion: 1,
    obligationId,
    testId,
    testFile: 'tests/accounts.spec.ts',
  };
}

let recordCounter = 0;

/**
 * Builds a witness-shaped record; provenance defaults to service-issued:
 * the recordId recomputes from the record's own identity (pin #7), the
 * exact predicate the engine verifies. Tests that forge a specific id
 * (or strip it) pass `recordId` in the overrides and it is honored
 * verbatim.
 */
function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  recordCounter += 1;
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    trust: 'witnessed',
    obligationId: obligation.id,
    testId: 'test-1',
    kind: 'ui.action',
    origin: 'engine-observed',
    payload: { operation: 'update', entityId: 'acc-1' },
    ...overrides,
  };
  const identity = [base['runId'], base['obligationId'], base['kind'], base['testId'], base['origin']];
  const forgeableId = Object.prototype.hasOwnProperty.call(overrides, 'recordId');
  const complete =
    !forgeableId &&
    identity.every((field) => typeof field === 'string' && (field as string).length > 0);
  if (!forgeableId && complete) {
    base['recordId'] = recordIdOf({
      runId: base['runId'] as string,
      obligationId: base['obligationId'] as string,
      kind: base['kind'] as string,
      testId: base['testId'] as string,
      origin: base['origin'] as 'engine-observed' | 'suite-submitted',
      payload: base['payload'],
    });
  }
  return base;
}

function witnessedAction(overrides: Record<string, unknown> = {}) {
  return makeRecord({ kind: 'ui.action', ...overrides });
}

function witnessedPersistence(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    kind: 'persistence.entity',
    // Engine-observed observation meeting persistence:update's
    // postcondition: pre-observation fields + a real before/after delta.
    payload: {
      entityId: 'acc-1',
      found: true,
      fields: { name: 'New Name' },
      before: { found: true, fields: { name: 'Old Name' } },
    },
    ...overrides,
  });
}

function makeWaiver(overrides: Record<string, unknown> = {}): WaiverRef {
  return WaiverSchema.parse({
    schemaVersion: 1,
    owner: 'team-accounts',
    justificationUrl: 'https://issues.example.com/T-123',
    approver: 'alice',
    scope: { kind: 'exact', resourceId: obligation.resourceId, fingerprint: FP },
    expiresAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  });
}

describe('evaluateObligation — satisfied requires complete witnessed evidence (D2)', () => {
  it('is satisfied by witnessed ui.action + persistence.entity for the same entity', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [witnessedAction(), witnessedPersistence()],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.reason).toBeNull();
    expect(outcome.recordIds).toHaveLength(2);
    expect(outcome.recordIds).toEqual([...outcome.recordIds].sort());
  });

  it('is NOT satisfied by a fully consistent claimed-tier bundle (GF-23)', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [
        witnessedAction({ trust: 'claimed' }),
        witnessedPersistence({ trust: 'claimed' }),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('claimed-tier');
    expect(outcome.reason).toContain('GF-23');
  });

  it('demotes records lacking service-issued provenance to claimed-tier', () => {
    for (const strip of ['recordId', 'runId'] as const) {
      const outcome = evaluateObligation(obligation, {
        claims: [makeClaim('test-1')],
        records: [
          witnessedAction({ [strip]: undefined }),
          witnessedPersistence({ [strip]: undefined }),
        ],
        waivers: [],
        classification,
        now: NOW,
      });
      // trust: 'witnessed' alone is not enough — without recordId+runId
      // the record is claimed-tier, so the bundle cannot satisfy (GF-23).
      expect(outcome.verdict).toBe('invalid');
      expect(outcome.reason).toContain('claimed-tier');
      expect(outcome.reason).toContain('only service-witnessed evidence satisfies');
    }
  });

  it('demotes a 64-hex recordId that does not recompute from the record contents (GF-23)', () => {
    // Shape-forged id: correct 64-hex form, wrong value — the audit's
    // arbitrary-hex fabrication must never grade witnessed.
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [
        witnessedAction({ recordId: 'a'.repeat(64) }),
        witnessedPersistence({ recordId: 'b'.repeat(64) }),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('claimed-tier');
    expect(outcome.reason).toContain('only service-witnessed evidence satisfies');
  });

  it('demotes a record whose contents were altered after issuance (transplanted id)', () => {
    // An honest record id, but the payload was tampered with afterwards:
    // the id no longer recomputes, so provenance fails.
    const honest = makeRecord();
    const tampered = { ...honest, payload: { operation: 'update', entityId: 'acc-2' } };
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [
        tampered,
        makeRecord({
          kind: 'persistence.entity',
          payload: { entityId: 'acc-2', fields: {} },
        }),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('claimed-tier');
  });

  it('is missing when no claim declares the obligation', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [witnessedAction(), witnessedPersistence()],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toBe("no claim declares 'tenant.accounts:persistence:update'");
    expect(outcome.recordIds).toEqual([]);
  });

  it('is missing when a claim carries no evidence records', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("claim 'test-1'");
    expect(outcome.reason).toContain('no evidence records');
  });

  it('is missing when the required witnessed kinds are absent', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [makeRecord({ kind: 'ui.visible-result', payload: { entityId: 'acc-1' } })],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("no 'ui.action' evidence");
  });

  it('rejects a witnessed ui.action with the wrong operation', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [
        witnessedAction({ payload: { operation: 'create', entityId: 'acc-1' } }),
        witnessedPersistence(),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain("'create'");
    expect(outcome.reason).toContain("'persistence:update' requires 'update'");
  });
});

describe('evaluateObligation — persistence postconditions, owner-owned (audit round 5)', () => {
  /** Obligation whose lifecycle deletes by ARCHIVE (like the fixture). */
  const archiveLifecycle = LIFECYCLE;
  const hardLifecycle = {
    ...LIFECYCLE,
    deleteSemantics: 'hard',
    archiveFields: undefined,
  } as const;

  function claimOutcome(contract: string, lifecycle: unknown, records: unknown[]) {
    const target = makeObligation({
      resourceId: 'tenant.accounts',
      contract,
      lifecycle: lifecycle as typeof LIFECYCLE,
    });
    // Re-attribute the records to THIS obligation and re-stamp their
    // provenance for the new identity (the helpers default to the
    // module-level persistence:update fixture).
    const attributed = (records as Array<Record<string, unknown>>).map((record) => {
      const rebuilt: Record<string, unknown> = { ...record, obligationId: target.id };
      delete rebuilt['recordId'];
      const identity = [
        rebuilt['runId'],
        rebuilt['obligationId'],
        rebuilt['kind'],
        rebuilt['testId'],
        rebuilt['origin'],
      ];
      if (identity.every((field) => typeof field === 'string' && (field as string).length > 0)) {
        rebuilt['recordId'] = recordIdOf({
          runId: rebuilt['runId'] as string,
          obligationId: rebuilt['obligationId'] as string,
          kind: rebuilt['kind'] as string,
          testId: rebuilt['testId'] as string,
          origin: rebuilt['origin'] as 'engine-observed' | 'suite-submitted',
          payload: rebuilt['payload'],
        });
      }
      return rebuilt;
    });
    return evaluateObligation(target, {
      claims: [makeClaim('test-1', target.id)],
      records: attributed as never[],
      waivers: [],
      classification,
      now: NOW,
    });
  }

  it('the reviewer archive bypass: an active entity can be dressed up as archived by the SUITE, but the classification owns the archived state', () => {
    // Contract persistence:delete (archive). The suite claims "deleted"
    // and the engine observes the entity STILL {status: active}. Under
    // round 4 the suite could declare {status: active} as its expected
    // archive result and satisfy; now the archived state is graded
    // against the classification's archiveFields — never the suite.
    const outcome = claimOutcome('persistence:delete', archiveLifecycle, [
      witnessedAction({
        payload: { operation: 'delete', entityId: 'acc-1' },
      }),
      witnessedPersistence({
        payload: { entityId: 'acc-1', found: true, fields: { status: 'active' } },
      }),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('archive postcondition violated');
    expect(outcome.reason).toContain("'status'");
    expect(outcome.reason).toContain('expected "archived"');
    expect(outcome.reason).toContain('persisted "active"');

    // The honest archive: the engine observes the classification-declared
    // archived state.
    const archived = claimOutcome('persistence:delete', archiveLifecycle, [
      witnessedAction({ payload: { operation: 'delete', entityId: 'acc-1' } }),
      witnessedPersistence({
        payload: {
          entityId: 'acc-1',
          found: true,
          fields: { first_name: 'Ada', status: 'archived' },
        },
      }),
    ]);
    expect(archived.verdict).toBe('satisfied');
  });

  it('a hard delete requires the entity observed ABSENT', () => {
    const action = witnessedAction({
      payload: { operation: 'delete', entityId: 'acc-1' },
    });
    const stillThere = claimOutcome('persistence:delete', hardLifecycle, [
      action,
      witnessedPersistence({
        payload: { entityId: 'acc-1', found: true, fields: { status: 'active' } },
      }),
    ]);
    expect(stillThere.verdict).toBe('invalid');
    expect(stillThere.reason).toContain('entity still present after a hard delete');

    const gone = claimOutcome('persistence:delete', hardLifecycle, [
      action,
      witnessedPersistence({
        payload: { entityId: 'acc-1', found: false },
      }),
    ]);
    expect(gone.verdict).toBe('satisfied');
  });

  it('create requires engine-observed absence before and presence after', () => {
    const action = witnessedAction({
      payload: { operation: 'create', entityId: 'acc-9', fields: { name: 'New' } },
    });
    const noBefore = claimOutcome('persistence:create', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: {
          entityId: 'acc-9',
          found: true,
          fields: { name: 'New' },
        },
      }),
    ]);
    expect(noBefore.verdict).toBe('invalid');
    expect(noBefore.reason).toContain('no engine-observed pre-observation');

    const withBefore = claimOutcome('persistence:create', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: {
          entityId: 'acc-9',
          found: true,
          fields: { name: 'New', status: 'active' },
          before: { entityAbsent: true },
        },
      }),
    ]);
    expect(withBefore.verdict).toBe('satisfied');

    const neverAppeared = claimOutcome('persistence:create', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: {
          entityId: 'acc-9',
          found: false,
          before: { entityAbsent: true },
        },
      }),
    ]);
    expect(neverAppeared.verdict).toBe('invalid');
    expect(neverAppeared.reason).toContain('entity still absent after the action');
  });

  it('update requires an engine-observed before/after delta, not suite declarations', () => {
    const action = witnessedAction({ payload: { operation: 'update', entityId: 'acc-1' } });

    // No pre-observation at all: nothing proves what "before" was.
    const noBefore = claimOutcome('persistence:update', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: { entityId: 'acc-1', found: true, fields: { name: 'Whatever' } },
      }),
    ]);
    expect(noBefore.verdict).toBe('invalid');
    expect(noBefore.reason).toContain('no engine-observed before-state');

    // Pre-observation exists but nothing changed: the suite re-read the
    // unchanged entity — previously satisfiable, now blocked.
    const noDelta = claimOutcome('persistence:update', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: {
          entityId: 'acc-1',
          found: true,
          fields: { name: 'Same' },
          before: { found: true, fields: { name: 'Same' } },
        },
      }),
    ]);
    expect(noDelta.verdict).toBe('invalid');
    expect(noDelta.reason).toContain('touches no classification-declared');

    // A real engine-observed delta satisfies.
    const changed = claimOutcome('persistence:update', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: {
          entityId: 'acc-1',
          found: true,
          fields: { name: 'New Name' },
          before: { found: true, fields: { name: 'Old Name' } },
        },
      }),
    ]);
    expect(changed.verdict).toBe('satisfied');

    const observedAbsence = claimOutcome('persistence:update', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: {
          entityId: 'acc-1',
          found: false,
          before: { found: true, fields: { name: 'Old Name' } },
        },
      }),
    ]);
    expect(observedAbsence.verdict).toBe('invalid');
    expect(observedAbsence.reason).toContain('entity absent after the action');
  });

  it('read grades on engine-observed presence; suite visibility claims cannot satisfy', () => {
    const action = witnessedAction({ payload: { operation: 'read', entityId: 'acc-1' } });

    const present = claimOutcome('persistence:read', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: { entityId: 'acc-1', found: true, fields: { status: 'active' } },
      }),
    ]);
    expect(present.verdict).toBe('satisfied');

    // Suite-submitted visibility is claimed-only and plays no part in
    // satisfaction: a read with NO visible record still grades on the
    // engine observation alone.
    const absent = claimOutcome('persistence:read', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: { entityId: 'acc-1', found: false },
      }),
    ]);
    expect(absent.verdict).toBe('invalid');
    expect(absent.reason).toContain('entity absent');
  });

  it('the reviewer repro: an updated_at-only delta while the claimed field is unchanged is invalid', () => {
    // The suite claims a business-field change, but the engine observes
    // only bookkeeping drift. Round 5 satisfied this; round 6 requires
    // the delta to touch a classification-declared updateable field.
    const action = witnessedAction({
      payload: { operation: 'update', entityId: 'acc-1', fields: { name: 'New Name' } },
    });
    const outcome = claimOutcome('persistence:update', LIFECYCLE, [
      action,
      witnessedPersistence({
        payload: {
          entityId: 'acc-1',
          found: true,
          fields: { name: 'Old Name', updated_at: '2026-08-31T00:00:00.000Z' },
          before: { found: true, fields: { name: 'Old Name', updated_at: '2026-08-30T00:00:00.000Z' } },
        },
      }),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('touches no classification-declared');
    expect(outcome.reason).toContain('updated_at');
    expect(outcome.reason).toContain('updateableFields');
  });

  it('update without classification-declared updateableFields fails closed', () => {
    const action = witnessedAction({ payload: { operation: 'update', entityId: 'acc-1' } });
    const noUpdateable = { ...LIFECYCLE, updateableFields: undefined };
    const outcome = claimOutcome('persistence:update', noUpdateable, [
      action,
      witnessedPersistence({
        payload: {
          entityId: 'acc-1',
          found: true,
          fields: { name: 'New Name' },
          before: { found: true, fields: { name: 'Old Name' } },
        },
      }),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('declares no updateableFields');
  });

  it('a persistence record without an engine observation can never satisfy', () => {
    const outcome = claimOutcome('persistence:update', LIFECYCLE, [
      witnessedAction(),
      witnessedPersistence({
        payload: { entityId: 'acc-1', fields: { name: 'New Name' } }, // no `found`
      }),
    ]);
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('no engine-observed presence observation');
  });

  it('UI-semantic crud: contracts fail closed — no witness-controlled UI observation exists', () => {
    // A complete, honest, witnessed persistence bundle offered to the
    // UI-semantic crud:update contract: still blocking missing, with the
    // explicit reason (round 5).
    const outcome = claimOutcome('crud:update', LIFECYCLE, [
      witnessedAction(),
      witnessedPersistence(),
    ]);
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain('no witness-controlled UI observation channel');
    expect(outcome.reason).toContain("the UI-semantic contract 'crud:update' cannot be verified");
  });
});

describe('evaluateObligation — same-entity enforcement (invariant 3, D3)', () => {
  it('is invalid when persistence evidence targets a different entity', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [
        witnessedAction(),
        witnessedPersistence({ payload: { entityId: 'acc-2' } }),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('same-entity violation');
  });

  it('is invalid when the ui.action carries no entityId', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [witnessedAction({ payload: { operation: 'update' } }), witnessedPersistence()],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('no entityId');
  });

  it('satisfies composite identity matched column-by-column (D3)', () => {
    const composite = makeObligation({ resourceId: 'tenant.regions' });
    const entity = { region: 'eu', code: 'x-1' };
    const outcome = evaluateObligation(composite, {
      claims: [makeClaim('test-1', composite.id)],
      records: [
        witnessedAction({
          obligationId: composite.id,
          payload: { operation: 'update', entityId: entity },
        }),
        witnessedPersistence({
          obligationId: composite.id,
          payload: {
            entityId: { code: 'x-1', region: 'eu' },
            found: true,
            fields: { name: 'New Name' },
            before: { found: true, fields: { name: 'Old Name' } },
          },
        }),
      ],
      waivers: [],
      classification: compositeClassification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('satisfied');
  });

  it('rejects composite entityId missing a key part (D3 checkable violation)', () => {
    const composite = makeObligation({ resourceId: 'tenant.regions' });
    const outcome = evaluateObligation(composite, {
      claims: [makeClaim('test-1', composite.id)],
      records: [
        witnessedAction({
          obligationId: composite.id,
          payload: { operation: 'update', entityId: { region: 'eu' } },
        }),
        witnessedPersistence({
          obligationId: composite.id,
          payload: { entityId: { region: 'eu' } },
        }),
      ],
      waivers: [],
      classification: compositeClassification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('missing key parts');
  });

  it('rejects composite entityId with an unknown key part', () => {
    const composite = makeObligation({ resourceId: 'tenant.regions' });
    const entityId = { region: 'eu', code: 'x', extra: 1 };
    const outcome = evaluateObligation(composite, {
      claims: [makeClaim('test-1', composite.id)],
      records: [
        witnessedAction({
          obligationId: composite.id,
          payload: { operation: 'update', entityId },
        }),
        witnessedPersistence({ obligationId: composite.id, payload: { entityId } }),
      ],
      waivers: [],
      classification: compositeClassification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('unknown key parts');
  });

  it('rejects scalar entityId for a composite resource', () => {
    const composite = makeObligation({ resourceId: 'tenant.regions' });
    const outcome = evaluateObligation(composite, {
      claims: [makeClaim('test-1', composite.id)],
      records: [
        witnessedAction({
          obligationId: composite.id,
          payload: { operation: 'update', entityId: 'eu:x' },
        }),
        witnessedPersistence({ obligationId: composite.id, payload: { entityId: 'eu:x' } }),
      ],
      waivers: [],
      classification: compositeClassification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('column-keyed object');
  });

  it('rejects an object entityId for a single-column resource', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [
        witnessedAction({ payload: { operation: 'update', entityId: { id: 'acc-1' } } }),
        witnessedPersistence({ payload: { entityId: { id: 'acc-1' } } }),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('scalar entityId is required');
  });

  it('is invalid when visible and persisted fields disagree', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [
        witnessedAction(),
        witnessedPersistence(),
        makeRecord({
          kind: 'ui.visible-result',
          payload: { entityId: 'acc-1', fields: { name: 'Different' } },
        }),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain("disagree on 'name'");
  });
});

describe('evaluateObligation — classification gating', () => {
  it('blocks unclassified resources', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [witnessedAction(), witnessedPersistence()],
      waivers: [],
      classification: null,
      now: NOW,
    });
    expect(outcome.verdict).toBe('unclassified');
    expect(outcome.reason).toContain('no classification');
  });

  it('blocks resources whose classification fails validation', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [],
      waivers: [],
      classification: { exposure: 'nonsense' },
      now: NOW,
    });
    expect(outcome.verdict).toBe('unclassified');
    expect(outcome.reason).toContain('failed validation');
  });

  it('invalidates claims on internal resources (G2 convention)', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1')],
      records: [witnessedAction(), witnessedPersistence()],
      waivers: [],
      classification: { ...classification, exposure: 'internal' },
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('internal');
  });
});

describe('evaluateObligation — waiver matching (D4, GF-16/17)', () => {
  it('yields waived for an exact unexpired waiver match', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [],
      waivers: [makeWaiver()],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('waived');
    expect(outcome.reason).toContain('team-accounts');
    expect(outcome.reason).toContain('alice');
    expect(outcome.recordIds).toEqual([]);
  });

  it('ignores waivers scoped to a different fingerprint (exact scope only)', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [],
      waivers: [
        makeWaiver({
          scope: { kind: 'exact', resourceId: obligation.resourceId, fingerprint: sha256Canonical({ other: true }) },
        }),
      ],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('missing');
  });

  it('yields invalid for an expired waiver (D4, GF-16)', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [],
      waivers: [makeWaiver({ expiresAt: '2026-08-01T00:00:00.000Z' })],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('expired');
    expect(outcome.reason).toContain('D4');
  });

  it('treats the exact expiry instant as expired', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [],
      waivers: [makeWaiver({ expiresAt: NOW })],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
  });

  it('yields stale for a waiver whose owner check fails (GF-17)', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [],
      waivers: [{ ...makeWaiver(), ownerStale: true }],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('stale');
    expect(outcome.reason).toContain('team-accounts');
  });

  it('prefers a valid waiver over an expired one for the same scope', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [],
      waivers: [
        makeWaiver({ expiresAt: '2026-08-01T00:00:00.000Z', owner: 'old-owner' }),
        makeWaiver(),
      ],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('waived');
  });

  it('prefers invalid (D4) over stale when only expired and stale waivers match', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [],
      waivers: [
        makeWaiver({ expiresAt: '2026-08-01T00:00:00.000Z', owner: 'lapsed-owner' }),
        { ...makeWaiver({ owner: 'gone-owner' }), ownerStale: true },
      ],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('invalid');
  });

  it('accepts the injected clock as a Date or ISO string', () => {
    const context = {
      claims: [],
      records: [],
      waivers: [makeWaiver({ expiresAt: '2026-08-01T00:00:00.000Z' })],
      classification,
    };
    expect(evaluateObligation(obligation, { ...context, now: NOW }).verdict).toBe('invalid');
    expect(evaluateObligation(obligation, { ...context, now: new Date(NOW) }).verdict).toBe(
      'invalid',
    );
  });
});

describe('evaluateObligation — generic contracts and determinism', () => {
  it('fails closed on non-crud contracts: no generic satisfaction without a semantic verifier', () => {
    const audit = makeObligation({ resourceId: 'tenant.audit', contract: 'audit:event' });
    const outcome = evaluateObligation(audit, {
      claims: [makeClaim('test-1', audit.id)],
      records: [
        witnessedAction({ obligationId: audit.id, payload: { entityId: 'ev-9' } }),
        witnessedPersistence({ obligationId: audit.id, payload: { entityId: 'ev-9' } }),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    // Even a complete, fully witnessed CRUD-shaped bundle must NOT
    // satisfy a non-CRUD contract: the generic rule is meaningless for
    // it (missing blocks — fail closed until a pack-specific verifier
    // is registered).
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toContain("no semantic verifier is registered for contract 'audit:event'");
  });

  it('ignores claims and records belonging to other obligations', () => {
    const other = makeObligation({ resourceId: 'tenant.orders' });
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('test-1', other.id)],
      records: [
        witnessedAction({ obligationId: other.id }),
        witnessedPersistence({ obligationId: other.id }),
      ],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('missing');
  });

  it('is deterministic across repeated evaluation and claim order', () => {
    const context = {
      claims: [makeClaim('b-test'), makeClaim('a-test')],
      records: [witnessedPersistence(), witnessedAction()],
      waivers: [],
      classification,
      now: NOW,
    };
    const first = evaluateObligation(obligation, context);
    const second = evaluateObligation(obligation, { ...context, claims: [...context.claims].reverse() });
    expect(second).toEqual(first);
  });

  it('satisfies from the first satisfiable claim in testId order', () => {
    const good = witnessedPersistence({ testId: 'a-good' });
    const outcome = evaluateObligation(obligation, {
      claims: [makeClaim('a-good'), makeClaim('z-empty')],
      records: [witnessedAction({ testId: 'a-good' }), good],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('satisfied');
    expect(outcome.recordIds).toContain(good.recordId);
  });

  it('throws GateforgeVerdictError for a malformed obligation (engine bug, not evidence)', () => {
    const broken = { ...obligation, id: 'wrong:id' } as unknown as Obligation;
    expect(() =>
      evaluateObligation(broken, {
        claims: [],
        records: [],
        waivers: [],
        classification,
        now: NOW,
      }),
    ).toThrow(GateforgeVerdictError);
  });

  it('throws GateforgeVerdictError for a malformed clock', () => {
    expect(() =>
      evaluateObligation(obligation, {
        claims: [],
        records: [],
        waivers: [],
        classification,
        now: 'not-a-date',
      }),
    ).toThrow(GateforgeVerdictError);
  });
});

describe('evaluateObligations — batch wrapper', () => {
  it('returns entries sorted by obligation id with trust tiers', () => {
    const other = makeObligation({ resourceId: 'tenant.orders' });
    const entries = evaluateObligations([other, obligation], {
      claims: [makeClaim('test-1'), makeClaim('test-1', other.id)],
      records: [witnessedAction(), witnessedPersistence()],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(entries.map((entry) => entry.obligation.id)).toEqual(
      ['tenant.accounts:persistence:update', 'tenant.orders:persistence:update'].sort(),
    );
    const accounts = entries.find((entry) => entry.obligation.resourceId === 'tenant.accounts');
    const orders = entries.find((entry) => entry.obligation.resourceId === 'tenant.orders');
    expect(accounts?.verdict).toBe('satisfied');
    expect(accounts?.trustTier).toBe('witnessed');
    expect(orders?.verdict).toBe('missing');
    expect(orders?.trustTier).toBeNull();
  });

  it('reports claimed as the tier when only claimed records exist', () => {
    const entries = evaluateObligations([obligation], {
      claims: [makeClaim('test-1')],
      records: [witnessedAction({ trust: 'claimed' })],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(entries[0]?.trustTier).toBe('claimed');
    // A suite-asserted action anchors the claim, but with no
    // engine-observed persistence record the outcome is unverifiable →
    // missing (blocking).
    expect(entries[0]?.verdict).toBe('missing');
    expect(entries[0]?.reason).toContain("no witnessed 'persistence.*'");
  });
});
