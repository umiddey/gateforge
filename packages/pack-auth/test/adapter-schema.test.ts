/**
 * Auth pack adapter-schema suite: the validator accepts the shipped
 * sample adapter and rejects malformed adapters fail-closed.
 *
 * The sample adapter is statically imported (`.mjs` extension, ESM
 * default export) and validated directly. This mirrors the engine's
 * adapter-loading path at runtime.
 */
import { describe, expect, it } from 'vitest';
import sampleDefault from '../examples/example.billing.refund.adapter.mjs';
import { validateAuthEntityAdapter } from '../src/index.js';

describe('entity-adapter schema + sample adapter', () => {
  it('validates the shipped example adapter against the contract', () => {
    const validation = validateAuthEntityAdapter(sampleDefault);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.adapter.resourceId).toBe('example.billing.refund');
    expect(validation.adapter.deletion).toBe('hard');
    expect(validation.adapter.environmentFingerprint).toBe('auth-loopback-v1');
  });

  it('normalize projects the raw body onto { entityId, fields }', () => {
    const normalized = sampleDefault.normalize({
      id: 'rfn-1',
      amount_cents: 4200,
      tenant_id: 'tenant-a',
      requested_by: 'admin-1',
      status: 'refunded',
      created_at: '2026-08-31T00:00:00.000Z',
    });
    expect(normalized).toEqual({
      entityId: 'rfn-1',
      fields: {
        id: 'rfn-1',
        amount_cents: 4200,
        tenant_id: 'tenant-a',
        status: 'refunded',
      },
    });
  });

  it('rejects adapters missing data fields fail-closed', () => {
    const validation = validateAuthEntityAdapter({
      read: async () => null,
      normalize: () => ({ entityId: 'x', fields: {} }),
      deletion: 'hard',
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.join(' ')).toContain('resourceId');
    expect(validation.issues.join(' ')).toContain('environmentFingerprint');
  });

  it('rejects adapters whose read/normalize are not functions', () => {
    const validation = validateAuthEntityAdapter({
      resourceId: 'x',
      read: 'not-a-function',
      normalize: null,
      deletion: 'hard',
      environmentFingerprint: 'env-v1',
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues.join(' ')).toContain('read');
      expect(validation.issues.join(' ')).toContain('normalize');
    }
  });

  it('rejects an unknown deletion semantics value', () => {
    const validation = validateAuthEntityAdapter({
      resourceId: 'x',
      read: async () => null,
      normalize: () => ({ entityId: 'x', fields: {} }),
      deletion: 'soft',
      environmentFingerprint: 'env-v1',
    } as unknown);
    expect(validation.ok).toBe(false);
  });
});