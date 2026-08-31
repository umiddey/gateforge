/**
 * Adapter-schema suite: validate passing + failing adapters against
 * the frozen Zod schema and the function-field checks.
 */
import { describe, expect, it } from 'vitest';
import passing from './fixtures/passing_adapter.js';
import failing from './fixtures/failing_adapter.js';
import {
  auditLogContainsTransition,
  projectAuditRow,
  validateWorkflowAdapter,
} from '../src/index.js';

describe('validateWorkflowAdapter()', () => {
  it('accepts a complete adapter module', () => {
    const result = validateWorkflowAdapter(passing);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.adapter.resourceId).toBe('workflow.contract.contracts.draft');
      expect(result.adapter.deletion).toBe('archive');
    }
  });

  it('rejects an adapter missing readAuditLog with a single-cause diagnostic', () => {
    const result = validateWorkflowAdapter(failing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.startsWith('readAuditLog:'))).toBe(true);
    }
  });

  it('rejects an adapter with non-function fields', () => {
    const result = validateWorkflowAdapter({
      resourceId: 'x',
      deletion: 'archive',
      environmentFingerprint: 'fp',
      readEntity: 'not a function',
      readAuditLog: async () => ({}),
      attemptTransition: async () => ({ accepted: true }),
      allowedTransition: async () => ({ accepted: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.startsWith('readEntity:'))).toBe(true);
    }
  });

  it('rejects an adapter missing the resourceId field via zod', () => {
    const result = validateWorkflowAdapter({
      deletion: 'archive',
      environmentFingerprint: 'fp',
      readEntity: async () => ({}),
      readAuditLog: async () => ({}),
      attemptTransition: async () => ({ accepted: true }),
      allowedTransition: async () => ({ accepted: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.startsWith('resourceId:'))).toBe(true);
    }
  });

  it('rejects deletion values outside the enum', () => {
    const result = validateWorkflowAdapter({
      resourceId: 'x',
      deletion: 'soft', // invalid
      environmentFingerprint: 'fp',
      readEntity: async () => ({}),
      readAuditLog: async () => ({}),
      attemptTransition: async () => ({ accepted: true }),
      allowedTransition: async () => ({ accepted: true }),
    });
    expect(result.ok).toBe(false);
  });
});

describe('projectAuditRow()', () => {
  it('returns the row shape for canonical bodies', () => {
    const row = projectAuditRow({ actor: 'u1', from: 'draft', to: 'pending', at: '2026-08-31T00:00:00.000Z' });
    expect(row).toEqual({
      actor: 'u1',
      from: 'draft',
      to: 'pending',
      at: '2026-08-31T00:00:00.000Z',
    });
  });

  it('returns null for non-canonical bodies', () => {
    expect(projectAuditRow(null)).toBeNull();
    expect(projectAuditRow({})).toBeNull();
    expect(projectAuditRow({ actor: 'u1' })).toBeNull();
    expect(projectAuditRow('raw')).toBeNull();
  });
});

describe('auditLogContainsTransition()', () => {
  it('finds a matching transition in the log', () => {
    const rows = [
      { actor: 'u1', from: 'draft', to: 'pending', at: '2026-08-31T00:00:00.000Z' },
      { actor: 'u1', from: 'pending', to: 'signed', at: '2026-08-31T00:01:00.000Z' },
    ];
    expect(auditLogContainsTransition(rows, { actor: 'u1', from: 'draft', to: 'pending' })).toBe(true);
  });

  it('does not match a missing transition', () => {
    const rows = [{ actor: 'u1', from: 'pending', to: 'signed', at: '2026-08-31T00:00:00.000Z' }];
    expect(auditLogContainsTransition(rows, { actor: 'u1', from: 'draft', to: 'pending' })).toBe(false);
  });

  it('returns false for an empty log', () => {
    expect(auditLogContainsTransition([], { actor: 'u1', from: 'draft', to: 'pending' })).toBe(false);
  });
});