import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GateforgeReporter } from '../src/reporter/reporter.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('timeout timing report', () => {
  it('splits timed-out test wall time into app and witness durations', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gf-reporter-timing-'));
    roots.push(stateDir);
    const diagnosticsDir = join(stateDir, 'diagnostics');
    mkdirSync(diagnosticsDir, { recursive: true });
    writeFileSync(
      join(diagnosticsDir, 'adapter-timing.jsonl'),
      `${JSON.stringify({ runId: 'run-1', testId: 'test-1', durationMs: 1_200 })}\n`,
      'utf8',
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reporter = new GateforgeReporter({ stateDir, runId: 'run-1' });
    reporter.onTestEnd(
      { id: 'test-1', title: 'slow test', location: { file: join(process.cwd(), 'tests', 'slow.spec.ts'), line: 1, column: 1 } },
      { status: 'timedOut', duration: 3_000 },
    );
    expect(warning).toHaveBeenCalledWith(
      '[gateforge] timeout split for test-1: app/runner 1800ms, witness adapter 1200ms',
    );
    const recordedTest = JSON.parse(readFileSync(join(diagnosticsDir, 'test-timing.jsonl'), 'utf8').trim()) as {
      status: string;
      testId: string;
    };
    expect(recordedTest).toMatchObject({ status: 'timedOut', testId: 'test-1' });
  });
});
