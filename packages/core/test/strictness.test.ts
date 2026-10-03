/**
 * Strictness modes: the optional owner-owned
 * `mode` key, its default, and the pure gate-decision function.
 *
 * A config WITHOUT `mode` must behave exactly like `mode: strict` —
 * that equivalence is the frozen contract, so it is asserted first.
 */
import { describe, expect, it } from 'vitest';
import {
  decideStrictness,
  GateforgeConfigSchema,
  parseConfig,
  resolveStrictnessMode,
  strictnessSummaryLine,
  type GateforgeConfig,
} from '../src/index.js';

const baseConfig = {
  schemaVersion: 1,
  project: {
    languages: ['python'],
    paths: { include: ['backend/**/*.py'], exclude: [] },
  },
  plugins: [],
  policies: '.gateforge/policies.yml',
  classificationPolicy: '.gateforge/classification-policy.yml',
  adapters: '.gateforge/adapters',
  waivers: '.gateforge/waivers',
  baselines: '.gateforge/baselines/obligations.json',
  changed: { provider: 'auto' },
  witness: { maxDurationSeconds: 30 },
  clock: { mode: 'system' },
} as const;

describe('strictness mode configuration', () => {
  it('accepts the optional mode key', () => {
    for (const mode of ['strict', 'changed', 'warn'] as const) {
      const parsed = parseConfig({ ...baseConfig, mode }, { file: '.gateforge.yml' });
      expect(parsed['mode']).toBe(mode);
    }
  });

  it('leaves mode absent when the key is not declared', () => {
    const parsed = parseConfig({ ...baseConfig }, { file: '.gateforge.yml' });
    expect(parsed['mode']).toBeUndefined();
  });

  it('rejects an unknown mode', () => {
    const result = GateforgeConfigSchema.safeParse({ ...baseConfig, mode: 'lenient' });
    expect(result.success).toBe(false);
  });

  it('treats a missing mode as strict (today’s behavior)', () => {
    expect(resolveStrictnessMode(parseConfig({ ...baseConfig }, { file: '.gateforge.yml' }))).toBe('strict');
    expect(
      resolveStrictnessMode(parseConfig({ ...baseConfig, mode: 'strict' }, { file: '.gateforge.yml' })),
    ).toBe('strict');
  });
});

describe('strictness decision', () => {
  const strictBlocked = { strictExitCode: 1 as const, blockingTotal: 3 };

  it('keeps the strict decision in strict mode', () => {
    const decision = decideStrictness({ mode: 'strict', ...strictBlocked });
    expect(decision.exitCode).toBe(1);
    expect(decision.wouldBlock).toBe(true);
    expect(decision.blockingInScope).toBe(3);
  });

  it('never softens a config/usage error (exit 2 keeps its meaning)', () => {
    for (const mode of ['strict', 'changed', 'warn'] as const) {
      const decision = decideStrictness({
        mode,
        strictExitCode: 2,
        blockingTotal: 0,
        ...(mode === 'changed' ? { changed: { active: true, blockingInScope: 0 } } : {}),
      });
      expect(decision.exitCode).toBe(2);
    }
  });

  it('exits 0 in warn mode while reporting it would block', () => {
    const decision = decideStrictness({ mode: 'warn', ...strictBlocked });
    expect(decision.exitCode).toBe(0);
    expect(decision.wouldBlock).toBe(true);
    expect(decision.blockingTotal).toBe(3);
  });

  it('keeps a clean run clean in every mode', () => {
    for (const mode of ['strict', 'changed', 'warn'] as const) {
      const decision = decideStrictness({ mode, strictExitCode: 0, blockingTotal: 0 });
      expect(decision.exitCode).toBe(0);
      expect(decision.wouldBlock).toBe(false);
    }
  });

  it('blocks in changed mode only for debt the change touches', () => {
    const decision = decideStrictness({
      mode: 'changed',
      strictExitCode: 1,
      blockingTotal: 3,
      changed: { active: true, blockingInScope: 1 },
    });
    expect(decision.exitCode).toBe(1);
    expect(decision.blockingInScope).toBe(1);
  });

  it('passes a change that touches none of the debt', () => {
    const decision = decideStrictness({
      mode: 'changed',
      strictExitCode: 1,
      blockingTotal: 3,
      changed: { active: true, blockingInScope: 0 },
    });
    expect(decision.exitCode).toBe(0);
    expect(decision.wouldBlock).toBe(true);
  });

  it('fails closed in changed mode when no diff could be resolved', () => {
    const decision = decideStrictness({
      mode: 'changed',
      strictExitCode: 1,
      blockingTotal: 3,
      changed: { active: false, blockingInScope: 3 },
    });
    expect(decision.exitCode).toBe(1);
  });
});

describe('strictness reporting', () => {
  it('names the active mode and what it would have blocked', () => {
    const decision = decideStrictness({ mode: 'warn', strictExitCode: 1, blockingTotal: 3 });
    expect(strictnessSummaryLine(decision)).toBe('mode: warn (would block: 3)');
  });

  it('says plain strict when nothing is blocked', () => {
    const decision = decideStrictness({ mode: 'strict', strictExitCode: 0, blockingTotal: 0 });
    expect(strictnessSummaryLine(decision)).toBe('mode: strict');
  });

  it('is additively serializable onto a report document', () => {
    const decision = decideStrictness({ mode: 'changed', strictExitCode: 1, blockingTotal: 3, changed: { active: true, blockingInScope: 0 } });
    expect({
      mode: decision.mode,
      wouldBlock: decision.wouldBlock,
      blockingInScope: decision.blockingInScope,
    }).toEqual({ mode: 'changed', wouldBlock: true, blockingInScope: 0 });
  });
});

describe('config type surface', () => {
  it('exposes the optional mode on the inferred config type', () => {
    const config = parseConfig({ ...baseConfig, mode: 'warn' }, { file: '.gateforge.yml' }) as GateforgeConfig;
    expect(config.mode).toBe('warn');
  });
});
