import type { Io } from '../io.js';
export declare const WAIVE_USAGE: string;
/**
 * Runs the waive subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 waiver written, 2 usage/validation/config.
 * @throws UsageError (exit 2) on any usage or fail-closed problem; other
 *   fail-closed engine errors (config/plugin/pipeline) propagate.
 */
export declare function waiveCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=waive.d.ts.map