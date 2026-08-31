/**
 * Obligation contract tests: the pack's `TASK_OBLIGATION_CONTRACTS`
 * vocabulary + the `obligationsFor(resourceId)` builder. Mirrors
 * the auth pack's contract-enumeration tests.
 */
import { describe, expect, it } from 'vitest';
import {
  TASK_OBLIGATION_CONTRACTS,
  TASK_OBLIGATION_DESCRIPTIONS,
  obligationsFor,
} from '../src/index.js';

describe('pack-task obligation contract vocabulary', () => {
  it('exposes exactly the five pinned contracts', () => {
    expect(TASK_OBLIGATION_CONTRACTS).toEqual([
      'task:retry-policy-enforced',
      'task:idempotent',
      'task:terminal-handled',
      'task:observability-recorded',
      'task:duplicate-delivery-handled',
    ]);
  });

  it('every contract has a human-readable description', () => {
    for (const contract of TASK_OBLIGATION_CONTRACTS) {
      expect(typeof TASK_OBLIGATION_DESCRIPTIONS[contract]).toBe('string');
      expect(TASK_OBLIGATION_DESCRIPTIONS[contract].length).toBeGreaterThan(0);
    }
  });

  it('obligationsFor builds five obligation ids for one resource', () => {
    const ids = obligationsFor('task.email.send');
    expect(ids).toEqual([
      'task.email.send:task:retry-policy-enforced',
      'task.email.send:task:idempotent',
      'task.email.send:task:terminal-handled',
      'task.email.send:task:observability-recorded',
      'task.email.send:task:duplicate-delivery-handled',
    ]);
  });

  it('obligationsFor is total (no exceptions for arbitrary ids)', () => {
    expect(() => obligationsFor('x')).not.toThrow();
    expect(obligationsFor('x')).toHaveLength(5);
  });
});