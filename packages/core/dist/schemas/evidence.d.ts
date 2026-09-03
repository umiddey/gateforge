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
 * Where a record's contents came from (part of the hashed identity,
 * pin #7). `suite-submitted` records carry the TESTED SUITE's own
 * assertion — the witness received it but cannot verify it happened —
 * and are stamped `trust: 'claimed'` at issuance. `engine-observed`
 * records carry contents the witness itself produced from an
 * engine-side observation (the adapter read behind
 * `persistence.entity`) and are stamped `trust: 'witnessed'`.
 */
export declare const RecordOriginSchema: z.ZodEnum<{
    "suite-submitted": "suite-submitted";
    "engine-observed": "engine-observed";
}>;
/** Inferred record-origin shape. */
export type RecordOrigin = z.infer<typeof RecordOriginSchema>;
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
    origin: z.ZodOptional<z.ZodEnum<{
        "suite-submitted": "suite-submitted";
        "engine-observed": "engine-observed";
    }>>;
    scope: z.ZodOptional<z.ZodObject<{
        kind: z.ZodLiteral<"bulk">;
        count: z.ZodNumber;
    }, z.core.$strict>>;
    issuedAt: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strict>;
/** Inferred evidence-record shape. */
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
//# sourceMappingURL=evidence.d.ts.map