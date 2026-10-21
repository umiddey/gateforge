/**
 * The near-budget warning lines (plan 20261021_0030_gf_infra_visibility,
 * P3): one line per witness API path that had at least one call taking
 * ≥ 80 % of its timeout — printed next to the observe-notes/infra lines
 * so an operator sees the budget pressure BEFORE a call actually blows
 * its 5 s deadline.
 */
import { describe, expect, it } from 'vitest';
import type { SupervisorPathTiming } from '@gate-forge/pack-playwright';
import { supervisorTimingWarningLines } from './supervisor-timing.js';

describe('supervisorTimingWarningLines (plan 20261021_0030_gf_infra_visibility P3)', () => {
  it('warns once per path that had a near-budget call, sorted by path', () => {
    const timing: SupervisorPathTiming[] = [
      { path: '/sessions/open', count: 5, maxMs: 4600, nearBudget: 3, budgetMs: 5000 },
      { path: '/sessions/close', count: 5, maxMs: 40, nearBudget: 0, budgetMs: 5000 },
      { path: '/runs/execution-trace', count: 1, maxMs: 4200, nearBudget: 1, budgetMs: 5000 },
    ];
    expect(supervisorTimingWarningLines(timing)).toEqual([
      'warning: /runs/execution-trace slowest 4.2 s of 5 s budget (1 calls ≥ 80 %)',
      'warning: /sessions/open slowest 4.6 s of 5 s budget (3 calls ≥ 80 %)',
    ]);
  });

  it('warns nowhere when every call stayed under 80 % of its budget', () => {
    const timing: SupervisorPathTiming[] = [
      { path: '/sessions/open', count: 9, maxMs: 3999, nearBudget: 0, budgetMs: 5000 },
    ];
    expect(supervisorTimingWarningLines(timing)).toEqual([]);
  });
});
