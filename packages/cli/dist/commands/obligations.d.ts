import type { Io } from '../io.js';
export declare const OBLIGATIONS_USAGE = "usage: gateforge obligations [--json]";
/**
 * Runs the obligations subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code (0 on success).
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export declare function obligationsCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=obligations.d.ts.map