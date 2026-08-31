/**
 * Baseline tests (GF-07/08, pin #3, invariant 4): strict-subset update
 * semantics, fail-closed loading, and the disk writer round-trip.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BaselineSchema,
  GateforgeBaselineError,
  canUpdate,
  loadBaseline,
  serializeBaseline,
  sha256Canonical,
  updateBaseline,
  writeBaseline,
  type Baseline,
} from '../src/index.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-baselines-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fp(name: string): string {
  return sha256Canonical({ fingerprint: name });
}

/** Builds a validated baseline from fingerprint names. */
function baseline(...names: string[]): Baseline {
  return BaselineSchema.parse({
    schemaVersion: 1,
    fingerprints: names.map(fp).sort(),
  });
}

describe('canUpdate — strict-subset semantics (invariant 4)', () => {
  it('GF-07: {A, B} → {A, NEW} FAILS (count-preserving debt laundering)', () => {
    const current = baseline('A', 'B');
    const next = baseline('A', 'NEW');
    expect(canUpdate(current, next)).toBe(false);
    expect(() => updateBaseline(current, next.fingerprints)).toThrow(GateforgeBaselineError);
  });

  it('GF-07: the rejection names the laundered-in fingerprint', () => {
    const current = baseline('A', 'B');
    const next = baseline('A', 'NEW');
    try {
      updateBaseline(current, next.fingerprints);
      expect.unreachable('updateBaseline must throw');
    } catch (error) {
      expect((error as GateforgeBaselineError).message).toContain(fp('NEW'));
      expect((error as GateforgeBaselineError).message).toContain('strict subset');
    }
  });

  it('GF-08: {A, B} → {A} PASSES (pure shrink)', () => {
    const current = baseline('A', 'B');
    const next = baseline('A');
    expect(canUpdate(current, next)).toBe(true);
    const updated = updateBaseline(current, next.fingerprints);
    expect(updated.fingerprints).toEqual([fp('A')]);
  });

  it('rejects an identical replacement (nothing was resolved)', () => {
    const current = baseline('A', 'B');
    expect(canUpdate(current, baseline('A', 'B'))).toBe(false);
  });

  it('rejects growth', () => {
    expect(canUpdate(baseline('A'), baseline('A', 'B'))).toBe(false);
  });

  it('allows shrinking to empty (all debt resolved)', () => {
    expect(canUpdate(baseline('A', 'B'), baseline())).toBe(true);
    expect(updateBaseline(baseline('A', 'B'), []).fingerprints).toEqual([]);
  });

  it('rejects duplicate fingerprints in the update input', () => {
    expect(() => updateBaseline(baseline('A', 'B'), [fp('A'), fp('A')])).toThrow(
      /duplicate fingerprints/,
    );
  });
});

describe('loadBaseline — fail-closed loading (pin #3)', () => {
  it('round-trips a written baseline', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'obligations.json');
    writeBaseline(path, baseline('A', 'B'));
    expect(path).toContain('nested');
    const loaded = loadBaseline(path);
    expect(loaded.fingerprints).toEqual([fp('A'), fp('B')]);
  });

  it('serializes as sorted 2-space JSON with a trailing newline', () => {
    const text = serializeBaseline(baseline('B', 'A'));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toBe(`${JSON.stringify({ schemaVersion: 1, fingerprints: [fp('A'), fp('B')] }, null, 2)}\n`);
  });

  it('throws on a missing file', () => {
    expect(() => loadBaseline(join(tmpdir(), 'gateforge-nope', 'obligations.json'))).toThrow(
      GateforgeBaselineError,
    );
  });

  it('throws on unparsable JSON', () => {
    const dir = tempDir();
    const path = join(dir, 'obligations.json');
    writeFileSync(path, '{nope', 'utf8');
    expect(() => loadBaseline(path)).toThrow(GateforgeBaselineError);
  });

  it('throws on unsorted fingerprints (schema invariant)', () => {
    const dir = tempDir();
    const path = join(dir, 'obligations.json');
    const document = { schemaVersion: 1, fingerprints: [fp('B'), fp('A')] };
    writeFileSync(path, JSON.stringify(document), 'utf8');
    expect(() => loadBaseline(path)).toThrow(/sorted/);
  });

  it('throws on duplicate fingerprints (schema invariant)', () => {
    const dir = tempDir();
    const path = join(dir, 'obligations.json');
    const document = { schemaVersion: 1, fingerprints: [fp('A'), fp('A')] };
    writeFileSync(path, JSON.stringify(document), 'utf8');
    expect(() => loadBaseline(path)).toThrow(/duplicate/);
  });

  it('throws on an unsupported schemaVersion (never migrates)', () => {
    const dir = tempDir();
    const path = join(dir, 'obligations.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, fingerprints: [] }), 'utf8');
    expect(() => loadBaseline(path)).toThrow(GateforgeBaselineError);
  });

  it('keeps written bytes stable across identical rewrites (determinism)', () => {
    const dir = tempDir();
    const path = join(dir, 'obligations.json');
    writeBaseline(path, baseline('A', 'B'));
    const first = readFileSync(path, 'utf8');
    writeBaseline(path, baseline('B', 'A'));
    expect(readFileSync(path, 'utf8')).toBe(first);
  });
});
