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
//# sourceMappingURL=verdict.d.ts.map