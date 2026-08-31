/**
 * Waiver-loader tests (GF-15/16/17): fail-closed five-field validation,
 * expiry via the injected clock, and the stale-owner hook.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GateforgeWaiverError,
  loadWaivers,
  sha256Canonical,
  type Waiver,
} from '../src/index.js';

/** Injected clock: the only time source (invariant 7, GF-16). */
const NOW = '2026-08-30T12:00:00.000Z';
const FUTURE = '2026-09-30T00:00:00.000Z';

const dirs: string[] = [];

/** Creates a fresh waivers dir that is removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-waivers-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fully valid waiver document for `scopeKey`. */
function waiverDocument(scopeKey = 'tenant.accounts', overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    owner: 'team-accounts',
    justificationUrl: 'https://issues.example.com/T-123',
    approver: 'alice',
    scope: {
      kind: 'exact',
      resourceId: scopeKey,
      fingerprint: sha256Canonical({ obligation: scopeKey }),
    },
    expiresAt: FUTURE,
    ...overrides,
  };
}

function write(dir: string, name: string, document: unknown): void {
  writeFileSync(
    join(dir, name),
    typeof document === 'string' ? document : JSON.stringify(document, null, 2),
    'utf8',
  );
}

describe('loadWaivers — valid loads', () => {
  it('loads all valid waiver files, sorted by owner then expiry', () => {
    const dir = tempDir();
    write(dir, 'b.json', waiverDocument('tenant.orders', { owner: 'zeta-team' }));
    write(dir, 'a.json', waiverDocument('tenant.accounts', { owner: 'alpha-team' }));
    const result = loadWaivers(dir, { now: NOW });
    expect(result.waivers.map((waiver) => waiver.owner)).toEqual(['alpha-team', 'zeta-team']);
    expect(result.staleOwner).toEqual([]);
    expect(result.expired).toEqual([]);
  });

  it('returns an empty result for a missing directory (no waivers yet)', () => {
    const result = loadWaivers(join(tmpdir(), 'gateforge-waivers-does-not-exist'), { now: NOW });
    expect(result).toEqual({ waivers: [], staleOwner: [], expired: [] });
  });

  it('ignores non-JSON files in the directory', () => {
    const dir = tempDir();
    write(dir, 'README.md', '# not a waiver');
    const result = loadWaivers(dir, { now: NOW });
    expect(result.waivers).toEqual([]);
  });
});

describe('loadWaivers — GF-15 fail-closed five-field validation', () => {
  it('rejects a waiver missing each of the five mandatory fields', () => {
    for (const missing of ['owner', 'justificationUrl', 'approver', 'scope', 'expiresAt']) {
      const dir = tempDir();
      const partial: Record<string, unknown> = waiverDocument();
      delete partial[missing];
      write(dir, 'waiver.json', partial);
      expect(() => loadWaivers(dir, { now: NOW })).toThrow(GateforgeWaiverError);
      try {
        loadWaivers(dir, { now: NOW });
      } catch (error) {
        expect(error).toBeInstanceOf(GateforgeWaiverError);
        expect((error as GateforgeWaiverError).message).toContain('waiver.json');
        expect((error as GateforgeWaiverError).problems[0]?.detail).toContain(missing);
      }
    }
  });

  it('rejects unparsable JSON fail-closed', () => {
    const dir = tempDir();
    write(dir, 'broken.json', '{ not json');
    expect(() => loadWaivers(dir, { now: NOW })).toThrow(GateforgeWaiverError);
  });

  it('rejects unsupported schemaVersion (never migrates)', () => {
    const dir = tempDir();
    write(dir, 'waiver.json', waiverDocument('tenant.accounts', { schemaVersion: 2 }));
    expect(() => loadWaivers(dir, { now: NOW })).toThrow(GateforgeWaiverError);
  });

  it('reports every problem across every file in one fail-closed error', () => {
    const dir = tempDir();
    write(dir, 'a.json', waiverDocument('tenant.accounts', { owner: '' }));
    write(dir, 'b.json', waiverDocument('tenant.orders', { approver: undefined }));
    try {
      loadWaivers(dir, { now: NOW });
      expect.unreachable('loadWaivers must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GateforgeWaiverError);
      expect((error as GateforgeWaiverError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('rejects two waivers claiming the same exact scope', () => {
    const dir = tempDir();
    write(dir, 'a.json', waiverDocument('tenant.accounts'));
    write(
      dir,
      'b.json',
      waiverDocument('tenant.accounts', { owner: 'other-team', justificationUrl: 'https://issues.example.com/T-999' }),
    );
    expect(() => loadWaivers(dir, { now: NOW })).toThrow(/duplicate exact scope/);
  });
});

describe('loadWaivers — GF-16 expiry via the injected clock', () => {
  it('partitions expired waivers from active ones', () => {
    const dir = tempDir();
    write(dir, 'active.json', waiverDocument('tenant.accounts'));
    write(dir, 'lapsed.json', waiverDocument('tenant.orders', { expiresAt: '2026-08-01T00:00:00.000Z' }));
    const result = loadWaivers(dir, { now: NOW });
    expect(result.waivers.map((waiver) => waiver.scope.resourceId)).toEqual(['tenant.accounts']);
    expect(result.expired.map((waiver) => waiver.scope.resourceId)).toEqual(['tenant.orders']);
  });

  it('accepts the injected clock as a Date as well as an ISO string', () => {
    const dir = tempDir();
    write(dir, 'lapsed.json', waiverDocument('tenant.orders', { expiresAt: '2026-08-01T00:00:00.000Z' }));
    const fromString = loadWaivers(dir, { now: NOW });
    const fromDate = loadWaivers(dir, { now: new Date(NOW) });
    expect(fromDate.expired).toHaveLength(fromString.expired.length);
  });

  it('treats a waiver at exactly `now` as expired', () => {
    const dir = tempDir();
    write(dir, 'boundary.json', waiverDocument('tenant.accounts', { expiresAt: NOW }));
    const result = loadWaivers(dir, { now: NOW });
    expect(result.expired).toHaveLength(1);
    expect(result.waivers).toEqual([]);
  });

  it('rejects waivers exceeding the optional maximum duration (config constant)', () => {
    const dir = tempDir();
    write(dir, 'long.json', waiverDocument('tenant.accounts', { expiresAt: '2027-08-30T00:00:00.000Z' }));
    const halfYearMs = 180 * 86_400_000;
    expect(() => loadWaivers(dir, { now: NOW, maxDurationMs: halfYearMs })).toThrow(
      /maximum waiver duration/,
    );
    const result = loadWaivers(dir, { now: NOW });
    expect(result.waivers).toHaveLength(1);
  });
});

describe('loadWaivers — GF-17 stale-owner hook', () => {
  it('flags waivers whose owner fails the injected owner check', () => {
    const dir = tempDir();
    write(dir, 'gone.json', waiverDocument('tenant.accounts', { owner: 'dissolved-team' }));
    write(dir, 'here.json', waiverDocument('tenant.orders', { owner: 'alive-team' }));
    const result = loadWaivers(dir, {
      now: NOW,
      ownerExists: (waiver: Waiver) => waiver.owner !== 'dissolved-team',
    });
    expect(result.waivers.map((waiver) => waiver.owner)).toEqual(['alive-team']);
    expect(result.staleOwner).toHaveLength(1);
    const stale = result.staleOwner[0];
    expect(stale?.owner).toBe('dissolved-team');
    expect(stale?.ownerStale).toBe(true);
  });

  it('performs no owner checking by default (hook optional)', () => {
    const dir = tempDir();
    write(dir, 'waiver.json', waiverDocument('tenant.accounts', { owner: 'who-knows' }));
    const result = loadWaivers(dir, { now: NOW });
    expect(result.waivers).toHaveLength(1);
    expect(result.staleOwner).toEqual([]);
  });
});
