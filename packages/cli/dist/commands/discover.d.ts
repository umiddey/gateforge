import type { Io } from '../io.js';
export declare const DISCOVER_USAGE = "usage: gateforge discover [--json]";
/**
 * Runs the discover subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code (0 on success).
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export declare function discoverCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=discover.d.ts.map