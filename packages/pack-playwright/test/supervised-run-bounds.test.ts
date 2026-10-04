/**
 * F4 — the whole-run bound is an OPERATOR bound, the stall bound is a
 * safety net (0.10.2).
 *
 * `DEFAULT_RUN_TIMEOUT_MS = 30 min` was a whole-run cap nobody declared:
 * it killed a real 1101-test suite that needs 2+ hours. The default is
 * now NO whole-run cap — one applies only from `runtime.yml
 * executionTimeoutSeconds` or `--run-timeout-min` — and the safety net
 * that remains is a STALL bound: no test FINISHED for N minutes
 * (default 15) kills the run and fails it closed, naming the last
 * finished test and the progress count.
 *
 * The stall watchdog rides the per-test completion signal the
 * `--progress` stream already consumes (`SupervisedRunOptions.activity`,
 * installed by this module before the spawn) — there is no second
 * signal.
 *
 * The tests use FAKE timers: 40 simulated minutes cost no wall-clock.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STALL_TIMEOUT_MS,
  executeSupervisedPlaywright,
  type RunActivity,
  type RunnerOutcomesDocument,
} from '../src/discovery/supervised-run.js';

const DIRECTORIES: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of DIRECTORIES.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp repo root with a playwright config (consumer wiring present). */
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-bounds-project-'));
  DIRECTORIES.push(dir);
  writeFileSync(join(dir, 'playwright.config.ts'), 'export default { projects: [] };\n');
  return dir;
}

/** A run-state dir. */
function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-bounds-state-'));
  DIRECTORIES.push(dir);
  return dir;
}

/** A stub runner: writes outcomes, then exits with `code` after `delayMs`. */
function stubRunner(
  stateDir: string,
  document: RunnerOutcomesDocument | null,
  code: number,
  delayMs = 0,
): readonly string[] {
  const outcomesPath = join(stateDir, 'runner-outcomes.json');
  const script = `
    const fs = require('node:fs');
    ${document === null ? '' : `fs.writeFileSync(${JSON.stringify(outcomesPath)}, ${JSON.stringify(JSON.stringify(document))});`}
    setTimeout(() => process.exit(${String(code)}), ${String(delayMs)});
  `;
  return [process.execPath, '-e', script];
}

const PASSING_ROW = {
  testId: 's1',
  file: 'e2e/a.spec.ts',
  titlePath: ['deletes'],
  project: 'chromium' as string | null,
  status: 'passed',
  attempt: 1,
  expectedFailure: false,
};

const PASSING_DOC: RunnerOutcomesDocument = {
  schemaVersion: 1,
  runStatus: 'passed',
  runnerErrors: [],
  shard: null,
  outcomes: [PASSING_ROW],
};

const FIFTEEN_MIN = 15 * 60_000;
const FIVE_MIN = 5 * 60_000;

describe('F4 the whole-run cap is an operator bound, never a default', () => {
  it('a run making steady progress past 30 simulated minutes is NOT killed', async () => {
    // The red case: `DEFAULT_RUN_TIMEOUT_MS` fired at minute 30 and
    // killed a suite that was demonstrably still working.
    vi.useFakeTimers();
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const activity: RunActivity = {};
    const titles: string[] = [];
    // This is the drain feeding the run the SAME per-test completion
    // event the `--progress` stream already receives — one signal, two
    // consumers.
    const noteFinished = (title: string): void => {
      titles.push(title);
      activity.onTestFinished?.(title);
    };
    const run = executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      {
        command: stubRunner(stateDir, PASSING_DOC, 0, 250),
        cwd,
        activity,
        stallTimeoutMs: FIFTEEN_MIN,
      },
    );
    for (let minute = 0; minute < 8; minute += 1) {
      await vi.advanceTimersByTimeAsync(FIVE_MIN);
      noteFinished(`suite > spec > test ${String(minute)}`);
    }
    const envelope = await run;
    expect(titles).toHaveLength(8);
    expect(envelope.incompleteDetail ?? '').not.toMatch(/stalled/);
    expect(envelope.complete).toBe(true);
    expect(envelope.processExit).toBe(0);
  });

  it('a run that stops finishing tests is killed after the stall bound, naming the last finished test', async () => {
    vi.useFakeTimers();
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const activity: RunActivity = {};
    const run = executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      {
        command: stubRunner(stateDir, PASSING_DOC, 0, 60_000),
        cwd,
        activity,
        stallTimeoutMs: FIFTEEN_MIN,
      },
    );
    // One test finishes; then the suite goes quiet forever.
    await vi.advanceTimersByTimeAsync(1_000);
    activity.onTestFinished?.('suite > spec > login works');
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN + 1_000);
    const envelope = await run;
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toBe(
      'stalled: no test finished for 15 min (last finished: suite > spec > login works, 1/1)',
    );
  });

  it('a stall before ANY test finished names the honest zero-progress state', async () => {
    vi.useFakeTimers();
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const activity: RunActivity = {};
    const run = executeSupervisedPlaywright(
      { logicalKeys: ['k', 'k2'] },
      { stateDir, runId: 'run', vars: {} },
      { command: stubRunner(stateDir, PASSING_DOC, 0, 60_000), cwd, activity },
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_STALL_TIMEOUT_MS + 1_000);
    const envelope = await run;
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toBe(
      `stalled: no test finished for 15 min (last finished: none, 0/${String(2)})`,
    );
  });

  it('an explicit whole-run cap still wins over the stall bound', async () => {
    vi.useFakeTimers();
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const run = executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      {
        command: stubRunner(stateDir, PASSING_DOC, 0, 60_000),
        cwd,
        timeoutMs: 250,
        stallTimeoutMs: FIFTEEN_MIN,
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const envelope = await run;
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toMatch(/exceeded its 250ms bound/i);
    expect(envelope.incompleteDetail).not.toMatch(/stalled/);
  });

  it('an owner-declared stall bound is honoured verbatim (the runtime document wins)', async () => {
    vi.useFakeTimers();
    const cwd = tempProject();
    const stateDir = tempStateDir();
    const activity: RunActivity = {};
    const run = executeSupervisedPlaywright(
      { logicalKeys: ['k'] },
      { stateDir, runId: 'run', vars: {} },
      { command: stubRunner(stateDir, PASSING_DOC, 0, 60_000), cwd, activity, stallTimeoutMs: 60_000 },
    );
    await vi.advanceTimersByTimeAsync(61_000);
    const envelope = await run;
    expect(envelope.incompleteDetail).toMatch(/stalled: no test finished for 1 min \(last finished: none, 0\/1\)/);
  });
});