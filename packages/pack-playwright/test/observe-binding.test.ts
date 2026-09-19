/**
 * Adapter `observe` binding validation (Observe channel, Phase 2):
 * shape rules for the trusted per-operation mutation declarations —
 * concrete verbs, absolute paths, `{id}` required everywhere except
 * create (which forbids it: create ids come from the list-diff).
 * Present-but-malformed bindings fail at load, never at finalize.
 */
import { describe, expect, it } from 'vitest';
import { validateAdapter, validateObserveBinding } from '../src/witness/adapter-registry.js';

const BASE = {
  read: async () => null,
  normalize: (body: unknown) => ({ entityId: null, fields: {} }),
  deletion: 'hard',
  environmentFingerprint: 'example-v1',
};

describe('validateObserveBinding', () => {
  it('accepts a full four-operation binding', () => {
    expect(
      validateObserveBinding({
        create: { method: 'POST', path: '/api/v2/accounts' },
        read: { method: 'GET', path: '/api/v2/accounts/{id}' },
        update: { method: 'PATCH', path: '/api/v2/accounts/{id}' },
        delete: { method: 'DELETE', path: '/api/v2/accounts/{id}' },
      }),
    ).toBe(null);
  });

  it('accepts a partial binding (only declared operations are observe-eligible)', () => {
    expect(validateObserveBinding({ create: { method: 'POST', path: '/accounts' } })).toBe(null);
  });

  it('rejects non-objects, unknown operations, and malformed entries', () => {
    expect(validateObserveBinding(null)).toContain('must be an object');
    expect(validateObserveBinding([])).toContain('must be an object');
    expect(validateObserveBinding({ upsert: { method: 'POST', path: '/x' } })).toContain('unknown operation');
    expect(validateObserveBinding({ create: 'POST /x' })).toContain('must be {method, path}');
    expect(validateObserveBinding({ create: { method: 'post', path: '/x' } })).toContain('uppercase HTTP verb');
    expect(validateObserveBinding({ create: { method: 'QUERY', path: '/x' } })).toContain('uppercase HTTP verb');
    expect(validateObserveBinding({ create: { method: 'POST', path: 'accounts' } })).toContain("starting with '/'");
  });

  it('rejects non-template path shapes', () => {
    expect(validateObserveBinding({ create: { method: 'POST', path: '/a//b' } })).toContain('plain path template');
    expect(validateObserveBinding({ create: { method: 'POST', path: '/a?x=1' } })).toContain('plain path template');
    expect(validateObserveBinding({ create: { method: 'POST', path: '/a/{name}' } })).toContain("only the '{id}' segment");
  });

  it('forbids {id} on create and requires it elsewhere', () => {
    expect(
      validateObserveBinding({ create: { method: 'POST', path: '/api/v2/accounts/{id}' } }),
    ).toContain('must not template');
    expect(validateObserveBinding({ update: { method: 'PATCH', path: '/api/v2/accounts' } })).toContain(
      "exactly one '{id}'",
    );
    expect(
      validateObserveBinding({ delete: { method: 'DELETE', path: '/a/{id}/b/{id}' } }),
    ).toContain("exactly one '{id}'");
  });
});

describe('validateAdapter observe integration', () => {
  it('keeps an adapter without observe valid (Observe simply unavailable)', () => {
    expect(() => validateAdapter({ ...BASE }, 'accounts')).not.toThrow();
    expect(validateAdapter({ ...BASE }, 'accounts').observe).toBe(undefined);
  });

  it('carries a valid observe binding onto the registry entry', () => {
    const adapter = validateAdapter(
      { ...BASE, observe: { create: { method: 'POST', path: '/api/v2/accounts' } } },
      'accounts',
    );
    expect(adapter.observe).toEqual({ create: { method: 'POST', path: '/api/v2/accounts' } });
  });

  it('fails load on a malformed observe binding', () => {
    expect(() =>
      validateAdapter({ ...BASE, observe: { create: { method: 'POST', path: 'relative' } } }, 'accounts'),
    ).toThrow(/violates the adapter contract/);
  });
});
