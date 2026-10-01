/**
 * Adapter admission (Observe channel, Phase 2): shape rules for the
 * trusted per-operation mutation declarations — concrete verbs,
 * absolute paths, `{id}` required everywhere except create (which
 * forbids it: create ids come from the list-diff) — plus the optional
 * COLLECTION read shape (a read + GET naming its rows instead of its
 * `{id}`) and the declared `volatileFields` list. Present-but-malformed
 * bindings fail at load, never at finalize.
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

describe('validateObserveBinding (collection reads)', () => {
  it('accepts a wrapped collection read and a root-array one', () => {
    expect(
      validateObserveBinding({
        read: { method: 'GET', path: '/api/accounts', collection: { rowsKey: 'accounts', idKey: 'id' } },
      }),
    ).toBe(null);
    expect(
      validateObserveBinding({ read: { method: 'GET', path: '/api/accounts', collection: { idKey: 'id' } } }),
    ).toBe(null);
  });

  it('refuses a collection on anything but a GET read', () => {
    expect(
      validateObserveBinding({
        create: { method: 'POST', path: '/api/accounts', collection: { idKey: 'id' } },
      }),
    ).toContain('only a read renders a collection');
    expect(
      validateObserveBinding({
        update: { method: 'PATCH', path: '/api/accounts/{id}', collection: { idKey: 'id' } },
      }),
    ).toContain('only a read renders a collection');
    expect(
      validateObserveBinding({ read: { method: 'DELETE', path: '/api/accounts', collection: { idKey: 'id' } } }),
    ).toContain("requires method 'GET'");
  });

  it('refuses a collection on a path that already carries {id}', () => {
    expect(
      validateObserveBinding({
        read: { method: 'GET', path: '/api/accounts/{id}', collection: { idKey: 'id' } },
      }),
    ).toContain("must not be declared on a path carrying '{id}'");
  });

  it('refuses a collection with unusable key declarations', () => {
    expect(validateObserveBinding({ read: { method: 'GET', path: '/x', collection: [] } })).toContain(
      'must be an object',
    );
    expect(validateObserveBinding({ read: { method: 'GET', path: '/x', collection: {} } })).toContain(
      'idKey must be a non-empty property name',
    );
    expect(
      validateObserveBinding({ read: { method: 'GET', path: '/x', collection: { idKey: 'id', rowsKey: '' } } }),
    ).toContain('rowsKey must be a non-empty property name');
    expect(
      validateObserveBinding({ read: { method: 'GET', path: '/x', collection: { idKey: 'id', offset: 2 } } }),
    ).toContain("unknown key 'offset'");
  });

  it('keeps the by-id read binding valid beside a collection read adapter', () => {
    expect(
      validateObserveBinding({
        create: { method: 'POST', path: '/api/accounts' },
        read: { method: 'GET', path: '/api/accounts/{id}' },
        update: { method: 'PATCH', path: '/api/accounts/{id}' },
        delete: { method: 'POST', path: '/api/accounts/{id}/archive' },
      }),
    ).toBe(null);
  });
});

describe('validateAdapter volatileFields admission', () => {
  it('fails load on a malformed declaration', () => {
    expect(() => validateAdapter({ ...BASE, volatileFields: 'status' }, 'accounts')).toThrow(
      /violates the adapter contract/,
    );
    expect(() => validateAdapter({ ...BASE, volatileFields: ['status', ''] }, 'accounts')).toThrow(
      /unique non-empty field names/,
    );
    expect(() => validateAdapter({ ...BASE, volatileFields: ['status', 'status'] }, 'accounts')).toThrow(
      /unique non-empty field names/,
    );
  });
});
