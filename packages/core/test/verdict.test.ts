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
} as const;

function makeObligation(overrides: Record<string, unknown> = {}): Obligation {
  const base = {
    schemaVersion: 1,
    resourceId: 'tenant.accounts',
    contract: 'crud:update',
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

/** Builds a witness-shaped record; provenance defaults to service-issued. */
function makeRecord(overrides: Record<string, unknown> = {}) {
  recordCounter += 1;
  return {
    schemaVersion: 1,
    recordId: sha256Canonical({ record: recordCounter }),
    runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    trust: 'witnessed',
    obligationId: obligation.id,
    testId: 'test-1',
    kind: 'ui.action',
    payload: { operation: 'update', entityId: 'acc-1' },
    ...overrides,
  };
}

function witnessedAction(overrides: Record<string, unknown> = {}) {
  return makeRecord({ kind: 'ui.action', ...overrides });
}

function witnessedPersistence(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    kind: 'persistence.entity',
    payload: { entityId: 'acc-1', fields: { name: 'New Name' } },
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

  it('is missing when no claim declares the obligation', () => {
    const outcome = evaluateObligation(obligation, {
      claims: [],
      records: [witnessedAction(), witnessedPersistence()],
      waivers: [],
      classification,
      now: NOW,
    });
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).toBe("no claim declares 'tenant.accounts:crud:update'");
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
    expect(outcome.reason).toContain("no witnessed 'ui.action'");
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
    expect(outcome.reason).toContain("'crud:update' requires 'update'");
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
          payload: { entityId: { code: 'x-1', region: 'eu' } },
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
  it('satisfies non-crud contracts with the generic two-record rule', () => {
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
    expect(outcome.verdict).toBe('satisfied');
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
      ['tenant.accounts:crud:update', 'tenant.orders:crud:update'].sort(),
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
    expect(entries[0]?.verdict).toBe('invalid');
  });
});
