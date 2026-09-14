/**
 * Coverage-policy schemas (plan 2026-09-13 §3.6, Phase 0 item 7, ADR
 * 0005 D5): a tracked, OWNER-OWNED configuration section enumerating
 * user-facing tables, their required real-UI CRUD operations, and any
 * owner disposition excusing a table from that coverage. Recording or
 * approving a disposition is a trusted-policy act — an agent edit never
 * self-approves, because the section participates in the trusted policy
 * revision identity.
 */
import { z } from 'zod';
/** The four real-UI operations a table may require coverage for. */
export declare const COVERAGE_OPERATIONS: readonly ["create", "read", "update", "delete"];
/** The operation union a coverage policy may require. */
export declare const CoverageOperationSchema: z.ZodEnum<{
    create: "create";
    read: "read";
    update: "update";
    delete: "delete";
}>;
/** Inferred coverage-operation type. */
export type CoverageOperation = (typeof COVERAGE_OPERATIONS)[number];
/**
 * An OWNER disposition (plan §3.6): the recorded reason a table owes no
 * real-UI coverage for its required operations. Kinds are closed-world;
 * `other` requires the note to stay auditable. Approving one is a
 * trusted-policy act, never an agent self-approval.
 */
export declare const CoverageDispositionSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        "read-only-surface": "read-only-surface";
        "admin-plane-unreachable": "admin-plane-unreachable";
        "not-user-facing": "not-user-facing";
        other: "other";
    }>;
    note: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Inferred coverage-disposition type. */
export type CoverageDisposition = z.infer<typeof CoverageDispositionSchema>;
/** One policy-enumerated user-facing table. */
export declare const CoverageTableSchema: z.ZodObject<{
    name: z.ZodString;
    requiredOperations: z.ZodArray<z.ZodEnum<{
        create: "create";
        read: "read";
        update: "update";
        delete: "delete";
    }>>;
    disposition: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            "read-only-surface": "read-only-surface";
            "admin-plane-unreachable": "admin-plane-unreachable";
            "not-user-facing": "not-user-facing";
            other: "other";
        }>;
        note: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred coverage-table type. */
export type CoverageTable = z.infer<typeof CoverageTableSchema>;
/**
 * The `coveragePolicy` config section (plan §3.6). Absent or empty
 * (`tables: []`) means the feature is OFF — enabling it is an explicit,
 * tracked owner decision. Table names must be unique (a duplicate would
 * make the enforcement scope ambiguous); each name is validated against
 * the current run's resource inventory on every run.
 */
export declare const CoveragePolicySchema: z.ZodObject<{
    tables: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        requiredOperations: z.ZodArray<z.ZodEnum<{
            create: "create";
            read: "read";
            update: "update";
            delete: "delete";
        }>>;
        disposition: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                "read-only-surface": "read-only-surface";
                "admin-plane-unreachable": "admin-plane-unreachable";
                "not-user-facing": "not-user-facing";
                other: "other";
            }>;
            note: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred coverage-policy section type. */
export type CoveragePolicy = z.infer<typeof CoveragePolicySchema>;
//# sourceMappingURL=coverage-policy.d.ts.map