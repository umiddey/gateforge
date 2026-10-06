/**
 * The swept channel's per-page progress line (pure formatting): one line
 * per visited page, emitted as the visit finishes so a killed run keeps
 * the lines it already earned.
 */
import { describe, expect, it } from 'vitest';
import { formatSweepProgress } from '../src/witness/page-observer-registration.js';

describe('sweep progress lines', () => {
  it('formats a proven page', () => {
    expect(
      formatSweepProgress({
        index: 3,
        total: 12,
        audience: 'tenant',
        path: '/orders',
        proven: true,
        firstReason: null,
        ms: 1234,
      }),
    ).toBe('page 3/12 tenant /orders -> proven (1234 ms)');
  });

  it('formats a refused page with its first reason', () => {
    expect(
      formatSweepProgress({
        index: 1,
        total: 2,
        audience: 'master',
        path: '/settings',
        proven: false,
        firstReason: 'PAGE_BOUNCED_TO_LOGIN',
        ms: 890,
      }),
    ).toBe('page 1/2 master /settings -> refused PAGE_BOUNCED_TO_LOGIN (890 ms)');
  });
});
