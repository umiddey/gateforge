import type { Io } from '../io.js';
export declare const CLASSIFY_USAGE = "usage: gateforge classify [--json] [--write-snapshot <path>]";
/**
 * Runs the classify subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 when every decision is block-free, 1 when any
 *   typed classification block exists (fail visible), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export declare function classifyCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=classify.d.ts.map