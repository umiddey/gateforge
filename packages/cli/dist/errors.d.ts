/**
 * Fail-closed error handling for the CLI.
 *
 * Exit-code contract (architecture contract 4 / pin #4): 0 clean or
 * waived, 1 unresolved obligations, 2 config/usage error. Every
 * fail-closed class in the engine (config, waivers, baselines, policy,
 * GPP/3 protocol failures) maps to 2 with its single-cause diagnostic on
 * stderr; gate outcomes map to 0/1 through `runExitCode`.
 */
import type { Io } from './io.js';
/** A CLI usage error (unknown subcommand, bad flags, bad state files). */
export declare class UsageError extends Error {
    constructor(message: string);
}
/**
 * Whether an error is a config/usage failure (exit 2) rather than a gate
 * outcome. Protocol failures carry subtype names (FrameJsonError etc.)
 * but are all `instanceof ProtocolFailure` — checked by name here to
 * keep the CLI decoupled from the protocol package's class hierarchy.
 */
export declare function isConfigError(error: unknown): boolean;
/** Print a fail-closed diagnostic to stderr: `gateforge: <message>`. */
export declare function printFailure(io: Io, error: unknown): void;
/**
 * Runs a command body, mapping expected failures to their exit code.
 * The body's own return value is an exit code already; only thrown
 * failures are classified here.
 */
export declare function runWithExitCodes(io: Io, body: () => Promise<number>): Promise<number>;
//# sourceMappingURL=errors.d.ts.map