import type { WitnessHandle } from './types.js';
/** One-line usage (the header comment above is the long form). */
export declare const WITNESS_BIN_USAGE: string;
/**
 * Reads env + argv and starts the witness.
 *
 * Args:
 *   argv: CLI flags (see the module header; `--help` prints usage and
 *     returns a never-started handle).
 *   env: process environment.
 *
 * Returns:
 *   WitnessHandle once listening (or a handle with an empty `url` for
 *   `--help`; the wrapper skips its URL banner in that case).
 *
 * Throws:
 *   WitnessStartupError / AttestationError / AdapterRegistryError:
 *     fail-closed startup problems (exit 2 via the wrapper).
 */
export declare function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<WitnessHandle>;
//# sourceMappingURL=bin.d.ts.map