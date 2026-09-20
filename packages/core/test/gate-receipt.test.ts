/**
 * Gate-receipt unit tests (plan 2026-09-13 §5.1 row "Gate receipt", ADR
 * 0005 D3): versioned, domain-separated authentication over the complete
 * run binding. Verification is fail-closed — a forged or tampered
 * receipt is a `mac-fail`, a digest mismatch is typed per field, a
 * blocking verdict summary is `not-clean`, and the receipt MAC can never
 * verify as a v2 ledger attestation (nor the reverse).
 */
import { describe, expect, it } from 'vitest';
import {
  GateReceiptSchema,
  RECEIPT_DOMAIN,
  RECEIPT_VERSION,
  attestationMac,
  gateReceiptMac,
  verifyAttestationMac,
  verifyGateReceipt,
  type GateReceipt,
} from '../src/index.js';

const KEY = 'test-verifier-key';
const HEX = (seed: number): string => String(seed).repeat(32) + String(seed).repeat(32);
const DIGEST = HEX(1);
const OTHER = HEX(2);

/** A valid clean receipt body (no mac). */
function body(overrides: Partial<Omit<GateReceipt, 'mac'>> = {}): Omit<GateReceipt, 'mac'> {
  return {
    schemaVersion: 1,
    receiptVersion: 2,
    receiptId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    runId: '11111111-2222-4333-8444-555555555555',
    invocationId: '66666666-7777-4888-8999-000000000000',
    inputDigest: DIGEST,
    gitSha: null,
    parentSha: null,
    trustedPolicyDigest: HEX(3),
    invocation: 'test-gates --changed',
    selectionDigest: HEX(4),
    catalogDigest: HEX(5),
    executionResultDigest: HEX(6),
    evidenceAttestationDigest: null,
    candidateTreeId: null,
    behaviorCatalogDigest: 'b'.repeat(64),
    requiredCaseSetDigest: 'c'.repeat(64),
    caseExecutionDigest: 'd'.repeat(64),
    engineBundleDigest: 'e'.repeat(64),
    executionBoundaryDigest: 'f'.repeat(64),
    targetArtifactDigest: 'a'.repeat(64),
    verdictSummary: { total: 2, satisfied: 2, waived: 0, blocking: 0 },
    issuedAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

/** A fully signed receipt for `body()`. */
function signed(overrides: Partial<Omit<GateReceipt, 'mac'>> = {}): GateReceipt {
  const base = body(overrides);
  return { ...base, mac: gateReceiptMac(KEY, base) };
}

describe('gate receipt issuance round-trip', () => {
  it('a correctly signed receipt verifies with no expectations', () => {
    const receipt = signed();
    const outcome = verifyGateReceipt(KEY, JSON.parse(JSON.stringify(receipt)));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt).toEqual(receipt);
  });

  it('a correctly signed receipt verifies when every expected digest matches', () => {
    const receipt = signed();
    const outcome = verifyGateReceipt(KEY, receipt, {
      inputDigest: DIGEST,
      trustedPolicyDigest: HEX(3),
      selectionDigest: HEX(4),
      catalogDigest: HEX(5),
      executionResultDigest: HEX(6),
      evidenceAttestationDigest: null,
    });
    expect(outcome.ok).toBe(true);
  });

  it('the produced document parses against the strict v2 schema', () => {
    expect(GateReceiptSchema.safeParse(signed()).success).toBe(true);
  });
});

describe('gate receipt fail-closed rejections', () => {
  it('a missing receipt is `missing`', () => {
    expect(verifyGateReceipt(KEY, null)).toMatchObject({ ok: false, rejection: 'missing' });
    expect(verifyGateReceipt(KEY, undefined)).toMatchObject({ ok: false, rejection: 'missing' });
  });

  it('a structurally wrong receipt is `malformed`', () => {
    expect(verifyGateReceipt(KEY, { hello: 'world' })).toMatchObject({ ok: false, rejection: 'malformed' });
    expect(verifyGateReceipt(KEY, 'a string')).toMatchObject({ ok: false, rejection: 'malformed' });
    expect(verifyGateReceipt(KEY, [])).toMatchObject({ ok: false, rejection: 'malformed' });
  });

  it('an unknown extra key is rejected by the strict schema (malformed)', () => {
    const forged: Record<string, unknown> = { ...signed(), extraAuthority: true };
    expect(verifyGateReceipt(KEY, forged)).toMatchObject({ ok: false, rejection: 'malformed' });
  });

  it('a receipt whose mac was flipped is `mac-fail` (forged)', () => {
    const receipt = signed();
    const flipped = { ...receipt, mac: receipt.mac.split('').reverse().join('') };
    expect(verifyGateReceipt(KEY, flipped)).toMatchObject({ ok: false, rejection: 'mac-fail' });
  });

  it('a tampered body field (digest swapped under the original mac) is `mac-fail`', () => {
    const receipt = signed();
    const tampered = { ...receipt, inputDigest: OTHER };
    expect(verifyGateReceipt(KEY, tampered)).toMatchObject({ ok: false, rejection: 'mac-fail' });
  });

  it('a receipt signed by a different verifier key is `mac-fail`', () => {
    expect(verifyGateReceipt('another-key', signed())).toMatchObject({ ok: false, rejection: 'mac-fail' });
  });

  it('a non-hex mac string is structurally `malformed`, never a downgrade', () => {
    const receipt = signed();
    expect(verifyGateReceipt(KEY, { ...receipt, mac: 'deadbeef' })).toMatchObject({ ok: false, rejection: 'malformed' });
  });

  it('each binding mismatch is typed per field', () => {
    const receipt = signed();
    const cases: Array<[Parameters<typeof verifyGateReceipt>[2], string]> = [
      [{ inputDigest: OTHER }, 'input-digest-mismatch'],
      [{ trustedPolicyDigest: OTHER }, 'policy-digest-mismatch'],
      [{ selectionDigest: OTHER }, 'selection-digest-mismatch'],
      [{ catalogDigest: OTHER }, 'catalog-digest-mismatch'],
      [{ executionResultDigest: OTHER }, 'execution-digest-mismatch'],
      [{ evidenceAttestationDigest: OTHER }, 'attestation-digest-mismatch'],
      [{ candidateTreeId: 'a'.repeat(40) }, 'tree-mismatch'],
      [{ behaviorCatalogDigest: OTHER }, 'behavior-digest-mismatch'],
      [{ requiredCaseSetDigest: OTHER }, 'case-set-mismatch'],
      [{ caseExecutionDigest: OTHER }, 'case-execution-mismatch'],
      [{ engineBundleDigest: OTHER }, 'engine-bundle-mismatch'],
      [{ executionBoundaryDigest: OTHER }, 'boundary-mismatch'],
      [{ targetArtifactDigest: OTHER }, 'artifact-mismatch'],
    ];
    for (const [expected, rejection] of cases) {
      expect(verifyGateReceipt(KEY, receipt, expected), rejection).toMatchObject({ ok: false, rejection });
    }
  });

  it('an evidence-attestation mismatch is typed when the receipt carries one', () => {
    const receipt = signed({ evidenceAttestationDigest: HEX(7) });
    expect(
      verifyGateReceipt(KEY, receipt, { evidenceAttestationDigest: OTHER }),
    ).toMatchObject({ ok: false, rejection: 'attestation-digest-mismatch' });
    expect(
      verifyGateReceipt(KEY, receipt, { evidenceAttestationDigest: null }),
    ).toMatchObject({ ok: false, rejection: 'attestation-digest-mismatch' });
  });

  it('a receipt sealing a blocking verdict summary is `not-clean` (receipts exist only for complete success)', () => {
    const receipt = signed({ verdictSummary: { total: 2, satisfied: 1, waived: 0, blocking: 1 } });
    expect(GateReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(verifyGateReceipt(KEY, receipt)).toMatchObject({ ok: false, rejection: 'not-clean' });
  });

  it('an unmacable receipt with a missing verifier key fails closed (mac-fail), never throws', () => {
    const receipt = signed();
    expect(verifyGateReceipt('', receipt)).toMatchObject({ ok: false, rejection: 'mac-fail' });
  });

  it('gateReceiptMac throws a TypeError on an empty verifier key', () => {
    expect(() => gateReceiptMac('', body())).toThrow(TypeError);
  });
});

describe('gate receipt schema pinning', () => {
  it('only receiptVersion 2 is honored', () => {
    const v1 = body({ receiptVersion: 1 as never });
    expect(GateReceiptSchema.safeParse({ ...v1, mac: '0'.repeat(64) }).success).toBe(false);
  });

  it('a v1 receipt is rejected with a fresh-run instruction, never re-signed', () => {
    const v1receipt = { ...body({ receiptVersion: 1 as never }), mac: '0'.repeat(64) };
    expect(verifyGateReceipt(KEY, v1receipt)).toMatchObject({ ok: false, rejection: 'malformed' });
  });

  it('RECEIPT_DOMAIN and RECEIPT_VERSION are the v2 pin', () => {
    expect(RECEIPT_DOMAIN).toBe('gateforge.receipt.v2');
    expect(RECEIPT_VERSION).toBe(2);
  });

  it('a verdict summary whose satisfied + waived exceed total is rejected', () => {
    const bad = body({ verdictSummary: { total: 1, satisfied: 1, waived: 1, blocking: 0 } });
    expect(GateReceiptSchema.safeParse({ ...bad, mac: '0'.repeat(64) }).success).toBe(false);
  });
});

describe('approvedPolicyDigest binding (review 2026-09-13 P1 #5, additive v1 field)', () => {
  it('a receipt carrying the approved-policy binding parses and verifies (MAC covers it)', () => {
    const receipt = signed({ approvedPolicyDigest: HEX(8) });
    expect(GateReceiptSchema.safeParse(receipt).success).toBe(true);
    const outcome = verifyGateReceipt(KEY, JSON.parse(JSON.stringify(receipt)));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.receipt.approvedPolicyDigest).toBe(HEX(8));
  });

  it('old receipts without the field remain schema-valid and verifiable (additive, no pin)', () => {
    const receipt = signed();
    expect('approvedPolicyDigest' in receipt).toBe(false);
    expect(GateReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(verifyGateReceipt(KEY, receipt)).toMatchObject({ ok: true });
  });

  it('tampering the approved-policy binding under the original mac is `mac-fail`', () => {
    const receipt = signed({ approvedPolicyDigest: HEX(8) });
    const tampered = { ...receipt, approvedPolicyDigest: HEX(9) };
    expect(verifyGateReceipt(KEY, tampered)).toMatchObject({ ok: false, rejection: 'mac-fail' });
  });

  it('a malformed approvedPolicyDigest is rejected by the strict schema', () => {
    const bad = body({ approvedPolicyDigest: 'deadbeef' });
    expect(GateReceiptSchema.safeParse({ ...bad, mac: '0'.repeat(64) }).success).toBe(false);
  });
});

describe('domain separation (ADR 0005 D3: no cross-format acceptance)', () => {
  it('the receipt MAC never equals a v2 ledger attestation MAC for the same fields and key', () => {
    const receipt = signed();
    const attestationMacValue = attestationMac(KEY, {
      runId: receipt.runId,
      invocationId: receipt.invocationId,
      inputDigest: receipt.inputDigest,
      recordIds: [],
    });
    expect(receipt.mac).not.toBe(attestationMacValue);
  });

  it('a v2 attestation document cannot verify as a gate receipt (malformed, not a pass)', () => {
    const attestation = {
      attestationVersion: 2,
      runId: '11111111-2222-4333-8444-555555555555',
      invocationId: '66666666-7777-4888-8999-000000000000',
      inputDigest: DIGEST,
      recordIds: [],
      mac: attestationMac(KEY, {
        runId: '11111111-2222-4333-8444-555555555555',
        invocationId: '66666666-7777-4888-8999-000000000000',
        inputDigest: DIGEST,
        recordIds: [],
      }),
    };
    expect(verifyGateReceipt(KEY, attestation)).toMatchObject({ ok: false, rejection: 'malformed' });
  });

  it('a gate receipt MAC cannot verify as a v2 ledger attestation', () => {
    const receipt = signed();
    expect(
      verifyAttestationMac(KEY, {
        runId: receipt.runId,
        invocationId: receipt.invocationId,
        inputDigest: receipt.inputDigest,
        recordIds: [],
      }, receipt.mac),
    ).toBe(false);
  });
});
