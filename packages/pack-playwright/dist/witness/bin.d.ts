import type { WitnessHandle } from './types.js';
/**
 * Reads env and starts the witness.
 *
 * Args:
 *   argv: unused (reserved for flags).
 *   env: process environment.
 *
 * Returns:
 *   WitnessHandle once listening.
 *
 * Throws:
 *   WitnessStartupError / AttestationError / AdapterRegistryError:
 *     fail-closed startup problems (exit 2 via the wrapper).
 */
export declare function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<WitnessHandle>;
//# sourceMappingURL=bin.d.ts.map