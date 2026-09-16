import type { Io } from '../io.js';
export declare const TEST_GATES_USAGE: string;
/**
 * Runs the test-gates subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved or suite failure,
 *   2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export declare function testGatesCommand(io: Io, argv: readonly string[]): Promise<number>;
/**
 * Parses `--run-timeout-min` into a whole-run wall-clock bound.
 * The 30-minute default stands when the flag is absent; an explicit
 * bound never weakens verification (same expected set, same
 * completeness rules — only the kill timer moves, under operator
 * control for multi-hour suites). Bounded above so the value always
 * fits the runner's timer range (larger values would overflow it and
 * kill the run immediately — fail-open by accident is worse than a
 * documented cap).
 *
 * Args:
 *   raw: the flag value, or undefined when absent.
 *
 * Returns:
 *   Milliseconds, or undefined for the default bound.
 * @throws UsageError on non-integer, out-of-range, or repeated values.
 */
export declare function parseRunTimeoutMin(raw: string | undefined): number | undefined;
//# sourceMappingURL=test-gates.d.ts.map