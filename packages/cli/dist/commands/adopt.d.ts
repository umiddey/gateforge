import type { Io } from '../io.js';
export declare const ADOPT_USAGE = "usage: gateforge adopt";
/**
 * Runs the adopt subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand (none supported beyond --help).
 *
 * Returns:
 *   number: exit code — 0 adopted (or idempotent no-op), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/pipeline/baseline layers.
 */
export declare function adoptCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=adopt.d.ts.map