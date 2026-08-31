import type { WitnessHandle, WitnessOptions } from './types.js';
/** Fail-closed witness configuration/startup error. */
export declare class WitnessStartupError extends Error {
    constructor(message: string);
}
/**
 * Derives the service-issued recordId: sha256 over GF-canonical JSON of
 * the record identity (pin #1). Deterministic and stable across runs;
 * an entry that never passed through the service has no matching hash,
 * so shape-level fabrication (a hex string the service never issued)
 * cannot line up with the ledger the reporter copies.
 */
export declare function recordIdOf(identity: {
    runId: string;
    obligationId: string;
    kind: string;
    testId: string;
    payload: unknown;
}): string;
/**
 * Starts the witness service.
 *
 * Args:
 *   options: run identity + token (required), state dir, adapters dir,
 *     classifications path, target/attestation config, timeout, clock.
 *
 * Returns:
 *   WitnessHandle: {url, stop} once the server listens.
 *
 * Throws:
 *   WitnessStartupError / AdapterRegistryError / AttestationError:
 *     fail-closed startup problems (GF-10 blocks non-loopback targets
 *     HERE, before any adapter request can be constructed).
 */
export declare function startWitness(options: WitnessOptions): Promise<WitnessHandle>;
//# sourceMappingURL=server.d.ts.map