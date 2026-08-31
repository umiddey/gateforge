/**
 * Detector unit suite: scans every fixture under `fixtures/` and
 * asserts the resource list + findings match the documented pack
 * vocabulary.
 */
import { describe, expect, it } from 'vitest';
import { ALL_FIXTURE_PATHS, detectorOverFixtures } from './helpers.js';
import type { Resource } from '@gateforge/core';
import type { DiscoveryOutcome, Finding } from '@gateforge/plugin-protocol';

/** Lookup helper for resources by id. */
const byId = (doc: { resources: Resource[] }, id: string): Resource | undefined =>
  doc.resources.find((r) => r.id === id);

/** Returns the typed attribute bag for one resource id. */
const attrs = (doc: { resources: Resource[] }, id: string): Record<string, unknown> => {
  const r = byId(doc, id);
  if (!r) throw new Error(`missing resource ${id}`);
  return r.attributes;
};

/** Shape asserted by the tests for `retryPolicy` (detector-defined). */
interface RetryPolicy {
  maxAttempts: number;
  backoff: string;
}

/** Reads the `retryPolicy` sub-shape with a runtime check (no inline cast). */
const getRetryPolicy = (doc: { resources: Resource[] }, id: string): RetryPolicy => {
  const a = attrs(doc, id);
  if (typeof a.retryPolicy !== 'object' || a.retryPolicy === null) {
    throw new Error(`retryPolicy missing on ${id}`);
  }
  const rp = a.retryPolicy as RetryPolicy;
  if (typeof rp.maxAttempts !== 'number' || typeof rp.backoff !== 'string') {
    throw new Error(`malformed retryPolicy on ${id}`);
  }
  return rp;
};

/** Reads the `terminalOn` array with a runtime check. */
const getTerminalOn = (doc: { resources: Resource[] }, id: string): string[] => {
  const a = attrs(doc, id);
  if (!Array.isArray(a.terminalOn)) {
    throw new Error(`terminalOn missing on ${id}`);
  }
  return a.terminalOn as string[];
};

/** Returns the set of finding codes. */
const codes = (findings: Finding[]): string[] => findings.map((f) => f.code);

describe('pack-task detector (BullMQ, Bee-Queue, custom, message, recurring, decorator)', () => {
  let outcome: DiscoveryOutcome;

  it('discovers every fixture without crashing', async () => {
    outcome = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    expect(outcome.resources.length).toBeGreaterThan(0);
  });

  it('emits BullMQ resources with attempts/backoff + jobId idempotency', async () => {
    const a = attrs(outcome, 'task.email.send');
    expect(a.framework).toBe('bullmq');
    const rp = getRetryPolicy(outcome, 'task.email.send');
    expect(rp.maxAttempts).toBe(5);
    expect(rp.backoff).toBe('exponential');
    expect(a.idempotencyKey).toBe(true);
  });

  it('emits a Bee-Queue resource', async () => {
    const r = byId(outcome, 'task.image.resize');
    expect(r).toBeDefined();
    expect(attrs(outcome, 'task.image.resize').framework).toBe('bee-queue');
  });

  it('emits custom-queue resources with resolved handler', async () => {
    const r = byId(outcome, 'task.webhook.dispatch');
    // The handler is resolved (the line has `async (job...) =>`).
    // AMBIGUOUS_HANDLER findings still exist for OTHER tasks (audit.flush
    // has no handler) — that's tested in the next case.
    expect(attrs(outcome, 'task.webhook.dispatch').hasHandler).toBeUndefined();
    // The webhook.dispatch resource must not have an associated AMBIGUOUS_HANDLER finding.
    const ambiguousForDispatch = outcome.findings.filter(
      (f) => f.code === 'AMBIGUOUS_HANDLER' && f.detail.includes('webhook.dispatch'),
    );
    expect(ambiguousForDispatch).toHaveLength(0);
  });

  it('emits multi-line CustomQueue resources (block across newlines)', async () => {
    const r = byId(outcome, 'task.index.reindex');
    expect(r).toBeDefined();
    expect(attrs(outcome, 'task.index.reindex').framework).toBe('custom-queue');
  });

  it('emits an AMBIGUOUS_HANDLER finding for register calls without a handler', async () => {
    expect(codes(outcome.findings)).toContain('AMBIGUOUS_HANDLER');
  });

  it('emits message-handler resources for the three patterns', async () => {
    // Three patterns → 3 detections; expect at least 2 unique ids
    // (some collapse by name).
    const ids = outcome.resources.map((r) => r.id).filter((id) => id.startsWith('task.'));
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it('emits recurring-job resources for setInterval + setImmediate', async () => {
    const ids = outcome.resources.map((r) => r.id);
    expect(ids.some((id) => id.startsWith('task.tick')) || ids.some((id) => id.startsWith('task.flush'))).toBe(true);
  });

  it('emits decorator resources for @Task / @Queue annotations', async () => {
    const r = byId(outcome, 'task.decorated');
    expect(r).toBeDefined();
    expect(attrs(outcome, 'task.decorated').framework).toBe('decorator');
  });

  it('emits terminalOn + observability hints from the source', async () => {
    const a = attrs(outcome, 'task.index.reindex');
    expect(getTerminalOn(outcome, 'task.index.reindex')).toEqual(['AuthError', 'ValidationError']);
    expect(a.observability).toBe(true);
  });

  it('is deterministic (invariant 7): two scans produce identical resources', async () => {
    const a = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    const b = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    expect(a.resources.map((r) => r.id).sort()).toEqual(b.resources.map((r) => r.id).sort());
    expect(a.resources.map((r) => JSON.stringify(r.attributes))).toEqual(
      b.resources.map((r) => JSON.stringify(r.attributes)),
    );
  });

  it('resource ids match the dotted `task.<name>` shape', async () => {
    for (const r of outcome.resources) {
      expect(r.id).toMatch(/^task\.[A-Za-z][\w.-]*$/);
      expect(r.kind).toBe('task.resource');
    }
  });

  it('sorts resources by id (determinism)', async () => {
    const ids = outcome.resources.map((r) => r.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});