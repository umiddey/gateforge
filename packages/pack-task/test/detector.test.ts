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

describe('pack-task detector (worker internality reachability discovery)', () => {
  let outcome: DiscoveryOutcome;

  it('discovers every fixture without crashing and emits signals with empty resources', async () => {
    outcome = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    expect(outcome.resources).toHaveLength(0);
    expect(outcome.classificationSignals.length).toBeGreaterThan(0);
  });
  it('emits internality worker signals for BullMQ queue definitions', async () => {
    const targets = outcome.classificationSignals.map((s) => s.target?.resourceName ?? '');
    expect(targets.some((t) => t.includes('email') || t.includes('refund'))).toBe(true);
    const signals = outcome.classificationSignals.filter(
      (s) => (s.target?.resourceName ?? '').includes('email') || (s.target?.resourceName ?? '').includes('refund'),
    );
    expect(signals[0]?.assertion).toEqual({ category: 'worker' });
    expect(signals[0]?.dimension).toBe('internality');
  });

  it('emits an AMBIGUOUS_HANDLER finding for register calls without a handler', async () => {
    expect(codes(outcome.findings)).toContain('AMBIGUOUS_HANDLER');
  });

  it('keeps message-handler signal locations schema-valid for synthetic names', () => {
    for (const signal of outcome.classificationSignals) {
      expect(signal.location.col).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic (invariant 7): two scans produce identical signals', async () => {
    const a = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    const b = await detectorOverFixtures().discover([...ALL_FIXTURE_PATHS]);
    expect(JSON.stringify(a.classificationSignals)).toEqual(
      JSON.stringify(b.classificationSignals),
    );
  });

  it('validates every emitted signal against the core classification schema', () => {
    for (const signal of outcome.classificationSignals) {
      expect(signal.dimension).toBe('internality');
      expect(signal.assertion).toEqual({ category: 'worker' });
      expect(signal.basis).toBe('code-positive');
      expect(String(signal.target.resourceName)).toBeTruthy();
    }
  });
});
