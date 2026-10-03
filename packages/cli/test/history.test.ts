import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneRunHistory, queryRunHistory, recordRunHistory } from '../src/history.js';

const roots: string[] = [];

/** Creates and tracks one temporary history root.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   string: isolated history root.
 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gf-history-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('supervised run history', () => {
  it('prunes records exactly at the retention boundary using a fake clock', () => {
    const stateDir = tempRoot();
    const now = Date.parse('2026-09-28T12:00:00.000Z');
    const oldDate = new Date(now - 14 * 86_400_000 - 1).toISOString();
    const newDate = new Date(now).toISOString();
    recordRunHistory(stateDir, 14, {
      runId: 'old-run', finishedAt: oldDate, status: 'passed', testCount: 0, failedCount: 0,
    }, [], now - 13 * 86_400_000);
    pruneRunHistory(join(stateDir, 'history'), 14, now);
    expect(queryRunHistory(join(stateDir, 'history'))).toEqual([]);
    expect(readFileSync(join(stateDir, 'history/index.jsonl'), 'utf8')).toBe('');
    recordRunHistory(stateDir, 14, {
      runId: 'new-run', finishedAt: newDate, status: 'failed', testCount: 1, failedCount: 1,
    }, [{ logicalKey: 'tests/a.spec.ts::case', status: 'failed' }], now);
    expect(queryRunHistory(join(stateDir, 'history'), { failed: true, test: 'case' })).toMatchObject([
      { runId: 'new-run', failedCount: 1 },
    ]);
  });

  it('appends test history only when the status changes and keeps disabled mode inert', () => {
    const stateDir = tempRoot();
    const base = { finishedAt: '2026-09-28T12:00:00.000Z', testCount: 1 };
    recordRunHistory(stateDir, 14, { ...base, runId: 'r1', status: 'passed', failedCount: 0 }, [
      { logicalKey: 'tests/a.spec.ts::case', status: 'passed' },
    ]);
    recordRunHistory(stateDir, 14, { ...base, runId: 'r2', status: 'passed', failedCount: 0 }, [
      { logicalKey: 'tests/a.spec.ts::case', status: 'passed' },
    ]);
    recordRunHistory(stateDir, 14, { ...base, runId: 'r3', status: 'failed', failedCount: 1 }, [
      { logicalKey: 'tests/a.spec.ts::case', status: 'failed' },
    ]);
    expect(readFileSync(join(stateDir, 'history/tests.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    recordRunHistory(stateDir, 'off', { ...base, runId: 'off', status: 'passed', failedCount: 0 }, []);
    expect(queryRunHistory(join(stateDir, 'history'), { since: '2026-09-28T00:00:00.000Z' })).toHaveLength(3);
  });
});
