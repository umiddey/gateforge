/**
 * The near-budget warning lines for the supervised run (plan
 * 20261021_0030_gf_infra_visibility, P3): one stderr line per witness
 * API path that had at least one call take ≥ 80 % of its timeout, so
 * budget pressure is visible BEFORE a call actually exceeds its
 * deadline. Pure presentation: the aggregates come from the drain's
 * `stop()` result (`supervisorTiming`), and the state document is
 * written by {@link writeSupervisorTiming} beside these lines.
 */
import type { SupervisorPathTiming } from '@gate-forge/pack-playwright';

/**
 * Builds one warning line per path that had a near-budget call, sorted
 * by path — e.g. `warning: /sessions/open slowest 4.6 s of 5 s budget
 * (3 calls ≥ 80 %)`.
 *
 * Args:
 *   timing: the per-path aggregates from the drain's `stop()` result.
 *
 * Returns:
 *   string[]: the warning lines, without the `test-gates: ` prefix.
 */
export function supervisorTimingWarningLines(timing: readonly SupervisorPathTiming[]): string[] {
  return [...timing]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .filter((entry) => entry.nearBudget > 0)
    .map((entry) => {
      const slowestSeconds = (entry.maxMs / 1000).toFixed(1);
      const budgetSeconds = String(entry.budgetMs / 1000);
      return `warning: ${entry.path} slowest ${slowestSeconds} s of ${budgetSeconds} s budget (${String(entry.nearBudget)} calls ≥ 80 %)`;
    });
}
