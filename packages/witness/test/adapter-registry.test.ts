import { describe, expect, it } from 'vitest';
import { validateAdapter } from '../src/witness/adapter-registry.js';

function adapter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    read: async () => null,
    normalize: () => ({ entityId: 'id', fields: {} }),
    environmentFingerprint: 'test',
    ...overrides,
  };
}

describe('adapter deletion semantics and disabled lifecycle', () => {
  it('accepts an omitted deletion semantic only for a delete-disabled resource', () => {
    const validated = validateAdapter(adapter(), 'read-only', { deleteDisabled: true });
    expect(validated.deletion).toBeUndefined();
  });

  it('still accepts a declared deletion semantic for a delete-disabled resource', () => {
    // Existing adapters (and shared factories) declare it; a patch release must not refuse them.
    const validated = validateAdapter(adapter({ deletion: 'hard' }), 'read-only', { deleteDisabled: true });
    expect(validated.deletion).toBe('hard');
  });

  it('rejects an invalid declared deletion semantic for a delete-disabled resource', () => {
    expect(() => validateAdapter(adapter({ deletion: 'soft' }), 'read-only', { deleteDisabled: true }))
      .toThrow(/deletion must be 'hard' or 'archive'/);
  });

  it('keeps deletion required when delete is enabled', () => {
    expect(() => validateAdapter(adapter(), 'writable')).toThrow(/deletion must be 'hard' or 'archive'/);
  });
});
