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
 *
 * Scope extension (opt-in scoped supervised runs): a receipt also names
 * its evaluation scope (`scope`, absent = `full` for pre-extension
 * receipts) and, for `changed`-scope receipts, the pin-#2 fingerprints of
 * the obligations the sealed slice covers. Both fields sit inside the
 * signed body (the MAC covers every field but `mac` by construction), so
 * a covered set cannot be widened or trimmed without breaking the
 * signature.
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';
import { FingerprintHexSchema } from './baseline.js';
/** Hex pattern shared by every digest field. */
const HEX64 = /^[0-9a-f]{64}$/;
/**
 * The evaluation scope a receipt seals (opt-in scoped supervised runs):
 * - `full` — the whole relevant suite ran and the whole-repo gate was
 *   green (the historical, default shape);
 * - `changed` — only the SLICE of tests claiming obligations affected by
 *   the changed files ran, and only those obligations were graded.
 * OPTIONAL/additive like `approvedPolicyDigest`: receipts sealed before
 * scoped runs existed omit it and are read as `full` (that is exactly
 * what the old seal process certified).
 */
export const ReceiptScopeSchema = z.enum(['full', 'changed']);
/** The final verdict summary the receipt seals. */
export const ReceiptVerdictSummarySchema = z
    .object({
    /** Number of obligations evaluated. */
    total: z.number().int().min(0),
    /** Obligations graded `satisfied`. */
    satisfied: z.number().int().min(0),
    /** Obligations graded `waived` (legacy/reporting; not strict proof). */
    waived: z.number().int().min(0),
    /** Blocking obligations + blocking entries (must be 0 for issuance). */
    blocking: z.number().int().min(0),
})
    .strict()
    .superRefine((summary, ctx) => {
    if (summary.satisfied + summary.waived > summary.total) {
        ctx.addIssue({
            code: 'custom',
            message: 'satisfied + waived cannot exceed total obligations',
        });
    }
});
/**
 * The gate receipt. Unsigned fields first, `mac` last; the signed body is
 * exactly `{domain, receiptVersion, ...everything except mac}`.
 */
export const GateReceiptSchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /** Envelope version; only `1` is produced or honored. */
    receiptVersion: z.literal(1),
    /** Receipt identity (UUID) — the `reused receipt <id>` surface value. */
    receiptId: z.string().uuid(),
    /** Run manifest identity of the sealed run. */
    runId: z.string().uuid(),
    /** Fresh trusted invocation identity of the sealed run. */
    invocationId: z.string().uuid(),
    /** 64-hex digest of the canonical input snapshot the run tested. */
    inputDigest: z.string().regex(HEX64, 'inputDigest must be 64-char lowercase hex'),
    /** Candidate HEAD sha, or null when unavailable (base identity). */
    gitSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/, 'gitSha must be a 40-char lowercase sha1 hex')
        .nullable(),
    /** Parent commit sha, or null when unavailable (parent identity). */
    parentSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/, 'parentSha must be a 40-char lowercase sha1 hex')
        .nullable(),
    /** 64-hex trusted policy/config revision digest (ADR 0005 D6). */
    trustedPolicyDigest: z.string().regex(HEX64, 'trustedPolicyDigest must be 64-char lowercase hex'),
    /**
     * ADDITIVE v1 field: 64-hex digest of the OWNER-APPROVED policy
     * revision the sealing run was pinned to (from
     * `GATEFORGE_APPROVED_POLICY_DIGEST` / `--approved-policy-digest` /
     * a trusted config outside the candidate). OPTIONAL for backward
     * compatibility: receipts sealed before a policy pin was provisioned
     * omit it and remain verifiable without a pin; verification under a
     * provisioned pin demands it and rejects a missing or different value
     * as "policy revision changed after sealing" (fail closed).
     */
    approvedPolicyDigest: z
        .string()
        .regex(HEX64, 'approvedPolicyDigest must be 64-char lowercase hex')
        .optional(),
    /**
     * ADDITIVE v1 field: the evaluation scope the receipt seals. OPTIONAL
     * for backward compatibility — absent reads as `full`, which is what
     * the historical seal process (whole relevant suite, whole-repo clean
     * gate) certified. See {@link ReceiptScopeSchema}.
     */
    scope: ReceiptScopeSchema.optional(),
    /**
     * ADDITIVE v1 field, `scope: 'changed'` receipts ONLY: the pin-#2
     * fingerprints of the obligations the sealed slice covers (sorted,
     * duplicate-free). Fingerprints — not obligation ids — because they
     * are the SAME identity the baseline/waiver layers hash
     * (`obligationFingerprint`), so every consumer joins covered sets
     * through one hash and a policy/lifecycle change (which moves the
     * fingerprint) cannot let an old receipt claim a reshaped obligation.
     * A `full` receipt must NOT carry the field (it covers everything by
     * definition); a `changed` receipt must (an empty slice seals
     * nothing and is refused at planning, never receipted).
     */
    coveredObligationFingerprints: z.array(FingerprintHexSchema).optional(),
    /** Normalized invocation that produced the receipt (e.g. `test-gates --changed`). */
    invocation: z.string().min(1),
    /** 64-hex selection digest (the expected test set, fixed pre-run). */
    selectionDigest: z.string().regex(HEX64, 'selectionDigest must be 64-char lowercase hex'),
    /** 64-hex digest of the catalog the selection was planned from. */
    catalogDigest: z.string().regex(HEX64, 'catalogDigest must be 64-char lowercase hex'),
    /** 64-hex digest of the supervision execution result (ADR 0005 D2). */
    executionResultDigest: z.string().regex(HEX64, 'executionResultDigest must be 64-char lowercase hex'),
    /**
     * 64-hex digest of the v2 evidence attestation envelope sealed into
     * the receipt, or null when the run carried none (such a run can only
     * be clean when no evidence was required).
     */
    evidenceAttestationDigest: z.string().regex(HEX64, 'evidenceAttestationDigest must be 64-char lowercase hex').nullable(),
    /** Final verdict summary (blocking must have been 0 at issuance). */
    verdictSummary: ReceiptVerdictSummarySchema,
    /** Issuance instant (ISO-8601). */
    issuedAt: z.string().datetime(),
    /** HMAC-SHA256 over the receipt body, domain `gateforge.receipt.v1`. */
    mac: z.string().regex(HEX64, 'mac must be a 64-char lowercase hex HMAC'),
})
    .strict()
    .superRefine((receipt, ctx) => {
    // Scope/coverage coherence (fail closed): the covered set exists only
    // for changed-scope receipts, and a changed-scope receipt without one
    // would claim authority over an unnamed slice. Ordering/duplication
    // are enforced so the canonical signed bytes are deterministic.
    if (receipt.scope === 'changed') {
        const covered = receipt.coveredObligationFingerprints;
        if (covered === undefined || covered.length === 0) {
            ctx.addIssue({
                code: 'custom',
                path: ['coveredObligationFingerprints'],
                message: "a 'changed'-scope receipt must carry its coveredObligationFingerprints",
            });
            return;
        }
        const sorted = [...covered].sort();
        for (let index = 0; index < covered.length; index += 1) {
            const current = covered[index];
            const expected = sorted[index];
            if (current !== expected) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['coveredObligationFingerprints', index],
                    message: "coveredObligationFingerprints must be sorted; expected '" + expected +
                        "' at index " + index + ", got '" + current + "'",
                });
                return;
            }
            if (index > 0 && current === covered[index - 1]) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['coveredObligationFingerprints', index],
                    message: `duplicate covered fingerprint '${current}'`,
                });
                return;
            }
        }
        return;
    }
    if (receipt.coveredObligationFingerprints !== undefined) {
        ctx.addIssue({
            code: 'custom',
            path: ['coveredObligationFingerprints'],
            message: "only a 'changed'-scope receipt may carry coveredObligationFingerprints",
        });
    }
});
//# sourceMappingURL=gate-receipt.js.map