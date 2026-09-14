/**
 * Verdict + UnresolvedReason schemas (ADR 0001 seven verdicts, pin #5
 * unresolved-entry shape). The pure evaluator itself lives in
 * `src/verdict` (G3); these are the frozen data shapes it speaks.
 */
import { z } from 'zod';
/**
 * The seven verdicts. Blocking (non-clean) verdicts: `missing`,
 * `invalid`, `unclassified`, `unresolved`, `stale`. Clean: `satisfied`,
 * `waived`.
 */
export declare const VerdictSchema: z.ZodEnum<{
    satisfied: "satisfied";
    missing: "missing";
    invalid: "invalid";
    unclassified: "unclassified";
    unresolved: "unresolved";
    waived: "waived";
    stale: "stale";
}>;
/** Inferred verdict shape. */
export type Verdict = z.infer<typeof VerdictSchema>;
/** Machine-readable reason attached to `unresolved` verdicts. */
export declare const UnresolvedReasonSchema: z.ZodObject<{
    code: z.ZodString;
    detail: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Inferred unresolved-reason shape. */
export type UnresolvedReason = z.infer<typeof UnresolvedReasonSchema>;
/**
 * Stable cause codes for the shared report model (plan §5.4, ADR 0005).
 * Blocking-obligation causes name WHY an obligation is not satisfied and
 * select its next action; the three `DIAGNOSTIC_*` codes are advisory
 * result causes for the separate diagnostic run (plan §3.5) — never
 * obligation verdicts. The seven verdict VALUES are unchanged; causes
 * enrich them without weakening any contract.
 */
export declare const CauseCodeSchema: z.ZodEnum<{
    TEST_INVENTORY_INCOMPLETE: "TEST_INVENTORY_INCOMPLETE";
    TEST_KIND_UNKNOWN: "TEST_KIND_UNKNOWN";
    TEST_MAPPING_MISSING: "TEST_MAPPING_MISSING";
    TEST_MAPPING_AMBIGUOUS: "TEST_MAPPING_AMBIGUOUS";
    TEST_MAPPING_STALE: "TEST_MAPPING_STALE";
    EVIDENCE_NOT_COLLECTED: "EVIDENCE_NOT_COLLECTED";
    VERIFIER_UNSUPPORTED: "VERIFIER_UNSUPPORTED";
    TEST_NOT_EXECUTED: "TEST_NOT_EXECUTED";
    TEST_FAILED: "TEST_FAILED";
    RUN_INCOMPLETE: "RUN_INCOMPLETE";
    EVIDENCE_STALE: "EVIDENCE_STALE";
    CHANGE_UNMAPPED: "CHANGE_UNMAPPED";
    ENFORCEMENT_UNTRUSTED: "ENFORCEMENT_UNTRUSTED";
    EVIDENCE_VALUE_MISMATCH: "EVIDENCE_VALUE_MISMATCH";
    CRUD_COVERAGE_MISSING: "CRUD_COVERAGE_MISSING";
    DIAGNOSTIC_TEST_FAILURE: "DIAGNOSTIC_TEST_FAILURE";
    DIAGNOSTIC_RUN_INCOMPLETE: "DIAGNOSTIC_RUN_INCOMPLETE";
    DIAGNOSTIC_RESULT_STALE: "DIAGNOSTIC_RESULT_STALE";
}>;
/** Inferred cause-code union. */
export type CauseCode = z.infer<typeof CauseCodeSchema>;
/**
 * The plan §5.4 next action per cause code. Text, JSON, and SARIF
 * renderings all carry the same strings so every surface agrees on what
 * to do next.
 */
export declare const CAUSE_NEXT_ACTIONS: Readonly<Record<CauseCode, string>>;
//# sourceMappingURL=verdict.d.ts.map