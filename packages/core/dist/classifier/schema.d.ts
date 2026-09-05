/**
 * Classifier result schemas (ADR 0003 D1/D2): the decision trace, the
 * effective classification, and the typed machine-actionable blocks.
 *
 * `EffectiveClassification` carries the existing `Classification` fields
 * policy/verdict code consumes PLUS explainability metadata (fingerprint,
 * contributing signals, defaults, contradictions, rule ids). On graph
 * resources the classification fields bind `GraphResource.classification`
 * and the explainability rides the sibling `classificationTrace` field —
 * never detector attributes.
 */
import { z } from 'zod';
/** Why the classifier blocked one resource (each code is machine-actionable). */
export declare const CLASSIFIER_BLOCK_CODES: readonly ["CLASSIFICATION_CONTRADICTION", "LIFECYCLE_CONTRADICTION", "PLANE_CONTRADICTION", "IDENTITY_CONTRADICTION", "INCOMPLETE_PROOF_SCOPE", "PLANE_UNRESOLVED", "IDENTITY_UNRESOLVED", "DELETE_SEMANTICS_UNRESOLVED", "ADAPTER_MISSING", "STALE_SIGNAL_TARGET", "INVALID_SIGNAL", "UNAUTHORIZED_SUPPRESSIVE_SIGNAL"];
/** Union of classifier block codes. */
export type ClassifierBlockCode = (typeof CLASSIFIER_BLOCK_CODES)[number];
export declare const ClassifierBlockCodeSchema: z.ZodEnum<{
    CLASSIFICATION_CONTRADICTION: "CLASSIFICATION_CONTRADICTION";
    LIFECYCLE_CONTRADICTION: "LIFECYCLE_CONTRADICTION";
    PLANE_CONTRADICTION: "PLANE_CONTRADICTION";
    IDENTITY_CONTRADICTION: "IDENTITY_CONTRADICTION";
    INCOMPLETE_PROOF_SCOPE: "INCOMPLETE_PROOF_SCOPE";
    PLANE_UNRESOLVED: "PLANE_UNRESOLVED";
    IDENTITY_UNRESOLVED: "IDENTITY_UNRESOLVED";
    DELETE_SEMANTICS_UNRESOLVED: "DELETE_SEMANTICS_UNRESOLVED";
    ADAPTER_MISSING: "ADAPTER_MISSING";
    STALE_SIGNAL_TARGET: "STALE_SIGNAL_TARGET";
    INVALID_SIGNAL: "INVALID_SIGNAL";
    UNAUTHORIZED_SUPPRESSIVE_SIGNAL: "UNAUTHORIZED_SUPPRESSIVE_SIGNAL";
}>;
/** Also expose the block dimension mapping for report/block consumers. */
export declare const BLOCK_DIMENSIONS: Record<string, string>;
/** One typed classifier block: fail-closed, explainable, resolvable in code. */
export declare const ClassifierBlockSchema: z.ZodObject<{
    code: z.ZodEnum<{
        CLASSIFICATION_CONTRADICTION: "CLASSIFICATION_CONTRADICTION";
        LIFECYCLE_CONTRADICTION: "LIFECYCLE_CONTRADICTION";
        PLANE_CONTRADICTION: "PLANE_CONTRADICTION";
        IDENTITY_CONTRADICTION: "IDENTITY_CONTRADICTION";
        INCOMPLETE_PROOF_SCOPE: "INCOMPLETE_PROOF_SCOPE";
        PLANE_UNRESOLVED: "PLANE_UNRESOLVED";
        IDENTITY_UNRESOLVED: "IDENTITY_UNRESOLVED";
        DELETE_SEMANTICS_UNRESOLVED: "DELETE_SEMANTICS_UNRESOLVED";
        ADAPTER_MISSING: "ADAPTER_MISSING";
        STALE_SIGNAL_TARGET: "STALE_SIGNAL_TARGET";
        INVALID_SIGNAL: "INVALID_SIGNAL";
        UNAUTHORIZED_SUPPRESSIVE_SIGNAL: "UNAUTHORIZED_SUPPRESSIVE_SIGNAL";
    }>;
    resourceId: z.ZodNullable<z.ZodString>;
    name: z.ZodNullable<z.ZodString>;
    detail: z.ZodString;
    locations: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred classifier-block shape. */
export type ClassifierBlock = z.infer<typeof ClassifierBlockSchema>;
/** One contradiction between two pieces of evidence (rendered in traces). */
export declare const ClassifierContradictionSchema: z.ZodObject<{
    dimension: z.ZodString;
    detail: z.ZodString;
    locations: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred classifier-contradiction shape. */
export type ClassifierContradiction = z.infer<typeof ClassifierContradictionSchema>;
/**
 * The explainability trace of one classification decision (ADR 0003 D1):
 * rule ids that selected each value, the conservative defaults applied,
 * the sorted contributing-signal identities, contradictions, and the
 * dimensions the classifier could not decide.
 */
export declare const ClassificationDecisionTraceSchema: z.ZodObject<{
    rules: z.ZodArray<z.ZodString>;
    defaultsApplied: z.ZodArray<z.ZodString>;
    contributingSignalIds: z.ZodArray<z.ZodString>;
    contributingDetectors: z.ZodArray<z.ZodString>;
    contradictions: z.ZodArray<z.ZodObject<{
        dimension: z.ZodString;
        detail: z.ZodString;
        locations: z.ZodArray<z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    unresolvedDimensions: z.ZodArray<z.ZodString>;
    decisionFingerprint: z.ZodString;
}, z.core.$strict>;
/** Inferred decision-trace shape. */
export type ClassificationDecisionTrace = z.infer<typeof ClassificationDecisionTraceSchema>;
/**
 * The classifier's complete decision for one resource: the plain
 * `Classification` fields (what policy/verdict code consumes) plus the
 * explainability metadata. Produced only when the resource has NO
 * blocking classifier finding.
 */
export declare const EffectiveClassificationSchema: z.ZodObject<{
    exposure: z.ZodEnum<{
        "user-facing": "user-facing";
        internal: "internal";
    }>;
    plane: z.ZodEnum<{
        tenant: "tenant";
        master: "master";
        global: "global";
    }>;
    lifecycle: z.ZodObject<{
        create: z.ZodBoolean;
        read: z.ZodBoolean;
        update: z.ZodBoolean;
        delete: z.ZodBoolean;
        deleteSemantics: z.ZodOptional<z.ZodEnum<{
            hard: "hard";
            archive: "archive";
        }>>;
        archiveFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
        updateableFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
    primaryKey: z.ZodArray<z.ZodString>;
    evidenceAdapter: z.ZodOptional<z.ZodString>;
    evidenceLane: z.ZodOptional<z.ZodEnum<{
        adapter: "adapter";
        claims: "claims";
    }>>;
    notes: z.ZodOptional<z.ZodString>;
    rules: z.ZodArray<z.ZodString>;
    defaultsApplied: z.ZodArray<z.ZodString>;
    contributingSignalIds: z.ZodArray<z.ZodString>;
    contributingDetectors: z.ZodArray<z.ZodString>;
    contradictions: z.ZodArray<z.ZodObject<{
        dimension: z.ZodString;
        detail: z.ZodString;
        locations: z.ZodArray<z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    unresolvedDimensions: z.ZodArray<z.ZodString>;
    decisionFingerprint: z.ZodString;
}, z.core.$strict>;
/** Inferred effective-classification shape. */
export type EffectiveClassification = z.infer<typeof EffectiveClassificationSchema>;
//# sourceMappingURL=schema.d.ts.map