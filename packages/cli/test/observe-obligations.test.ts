/**
 * `observeObligationIds` unit tests (Observe channel, Phase 2): the
 * trusted CLI layer resolves exactly the obligations with an
 * `observed-e2e` binding into the witness declaration set — sorted,
 * deduplicated, and blind to every other kind.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedMappings } from '@gate-forge/core';
import { observeObligationIds, serverE2eObligationIds } from '../src/mapping.js';

function resolution(bindings: Array<{ obligationId: string; declaredKind: 'observed-e2e' | 'browser-e2e' | 'server-e2e' | null }>): ResolvedMappings {
  return {
    obligations: bindings.map((binding, index) => ({
      obligationId: binding.obligationId,
      bindings: [
        {
          logicalKey: `key-${index}`,
          instances: [],
          origin: 'sidecar',
          sourceDigest: null,
          declaredKind: binding.declaredKind,
          categories: [],
          reason: 'test',
          sourceLocation: null,
        },
      ],
    })),
    problems: [],
  };
}

describe('observeObligationIds', () => {
  it('collects observed-e2e obligations sorted and deduplicated', () => {
    const ids = observeObligationIds(
      resolution([
        { obligationId: 'tenant.orders:persistence:read', declaredKind: 'observed-e2e' },
        { obligationId: 'tenant.accounts:persistence:create', declaredKind: 'observed-e2e' },
        { obligationId: 'tenant.accounts:persistence:create', declaredKind: 'observed-e2e' },
        { obligationId: 'tenant.accounts:persistence:read', declaredKind: 'browser-e2e' },
        { obligationId: 'tenant.outbox:persistence:create', declaredKind: 'server-e2e' },
        { obligationId: 'tenant.plain:persistence:read', declaredKind: null },
      ]),
    );
    expect(ids).toEqual(['tenant.accounts:persistence:create', 'tenant.orders:persistence:read']);
  });

  it('returns empty when nothing declares observed-e2e (server set untouched)', () => {
    const input = resolution([{ obligationId: 'tenant.outbox:persistence:create', declaredKind: 'server-e2e' }]);
    expect(observeObligationIds(input)).toEqual([]);
    expect(serverE2eObligationIds(input)).toEqual(['tenant.outbox:persistence:create']);
  });
});
