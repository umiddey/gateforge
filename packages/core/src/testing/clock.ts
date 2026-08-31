/**
 * Injected clock for fixture runs (fixture harness, G7).
 *
 * Gateforge never reads the wall clock at test time: run manifests are
 * stamped from the injected clock (pin #4) and verdict evaluation
 * receives `now` (pin #9). `makeClock` produces deterministic `now`
 * values from a fixed instant, an explicit sequence (e.g. waiver expiry
 * crossings, GF-16), or a stepping start instant.
 */

/**
 * Minimal clock surface consumed by the gate runner and evaluators.
 * `now()` always returns canonical ISO-8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
export interface TestClock {
  now(): string;
}

/** Clock specification: exactly one shape. */
export type ClockSpec =
  | { /** Every call returns the same instant. */
      fixedAt: string | Date }
  | { /** Calls return the instants in order, then fail loud. */
      sequence: Array<string | Date> }
  | { /** Calls return start + N*stepMs (stepMs default 1000). */
      startAt: string | Date;
      stepMs?: number };

/**
 * Normalizes an instant to canonical ISO-8601.
 *
 * Args:
 *   value: ISO-8601 string or Date.
 *
 * Returns:
 *   string: canonical `toISOString()` form.
 * @throws TypeError on unparseable input (fail loud, never NaN dates).
 */
export function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`not a valid instant: ${String(value)}`);
  }
  return date.toISOString();
}

/**
 * Builds a deterministic {@link TestClock} from a spec.
 *
 * Args:
 *   spec: `{fixedAt}` (constant), `{sequence}` (ordered instants,
 *   exhausted = thrown RangeError, never silent repetition), or
 *   `{startAt, stepMs}` (monotonic stepping).
 *
 * Returns:
 *   TestClock: `now()` yields canonical ISO-8601 instants.
 * @throws TypeError on an empty sequence or unparseable instants.
 */
export function makeClock(spec: ClockSpec): TestClock {
  if ('fixedAt' in spec) {
    const fixed = toIso(spec.fixedAt);
    return { now: () => fixed };
  }
  if ('sequence' in spec) {
    if (spec.sequence.length === 0) {
      throw new TypeError('sequence clock requires at least one instant');
    }
    const instants = spec.sequence.map(toIso);
    let index = 0;
    return {
      now: () => {
        if (index >= instants.length) {
          throw new RangeError(
            'clock sequence exhausted (fail loud: give the fixture enough instants, never silently repeat)',
          );
        }
        const next = instants[index];
        if (next === undefined) {
          throw new RangeError(`clock sequence index ${index} out of range (internal corruption)`);
        }
        index += 1;
        return next;
      },
    };
  }
  const startMs = Date.parse(toIso(spec.startAt));
  const stepMs = spec.stepMs ?? 1000;
  let ticks = 0;
  return {
    now: () => {
      const value = new Date(startMs + stepMs * ticks).toISOString();
      ticks += 1;
      return value;
    },
  };
}
