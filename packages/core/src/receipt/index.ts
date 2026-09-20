/**
 * Gate-receipt signing and verification (plan 2026-09-13 §5.1, ADR 0005
 * D3, Phase 4). The receipt is signed by the SAME authority as witness
 * records — the witness verifier key, HMAC-SHA256 over GF-canonical JSON —
 * reusing the exact provenance primitives (`createHmac`, `canonicalJson`,
 * constant-time compare). No second, weaker evidence system exists here:
 * a receipt without a verifying MAC is rejected, and the MAC domain
 * (`gateforge.receipt.v2`) is distinct from the ledger attestation domain,
 * so neither envelope can ever verify as the other.
 *
 * Issuance rule (plan Phase 4 item 5): a receipt is minted ONLY after
 * complete supervision success and evidence grading; verification is
 * fail-closed — every structural or cryptographic problem is a typed
 * rejection, never a partial pass.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256Canonical, type JsonValue } from '../canonical-json.js';
import { GateReceiptSchema, type GateReceipt } from '../schemas/gate-receipt.js';
import { EMPTY_BEHAVIOR_CATALOG_DIGEST } from '../policy/behavior.js';

/** Domain tag binding receipt MACs to the gate-receipt envelope format. */
export const RECEIPT_DOMAIN = 'gateforge.receipt.v2';

/** The only receipt envelope version this code produces or honors. */
export const RECEIPT_VERSION = 2;

/** Shape a 64-char lowercase hex MAC must have. */
const MAC_PATTERN = /^[0-9a-f]{64}$/;

/** The unsigned receipt body (everything the MAC covers). */
export type GateReceiptBody = Omit<GateReceipt, 'mac'>;

/** Canonical digest for an empty required-case set (never an omitted field). */
export const EMPTY_REQUIRED_CASE_SET_DIGEST = sha256Canonical({
  domain: 'gateforge.required-cases.v1',
  specifications: [],
});

/** Canonical digest when the sealed run executed no behavior cases. */
export const EMPTY_CASE_EXECUTION_DIGEST = sha256Canonical({
  domain: 'gateforge.case-execution.v1',
  executions: [],
});

/** Execution profile identifying a local, unisolated run (never managed acceptance). */
export const LOCAL_UNISOLATED_BOUNDARY = 'local-unisolated';

/**
 * Hashes the sorted full required case specifications (not just stable
 * case ids) into the receipt-bound required-case-set digest.
 */
export function requiredCaseSetDigestOf(specifications: readonly JsonValue[]): string {
  if (specifications.length === 0) return EMPTY_REQUIRED_CASE_SET_DIGEST;
  return sha256Canonical({
    domain: 'gateforge.required-cases.v1',
    specifications: [...specifications].sort((a, b) => {
      const left = JSON.stringify(a);
      const right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  });
}

/**
 * Hashes the sorted executed case ids into the receipt-bound
 * case-execution digest.
 */
export function caseExecutionDigestOf(caseIds: readonly string[]): string {
  if (caseIds.length === 0) return EMPTY_CASE_EXECUTION_DIGEST;
  return sha256Canonical({
    domain: 'gateforge.case-execution.v1',
    executions: [...new Set(caseIds)].sort(),
  });
}

/**
 * Binds the approved engine bundle: engine version plus the trusted
 * policy digest of the bundle it ran with.
 */
export function engineBundleDigestOf(engineVersion: string, trustedPolicyDigest: string): string {
  return sha256Canonical({
    domain: 'gateforge.engine-bundle.v1',
    engineVersion,
    trustedPolicyDigest,
  });
}

/**
 * Binds the controller-issued record of the active execution profile.
 * Local runs seal `local-unisolated`; that record cannot authorize a
 * managed/complete protected acceptance.
 */
export function executionBoundaryDigestOf(profile: string): string {
  return sha256Canonical({ domain: 'gateforge.execution-boundary.v1', profile });
}

/** Digest of the local-unisolated execution boundary (the only local value). */
export const LOCAL_UNISOLATED_BOUNDARY_DIGEST = executionBoundaryDigestOf(LOCAL_UNISOLATED_BOUNDARY);

/**
 * Binds the controlled app artifact derived from the candidate tree.
 * Local runs build nothing separate: the artifact IS the source tree
 * (explicit kind, never a self-reported app header).
 */
export function targetArtifactDigestOf(candidateTreeId: string | null): string {
  return sha256Canonical({
    domain: 'gateforge.target-artifact.v1',
    kind: 'source-tree',
    tree: candidateTreeId,
  });
}

export { EMPTY_BEHAVIOR_CATALOG_DIGEST };

/**
 * Computes the receipt MAC (ADR 0005 D3): HMAC-SHA256 over the GF-canonical
 * JSON of `{domain: 'gateforge.receipt.v2', receiptVersion: 2, ...body}`
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
  | 'tree-mismatch'
  | 'behavior-digest-mismatch'
  | 'case-set-mismatch'
  | 'case-execution-mismatch'
  | 'engine-bundle-mismatch'
  | 'boundary-mismatch'
  | 'artifact-mismatch'
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
    candidateTreeId?: string | null;
    behaviorCatalogDigest?: string;
    requiredCaseSetDigest?: string;
    caseExecutionDigest?: string;
    engineBundleDigest?: string;
    executionBoundaryDigest?: string;
    targetArtifactDigest?: string;
  } = {},
): ReceiptVerification {
  if (candidate === undefined || candidate === null) {
    return { ok: false, rejection: 'missing', detail: 'gate receipt is missing' };
  }
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as Record<string, unknown>)['receiptVersion'] === 1
  ) {
    return {
      ok: false,
      rejection: 'malformed',
      detail:
        'gate receipt is receiptVersion 1, which is no longer accepted — rerun the gate to seal a ' +
        'fresh receiptVersion 2 receipt (old receipts are never re-signed or auto-upgraded)',
    };
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
    {
      field: 'candidateTreeId',
      receiptValue: receipt.candidateTreeId,
      expectedValue: expected.candidateTreeId,
      rejection: 'tree-mismatch',
      label: 'candidate tree id',
    },
    {
      field: 'behaviorCatalogDigest',
      receiptValue: receipt.behaviorCatalogDigest,
      expectedValue: expected.behaviorCatalogDigest,
      rejection: 'behavior-digest-mismatch',
      label: 'behavior catalog digest',
    },
    {
      field: 'requiredCaseSetDigest',
      receiptValue: receipt.requiredCaseSetDigest,
      expectedValue: expected.requiredCaseSetDigest,
      rejection: 'case-set-mismatch',
      label: 'required case set digest',
    },
    {
      field: 'caseExecutionDigest',
      receiptValue: receipt.caseExecutionDigest,
      expectedValue: expected.caseExecutionDigest,
      rejection: 'case-execution-mismatch',
      label: 'case execution digest',
    },
    {
      field: 'engineBundleDigest',
      receiptValue: receipt.engineBundleDigest,
      expectedValue: expected.engineBundleDigest,
      rejection: 'engine-bundle-mismatch',
      label: 'engine bundle digest',
    },
    {
      field: 'executionBoundaryDigest',
      receiptValue: receipt.executionBoundaryDigest,
      expectedValue: expected.executionBoundaryDigest,
      rejection: 'boundary-mismatch',
      label: 'execution boundary digest',
    },
    {
      field: 'targetArtifactDigest',
      receiptValue: receipt.targetArtifactDigest,
      expectedValue: expected.targetArtifactDigest,
      rejection: 'artifact-mismatch',
      label: 'target artifact digest',
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
  candidateTreeId?: string | null;
  behaviorCatalogDigest?: string;
  requiredCaseSetDigest?: string;
  caseExecutionDigest?: string;
  engineBundleDigest?: string;
  executionBoundaryDigest?: string;
  targetArtifactDigest?: string;
}
