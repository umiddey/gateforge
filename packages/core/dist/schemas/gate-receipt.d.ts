/**
 * Gate receipt schema (plan 2026-09-13 §5.1 row "Gate receipt", ADR 0005
 * D3): a NEW versioned, domain-separated envelope issued by trusted
 * supervision only after complete run success and evidence grading.
 *
 * A receipt NEVER reuses or repurposes the v2 witness attestation
 * (`gateforge.ledger.v2`): old evidence stays valid only for its original
 * weaker contract. The receipt binds — in one authenticated object — the
 * tested input digest, base/parent Git identity, the trusted policy
 * revision digest (ADR 0005 D6), the invocation, the selection/catalog
 * digests, the supervision execution-result digest, the evidence
 * attestation digest, and the final verdict summary. The MAC is computed
 * with the SAME authority as witness records (the witness verifier key,
 * HMAC-SHA256 over GF-canonical JSON) — see `src/receipt/index.ts`.
 */
import { z } from 'zod';
/** The final verdict summary the receipt seals. */
export declare const ReceiptVerdictSummarySchema: z.ZodObject<{
    total: z.ZodNumber;
    satisfied: z.ZodNumber;
    waived: z.ZodNumber;
    blocking: z.ZodNumber;
}, z.core.$strict>;
/** Inferred receipt verdict-summary shape. */
export type ReceiptVerdictSummary = z.infer<typeof ReceiptVerdictSummarySchema>;
/**
 * The gate receipt. Unsigned fields first, `mac` last; the signed body is
 * exactly `{domain, receiptVersion, ...everything except mac}`.
 */
export declare const GateReceiptSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    receiptVersion: z.ZodLiteral<1>;
    receiptId: z.ZodString;
    runId: z.ZodString;
    invocationId: z.ZodString;
    inputDigest: z.ZodString;
    gitSha: z.ZodNullable<z.ZodString>;
    parentSha: z.ZodNullable<z.ZodString>;
    trustedPolicyDigest: z.ZodString;
    approvedPolicyDigest: z.ZodOptional<z.ZodString>;
    invocation: z.ZodString;
    selectionDigest: z.ZodString;
    catalogDigest: z.ZodString;
    executionResultDigest: z.ZodString;
    evidenceAttestationDigest: z.ZodNullable<z.ZodString>;
    verdictSummary: z.ZodObject<{
        total: z.ZodNumber;
        satisfied: z.ZodNumber;
        waived: z.ZodNumber;
        blocking: z.ZodNumber;
    }, z.core.$strict>;
    issuedAt: z.ZodString;
    mac: z.ZodString;
}, z.core.$strict>;
/** Inferred gate-receipt shape. */
export type GateReceipt = z.infer<typeof GateReceiptSchema>;
//# sourceMappingURL=gate-receipt.d.ts.map