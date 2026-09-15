import type { Io } from '../io.js';
export declare const ENFORCE_USAGE = "usage: gateforge enforce";
/**
 * Runs `gateforge enforce` in the io cwd.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 wired, 2 config/usage.
 */
export declare function enforceCommand(io: Io, argv: readonly string[]): number;
//# sourceMappingURL=enforce.d.ts.map