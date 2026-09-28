/**
 * Flaky-test quarantine (plan 20260925_2013 Phase 2): the loader's
 * fail-closed rules, the expiry partition against the INJECTED clock,
 * and the mapping projection that makes a quarantined test prove
 * nothing.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GateforgeQuarantineError,
  loadQuarantines,
  QUARANTINE_MAX_DURATION_MS,
  QuarantineSchema,
  serializeQuarantine,
  withoutQuarantinedBindings,
  type ResolvedMappings,
} from '../src/index.js';

const NOW = '2026-03-01T00:00:00.000Z';
const KEY = 'e2e/accounts.spec.js#Accounts>creates an account';

/** A schema-valid quarantine document with overridable fields. */
function quarantine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    testKey: KEY,
    owner: 'team-accounts',
    approver: 'lead@example.invalid',
    reason: 'flaky in CI: seeded clock race, tracked in issue 42',
    expiresAt: '2026-03-05T00:00:00.000Z',
    ...overrides,
  };
}

/** Writes quarantine documents into a fresh temp directory. */
function quarantineDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-quarantine-'));
  for (const [name, document] of Object.entries(files)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), serializeQuarantine(QuarantineSchema.parse(document) as never));
  }
  return dir;
}

describe('quarantine schema', () => {
  it('accepts a fully attributed quarantine', () => {
    expect(QuarantineSchema.safeParse(quarantine()).success).toBe(true);
  });

  it('rejects every missing attribution field', () => {
    for (const field of ['testKey', 'owner', 'approver', 'reason', 'expiresAt']) {
      const document = quarantine();
      delete document[field];
      expect(QuarantineSchema.safeParse(document).success, field).toBe(false);
    }
  });

  it('rejects unknown fields', () => {
    expect(QuarantineSchema.safeParse(quarantine({ force: true })).success).toBe(false);
  });
});

describe('quarantine loader', () => {
  it('returns an empty population for a directory that does not exist', () => {
    const result = loadQuarantines(join(tmpdir(), 'gateforge-quarantine-absent'), { now: NOW });
    expect(result).toEqual({ active: [], expired: [] });
  });

  it('partitions by the injected clock, never the wall clock', () => {
    const dir = quarantineDir({
      'a-live.yml': quarantine({ testKey: 'spec.js#A>live', expiresAt: '2026-03-05T00:00:00.000Z' }),
      'b-expired.yml': quarantine({ testKey: 'spec.js#B>expired', expiresAt: '2026-02-27T00:00:00.000Z' }),
    });
    const result = loadQuarantines(dir, { now: NOW });
    expect(result.active.map((entry) => entry.quarantine.testKey)).toEqual(['spec.js#A>live']);
    expect(result.expired.map((entry) => entry.quarantine.testKey)).toEqual(['spec.js#B>expired']);
  });

  it('fails closed on a duplicate test key', () => {
    const dir = quarantineDir({
      'a.yml': quarantine({ testKey: KEY }),
      'b.yml': quarantine({ testKey: KEY }),
    });
    expect(() => loadQuarantines(dir, { now: NOW })).toThrow(GateforgeQuarantineError);
  });

  it('fails closed on a duration beyond the 14-day ceiling', () => {
    const tooLong = new Date(Date.parse(NOW) + QUARANTINE_MAX_DURATION_MS + 86_400_000).toISOString();
    const dir = quarantineDir({ 'a.yml': quarantine({ expiresAt: tooLong }) });
    expect(() => loadQuarantines(dir, { now: NOW })).toThrow(/maximum quarantine duration/);
  });

  it('accepts exactly the ceiling', () => {
    const atCeiling = new Date(Date.parse(NOW) + QUARANTINE_MAX_DURATION_MS).toISOString();
    const dir = quarantineDir({ 'a.yml': quarantine({ expiresAt: atCeiling }) });
    expect(loadQuarantines(dir, { now: NOW }).active).toHaveLength(1);
  });

  it('fails closed on unparsable YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-quarantine-'));
    writeFileSync(join(dir, 'broken.yml'), 'testKey: [unclosed\n');
    expect(() => loadQuarantines(dir, { now: NOW })).toThrow(GateforgeQuarantineError);
  });
});

describe('quarantine and the mapping surface', () => {
  const resolution: ResolvedMappings = {
    obligations: [
      {
        obligationId: 'tenant.accounts:persistence:read',
        bindings: [
          {
            logicalKey: KEY,
            instances: [],
            origin: 'native',
            sourceDigest: null,
            declaredKind: null,
            categories: [],
            reason: null,
            sourceLocation: null,
          },
        ],
      },
      {
        obligationId: 'tenant.orders:persistence:read',
        bindings: [
          {
            logicalKey: 'e2e/orders.spec.js#Orders>lists orders',
            instances: [],
            origin: 'native',
            sourceDigest: null,
            declaredKind: null,
            categories: [],
            reason: null,
            sourceLocation: null,
          },
        ],
      },
    ],
    problems: [],
  };

  it('drops the quarantined test binding and keeps the rest', () => {
    const filtered = withoutQuarantinedBindings(resolution, new Set([KEY]));
    expect(filtered.obligations[0]?.bindings).toEqual([]);
    expect(filtered.obligations[1]?.bindings).toHaveLength(1);
    expect(filtered.problems).toEqual(resolution.problems);
  });

  it('returns the same document when nothing is quarantined', () => {
    expect(withoutQuarantinedBindings(resolution, new Set())).toBe(resolution);
  });
});
