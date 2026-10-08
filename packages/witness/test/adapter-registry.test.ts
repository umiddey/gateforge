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

  it('rejects a declared deletion semantic for a delete-disabled resource', () => {
    expect(() => validateAdapter(adapter({ deletion: 'hard' }), 'read-only', { deleteDisabled: true }))
      .toThrow(/deletion.*delete-disabled/);
  });

  it('keeps deletion required when delete is enabled', () => {
    expect(() => validateAdapter(adapter(), 'writable')).toThrow(/deletion must be 'hard' or 'archive'/);
  });
});
