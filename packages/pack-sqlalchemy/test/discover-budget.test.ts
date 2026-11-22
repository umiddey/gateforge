/**
 * Wiring test for the pack-sqlalchemy discover request budget. The
 * detector must hand its PluginSession a 600 s request budget, with the
 * handshake and shutdown budgets unchanged at 10 s. PluginSession keeps
 * its timeouts private, so the constructor options are captured by a
 * test-only FakeSession; no python process is spawned.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSqlalchemyDetector } from '../src/detector.js';

const captured = vi.hoisted(() => ({
  options: [] as Array<{ timeouts?: unknown }>,
}));

vi.mock('@gate-forge/plugin-protocol', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  class FakeSession {
    constructor(options: { timeouts?: unknown }) {
      captured.options.push(options);
    }
    async start(): Promise<void> {}
    async discover(): Promise<unknown> {
      return { resources: [], unresolved: [], findings: [], classificationSignals: [] };
    }
    async dispose(): Promise<void> {}
  }
  return { ...real, PluginSession: FakeSession };
});

describe('pack-sqlalchemy discover budget (wiring)', () => {
  it('gives the discover session a 600 s request budget and keeps 10 s handshake and shutdown', async () => {
    const detector = createSqlalchemyDetector({ planesConfig: { rules: [] }, tenancyScopeColumns: [] });
    await detector.discover(['.'], undefined);
    expect(captured.options).toHaveLength(1);
    expect(captured.options[0]?.timeouts).toEqual({
      handshakeMs: 10_000,
      requestMs: 600_000,
      shutdownMs: 10_000,
    });
  });
});
