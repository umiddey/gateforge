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
export type ClockSpec = {
    fixedAt: string | Date;
} | {
    sequence: Array<string | Date>;
} | {
    startAt: string | Date;
    stepMs?: number;
};
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
export declare function toIso(value: string | Date): string;
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
export declare function makeClock(spec: ClockSpec): TestClock;
//# sourceMappingURL=clock.d.ts.map