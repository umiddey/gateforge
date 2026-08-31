import type { Io } from '../io.js';
export declare const CHECK_USAGE = "usage: gateforge check [--changed] [--format text|json|sarif]";
/**
 * Runs the check subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved, 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export declare function checkCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=check.d.ts.map