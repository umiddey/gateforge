/**
 * Gate-receipt signing and verification (plan 2026-09-13 §5.1, ADR 0005
 * D3, Phase 4). The receipt is signed by the SAME authority as witness
 * records — the witness verifier key, HMAC-SHA256 over GF-canonical JSON —
 * reusing the exact provenance primitives (`createHmac`, `canonicalJson`,
 * constant-time compare). No second, weaker evidence system exists here:
 * a receipt without a verifying MAC is rejected, and the MAC domain
 * (`gateforge.receipt.v1`) is distinct from the ledger attestation domain,
 * so neither envelope can ever verify as the other.
 *
 * Issuance rule (plan Phase 4 item 5): a receipt is minted ONLY after
 * complete supervision success and evidence grading; verification is
 * fail-closed — every structural or cryptographic problem is a typed
 * rejection, never a partial pass.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../canonical-json.js';
import { GateReceiptSchema, type GateReceipt } from '../schemas/gate-receipt.js';

/** Domain tag binding receipt MACs to the gate-receipt envelope format. */
export const RECEIPT_DOMAIN = 'gateforge.receipt.v1';

/** The only receipt envelope version this code produces or honors. */
export const RECEIPT_VERSION = 1;

/** Shape a 64-char lowercase hex MAC must have. */
const MAC_PATTERN = /^[0-9a-f]{64}$/;

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
export function gateReceiptMac(verifierKey: string, body: GateReceiptBody): string {
  if (typeof verifierKey !== 'string' || verifierKey.length === 0) {
    throw new TypeError('gateReceiptMac: verifier key must be a non-empty string');
  }
  return createHmac('sha256', verifierKey)
    .update(
      canonicalJson({
        domain: RECEIPT_DOMAIN,
        ...body,
      }),
    )
    .digest('hex');
}

/** Typed reasons a receipt candidate failed verification (fail closed). */
export type ReceiptRejection =
  | 'missing'
  | 'malformed'
  | 'mac-fail'
  | 'input-digest-mismatch'
  | 'policy-digest-mismatch'
  | 'selection-digest-mismatch'
  | 'catalog-digest-mismatch'
  | 'execution-digest-mismatch'
  | 'attestation-digest-mismatch'
  | 'not-clean';

/** The verification outcome: a validated receipt or a typed rejection. */
export type ReceiptVerification =
  | { ok: true; receipt: GateReceipt }
  | { ok: false; rejection: ReceiptRejection; detail: string };

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
export function verifyGateReceipt(
  verifierKey: string,
  candidate: unknown,
  expected: {
    inputDigest?: string;
    trustedPolicyDigest?: string;
    selectionDigest?: string;
    catalogDigest?: string;
    executionResultDigest?: string;
    evidenceAttestationDigest?: string | null;
  } = {},
): ReceiptVerification {
  if (candidate === undefined || candidate === null) {
    return { ok: false, rejection: 'missing', detail: 'gate receipt is missing' };
  }
  const parsed = GateReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? '' : ` at '${issue.path.map(String).join('.')}':`;
    return {
      ok: false,
      rejection: 'malformed',
      detail:
        `gate receipt is malformed (expected receiptVersion 1 with the full binding set and mac)` +
        `${path} ${issue?.message ?? 'unknown schema error'}`,
    };
  }
  const receipt = parsed.data as GateReceipt;
  const { mac, ...body } = receipt;
  if (typeof verifierKey !== 'string' || verifierKey.length === 0) {
    return {
      ok: false,
      rejection: 'mac-fail',
      detail: 'gate receipt cannot verify without a verifier key (fail closed)',
    };
  }
  const claimed = mac;
  if (!MAC_PATTERN.test(claimed)) {
    return { ok: false, rejection: 'mac-fail', detail: 'gate receipt mac is malformed' };
  }
  let expectedMac: Buffer;
  let claimedMac: Buffer;
  try {
    expectedMac = Buffer.from(gateReceiptMac(verifierKey, body), 'hex');
    claimedMac = Buffer.from(claimed, 'hex');
  } catch {
    return { ok: false, rejection: 'mac-fail', detail: 'gate receipt mac could not be recomputed' };
  }
  if (expectedMac.length !== claimedMac.length || !timingSafeEqual(expectedMac, claimedMac)) {
    return {
      ok: false,
      rejection: 'mac-fail',
      detail: 'gate receipt signature fails; the receipt was forged or tampered with (fail closed)',
    };
  }
  const digestChecks: Array<{
    field: keyof ReceiptVerificationExpectations;
    receiptValue: string | null;
    expectedValue: string | null | undefined;
    rejection: ReceiptRejection;
    label: string;
  }> = [
    { field: 'inputDigest', receiptValue: receipt.inputDigest, expectedValue: expected.inputDigest, rejection: 'input-digest-mismatch', label: 'input digest' },
    { field: 'trustedPolicyDigest', receiptValue: receipt.trustedPolicyDigest, expectedValue: expected.trustedPolicyDigest, rejection: 'policy-digest-mismatch', label: 'trusted policy digest' },
    { field: 'selectionDigest', receiptValue: receipt.selectionDigest, expectedValue: expected.selectionDigest, rejection: 'selection-digest-mismatch', label: 'selection digest' },
    { field: 'catalogDigest', receiptValue: receipt.catalogDigest, expectedValue: expected.catalogDigest, rejection: 'catalog-digest-mismatch', label: 'catalog digest' },
    { field: 'executionResultDigest', receiptValue: receipt.executionResultDigest, expectedValue: expected.executionResultDigest, rejection: 'execution-digest-mismatch', label: 'execution-result digest' },
    {
      field: 'evidenceAttestationDigest',
      receiptValue: receipt.evidenceAttestationDigest,
      expectedValue: expected.evidenceAttestationDigest === undefined ? undefined : expected.evidenceAttestationDigest,
      rejection: 'attestation-digest-mismatch',
      label: 'evidence attestation digest',
    },
  ];
  for (const check of digestChecks) {
    if (check.expectedValue === undefined) continue;
    if (check.receiptValue !== check.expectedValue) {
      return {
        ok: false,
        rejection: check.rejection,
        detail:
          `gate receipt ${check.label} does not match the current run ` +
          `('${String(check.receiptValue)}' vs '${String(check.expectedValue)}'); ` +
          'the sealed run is not this run (fail closed)',
      };
    }
  }
  if (receipt.verdictSummary.blocking !== 0) {
    return {
      ok: false,
      rejection: 'not-clean',
      detail:
        `gate receipt seals a blocking verdict summary (${String(receipt.verdictSummary.blocking)} blocking); ` +
        'receipts are issued only after complete success (fail closed)',
    };
  }
  return { ok: true, receipt };
}

/** The expected-digest shape of {@link verifyGateReceipt} (named for docs). */
export interface ReceiptVerificationExpectations {
  inputDigest?: string;
  trustedPolicyDigest?: string;
  selectionDigest?: string;
  catalogDigest?: string;
  executionResultDigest?: string;
  evidenceAttestationDigest?: string | null;
}
