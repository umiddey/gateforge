/**
 * Trusted scope-snapshot validation (plan 2026-09-19 §4.4, Phase 4):
 * pure bounded checks. Incomplete collection, wrong namespace, unknown
 * identity, duplicates, disorder, omitted fields, and truncation block;
 * canonical complete snapshots validate with an identity index.
 */
import { describe, expect, it } from 'vitest';
import { identityKeyOf, validateScopeSnapshot, type SnapshotScopeSpec } from '../src/witness/behavior.js';

const SPEC: SnapshotScopeSpec = {
  scope: 'fixture-accounts',
  fixtureNamespace: 'fixture-run1-case1-1',
  identityFields: ['tenant_id', 'id'],
  fields: ['first_name', 'status'],
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'fixture-accounts',
    fixtureNamespace: 'fixture-run1-case1-1',
    complete: true,
    checkpoint: 'fixture-run1-case1-1:2',
    entities: [
      {
        entityId: { tenant_id: 't1', id: 'acc-1' },
        fields: { first_name: 'Ada', status: 'active' },
      },
      {
        entityId: { tenant_id: 't1', id: 'acc-2' },
        fields: { first_name: 'Grace', status: 'active' },
      },
    ],
    exhausted: true,
    ...overrides,
  };
}

describe('validateScopeSnapshot (green path)', () => {
  it('accepts a canonical complete snapshot with an identity index', () => {
    const result = validateScopeSnapshot(snapshot(), SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.checkpoint).toBe('fixture-run1-case1-1:2');
    expect(result.snapshot.order).toHaveLength(2);
    expect(result.snapshot.index.get('composite:id=string:acc-1|tenant_id=string:t1')?.fields).toMatchObject({
      first_name: 'Ada',
    });
  });

  it('accepts an empty scope (legitimately no entities)', () => {
    const result = validateScopeSnapshot(snapshot({ entities: [] }), SPEC);
    expect(result.ok).toBe(true);
  });

  it('accepts scalar single-column identities', () => {
    const spec: SnapshotScopeSpec = { ...SPEC, identityFields: ['id'] };
    const result = validateScopeSnapshot(
      snapshot({
        entities: [{ entityId: 'acc-1', fields: { first_name: 'Ada', status: 'active' } }],
      }),
      spec,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.order).toEqual(['string:acc-1']);
  });
});

describe('validateScopeSnapshot (blocking paths)', () => {
  it('blocks complete:false (no partial credit)', () => {
    expect(validateScopeSnapshot(snapshot({ complete: false }), SPEC)).toMatchObject({ ok: false });
  });

  it('blocks a wrong fixture namespace', () => {
    const result = validateScopeSnapshot(snapshot({ fixtureNamespace: 'other-ns' }), SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/namespace/);
  });

  it('blocks a scope mismatch', () => {
    expect(validateScopeSnapshot(snapshot({ scope: 'other-scope' }), SPEC)).toMatchObject({ ok: false });
  });

  it('blocks pagination not exhausted', () => {
    const without = snapshot();
    delete (without as Record<string, unknown>)['exhausted'];
    expect(validateScopeSnapshot(without, SPEC)).toMatchObject({ ok: false });
  });

  it('blocks truncation (entities fewer than totalSize)', () => {
    expect(validateScopeSnapshot(snapshot({ totalSize: 5 }), SPEC)).toMatchObject({ ok: false });
  });

  it('blocks omitted declared fields', () => {
    const bad = snapshot({
      entities: [{ entityId: { tenant_id: 't1', id: 'acc-1' }, fields: { first_name: 'Ada' } }],
    });
    const result = validateScopeSnapshot(bad, SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/status/);
  });

  it('blocks unknown identity', () => {
    const bad = snapshot({
      entities: [{ entityId: { tenant_id: 't1' }, fields: { first_name: 'Ada', status: 'active' } }],
    });
    expect(validateScopeSnapshot(bad, SPEC)).toMatchObject({ ok: false });
  });

  it('blocks duplicate identity', () => {
    const one = { entityId: { tenant_id: 't1', id: 'acc-1' }, fields: { first_name: 'Ada', status: 'active' } };
    const result = validateScopeSnapshot(snapshot({ entities: [one, { ...one }] }), SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/duplicate/);
  });

  it('blocks non-canonical order', () => {
    const entities = (snapshot().entities as unknown[]).reverse();
    const result = validateScopeSnapshot(snapshot({ entities }), SPEC);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/canonical/);
  });

  it('blocks over-limit scopes (bounded memory)', () => {
    const result = validateScopeSnapshot(snapshot(), { ...SPEC, maxEntities: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/bound/);
  });

  it('blocks a missing checkpoint', () => {
    expect(validateScopeSnapshot(snapshot({ checkpoint: '' }), SPEC)).toMatchObject({ ok: false });
  });

  it('blocks non-object snapshots', () => {
    expect(validateScopeSnapshot(null, SPEC)).toMatchObject({ ok: false });
    expect(validateScopeSnapshot([], SPEC)).toMatchObject({ ok: false });
  });
});

describe('identityKeyOf', () => {
  it('rejects null, missing columns, and non-scalar columns', () => {
    expect(identityKeyOf(null, ['id'])).toBe(null);
    expect(identityKeyOf({ id: 'a' }, ['id', 'tenant_id'])).toBe(null);
    expect(identityKeyOf({ id: ['a'] }, ['id'])).toBe(null);
    expect(identityKeyOf(['a'], ['id'])).toBe(null);
  });

  it('orders composite columns canonically regardless of input order', () => {
    expect(identityKeyOf({ id: 'a', tenant_id: 't' }, ['tenant_id', 'id'])).toBe(
      identityKeyOf({ tenant_id: 't', id: 'a' }, ['tenant_id', 'id']),
    );
  });
});
