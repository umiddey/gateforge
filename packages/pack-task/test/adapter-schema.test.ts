/**
 * Entity-adapter schema tests: the pack's `TaskAuditAdapterSchema`
 * + `validateTaskAuditAdapter` against a known-good module and the
 * fail-closed rejection paths.
 *
 * Mirrors `packages/pack-sqlalchemy/test/adapters.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { validateTaskAuditAdapter } from '../src/index.js';

describe('task audit adapter schema + validator', () => {
  it('validates a well-formed adapter against the contract', () => {
    const validation = validateTaskAuditAdapter({
      resourceId: 'task.runs',
      read: async () => ({ id: 'run-1', retries: 2, sideEffectCount: 1, terminal: false }),
      normalize: (body: unknown) => {
        const b = body as { id: string; retries: number; sideEffectCount: number; terminal: boolean };
        return { entityId: b.id, fields: { id: b.id, retries: b.retries, sideEffectCount: b.sideEffectCount, terminal: b.terminal } };
      },
      deletion: 'archive',
      environmentFingerprint: 'task-loopback-v1',
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.adapter.resourceId).toBe('task.runs');
    expect(validation.adapter.deletion).toBe('archive');
    expect(validation.adapter.environmentFingerprint).toBe('task-loopback-v1');
  });

  it('normalize projects the raw body onto { entityId, fields }', () => {
    const validation = validateTaskAuditAdapter({
      resourceId: 'task.runs',
      read: async () => null,
      normalize: (body: unknown) => {
        const b = body as { id: string; retries: number; terminal: boolean };
        return { entityId: b.id, fields: { id: b.id, retries: b.retries, terminal: b.terminal } };
      },
      deletion: 'archive',
      environmentFingerprint: 'task-loopback-v1',
    });
    if (!validation.ok) throw new Error('expected adapter to validate');
    const normalized = validation.adapter.normalize({ id: 'run-1', retries: 3, terminal: false });
    expect(normalized).toEqual({
      entityId: 'run-1',
      fields: { id: 'run-1', retries: 3, terminal: false },
    });
  });

  it('rejects adapters missing data fields fail-closed', () => {
    const validation = validateTaskAuditAdapter({
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
    const validation = validateTaskAuditAdapter({
      resourceId: 'x',
      read: 'not-a-function',
      normalize: null,
      deletion: 'hard',
      environmentFingerprint: 'env-v1',
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.join(' ')).toContain('read');
    expect(validation.issues.join(' ')).toContain('normalize');
  });

  it('rejects an unknown deletion semantics value', () => {
    const validation = validateTaskAuditAdapter({
      resourceId: 'x',
      read: async () => null,
      normalize: () => ({ entityId: 'x', fields: {} }),
      deletion: 'soft',
      environmentFingerprint: 'env-v1',
    } as unknown);
    expect(validation.ok).toBe(false);
  });
});