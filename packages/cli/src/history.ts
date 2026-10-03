import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HistoryRun {
  runId: string;
  finishedAt: string;
  status: string;
  testCount: number;
  failedCount: number;
}

export interface HistoryTestStatus {
  runId: string;
  logicalKey: string;
  status: string;
  finishedAt: string;
}

/** Prunes expired JSONL records and per-run history artifacts using a supplied clock.
 *
 * Args:
 *   historyDir: history directory under the ignored run-state root.
 *   retentionDays: number of days to retain, or 'off' to disable pruning/storage.
 *   nowMs: injected current time for deterministic pruning.
 *
 * Returns:
 *   void: expired records and run directories are removed in place.
 */
export function pruneRunHistory(
  historyDir: string,
  retentionDays: number | 'off' | undefined,
  nowMs = Date.now(),
): void {
  if (retentionDays === undefined || retentionDays === 'off') return;
  const cutoff = nowMs - retentionDays * 86_400_000;
  const indexPath = join(historyDir, 'index.jsonl');
  const testsPath = join(historyDir, 'tests.jsonl');
  const keep = <T extends { finishedAt: string }>(path: string): T[] => {
    if (!existsSync(path)) return [];
    const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const row = JSON.parse(line) as T;
        return Date.parse(row.finishedAt) >= cutoff ? [row] : [];
      } catch {
        return [];
      }
    });
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
    return rows;
  };
  const runs = keep<HistoryRun>(indexPath);
  keep<HistoryTestStatus>(testsPath);
  const retained = new Set(runs.map((run) => run.runId));
  const runsDir = join(historyDir, 'runs');
  if (existsSync(runsDir)) {
    for (const runId of readdirSync(runsDir)) {
      if (!retained.has(runId)) rmSync(join(runsDir, runId), { recursive: true, force: true });
    }
  }
}

/** Appends one run summary and only changed per-test statuses to run history.
 *
 * Args:
 *   stateDir: authoritative test-gates state directory.
 *   retentionDays: history policy, absent or 'off' disables recording.
 *   run: run-level summary row.
 *   tests: current per-test statuses.
 *   nowMs: injected current time for deterministic retention boundaries.
 *
 * Returns:
 *   void: history records and the run summary artifact are written when enabled.
 */
export function recordRunHistory(
  stateDir: string,
  retentionDays: number | 'off' | undefined,
  run: HistoryRun,
  tests: readonly Omit<HistoryTestStatus, 'runId' | 'finishedAt'>[],
  nowMs = Date.now(),
): void {
  if (retentionDays === undefined || retentionDays === 'off') return;
  const historyDir = join(stateDir, 'history');
  const runsDir = join(historyDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  pruneRunHistory(historyDir, retentionDays, nowMs);
  const indexPath = join(historyDir, 'index.jsonl');
  const testsPath = join(historyDir, 'tests.jsonl');
  const prior = new Map<string, string>();
  if (existsSync(testsPath)) {
    for (const line of readFileSync(testsPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const row = JSON.parse(line) as HistoryTestStatus;
        prior.set(row.logicalKey, row.status);
      } catch {
        continue;
      }
    }
  }
  appendFileSync(indexPath, `${JSON.stringify(run)}\n`, 'utf8');
  const changed = tests.filter((test) => prior.get(test.logicalKey) !== test.status);
  if (changed.length > 0) {
    appendFileSync(testsPath, changed.map((test) => JSON.stringify({ ...test, runId: run.runId, finishedAt: run.finishedAt })).join('\n') + '\n', 'utf8');
  }
  const runDir = join(runsDir, run.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify({ run, tests }, null, 2)}\n`, 'utf8');
}

/** Queries retained run summaries with optional test, failure, and date filters.
 *
 * Args:
 *   historyDir: history directory under the ignored run-state root.
 *   filters: optional test substring, failed-only selector, and lower date bound.
 *
 * Returns:
 *   HistoryRun[]: matching run summaries in chronological order.
 */
export function queryRunHistory(
  historyDir: string,
  filters: { test?: string; failed?: boolean; since?: string } = {},
): HistoryRun[] {
  const indexPath = join(historyDir, 'index.jsonl');
  if (!existsSync(indexPath)) return [];
  const since = filters.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(filters.since);
  if (!Number.isFinite(since) && filters.since !== undefined) throw new Error(`invalid --since date '${filters.since}'`);
  const testsPath = join(historyDir, 'tests.jsonl');
  const tests = existsSync(testsPath)
    ? readFileSync(testsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as HistoryTestStatus)
    : [];
  return readFileSync(indexPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoryRun)
    .filter((run) => Date.parse(run.finishedAt) >= since)
    .filter((run) => filters.failed !== true || run.failedCount > 0)
    .filter((run) => filters.test === undefined || tests.some((test) => test.runId === run.runId && test.logicalKey.includes(filters.test!)))
    .sort((left, right) => left.finishedAt.localeCompare(right.finishedAt));
}
