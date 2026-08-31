import type { Io } from '../io.js';
export declare const INIT_USAGE = "usage: gateforge init [--languages <comma,list>]";
/**
 * Runs `gateforge init` in the io cwd.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code (0).
 */
export declare function initCommand(io: Io, argv: readonly string[]): number;
//# sourceMappingURL=init.d.ts.map