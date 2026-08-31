import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RedProbeFailure,
  RedProbeSuiteError,
  cleanupProbeSuite,
  formatProbeRecords,
  runRedProbe,
  runRedProbes,
  spawnVitest,
  writeProbeRecords,
  writeProbeSuite,
  type RedProbe,
} from '../src/index.js';

/** Guard that actually checks behavior (passes on correct impl). */
function realGuard(value: number): void {
  expect(value).toBe(2);
}

/** Guard that asserts nothing — the fake-green culprit. */
function fakeGreenGuard(_value: number): void {
  // deliberately checks nothing
}

describe('runRedProbe', () => {
  it('honest probe: green passes, deliberately-broken guard fails', async () => {
    const record = await runRedProbe({
      name: 'real guard',
      green: () => realGuard(1 + 1),
      broken: () => realGuard(1 + 2), // broken impl: 3 ≠ 2 → guard fails
    });
    expect(record).toMatchObject({ name: 'real guard', greenPassed: true, brokenFailed: true, ok: true });
  });

  it('a guard failing on correct behavior is classified as a broken guard', async () => {
    const record = await runRedProbe({
      name: 'broken guard',
      green: () => realGuard(1 + 2), // guard fails on CORRECT behavior
      broken: () => realGuard(1 + 2),
    });
    expect(record.ok).toBe(false);
    expect(record.failure).toContain('guard FAILS on correct behavior');
  });

  it('catches a faked-green test: a guard asserting nothing passes the broken run', async () => {
    const record = await runRedProbe({
      name: 'fake green',
      green: () => fakeGreenGuard(1 + 1),
      broken: () => fakeGreenGuard(1 + 2), // broken impl, but the guard sees nothing
    });
    expect(record.ok).toBe(false);
    expect(record.failure).toContain('FAKE GREEN');
    expect(record.greenPassed).toBe(true);
    expect(record.brokenFailed).toBe(false);
  });
});

describe('runRedProbes', () => {
  const honest: RedProbe = {
    name: 'honest',
    green: () => realGuard(1 + 1),
    broken: () => realGuard(1 + 2),
  };
  const dishonest: RedProbe = {
    name: 'dishonest',
    green: () => fakeGreenGuard(1 + 1),
    broken: () => fakeGreenGuard(1 + 2),
  };

  it('collects records when every probe is honest', async () => {
    const records = await runRedProbes([honest, honest]);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.ok)).toBe(true);
  });

  it('throws RedProbeSuiteError naming dishonest probes', async () => {
    const error = await runRedProbes([honest, dishonest]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RedProbeSuiteError);
    const suiteError = error as RedProbeSuiteError;
    expect(suiteError.records).toHaveLength(2);
    expect(suiteError.message).toContain('dishonest');
    expect(suiteError.message).toContain('FAKE GREEN');
  });

  it('throwOnFailure: false returns records without throwing', async () => {
    const records = await runRedProbes([dishonest], { throwOnFailure: false });
    expect(records[0]).toMatchObject({ name: 'dishonest', ok: false });
  });
});

describe('probe records', () => {
  it('formatProbeRecords renders the classification table', () => {
    const table = formatProbeRecords([
      { name: 'a', greenPassed: true, brokenFailed: true, ok: true },
      { name: 'b', greenPassed: true, brokenFailed: false, ok: false, failure: 'FAKE GREEN: x' },
    ]);
    expect(table).toContain('| probe | green passed | broken failed | verdict |');
    expect(table).toContain('| a | yes | yes | ok |');
    expect(table).toContain('| b | yes | NO | FAKE GREEN / BROKEN GUARD |');
  });

  it('writeProbeRecords writes a run record to an explicit path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-red-probe-'));
    try {
      const path = join(dir, 'nested', 'red-probe-record.md');
      writeProbeRecords(path, [
        { name: 'a', greenPassed: true, brokenFailed: true, ok: true },
      ]);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf8');
      expect(content).toContain('# Red-probe run record');
      expect(content).toContain('| a | yes | yes | ok |');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('suite-level double run (CI-proof mode)', () => {
  /**
   * Builds a probe suite body: an implementation line plus a vitest test.
   * The suite runs twice — normal sources, then deliberately-broken
   * sources — and the broken run must exit non-zero.
   */
  function probeFile(implementation: string, assertion: string): string {
    return [
      "import { test, expect } from 'vitest';",
      implementation,
      `test('add returns the sum', () => { ${assertion} });`,
      '',
    ].join('\n');
  }

  const CONFIG = "export default { test: { include: ['suite.test.mjs'] } };\n";

  it('normal run passes; deliberately-broken run FAILS; fake-green run is exposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateforge-probe-suite-'));
    try {
      writeProbeSuite(dir, {
        'vitest.config.mjs': CONFIG,
        'suite.test.mjs': probeFile('const add = (a, b) => a + b;', 'expect(add(1, 1)).toBe(2);'),
      });
      const normal = spawnVitest(['--config', 'vitest.config.mjs'], { cwd: dir, timeoutMs: 120_000 });
      expect(normal.exitCode).toBe(0);

      // Deliberately broken sources: the same suite MUST fail.
      writeProbeSuite(dir, {
        'suite.test.mjs': probeFile('const add = (a, b) => a - b;', 'expect(add(1, 1)).toBe(2);'),
      });
      const broken = spawnVitest(['--config', 'vitest.config.mjs'], { cwd: dir, timeoutMs: 120_000 });
      expect(broken.exitCode).not.toBe(0);

      // Run 3: the same broken sources with a FAKE-GREEN guard (asserts
      // nothing) — the suite passes, which is exactly the fake green the
      // probe classification must expose.
      writeProbeSuite(dir, {
        'suite.test.mjs': probeFile('const add = (a, b) => a - b;', 'add(1, 1);'),
      });
      const fakeGreen = spawnVitest(['--config', 'vitest.config.mjs'], { cwd: dir, timeoutMs: 120_000 });
      expect(fakeGreen.exitCode).toBe(0);

      // Probe 1 — the real guard, run twice: passes on correct sources,
      // fails on broken ones. ok: true proves the suite catches the bug.
      const catchesRegression = await runRedProbe({
        name: 'suite guard catches regressions',
        green: () => expect(normal.exitCode).toBe(0),
        broken: () => expect(broken.exitCode).toBe(0),
      });
      expect(catchesRegression.ok).toBe(true);

      // Probe 2 — the fake-green guard, run twice: passes on correct
      // sources AND on broken ones. ok: false, classified FAKE GREEN.
      const catchesFakeGreen = await runRedProbe({
        name: 'suite guard is honest',
        green: () => expect(normal.exitCode).toBe(0),
        broken: () => expect(fakeGreen.exitCode).toBe(0),
      });
      expect(catchesFakeGreen.ok).toBe(false);
      expect(catchesFakeGreen.failure).toContain('FAKE GREEN');
    } finally {
      cleanupProbeSuite(dir);
      expect(existsSync(dir)).toBe(false);
    }
  }, 300_000);
});

describe('RedProbeFailure', () => {
  it('carries the failing record', async () => {
    const record = await runRedProbe({ name: 'x', green: () => {
      throw new Error('nope');
    }, broken: () => {
      throw new Error('nope');
    } });
    expect(() => {
      throw new RedProbeFailure(record);
    }).toThrow(/not honest|guard FAILS/);
  });
});
