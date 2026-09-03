import type { RecordOrigin } from './schemas/evidence.js';
/** The record identity a witness hashes into the service-issued id. */
export interface RecordIdentity {
    /** Run manifest identity the record was issued under. */
    runId: string;
    /** Obligation the record evidences. */
    obligationId: string;
    /** Evidence kind (e.g. `ui.action`, `persistence.entity`). */
    kind: string;
    /** Witness-issued test attribution. */
    testId: string;
    /** Where the contents came from (drives the trust stamp at issuance). */
    origin: RecordOrigin;
    /** JSON-representable evidence payload. */
    payload: unknown;
}
/**
 * Derives the service-issued record id: sha256 over the GF-canonical
 * JSON of exactly the identity fields (pin #1/#7). Deterministic and
 * stable across runs.
 *
 * Args:
 *   identity: runId, obligationId, kind, testId, origin, and payload.
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 *
 * Throws:
 *   TypeError: when the payload is not JSON-representable (the witness
 *   refuses to issue such records; callers issuing must too).
 */
export declare function recordIdOf(identity: {
    runId: string;
    obligationId: string;
    kind: string;
    testId: string;
    origin: RecordOrigin;
    payload: unknown;
}): string;
/**
 * Verifies a lenient record view against its own provenance (check 1):
 * the recordId must be 64-hex, every identity field present, and the
 * id must recompute from the contents. Adversary-controlled input can
 * never throw — any structural problem is `false` (the record then
 * demotes to claimed tier, GF-23).
 *
 * Args:
 *   record: an arbitrary record-shaped value (e.g. a `records.json`
 *     entry or a witness ledger row).
 *
 * Returns:
 *   boolean: true only when the record's own contents hash to its id.
 */
export declare function isProvenancedRecord(record: unknown): boolean;
/**
 * True when a record asserts the witnessed tier AND its provenance
 * verifies ({@link isProvenancedRecord}). The single witnessed-tier
 * predicate for the engine and the reporter's trust display, so a
 * record can never display as witnessed while the engine would demote
 * it (or vice versa).
 *
 * Args:
 *   record: an arbitrary record-shaped value.
 *
 * Returns:
 *   boolean: witnessed tier with verified provenance.
 */
export declare function isWitnessedRecord(record: unknown): boolean;
/**
 * Computes the witness-ledger MAC (pin #7): HMAC-SHA256 over the
 * GF-canonical JSON of `{runId, recordIds}` keyed by the witness's
 * VERIFIER KEY — a secret handed to the witness and the verifying CLI
 * by the run orchestrator, never to the tested suite (the suite's run
 * token authorizes submissions; it must not authorize attestation).
 * The MAC makes the durable, suite-writable manifest append tamper-
 * evident: changing one id, adding a forged id, or transplanting the
 * set across runs invalidates it.
 *
 * Args:
 *   verifierKey: the witness verifier secret (non-empty).
 *   runId: the run manifest identity binding the set to THIS run.
 *   recordIds: the issued record ids (normalized internally).
 *
 * Returns:
 *   string: 64-char lowercase hex HMAC.
 *
 * Throws:
 *   TypeError: when the verifier key is empty.
 */
export declare function ledgerMac(verifierKey: string, runId: string, recordIds: readonly string[]): string;
/**
 * Verifies a ledger MAC ({@link ledgerMac}) in constant time where the
 * inputs allow it. Adversary-controlled input never throws.
 *
 * Args:
 *   verifierKey: the witness verifier secret (non-empty).
 *   runId: the run manifest identity the set claims.
 *   recordIds: the record-id set the MAC must cover (normalized
 *     internally, exactly like the witness computed it).
 *   mac: the claimed MAC (64-char lowercase hex).
 *
 * Returns:
 *   boolean: true only when the MAC verifies over the exact set.
 */
export declare function verifyLedgerMac(verifierKey: string, runId: string, recordIds: readonly string[], mac: unknown): boolean;
//# sourceMappingURL=provenance.d.ts.map