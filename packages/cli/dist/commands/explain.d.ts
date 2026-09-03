import type { Io } from '../io.js';
export declare const EXPLAIN_USAGE = "usage: gateforge explain <resourceId> [--json]";
/**
 * Runs the explain subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 when the resource resolved, 1 when unknown or
 *   blocked (fail visible), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export declare function explainCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=explain.d.ts.map