/**
 * Adoption tests (phase 8 workstream C): the ONE sanctioned bulk-add.
 * `adoptBaseline` escapes the strict-subset invariant exactly once — for
 * `gateforge adopt` — while `updateBaseline` keeps its shrink-only
 * semantics (GF-07/08) against the adopted baseline. Also covers the
 * blocking-entry fingerprint (baseline identity for non-obligation red)
 * and the adoption-record persistence (loud receipt, fail-closed load).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdoptionRecordSchema,
  GateforgeBaselineError,
  adoptBaseline,
  adoptClassificationBlocked,
  adoptFamily,
  blockingEntryFingerprint,
  canUpdate,
  loadAdoptionRecord,
  loadBaseline,
  sha256Canonical,
  shrinkClassificationBlocked,
  shrinkFamilyForgiven,
  updateBaseline,
  writeAdoptionRecord,
  writeBaseline,
  type AdoptionFamily,
  type AdoptionRecord,
  type Baseline,
  type BlockingEntry,
} from '../src/index.js';


const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-adoption-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fp(name: string): string {
  return sha256Canonical({ fingerprint: name });
}

/** A validated baseline from fingerprint names. */
function baseline(...names: string[]): Baseline {
  return { schemaVersion: 1, fingerprints: names.map(fp).sort() };
}

/** One representative detector-finding blocking entry. */
function findingEntry(detail: string): BlockingEntry {
  return {
    kind: 'finding',
    resourceId: null,
    name: null,
    detail,
    location: { file: 'src/accounts.py', line: 3, col: 0 },
  };
}

describe('adoptBaseline — the one sanctioned bulk-add (phase 8 C)', () => {
  it('seeds a baseline from the red set without any subset check', () => {
    const seeded = adoptBaseline([fp('missing-a'), fp('missing-b'), fp('finding-x')]);
    expect(seeded.fingerprints).toEqual([fp('finding-x'), fp('missing-a'), fp('missing-b')].sort());
  });

  it('collapses duplicates and sorts (input order irrelevant)', () => {
    const seeded = adoptBaseline([fp('b'), fp('a'), fp('b')]);
    expect(seeded.fingerprints).toEqual([fp('a'), fp('b')]);
  });

  it('round-trips through the disk writer and loader', () => {
    const dir = tempDir();
    const path = join(dir, 'baselines', 'obligations.json');
    writeBaseline(path, adoptBaseline([fp('a'), fp('b')]));
    expect(loadBaseline(path).fingerprints).toEqual([fp('a'), fp('b')]);
  });

  it('GF-07 holds POST-adoption: updateBaseline still rejects additions', () => {
    const adopted = adoptBaseline([fp('debt-a'), fp('debt-b')]);
    // The laundering attempt: swap resolved debt for NEW unresolved debt.
    expect(() => updateBaseline(adopted, [fp('debt-a'), fp('new-debt')])).toThrow(
      GateforgeBaselineError,
    );
    expect(canUpdate(adopted, baseline('debt-a', 'new-debt'))).toBe(false);
  });

  it('GF-08 holds POST-adoption: shrinking to a strict subset passes', () => {
    const adopted = adoptBaseline([fp('debt-a'), fp('debt-b')]);
    const shrunk = updateBaseline(adopted, [fp('debt-a')]);
    expect(shrunk.fingerprints).toEqual([fp('debt-a')]);
  });

  it('the sanctioned escape does NOT reopen growth through updateBaseline', () => {
    const adopted = adoptBaseline([fp('debt-a')]);
    // Even a pure growth (no swap) is rejected post-adoption.
    expect(canUpdate(adopted, baseline('debt-a', 'debt-a2'))).toBe(false);
  });
});

describe('blockingEntryFingerprint — baseline identity for non-obligation red', () => {
  it('is deterministic 64-char hex, stable across process runs', () => {
    const first = blockingEntryFingerprint(findingEntry('PARSE_ERROR at src/accounts.py'));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(blockingEntryFingerprint(findingEntry('PARSE_ERROR at src/accounts.py'))).toBe(first);
  });

  it('changes when the underlying cause changes (fail closed, never re-forgiven)', () => {
    const base = blockingEntryFingerprint(findingEntry('PARSE_ERROR at src/accounts.py'));
    expect(blockingEntryFingerprint(findingEntry('PARSE_ERROR at src/accounts.py: moved'))).not.toBe(base);
    const shifted = { ...findingEntry('PARSE_ERROR at src/accounts.py'), location: { file: 'src/accounts.py', line: 4, col: 0 } };
    expect(blockingEntryFingerprint(shifted)).not.toBe(base);
    const reidentified = { ...findingEntry('PARSE_ERROR at src/accounts.py'), resourceId: 'tenant.accounts' };
    expect(blockingEntryFingerprint(reidentified)).not.toBe(base);
  });

  it('differs from an obligation fingerprint over the same resource', () => {
    // Distinct namespaces: an entry hash never collides with pin-#2
    // obligation hashes (different canonical input shape).
    const entryHash = blockingEntryFingerprint(findingEntry('d'));
    expect(entryHash).not.toBe(sha256Canonical({ resourceId: 'tenant.accounts' }));
  });
});

describe('adoption record — the loud receipt (fail-closed load)', () => {
  const record = AdoptionRecordSchema.parse({
    schemaVersion: 1,
    adoptedAt: '2026-09-11T00:00:00.000Z',
    gitSha: 'a'.repeat(40),
    adopted: 12,
    proven: 3,
  });

  it('round-trips through the writer and loader', () => {
    const dir = tempDir();
    const path = join(dir, 'baselines', 'adoption.json');
    writeAdoptionRecord(path, record);
    expect(loadAdoptionRecord(path)).toEqual(record);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('loads as null when absent (pre-adoption repo — backward compatible)', () => {
    expect(loadAdoptionRecord(join(tmpdir(), 'gateforge-nope', 'adoption.json'))).toBeNull();
  });

  it('throws on unparsable JSON (never silently unsanctioned)', () => {
    const dir = tempDir();
    const path = join(dir, 'adoption.json');
    writeFileSync(path, '{nope', 'utf8');
    expect(() => loadAdoptionRecord(path)).toThrow(GateforgeBaselineError);
  });

  it('throws on schema violations (unknown fields, bad instant, bad sha)', () => {
    const dir = tempDir();
    const bad = (document: unknown): string => {
      const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, JSON.stringify(document), 'utf8');
      return path;
    };
    expect(() => loadAdoptionRecord(bad({ ...record, extra: true }))).toThrow(GateforgeBaselineError);
    expect(() => loadAdoptionRecord(bad({ ...record, adoptedAt: 'yesterday' }))).toThrow(
      GateforgeBaselineError,
    );
    expect(() => loadAdoptionRecord(bad({ ...record, gitSha: 'nope' }))).toThrow(
      GateforgeBaselineError,
    );
    expect(() => loadAdoptionRecord(bad({ ...record, schemaVersion: 2 }))).toThrow(
      GateforgeBaselineError,
    );
  });

  it('accepts a null gitSha (repo without commits)', () => {
    const parsed = AdoptionRecordSchema.parse({ ...record, gitSha: null });
    expect(parsed.gitSha).toBeNull();
  });
});

describe('adoption record classificationBlocked — the two-layer receipt', () => {
  const base: AdoptionRecord = AdoptionRecordSchema.parse({
    schemaVersion: 1,
    adoptedAt: '2026-09-11T00:00:00.000Z',
    gitSha: null,
    adopted: 3,
    proven: 0,
  });

  it('accepts a receipt WITH the classification layer (sorted, unique ids)', () => {
    const parsed = AdoptionRecordSchema.parse({ ...base, classificationBlocked: ['raw.legacy', 'raw.planeless'] });
    expect(parsed.classificationBlocked).toEqual(['raw.legacy', 'raw.planeless']);
  });

  it('accepts a receipt WITHOUT the field (pre-layer engine — backward compatible)', () => {
    expect(base.classificationBlocked).toBeUndefined();
    // And it round-trips: a legacy receipt still loads.
    const dir = tempDir();
    const path = join(dir, 'adoption.json');
    writeAdoptionRecord(path, base);
    expect(loadAdoptionRecord(path)).toEqual(base);
  });

  it('rejects unsorted, duplicate, and empty ids (fail closed on shape)', () => {
    const attempt = (ids: string[]): string => {
      const dir = tempDir();
      const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, JSON.stringify({ ...base, classificationBlocked: ids }), 'utf8');
      try {
        loadAdoptionRecord(path);
        return 'loaded';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    expect(attempt(['raw.b', 'raw.a'])).toContain('must be sorted');
    expect(attempt(['raw.a', 'raw.a'])).toContain("duplicate classification-blocked resource id 'raw.a'");
    expect(attempt([''])).toContain('classificationBlocked.0');
  });
});

describe('adoptClassificationBlocked — the classification bulk-capture', () => {
  it('sorts and collapses duplicates (input order irrelevant)', () => {
    expect(adoptClassificationBlocked(['raw.b', 'raw.a', 'raw.b'])).toEqual(['raw.a', 'raw.b']);
  });

  it('returns an empty list for an adoption with no classification blocks', () => {
    expect(adoptClassificationBlocked([])).toEqual([]);
  });

  it('rejects schema-invalid ids (fail closed)', () => {
    expect(() => adoptClassificationBlocked([''])).toThrow(GateforgeBaselineError);
  });
});

describe('shrinkClassificationBlocked — the classification set is shrink-only', () => {
  const adopted: AdoptionRecord = AdoptionRecordSchema.parse({
    schemaVersion: 1,
    adoptedAt: '2026-09-11T00:00:00.000Z',
    gitSha: null,
    adopted: 3,
    proven: 0,
    classificationBlocked: ['raw.a', 'raw.b', 'raw.c'],
  });

  it('GF-08 mirrored: shrinking to a strict subset passes and stays sorted', () => {
    const shrunk = shrinkClassificationBlocked(adopted, ['raw.c', 'raw.a']);
    expect(shrunk.classificationBlocked).toEqual(['raw.a', 'raw.c']);
    // Nothing else on the receipt moves: the adoption event is history.
    expect(shrunk.adoptedAt).toBe(adopted.adoptedAt);
    expect(shrunk.adopted).toBe(adopted.adopted);
  });

  it('shrinking to empty is allowed (every resource gained a real classification)', () => {
    const empty = shrinkClassificationBlocked(adopted, []);
    expect(empty.classificationBlocked).toEqual([]);
  });

  it('GF-07 mirrored: re-listing the full set (no removal) is rejected', () => {
    expect(() => shrinkClassificationBlocked(adopted, ['raw.a', 'raw.b', 'raw.c'])).toThrow(
      GateforgeBaselineError,
    );
  });

  it('adding an id NOT in the adopted set is rejected (laundering fails closed)', () => {
    expect(() => shrinkClassificationBlocked(adopted, ['raw.a', 'raw.new'])).toThrow(
      GateforgeBaselineError,
    );
  });

  it('rejects duplicate input ids', () => {
    expect(() => shrinkClassificationBlocked(adopted, ['raw.a', 'raw.a'])).toThrow(
      GateforgeBaselineError,
    );
  });

  it('a receipt WITHOUT the layer has an empty effective set — nothing can be kept', () => {
    expect(() => shrinkClassificationBlocked({ ...adopted, classificationBlocked: undefined }, ['raw.a'])).toThrow(
      GateforgeBaselineError,
    );
  });
});

/** A validated pre-family receipt the family tests revise. */
const RECEIPT: AdoptionRecord = AdoptionRecordSchema.parse({
  schemaVersion: 1,
  adoptedAt: '2026-09-11T00:00:00.000Z',
  gitSha: null,
  adopted: 12,
  proven: 3,
});

describe('writeAdoptionRecord — the atomic receipt write', () => {
  it('an invalid record is refused BEFORE the filesystem is touched (old receipt intact, no temp left)', () => {
    const dir = tempDir();
    const path = join(dir, 'adoption.json');
    writeAdoptionRecord(path, RECEIPT);
    const before = readFileSync(path, 'utf8');
    expect(() =>
      writeAdoptionRecord(path, { ...RECEIPT, adoptedAt: 'not-an-instant' } as AdoptionRecord),
    ).toThrow(GateforgeBaselineError);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((name) => name.startsWith('adoption.json.tmp-'))).toEqual([]);
  });

  it('a valid rewrite replaces the receipt in place (round-trip)', () => {
    const dir = tempDir();
    const path = join(dir, 'adoption.json');
    writeAdoptionRecord(path, RECEIPT);
    const next = AdoptionRecordSchema.parse({ ...RECEIPT, adopted: 13 });
    writeAdoptionRecord(path, next);
    expect(loadAdoptionRecord(path)).toEqual(next);
    expect(readdirSync(dir).filter((name) => name.startsWith('adoption.json.tmp-'))).toEqual([]);
  });
});

describe('adoptFamily — the permanent family marker (0.13)', () => {
  const recorded = { 'a.page-1:page:loads': fp('page-1-loads'), 'a.page-1:page:data-ok': fp('page-1-data') };

  it('builds a sorted, validated marker (input order irrelevant)', () => {
    const family = adoptFamily({
      adoptedAt: '2026-09-11T00:00:00.000Z',
      gitSha: null,
      fingerprintsById: { 'a.page-1:page:data-ok': fp('page-1-data'), 'a.page-1:page:loads': fp('page-1-loads') },
      forgiven: [fp('page-1-data')],
    });
    expect(family).toEqual({
      schemaVersion: 1,
      adoptedAt: '2026-09-11T00:00:00.000Z',
      gitSha: null,
      fingerprintsById: recorded,
      forgiven: [fp('page-1-data')],
    });
    expect(Object.keys(family.fingerprintsById)).toEqual([
      'a.page-1:page:data-ok',
      'a.page-1:page:loads',
    ]); // sorted keys, deterministic bytes
  });

  it('collapses duplicate forgiven fingerprints and sorts them', () => {
    const family = adoptFamily({
      adoptedAt: '2026-09-11T00:00:00.000Z',
      gitSha: null,
      fingerprintsById: recorded,
      forgiven: [fp('page-1-loads'), fp('page-1-data'), fp('page-1-loads')],
    });
    expect(family.forgiven).toEqual([fp('page-1-data'), fp('page-1-loads')].sort());
  });

  it('accepts an empty family (zero pages) and an empty forgiven set', () => {
    const family = adoptFamily({
      adoptedAt: '2026-09-11T00:00:00.000Z',
      gitSha: null,
      fingerprintsById: {},
      forgiven: [],
    });
    expect(family.fingerprintsById).toEqual({});
    expect(family.forgiven).toEqual([]);
  });

  it('rejects a forgiven fingerprint that is not one of the recorded ones', () => {
    expect(() =>
      adoptFamily({
        adoptedAt: '2026-09-11T00:00:00.000Z',
        gitSha: null,
        fingerprintsById: recorded,
        forgiven: [fp('never-recorded')],
      }),
    ).toThrow(GateforgeBaselineError);
  });

  it('round-trips inside a receipt through the writer and loader', () => {
    const dir = tempDir();
    const path = join(dir, 'adoption.json');
    const family = adoptFamily({
      adoptedAt: '2026-09-11T00:00:00.000Z',
      gitSha: null,
      fingerprintsById: recorded,
      forgiven: [fp('page-1-data')],
    });
    writeAdoptionRecord(path, { ...RECEIPT, families: { pages: family } });
    expect(loadAdoptionRecord(path)?.families?.pages).toEqual(family);
  });

  it('a receipt WITHOUT families loads unchanged (backward compatible)', () => {
    const dir = tempDir();
    const path = join(dir, 'adoption.json');
    writeAdoptionRecord(path, RECEIPT);
    expect(loadAdoptionRecord(path)).toEqual(RECEIPT);
    expect(loadAdoptionRecord(path)?.families).toBeUndefined();
  });

  it('rejects unsorted fingerprintsById keys and a malformed fingerprint (fail closed on shape)', () => {
    const dir = tempDir();
    const bad = (document: unknown): string => {
      const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, JSON.stringify(document), 'utf8');
      return path;
    };
    expect(() =>
      loadAdoptionRecord(
        bad({
          ...RECEIPT,
          families: {
            pages: {
              schemaVersion: 1,
              adoptedAt: '2026-09-11T00:00:00.000Z',
              gitSha: null,
              fingerprintsById: { 'b:x': fp('x'), 'a:y': fp('y') },
              forgiven: [],
            },
          },
        }),
      ),
    ).toThrow(GateforgeBaselineError);
    expect(() =>
      loadAdoptionRecord(
        bad({
          ...RECEIPT,
          families: {
            pages: {
              schemaVersion: 1,
              adoptedAt: '2026-09-11T00:00:00.000Z',
              gitSha: null,
              fingerprintsById: { 'a:x': 'nothex' },
              forgiven: [],
            },
          },
        }),
      ),
    ).toThrow(GateforgeBaselineError);
  });
});

describe('shrinkFamilyForgiven — the family set is shrink-only, the marker retained', () => {
  const family = (): AdoptionFamily =>
    adoptFamily({
      adoptedAt: '2026-09-11T00:00:00.000Z',
      gitSha: null,
      fingerprintsById: {
        'a.page-1:page:data-ok': fp('page-1-data'),
        'a.page-1:page:loads': fp('page-1-loads'),
      },
      forgiven: [fp('page-1-data'), fp('page-1-loads')],
    });
  const adoptedRecord = (): AdoptionRecord => ({ ...RECEIPT, families: { pages: family() } });

  it('GF-08 mirrored: shrinking to a strict subset passes and stays sorted', () => {
    const next = shrinkFamilyForgiven(adoptedRecord(), 'pages', [fp('page-1-loads')]);
    expect(next.families?.pages?.forgiven).toEqual([fp('page-1-loads')]);
  });

  it('shrinking to empty keeps the marker (adoptedAt, gitSha, recorded ids)', () => {
    const next = shrinkFamilyForgiven(adoptedRecord(), 'pages', []);
    expect(next.families?.pages?.forgiven).toEqual([]);
    expect(next.families?.pages?.adoptedAt).toBe('2026-09-11T00:00:00.000Z');
    expect(Object.keys(next.families?.pages?.fingerprintsById ?? {}).length).toBe(2);
  });

  it('GF-07 mirrored: re-listing the full set (no removal) is rejected', () => {
    expect(() => shrinkFamilyForgiven(adoptedRecord(), 'pages', [fp('page-1-data'), fp('page-1-loads')])).toThrow(
      GateforgeBaselineError,
    );
  });

  it('a fingerprint the family never forgave is rejected (laundering fails closed)', () => {
    expect(() => shrinkFamilyForgiven(adoptedRecord(), 'pages', [fp('unknown')])).toThrow(
      GateforgeBaselineError,
    );
  });

  it('rejects duplicate input fingerprints', () => {
    expect(() => shrinkFamilyForgiven(adoptedRecord(), 'pages', [fp('page-1-loads'), fp('page-1-loads')])).toThrow(
      GateforgeBaselineError,
    );
  });

  it('a receipt WITHOUT the family marker has nothing to shrink', () => {
    expect(() => shrinkFamilyForgiven(RECEIPT, 'pages', [])).toThrow(GateforgeBaselineError);
  });
});
