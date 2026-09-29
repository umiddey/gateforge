/**
 * Declared server-computed fields (E18a).
 *
 * An app may legitimately compute a field the journey also entered (a
 * derived label, a server-side normalization, a slug). Before this
 * rule the exact-value echo failed such a correct app with
 * EVIDENCE_VALUE_MISMATCH. Now an adapter may DECLARE those keys; the
 * engine skips exactly them — and the skip is a reportable fact, never
 * a silently dropped mismatch, and never a blanket weakening: an
 * undeclared key still blocks exactly as before.
 */
import { describe, expect, it } from 'vitest';
import {
  ObligationSchema,
  evaluateObligation,
  recordIdOf,
  volatileEchoSkips,
  volatileFieldsOf,
  type Claim,
  type Obligation,
  type VerdictOutcome,
} from '../src/index.js';

/** Injected clock (invariant 7). */
const NOW = '2026-08-30T12:00:00.000Z';

/** The lifecycle the fixtures grade against. */
const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'archive',
  archiveFields: { status: 'archived' },
  updateableFields: ['name', 'label'],
} as const;

/** The obligation under grading. */
const OBLIGATION: Obligation = ObligationSchema.parse({
  schemaVersion: 1,
  resourceId: 'tenant.documents',
  contract: 'persistence:update',
  policyId: 'user-facing-lifecycle',
  lifecycle: LIFECYCLE,
  id: 'tenant.documents:persistence:update',
});

/** The classification the fixtures use. */
const CLASSIFICATION = {
  exposure: 'user-facing',
  plane: 'tenant',
  lifecycle: LIFECYCLE,
  primaryKey: ['id'],
  evidenceAdapter: 'documents',
};

/** The claim the fixture evidence satisfies. */
const CLAIM: Claim = {
  schemaVersion: 1,
  obligationId: OBLIGATION.id,
  testId: 'test-1',
  testFile: 'tests/documents.spec.ts',
};

/**
 * Builds a service-issued witness record.
 *
 * Args:
 *   kind: the record kind.
 *   payload: the engine-observed payload.
 *
 * Returns:
 *   Record<string, unknown>: a record whose id recomputes from its own
 *   identity (the exact predicate the engine verifies).
 */
function record(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  const runId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const identity = { runId, obligationId: OBLIGATION.id, kind, testId: 'test-1', origin: 'engine-observed' as const };
  return {
    schemaVersion: 1,
    trust: 'witnessed',
    ...identity,
    recordId: recordIdOf({ ...identity, payload }),
    payload,
  };
}

/** The journey's entered input. */
const ACTION = record('ui.action', {
  operation: 'update',
  entityId: 'doc-1',
  fields: { name: 'Quarterly report', label: 'Quarterly report' },
});

/**
 * Evaluates the obligation against one action and one persistence record.
 *
 * Args:
 *   persistence: the persistence record's payload.
 *
 * Returns:
 *   the verdict outcome.
 */
function grade(persistence: Record<string, unknown>): VerdictOutcome {
  return evaluateObligation(OBLIGATION, {
    claims: [CLAIM],
    records: [ACTION, record('persistence.entity', persistence)],
    waivers: [],
    classification: CLASSIFICATION,
    now: NOW,
  });
}

describe('declared volatile fields (E18a)', () => {
  it('still blocks an undeclared server-changed field', () => {
    const outcome = grade({
      entityId: 'doc-1',
      found: true,
      fields: { name: 'Quarterly report', label: 'QUARTERLY REPORT' },
      before: { found: true, fields: { name: 'Annual', label: 'ANNUAL' } },
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
  });

  it('accepts the same record when the adapter DECLARED the changed field', () => {
    const outcome = grade({
      entityId: 'doc-1',
      found: true,
      fields: { name: 'Quarterly report', label: 'QUARTERLY REPORT' },
      volatileFields: ['label'],
      before: { found: true, fields: { name: 'Annual', label: 'ANNUAL' } },
    });
    expect(outcome.verdict).toBe('satisfied');
  });

  it('keeps blocking an UNdeclared key while a declared one is skipped', () => {
    const outcome = grade({
      entityId: 'doc-1',
      found: true,
      fields: { name: 'Renamed by a bug', label: 'QUARTERLY REPORT' },
      volatileFields: ['label'],
      before: { found: true, fields: { name: 'Annual', label: 'ANNUAL' } },
    });
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('EVIDENCE_VALUE_MISMATCH');
    expect(outcome.reason).toContain('name');
  });

  it('reports every skipped key so the report can show it', () => {
    const persistence = record('persistence.entity', {
      entityId: 'doc-1',
      found: true,
      fields: { name: 'Quarterly report', label: 'QUARTERLY REPORT' },
      volatileFields: ['label', 'label', 'never_entered'],
      before: { found: true, fields: { name: 'Annual', label: 'ANNUAL' } },
    });
    expect(volatileFieldsOf(persistence)).toEqual(['label', 'never_entered']);
    const skips = volatileEchoSkips(ACTION, persistence);
    expect(skips).toEqual([
      { field: 'label', entered: 'Quarterly report', persisted: 'QUARTERLY REPORT' },
    ]);
  });

  it('reports no skips for an adapter that declares nothing', () => {
    const persistence = record('persistence.entity', {
      entityId: 'doc-1',
      found: true,
      fields: { name: 'Quarterly report' },
    });
    expect(volatileFieldsOf(persistence)).toEqual([]);
    expect(volatileEchoSkips(ACTION, persistence)).toEqual([]);
  });
});
