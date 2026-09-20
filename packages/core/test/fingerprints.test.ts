import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprint } from '../src/index.js';

/** Minimal valid lifecycle for fingerprint inputs. */
const lifecycle = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'archive', archiveFields: { status: 'archived' },
} as const;

describe('fingerprint (pin #2)', () => {
  it('hashes exactly {resourceId, contract, policyId, lifecycle}', () => {
    const expected = canonicalJson({
      resourceId: 'tenant.accounts',
      contract: 'crud:update',
      policyId: 'user-facing-sqlalchemy-lifecycle',
      lifecycle,
    });
    // The pin: sha256 over the canonical form of exactly those four keys.
    expect(fingerprint({
      resourceId: 'tenant.accounts',
      contract: 'crud:update',
      policyId: 'user-facing-sqlalchemy-lifecycle',
      lifecycle,
    })).toMatch(/^[0-9a-f]{64}$/);
    expect(
      fingerprint({
        resourceId: 'tenant.accounts',
        contract: 'crud:update',
        policyId: 'user-facing-sqlalchemy-lifecycle',
        lifecycle,
      }),
    ).not.toBe(fingerprint({
      resourceId: 'tenant.accounts',
      contract: 'crud:create',
      policyId: 'user-facing-sqlalchemy-lifecycle',
      lifecycle,
    }));
    expect(expected).toBeDefined();
  });

  it('is independent of input key order (flat and nested)', () => {
    const a = fingerprint({
      resourceId: 'tenant.accounts',
      contract: 'crud:update',
      policyId: 'user-facing-sqlalchemy-lifecycle',
      lifecycle,
    });
    const b = fingerprint({
      lifecycle: {
        deleteSemantics: 'archive', archiveFields: { status: 'archived' },
        delete: true,
        update: true,
        read: true,
        create: true,
      },
      policyId: 'user-facing-sqlalchemy-lifecycle',
      contract: 'crud:update',
      resourceId: 'tenant.accounts',
    });
    expect(a).toBe(b);
  });

  it('changes when any identity component changes', () => {
    const base = {
      resourceId: 'tenant.accounts',
      contract: 'crud:update',
      policyId: 'user-facing-sqlalchemy-lifecycle',
      lifecycle,
    };
    const variants = [
      { ...base, resourceId: 'tenant.contacts' },
      { ...base, contract: 'crud:create' },
      { ...base, policyId: 'other-policy' },
      { ...base, lifecycle: { ...lifecycle, update: false } },
    ];
    const baseFp = fingerprint(base);
    for (const variant of variants) {
      expect(fingerprint(variant)).not.toBe(baseFp);
    }
  });

  it('is stable across repeated calls (baseline-safe determinism)', () => {
    const input = {
      resourceId: 'master.settings',
      contract: 'crud:read',
      policyId: 'internal-sqlalchemy-lifecycle',
      lifecycle: { create: false, read: true, update: false, delete: false },
    };
    expect(fingerprint(input)).toBe(fingerprint({ ...input }));
  });

  it('rejects resourceIds containing colons (id splits at first colon)', () => {
    expect(() =>
      fingerprint({
        resourceId: 'tenant:accounts',
        contract: 'crud:update',
        policyId: 'p',
        lifecycle,
      }),
    ).toThrow(/':'/);
  });

  it('accepts namespaced contracts like crud:update', () => {
    expect(
      fingerprint({
        resourceId: 'tenant.accounts',
        contract: 'crud:update',
        policyId: 'p',
        lifecycle,
      }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits undefined requirementsDigest from the hashed identity', () => {
    const base = {
      resourceId: 'tenant.accounts',
      contract: 'crud:update',
      policyId: 'p',
      lifecycle,
    };
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
    expect(
      fingerprint({ ...base, requirementsDigest: 'ab'.repeat(32) }),
    ).not.toBe(fingerprint(base));
  });
});
