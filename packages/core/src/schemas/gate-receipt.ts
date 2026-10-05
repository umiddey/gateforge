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

/** Inferred receipt-scope shape. */
export type ReceiptScope = z.infer<typeof ReceiptScopeSchema>;

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

/** Inferred receipt verdict-summary shape. */
export type ReceiptVerdictSummary = z.infer<typeof ReceiptVerdictSummarySchema>;


/**
 * The gate receipt. Unsigned fields first, `mac` last; the signed body is
 * exactly `{domain, receiptVersion, ...everything except mac}`.
 */
export const GateReceiptSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Envelope version; only `2` is produced or honored (v1 rejected). */
    receiptVersion: z.literal(2),
    /** Receipt identity (UUID) — the `reused receipt <id>` surface value. */
    receiptId: z.string().uuid(),
    /** Non-secret verifier-key id used for safe key-ring rotation. */
    verifierKeyId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional(),
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
     * nothing and is refused at planning, never receipted) — except the
     * `docsOnly` slice below, a changed-scope receipt whose covered set
     * is empty BY CONSTRUCTION.
     */
    coveredObligationFingerprints: z.array(FingerprintHexSchema).optional(),
    /**
     * ADDITIVE v1 field, `scope: 'changed'` receipts ONLY: this receipt
     * seals the ENGINE-OWNED docs-only slice — the WHOLE changed set was
     * Markdown under `docs/`, so no obligation could arise from it and the
     * slice carries ZERO records. Such a receipt therefore covers NO
     * obligation: its `coveredObligationFingerprints` is empty, and a
     * consumer demands that identity for every obligation a later change
     * produces, so the next product change still needs its own evidence.
     *
     * Absent on every other seal. It is MAC-covered like every other
     * field, so the marking cannot be added after the fact; and a
     * consumer RECOMPUTES the docs-only decision from its own changed set
     * rather than believing this claim.
     */
    docsOnly: z.literal(true).optional(),
    /** Normalized invocation that produced the receipt (e.g. `test-gates --changed`). */
    invocation: z.string().min(1),
    /** 64-hex selection digest (the expected test set, fixed pre-run). */
    selectionDigest: z.string().regex(HEX64, 'selectionDigest must be 64-char lowercase hex'),
    /** 64-hex digest of the catalog the selection was planned from. */
    catalogDigest: z.string().regex(HEX64, 'catalogDigest must be 64-char lowercase hex'),
    /** 64-hex digest of the supervision execution result (ADR 0005 D2). */
    executionResultDigest: z.string().regex(HEX64, 'executionResultDigest must be 64-char lowercase hex'),
    /**
     * Immutable Git tree actually tested (40-char sha1, or null when the
     * workspace is not a Git checkout). The broker recomputes this from
     * raw candidate bytes and demands equality — a receipt for tree A
     * never authorizes tree B.
     */
    candidateTreeId: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'candidateTreeId must be a 40-char lowercase sha1 hex')
      .nullable(),
    /**
     * 64-hex digest of the compiled behavior catalog (the complete
     * endpoint/case set). Empty catalogs use the canonical empty digest,
     * never an omitted field.
     */
    behaviorCatalogDigest: z.string().regex(HEX64, 'behaviorCatalogDigest must be 64-char lowercase hex'),
    /**
     * 64-hex digest over the sorted full required case specifications
     * (not just stable case ids). Always signed, including full runs.
     */
    requiredCaseSetDigest: z.string().regex(HEX64, 'requiredCaseSetDigest must be 64-char lowercase hex'),
    /**
     * 64-hex digest over the executed case set (empty digest when no
     * behavior cases were executed in the sealed run).
     */
    caseExecutionDigest: z.string().regex(HEX64, 'caseExecutionDigest must be 64-char lowercase hex'),
    /**
     * ADDITIVE engine identity for comparing the installed CLI version
     * with the version that sealed this receipt. Optional so receipts
     * issued before this field retain their existing verification behavior.
     */
    engine: z
      .object({
        version: z.string().min(1),
        source: z.string().min(1),
        unpublished: z.boolean(),
      })
      .strict()
      .optional(),
    /** Additive stage that the installation configured for receipt enforcement. */
    receiptStage: z.enum(['pre-push', 'pre-commit', 'ci']).optional(),
    /** Commit sha of the full-scope receipt carried into this candidate. */
    carriedFrom: z.string().regex(/^[0-9a-f]{40}$/, 'carriedFrom must be a 40-char lowercase sha1 hex').optional(),
    /** Digest of the authenticated parent receipt whose proof was carried. */
    parentReceiptDigest: z.string().regex(HEX64, 'parentReceiptDigest must be 64-char lowercase hex').optional(),
    /**
     * ADDITIVE test-only re-seal binding: the 64-hex digest of the
     * VERIFIED parent receipt this run re-sealed from. Equal to
     * `parentReceiptDigest` (which stays the carried-proof binding) and
     * present only on a re-sealed receipt — a run that re-ran exactly
     * the tests a test-only change can affect and carried the rest from
     * the parent. The recomputation is the consumer's job: CI (and the
     * broker) diff the two sealed trees themselves and recompute the
     * classification, never trusting the claimed change class.
     */
    resealedFrom: z.string().regex(HEX64, 'resealedFrom must be 64-char lowercase hex').optional(),
    /**
     * ADDITIVE: WHICH kind of parent document `resealedFrom` names —
     * `receipt` (a verified gate receipt) or `run-record` (a whole-suite
     * run record, the only parent a run that sealed no receipt can
     * have). Absent reads as `receipt`, so every re-sealed receipt
     * sealed before this field existed keeps verifying unchanged. A
     * `run-record` re-seal carries NO `parentReceiptDigest` (there is no
     * parent receipt to name) and the consumer recomputes the run
     * record exactly like a parent receipt.
     */
    resealedFromKind: z.enum(['receipt', 'run-record']).optional(),
    /**
     * ADDITIVE: how many test outcomes this receipt carries unchanged
     * from the parent receipt (digest-bound to the parent's execution
     * result and evidence attestation). Absent on every other seal.
     */
    carriedTests: z.number().int().min(0).optional(),
    /** ADDITIVE: how many tests this invocation re-ran with fresh evidence. */
    rerunTests: z.number().int().min(0).optional(),
    /**
     * ADDITIVE change classification. Only one value exists today
     * (`test-only`); a receipt that carries it MUST carry the re-seal
     * fields above, and a receipt without it carries none of them.
     */
    changeClass: z.literal('test-only').optional(),
    /**
     * ADDITIVE: the changed repository-relative paths Gateforge itself
     * computed from the two sealed trees (sorted, duplicate-free) — the
     * claim CI recomputes. A CI recomputation that differs from this
     * list rejects the receipt (EVIDENCE_STALE).
     */
    changedPaths: z.array(z.string().min(1)).optional(),
    /**
     * ADDITIVE: the changed paths the OWNER declaration
     * `enforcement.resealRuntimeFiles` kept out of the classification —
     * runtime state the run itself rewrites, which no sealed commit
     * tracks. Present only when at least one path was disregarded, and
     * bound by the receipt MAC like every other re-seal field: the
     * consumer recomputes the list from the same globs and the two
     * commit trees, and any difference is `EVIDENCE_STALE`.
     */
    resealDisregarded: z.array(z.string().min(1)).optional(),
    /** 64-hex digest binding the approved engine/policy bundle version. */
    engineBundleDigest: z.string().regex(HEX64, 'engineBundleDigest must be 64-char lowercase hex'),
    /**
     * 64-hex digest binding the controller-issued record of the active
     * execution profile. Local runs seal `local-unisolated`, which a
     * protected authority never accepts for managed acceptance.
     */
    executionBoundaryDigest: z.string().regex(HEX64, 'executionBoundaryDigest must be 64-char lowercase hex'),
    /**
     * 64-hex digest identifying the controlled app build derived from the
     * candidate tree (local runs bind the source tree itself; managed
     * builds bind the real build artifact).
     */
    targetArtifactDigest: z.string().regex(HEX64, 'targetArtifactDigest must be 64-char lowercase hex'),
    /**
     * 64-hex digest of the v2 evidence attestation envelope sealed into
     * the receipt, or null when the run carried none (such a run can only
     * be clean when no evidence was required).
     */
    evidenceAttestationDigest: z.string().regex(HEX64, 'evidenceAttestationDigest must be 64-char lowercase hex').nullable(),
    /**
     * ADDITIVE: canonical digest of the EVIDENCE UNION this re-seal
     * sealed — the parent run's carried witness-issued records and
     * claims together with the re-run's own, exactly as they stand in
     * the run state. A re-seal carries a test's outcomes AND the
     * evidence those outcomes were witnessed with; this field binds
     * that second half, so a consumer recomputes the union from the
     * retained parent documents and demands the state evidence equal it
     * (any difference is `EVIDENCE_STALE`). MAC-bound like every other
     * re-seal field.
     */
    carriedEvidenceDigest: z.string().regex(HEX64, 'carriedEvidenceDigest must be 64-char lowercase hex').optional(),
    /** Final verdict summary (blocking must have been 0 at issuance). */
    verdictSummary: ReceiptVerdictSummarySchema,
    /** Issuance instant (ISO-8601). */
    issuedAt: z.string().datetime(),
    /** HMAC-SHA256 over the receipt body, domain `gateforge.receipt.v2`. */
    mac: z.string().regex(HEX64, 'mac must be a 64-char lowercase hex HMAC'),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if ((receipt.carriedFrom === undefined) !== (receipt.parentReceiptDigest === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['parentReceiptDigest'],
        message: 'carriedFrom and parentReceiptDigest must be present together',
      });
    }
    // Re-seal coherence (fail closed): the re-seal fields stand or fall
    // together, and a `test-only` change class is a CLAIM a consumer
    // must recompute — it never certifies itself. A receipt naming some
    // of them is malformed, never half-believed.
    const resealFields = [receipt.resealedFrom, receipt.carriedTests, receipt.rerunTests, receipt.changeClass] as const;
    const presentResealFields = resealFields.filter((field) => field !== undefined).length;
    if (presentResealFields > 0 && presentResealFields < resealFields.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['resealedFrom'],
        message: 'resealedFrom, carriedTests, rerunTests and changeClass must be present together',
      });
      return;
    }
    if (receipt.resealedFromKind !== undefined && presentResealFields !== resealFields.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['resealedFromKind'],
        message: 'resealedFromKind is a re-seal binding and stands or falls with the re-seal fields',
      });
    }
    if (receipt.resealDisregarded !== undefined && presentResealFields !== resealFields.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['resealDisregarded'],
        message: 'resealDisregarded is a re-seal binding and stands or falls with the re-seal fields',
      });
    }
    // The carried-EVIDENCE binding is a re-seal binding: a receipt that
    // carries one half of a re-seal's proof without the other is
    // malformed, never half-believed.
    if (receipt.carriedEvidenceDigest !== undefined && presentResealFields !== resealFields.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['carriedEvidenceDigest'],
        message: 'carriedEvidenceDigest is a re-seal binding and stands or falls with the re-seal fields',
      });
    }
    if (presentResealFields === resealFields.length) {
      // A `run-record` parent is NOT a receipt: `resealedFrom` then
      // names the run record's own digest and no carried-receipt binding
      // may be claimed. A `receipt` parent keeps the identity rule.
      if (receipt.resealedFromKind === 'run-record') {
        if (receipt.parentReceiptDigest !== undefined || receipt.carriedFrom !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['parentReceiptDigest'],
            message: 'a run-record re-seal names no parent receipt, so it carries no parentReceiptDigest',
          });
          return;
        }
      } else if (receipt.resealedFrom !== receipt.parentReceiptDigest) {
        ctx.addIssue({
          code: 'custom',
          path: ['resealedFrom'],
          message: 'resealedFrom must equal the parentReceiptDigest it re-sealed from',
        });
        return;
      }
      const paths = receipt.changedPaths ?? [];
      const sortedPaths = [...paths].sort();
      for (let index = 0; index < paths.length; index += 1) {
        if (paths[index] !== sortedPaths[index]) {
          ctx.addIssue({
            code: 'custom',
            path: ['changedPaths', index],
            message: "changedPaths must be sorted; expected '" + String(sortedPaths[index]) + "' at index " + String(index),
          });
          return;
        }
      }
      // The disregarded list is a CLAIM the consumer recomputes entry
      // for entry, so it is sorted exactly like `changedPaths`: an
      // unordered claim could never be reproduced.
      const disregarded = receipt.resealDisregarded ?? [];
      const sortedDisregarded = [...disregarded].sort();
      for (let index = 0; index < disregarded.length; index += 1) {
        if (disregarded[index] !== sortedDisregarded[index]) {
          ctx.addIssue({
            code: 'custom',
            path: ['resealDisregarded', index],
            message:
              "resealDisregarded must be sorted; expected '" +
              String(sortedDisregarded[index]) +
              "' at index " +
              String(index),
          });
          return;
        }
      }
    }
    // Scope/coverage coherence (fail closed): the covered set exists only
    // for changed-scope receipts, and a changed-scope receipt without one
    // would claim authority over an unnamed slice. Ordering/duplication
    // are enforced so the canonical signed bytes are deterministic.
    // The docs-only slice is the ONE changed-scope receipt that names no
    // covered obligation: its whole changed set was `docs/**.md`, so none
    // could arise from it. The marking is what earns that exemption, so
    // the two stand or fall together in both directions.
    if (receipt.docsOnly !== undefined && receipt.scope !== 'changed') {
      ctx.addIssue({
        code: 'custom',
        path: ['docsOnly'],
        message: "only a 'changed'-scope receipt may seal the docs-only slice",
      });
    }
    if (receipt.scope === 'changed') {
      const covered = receipt.coveredObligationFingerprints;
      if (receipt.docsOnly !== undefined) {
        // The docs-only slice covers nothing, so it must not also claim a
        // covered obligation: a receipt naming both contradicts itself.
        if (covered !== undefined && covered.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['coveredObligationFingerprints'],
            message: 'a docs-only receipt covers no obligation, so it must not name one',
          });
        }
        return;
      }
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
            message:
              "coveredObligationFingerprints must be sorted; expected '" + expected +
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

/** Inferred gate-receipt shape. */
export type GateReceipt = z.infer<typeof GateReceiptSchema>;
