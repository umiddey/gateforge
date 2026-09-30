/**
 * Timing-chaos scheduler (E63): the seeded release
 * plan the observation proxy applies to proxied app RESPONSES.
 *
 * The contract these tests pin is replayability. A finding is only
 * useful if the owner can reproduce it: every delay and every reorder
 * decision is a pure function of (seed, session identity, route key, k)
 * — never of wall time, never of global arrival order — and no recorded
 * field can carry a query value, a body or a header.
 */
import { describe, expect, it } from 'vitest';
import {
  ChaosScheduler,
  parseChaosOptions,
  type ChaosScheduleEntry,
} from '../src/witness/chaos.js';

const OPTIONS = { seed: 7, maxDelayMs: 400, reorder: true };

describe('chaos options', () => {
  it('accepts a non-negative integer seed with the documented defaults', () => {
    expect(parseChaosOptions({ seed: '0', maxDelayMs: undefined, reorder: undefined })).toEqual({
      seed: 0,
      maxDelayMs: 400,
      reorder: true,
    });
  });

  it('refuses a seed that is not a non-negative integer', () => {
    for (const seed of ['-1', '1.5', 'abc', '', ' 3', '0x10', '1e3', '+3']) {
      expect(() => parseChaosOptions({ seed, maxDelayMs: undefined, reorder: undefined }), seed).toThrow(
        /chaos seed/,
      );
    }
  });

  it('refuses a bound that is not a whole number of milliseconds', () => {
    expect(() => parseChaosOptions({ seed: '1', maxDelayMs: '12.5', reorder: undefined })).toThrow(
      /max delay/,
    );
    expect(() => parseChaosOptions({ seed: '1', maxDelayMs: '-1', reorder: undefined })).toThrow(/max delay/);
    expect(() => parseChaosOptions({ seed: '1', maxDelayMs: '60000', reorder: undefined })).toThrow(/max delay/);
  });

  it('refuses a reorder flag that is not on or off', () => {
    expect(() => parseChaosOptions({ seed: '1', maxDelayMs: '10', reorder: 'yes' })).toThrow(/reorder/);
    expect(parseChaosOptions({ seed: '1', maxDelayMs: '10', reorder: 'off' })).toEqual({
      seed: 1,
      maxDelayMs: 10,
      reorder: false,
    });
  });

  it('reads no chaos at all when the seed is absent', () => {
    expect(parseChaosOptions({ seed: undefined, maxDelayMs: undefined, reorder: undefined })).toBeNull();
  });
});

describe('chaos schedule', () => {
  it('replays the identical schedule for the same seed, session and route key', () => {
    const schedule = (): ChaosScheduleEntry[] => {
      const scheduler = new ChaosScheduler(OPTIONS, 'items.spec.js#tab B wins');
      const entries: ChaosScheduleEntry[] = [];
      for (let k = 0; k < 6; k += 1) {
        entries.push(scheduler.release(scheduler.reserve('GET /api/items', 1_000 * k), 1_000 * k));
      }
      return entries;
    };
    expect(schedule()).toEqual(schedule());
    expect(schedule().length).toBe(6);
  });

  it('is a pure function of the seed: another seed moves the schedule', () => {
    const withSeven = new ChaosScheduler(OPTIONS, 'session');
    const withEight = new ChaosScheduler({ ...OPTIONS, seed: 8 }, 'session');
    const schedule = (scheduler: ChaosScheduler): unknown[] => {
      const entries: unknown[] = [];
      for (let k = 0; k < 4; k += 1) {
        const at = 500 * k;
        entries.push(scheduler.release(scheduler.reserve('GET /api/items', at), at));
      }
      return entries;
    };
    expect(schedule(withEight)).not.toEqual(schedule(withSeven));
  });

  it('keeps every delay inside the declared bound and never negative', () => {
    const scheduler = new ChaosScheduler(OPTIONS, 'session');
    for (let k = 0; k < 200; k += 1) {
      const slot = scheduler.reserve('GET /api/items', 10_000 * k);
      const entry = scheduler.release(slot, 10_000 * k);
      expect(entry.delayMs).toBeGreaterThanOrEqual(0);
      expect(entry.delayMs).toBeLessThanOrEqual(OPTIONS.maxDelayMs);
      expect(slot.delayMs).toBeLessThanOrEqual(OPTIONS.maxDelayMs);
    }
  });

  it('never holds a response back from the first request on a route', () => {
    const scheduler = new ChaosScheduler(OPTIONS, 'session');
    const first = scheduler.reserve('GET /api/items', 0);
    expect(first.k).toBe(1);
    expect(first.releasedBefore).toBe(false);
  });

  it('can release a later response before an earlier one for one route key', () => {
    // Search the seeded space for a schedule that reorders the second
    // request behind the first on the same route key: that is the race
    // a chaos run exists to surface.
    let found: number | null = null;
    for (let seed = 0; seed < 200 && found === null; seed += 1) {
      const scheduler = new ChaosScheduler({ ...OPTIONS, seed }, 'session');
      const a = scheduler.reserve('GET /api/items', 0);
      const b = scheduler.reserve('GET /api/items', 1);
      if (b.releasedBefore && b.delayMs < a.delayMs) found = seed;
    }
    expect(found, 'no seed in 0..199 reorders the second request on this route key').not.toBeNull();
  });

  it('keeps arrival order when reorder is off', () => {
    const scheduler = new ChaosScheduler({ ...OPTIONS, reorder: false }, 'session');
    for (let k = 0; k < 20; k += 1) {
      const at = k * 2;
      const slot = scheduler.reserve('GET /api/items', at);
      expect(slot.releasedBefore).toBe(false);
      expect(slot.delayMs).toBeGreaterThanOrEqual(k - 1);
      expect(scheduler.release(slot, at).releasedBefore).toBe(false);
    }
  });

  it('counts each route key independently and records nothing but the route key', () => {
    const scheduler = new ChaosScheduler(OPTIONS, 'session');
    const at = 0;
    const entries = [
      scheduler.release(scheduler.reserve('GET /api/items?tab=a&token=secret', at), at),
      scheduler.release(scheduler.reserve('GET /api/items?tab=b&token=other', at), at),
      scheduler.release(scheduler.reserve('POST /api/items?token=secret', at), at),
    ];
    expect(entries.map((entry) => [entry.routeKey, entry.k])).toEqual([
      ['GET /api/items', 1],
      ['GET /api/items', 2],
      ['POST /api/items', 1],
    ]);
    // A recorded route key is method + pathname only: no query value,
    // body, header or session token can ever reach the schedule.
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(JSON.stringify(entries)).not.toContain('tab=');
  });

  it('never delays a response that already waited longer than its slot', () => {
    const scheduler = new ChaosScheduler(OPTIONS, 'session');
    // The upstream took longer than the planned slot: the response is
    // released immediately, never "negative delay".
    const slot = scheduler.reserve('GET /api/items', 0);
    expect(scheduler.release(slot, 5_000).delayMs).toBe(0);
  });
});
