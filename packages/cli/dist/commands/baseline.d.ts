import type { Io } from '../io.js';
export declare const BASELINE_USAGE = "usage: gateforge baseline update <fingerprint> [<fingerprint> ...]";
/**
 * Runs the baseline subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 updated, 2 usage/config/rejection.
 * @throws GateforgeBaselineError / errors (exit 2) on any problem.
 */
export declare function baselineCommand(io: Io, argv: readonly string[]): number;
//# sourceMappingURL=baseline.d.ts.map