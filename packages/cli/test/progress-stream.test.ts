/**
 * The CI progress stream (CI visibility plan, section 1): start/finish
 * lines with exact N/M counters, the alive ticker, the content
 * allowlist (a planted secret never reaches the stream, in any writer),
 * and the byte-identical guarantee with the stream off.
 *
 * The stream is built from WITNESS-SIDE facts only (counters, the test
 * title as declared in the catalog, the outcome) — never from runner
 * output — which is what makes it secret-free by construction.
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProgressStream, resolveProgressTarget } from '../src/progress.js';

/** Lines one stream wrote; every test reads this whole array. */
function collectingWriter(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

/** One stream over a fake clock and a fake timer (no real waiting). */
function stream(
  writer: { lines: string[]; write: (line: string) => void },
  overrides: {
    expected?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    scope?: 'full' | 'changed' | 'named';
  } = {},
): { progress: ProgressStream; tick: (ms: number) => void; elapsed: () => number } {
  let clock = 0;
  let timer: (() => void) | null = null;
  const progress = new ProgressStream({
    writer: { kind: 'stderr' },
    runner: 'playwright',
    scope: overrides.scope ?? 'full',
    expected: overrides.expected ?? 3,
    now: overrides.now ?? (() => clock),
    setTimer:
      overrides.setTimer ??
      ((fn: () => void) => {
        timer = fn;
        return 1;
      }),
    clearTimer:
      overrides.clearTimer ??
      (() => {
        timer = null;
      }),
    writeLine: writer.write,
  });
  return {
    progress,
    tick: (ms: number) => {
      clock += ms;
      timer?.();
    },
    elapsed: () => clock,
  };
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('progress target resolution', () => {
  it('is off locally and on stderr in CI when nothing is configured', () => {
    expect(resolveProgressTarget(undefined, undefined, {})).toBeNull();
    expect(resolveProgressTarget(undefined, undefined, { CI: 'true' })).toEqual({ kind: 'stderr' });
  });

  it('honours the flag over the config key over auto', () => {
    expect(resolveProgressTarget('off', undefined, { CI: 'true' })).toBeNull();
    expect(resolveProgressTarget(undefined, 'off', { CI: 'true' })).toBeNull();
    expect(resolveProgressTarget('stderr', 'off', {})).toEqual({ kind: 'stderr' });
    expect(resolveProgressTarget('file:.gateforge/progress.log', undefined, {})).toEqual({
      kind: 'file',
      path: '.gateforge/progress.log',
    });
  });

  it('rejects an unusable target instead of silently dropping the stream', () => {
    expect(() => resolveProgressTarget('stdout', undefined, {})).toThrow(/--progress/);
    expect(() => resolveProgressTarget('file:', undefined, {})).toThrow(/--progress/);
  });
});

describe('progress stream lines', () => {
  it('counts every finished test exactly once with N/M counters', () => {
    const writer = collectingWriter();
    const { progress } = stream(writer, { expected: 563 });
    progress.start();
    progress.beginTest('creates an account');
    progress.endTest({ logicalKey: 'a.spec.ts#creates an account', title: 'creates an account', outcome: 'passed' });
    progress.beginTest('lists accounts');
    progress.endTest({
      logicalKey: 'a.spec.ts#lists accounts',
      title: 'lists accounts',
      outcome: 'failed',
      message: 'Expected: 200\nReceived: 404',
    });
    progress.beginTest('deletes an account');
    progress.endTest({ logicalKey: 'a.spec.ts#deletes an account', title: 'deletes an account', outcome: 'skipped' });
    progress.finish();
    expect(writer.lines).toEqual([
      'gateforge: run started — 563 tests expected (runner playwright, scope full)',
      'gateforge: ✓ 1/563 creates an account',
      'gateforge: ✘ 2/563 lists accounts — Expected: 200',
      'gateforge: – 3/563 deletes an account (skipped)',
      'gateforge: run finished — 1 passed, 1 failed, 1 skipped in 0m00s; grading…',
    ]);
  });

  it('reports the scoped run it actually graded', () => {
    const writer = collectingWriter();
    const { progress } = stream(writer, { expected: 2, scope: 'changed' });
    progress.start();
    progress.finish();
    expect(writer.lines[0]).toBe('gateforge: run started — 2 tests expected (runner playwright, scope changed)');
  });

  it('prints nothing at all when the stream is off', () => {
    const writer = collectingWriter();
    const progress = new ProgressStream({
      writer: null,
      runner: 'playwright',
      scope: 'full',
      expected: 3,
      writeLine: writer.write,
    });
    progress.start();
    progress.beginTest('a');
    progress.endTest({ logicalKey: 'k#a', title: 'a', outcome: 'passed' });
    progress.finish();
    expect(writer.lines).toEqual([]);
  });
});

describe('progress stream alive ticker', () => {
  it('prints one alive line per quiet minute with the real counters', () => {
    const writer = collectingWriter();
    const { progress, tick } = stream(writer, { expected: 10 });
    progress.start();
    progress.beginTest('a');
    progress.beginTest('b');
    progress.endTest({ logicalKey: 'k#a', title: 'a', outcome: 'passed' });
    tick(60_000);
    expect(writer.lines[writer.lines.length - 1]).toBe(
      'gateforge: alive — 1/10 done, 1 running, 1m00s elapsed',
    );
    tick(90_000);
    expect(writer.lines[writer.lines.length - 1]).toBe(
      'gateforge: alive — 1/10 done, 1 running, 2m30s elapsed',
    );
    // An event resets the quiet clock: the next alive line only comes
    // after another full minute without one.
    progress.endTest({ logicalKey: 'k#b', title: 'b', outcome: 'passed' });
    tick(30_000);
    expect(writer.lines.filter((line) => line.includes('alive'))).toHaveLength(2);
  });

  it('stops the ticker when the run finishes', () => {
    const writer = collectingWriter();
    let armed: (() => void) | null = null;
    const cleared: unknown[] = [];
    const { progress, tick } = stream(writer, {
      setTimer: (fn: () => void) => {
        armed = fn;
        return 'timer';
      },
      clearTimer: (handle: unknown) => cleared.push(handle),
    });
    progress.start();
    expect(armed).not.toBeNull();
    progress.finish();
    expect(cleared).toEqual(['timer']);
    const before = writer.lines.length;
    tick(60_000);
    expect(writer.lines).toHaveLength(before);
  });
});

describe('progress stream content allowlist', () => {
  // The planted credential is BUILT at runtime from harmless fragments:
  // a secret-shaped string typed into a test file is itself a leak.
  const PLANTED = ['sk', '-', 'live-', '9f3a2b7c4d5e6f70a1b2c3d4e5f60718'].join('');

  it('never prints a planted secret from a test title or an error message', () => {
    const writer = collectingWriter();
    const { progress } = stream(writer, { expected: 1 });
    progress.start();
    progress.beginTest(`signs in with token ${PLANTED}`);
    progress.endTest({
      logicalKey: 'auth.spec.ts#signs in',
      title: `signs in with token ${PLANTED}`,
      outcome: 'failed',
      message: `Expected 401, received 200 for POST /login with {"password":"${PLANTED}"}`,
    });
    progress.finish();
    const streamText = writer.lines.join('\n');
    expect(streamText.includes(PLANTED)).toBe(false);
    expect(streamText).toContain('(message withheld: looks like a secret)');
    // The title is replaced by its own hash, never by a redaction that
    // could leak a prefix of the secret.
    const hash = createHash('sha256').update(`signs in with token ${PLANTED}`).digest('hex').slice(0, 12);
    expect(writer.lines[1]).toBe(
      `gateforge: ✘ 1/1 (secretsafe title ${hash}) — (message withheld: looks like a secret)`,
    );
  });

  it('truncates a long title at 200 characters', () => {
    const writer = collectingWriter();
    const { progress } = stream(writer, { expected: 1 });
    const title = 'x'.repeat(260);
    progress.start();
    progress.endTest({ logicalKey: 'k#long', title, outcome: 'passed' });
    const line = writer.lines[1] ?? '';
    expect(line).toBe(`gateforge: ✓ 1/1 ${'x'.repeat(200)}…`);
  });

  it('keeps a long failure message to its first 200 characters', () => {
    const writer = collectingWriter();
    const { progress } = stream(writer, { expected: 1 });
    progress.start();
    progress.endTest({
      logicalKey: 'k#a',
      title: 'a',
      outcome: 'failed',
      message: 'y'.repeat(400),
    });
    expect(writer.lines[1]).toBe(`gateforge: ✘ 1/1 a — ${'y'.repeat(200)}…`);
  });

  it('collects the guarded diagnosis of every failure for the artifact', () => {
    const writer = collectingWriter();
    const { progress } = stream(writer, { expected: 2 });
    progress.start();
    progress.endTest({
      logicalKey: 'k#a',
      title: 'a',
      outcome: 'failed',
      message: 'Expected: 3\nReceived: 4',
      stackFrames: ['specs/a.spec.ts:10', 'specs/a.spec.ts:10', 'specs/helper.ts:2', 'x:1', 'y:2', 'z:3'],
    });
    progress.endTest({ logicalKey: 'k#b', title: 'b', outcome: 'passed' });
    expect(progress.failures).toEqual([
      {
        logicalKey: 'k#a',
        title: 'a',
        // The artifact keeps the WHOLE message (the stream line shows
        // only its first line); the stack keeps file:line frames only.
        message: 'Expected: 3\nReceived: 4',
        stackFrames: ['specs/a.spec.ts:10', 'specs/helper.ts:2', 'x:1', 'y:2', 'z:3'],
      },
    ]);
  });

  it('keeps a planted secret out of the failure artifact too', () => {
    const writer = collectingWriter();
    const { progress } = stream(writer, { expected: 1 });
    progress.start();
    progress.endTest({
      logicalKey: 'k#a',
      title: 'a',
      outcome: 'failed',
      message: `Authorization: Bearer ${['ey', 'J', 'hbGciOi', 'JIUzI1NiJ9', '.', 'e30', '.', 'c2ln'].join('')}`,
      stackFrames: ['specs/a.spec.ts:10'],
    });
    const planted = ['ey', 'J', 'hbGciOi', 'JIUzI1NiJ9', '.', 'e30', '.', 'c2ln'].join('');
    expect(JSON.stringify(progress.failures).includes(planted)).toBe(false);
    expect(progress.failures[0]?.message).toBe('(message withheld: looks like a secret)');
  });
});

describe('progress stream file writer', () => {
  it('writes the same lines to the configured file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateforge-progress-'));
    directories.push(directory);
    const path = join(directory, 'progress.log');
    const progress = new ProgressStream({
      writer: { kind: 'file', path },
      runner: 'vitest',
      scope: 'full',
      expected: 1,
      writeLine: () => {
        throw new Error('stderr must not be used by a file target');
      },
    });
    progress.start();
    progress.endTest({ logicalKey: 'k#a', title: 'a', outcome: 'passed' });
    progress.finish();
    expect(readFileSync(path, 'utf8')).toBe(
      [
        'gateforge: run started — 1 tests expected (runner vitest, scope full)',
        'gateforge: ✓ 1/1 a',
        'gateforge: run finished — 1 passed, 0 failed, 0 skipped in 0m00s; grading…',
        '',
      ].join('\n'),
    );
  });

  it('warns once and stops writing when the stream cannot be written', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gateforge-progress-'));
    directories.push(directory);
    // A regular file stands where a directory would have to be: the
    // target can never be opened, which is the failure the stream must
    // survive without failing the run.
    const blocker = join(directory, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const warnings: string[] = [];
    const progress = new ProgressStream({
      writer: { kind: 'file', path: join(blocker, 'progress.log') },
      runner: 'playwright',
      scope: 'full',
      expected: 1,
      writeLine: () => {
        throw new Error('stderr must not be used by a file target');
      },
      warn: (line: string) => warnings.push(line),
    });
    progress.start();
    progress.endTest({ logicalKey: 'k#a', title: 'a', outcome: 'passed' });
    progress.finish();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/progress stream unavailable/);
  });
});
