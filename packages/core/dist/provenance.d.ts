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
/** Domain tag binding v2 attestation MACs to the ledger envelope format. */
export declare const ATTESTATION_DOMAIN = "gateforge.ledger.v2";
/** The only attestation envelope version this code produces or honors. */
export declare const ATTESTATION_VERSION = 2;
/**
 * The unsigned v2 attestation body: the witness run identity, the fresh
 * trusted invocation identity, the tested input digest, and the issued
 * record set. The MAC covers exactly these fields plus the domain tag —
 * never `mac` itself.
 */
export interface AttestationBody {
    /** Witness run UUID. */
    runId: string;
    /** Fresh UUID minted by the trusted test-gates caller per invocation. */
    invocationId: string;
    /** 64-char lowercase hex digest of the canonical input snapshot. */
    inputDigest: string;
    /** Issued record ids (normalized internally: sorted, unique). */
    recordIds: readonly string[];
}
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
/**
 * Computes the v2 attestation MAC (plan §11.3): HMAC-SHA256 over the
 * GF-canonical JSON of `{domain, attestationVersion: 2, runId,
 * invocationId, inputDigest, recordIds}` keyed by the witness's VERIFIER
 * KEY — a secret the tested suite never receives. The fixed domain tag
 * prevents cross-format signature acceptance: a legacy `{runId,
 * recordIds}` MAC can never verify as a v2 attestation, and a v2 MAC
 * can never verify as anything else.
 *
 * Args:
 *   verifierKey: the witness verifier secret (non-empty).
 *   body: runId, invocationId, 64-hex inputDigest, and issued record ids
 *     (normalized internally: deduplicated, codepoint-sorted).
 *
 * Returns:
 *   string: 64-char lowercase hex HMAC.
 *
 * Throws:
 *   TypeError: when the verifier key is empty, an identity is empty, or
 *   the input digest is not 64-char lowercase hex.
 */
export declare function attestationMac(verifierKey: string, body: AttestationBody): string;
/**
 * Verifies a v2 attestation MAC ({@link attestationMac}) in constant
 * time where the inputs allow it. Adversary-controlled input never
 * throws. A legacy `{runId, recordIds}` MAC is structurally incapable
 * of verifying here — the domain tag and the extra fields change the
 * signed bytes — so old evidence can never authorize through this path.
 *
 * Args:
 *   verifierKey: the witness verifier secret (non-empty).
 *   body: the claimed attestation body (runId, invocationId,
 *     inputDigest, recordIds).
 *   mac: the claimed MAC (64-char lowercase hex).
 *
 * Returns:
 *   boolean: true only when the MAC verifies over the exact v2 body.
 */
export declare function verifyAttestationMac(verifierKey: string, body: {
    runId: unknown;
    invocationId: unknown;
    inputDigest: unknown;
    recordIds: unknown;
}, mac: unknown): boolean;
//# sourceMappingURL=provenance.d.ts.map