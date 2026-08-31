/**
 * EvidenceRecord schema (plan §4.7, pins #7/#11): typed records issued
 * by the witness service. This is the only evidence shape the verifier
 * trusts; test-side assertions never appear here.
 *
 * ADR 0001 / GF-23 encoded here: every record carries a service-issued
 * `recordId` and the `runId` of its run manifest. Records whose trust
 * tier is `claimed` (no service-issued provenance) can never produce a
 * `satisfied` verdict — the verdict engine enforces that.
 */
import { z } from 'zod';
/**
 * Optional bulk scope (pin #11): a single record may stand for `count`
 * homogeneous items. Obligations themselves stay per-resource; bulk
 * scope only widens what one record attests.
 */
export declare const BulkScopeSchema: z.ZodObject<{
    kind: z.ZodLiteral<"bulk">;
    count: z.ZodNumber;
}, z.core.$strict>;
/** Inferred bulk-scope shape. */
export type BulkScope = z.infer<typeof BulkScopeSchema>;
/**
 * A trusted evidence record issued by the witness service.
 */
export declare const EvidenceRecordSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    recordId: z.ZodString;
    runId: z.ZodUUID;
    trust: z.ZodEnum<{
        claimed: "claimed";
        witnessed: "witnessed";
    }>;
    obligationId: z.ZodString;
    kind: z.ZodString;
    testId: z.ZodOptional<z.ZodString>;
    payload: z.ZodOptional<z.ZodUnknown>;
    scope: z.ZodOptional<z.ZodObject<{
        kind: z.ZodLiteral<"bulk">;
        count: z.ZodNumber;
    }, z.core.$strict>>;
    issuedAt: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strict>;
/** Inferred evidence-record shape. */
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
//# sourceMappingURL=evidence.d.ts.map