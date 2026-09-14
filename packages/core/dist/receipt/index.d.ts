import { type GateReceipt } from '../schemas/gate-receipt.js';
/** Domain tag binding receipt MACs to the gate-receipt envelope format. */
export declare const RECEIPT_DOMAIN = "gateforge.receipt.v1";
/** The only receipt envelope version this code produces or honors. */
export declare const RECEIPT_VERSION = 1;
/** The unsigned receipt body (everything the MAC covers). */
export type GateReceiptBody = Omit<GateReceipt, 'mac'>;
/**
 * Computes the receipt MAC (ADR 0005 D3): HMAC-SHA256 over the GF-canonical
 * JSON of `{domain: 'gateforge.receipt.v1', receiptVersion: 1, ...body}`
 * keyed by the witness verifier key — the same secret the tested suite
 * never receives for ledger attestations. The fixed domain tag prevents
 * cross-format signature acceptance in BOTH directions: a v2 ledger MAC
 * can never verify as a receipt, and a receipt MAC can never verify as a
 * ledger attestation.
 *
 * Args:
 *   verifierKey: the witness verifier secret (non-empty).
 *   body: the unsigned receipt body.
 *
 * Returns:
 *   string: 64-char lowercase hex HMAC.
 *
 * Throws:
 *   TypeError: when the verifier key is empty.
 */
export declare function gateReceiptMac(verifierKey: string, body: GateReceiptBody): string;
/** Typed reasons a receipt candidate failed verification (fail closed). */
export type ReceiptRejection = 'missing' | 'malformed' | 'mac-fail' | 'input-digest-mismatch' | 'policy-digest-mismatch' | 'selection-digest-mismatch' | 'catalog-digest-mismatch' | 'execution-digest-mismatch' | 'attestation-digest-mismatch' | 'not-clean';
/** The verification outcome: a validated receipt or a typed rejection. */
export type ReceiptVerification = {
    ok: true;
    receipt: GateReceipt;
} | {
    ok: false;
    rejection: ReceiptRejection;
    detail: string;
};
/**
 * Verifies a receipt candidate end-to-end (fail closed):
 * 1. structural — the value must parse against the strict v1 schema;
 * 2. authenticity — the HMAC must verify over the exact body (a forged
 *    or tampered receipt is a `mac-fail`, never a downgrade);
 * 3. binding — when an expected context is given, every supplied digest
 *    must equal the receipt's (mismatches are typed, per-field);
 * 4. content — the sealed verdict summary must be clean (blocking 0).
 * Adversary-controlled input never throws.
 *
 * Args:
 *   verifierKey: the witness verifier secret (non-empty).
 *   candidate: an arbitrary value (e.g. a parsed receipt.json).
 *   expected: optional digests the receipt must match for THIS use.
 *
 * Returns:
 *   ReceiptVerification: the validated receipt or a typed rejection.
 */
export declare function verifyGateReceipt(verifierKey: string, candidate: unknown, expected?: {
    inputDigest?: string;
    trustedPolicyDigest?: string;
    selectionDigest?: string;
    catalogDigest?: string;
    executionResultDigest?: string;
    evidenceAttestationDigest?: string | null;
}): ReceiptVerification;
/** The expected-digest shape of {@link verifyGateReceipt} (named for docs). */
export interface ReceiptVerificationExpectations {
    inputDigest?: string;
    trustedPolicyDigest?: string;
    selectionDigest?: string;
    catalogDigest?: string;
    executionResultDigest?: string;
    evidenceAttestationDigest?: string | null;
}
//# sourceMappingURL=index.d.ts.map