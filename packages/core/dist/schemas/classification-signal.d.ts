/**
 * Classification-signal schemas (ADR 0003 D1): the framework-neutral
 * evidence contract detectors emit so core can classify resources
 * automatically. A signal is a FACT — source-located, detector-versioned,
 * basis-typed — never a classification and never authoritative. Core's
 * deterministic rule lattice (ADR 0003 D2) turns signals into decisions.
 *
 * Anti-pattern guards encoded here:
 * - no confidence score field (a signal has a `basis`, not a probability);
 * - every signal must carry a `Location` and a detector identity;
 * - `code-negative-closed-world` names the only basis allowed to
 *   suppress, and the classifier additionally demands a complete-scan
 *   attestation before honoring it.
 */
import { z } from 'zod';
/** What a signal addresses: bare name, plane-qualified id, or symbol. */
export declare const SignalTargetSchema: z.ZodObject<{
    resourceName: z.ZodOptional<z.ZodString>;
    resourceId: z.ZodOptional<z.ZodString>;
    symbol: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Inferred signal-target shape. */
export type SignalTarget = z.infer<typeof SignalTargetSchema>;
/** Every classification dimension a signal can speak about. */
export declare const SIGNAL_DIMENSIONS: readonly ["exposure", "plane", "identity", "lifecycle.create", "lifecycle.read", "lifecycle.update", "lifecycle.delete", "delete-semantics", "archive-state", "adapter-binding", "internality"];
/** Union of signal dimensions. */
export type SignalDimension = (typeof SIGNAL_DIMENSIONS)[number];
export declare const SignalDimensionSchema: z.ZodEnum<{
    exposure: "exposure";
    plane: "plane";
    identity: "identity";
    "lifecycle.create": "lifecycle.create";
    "lifecycle.read": "lifecycle.read";
    "lifecycle.update": "lifecycle.update";
    "lifecycle.delete": "lifecycle.delete";
    "delete-semantics": "delete-semantics";
    "archive-state": "archive-state";
    "adapter-binding": "adapter-binding";
    internality: "internality";
}>;
/**
 * The evidence basis of a signal (ADR 0003 D1). Only
 * `code-negative-closed-world` may ever suppress obligations, and only
 * when the classifier's complete-scan attestation holds.
 */
export declare const SignalBasisSchema: z.ZodEnum<{
    "code-positive": "code-positive";
    "code-negative-closed-world": "code-negative-closed-world";
    declaration: "declaration";
    "organization-policy": "organization-policy";
}>;
/** Inferred signal-basis type. */
export type SignalBasis = z.infer<typeof SignalBasisSchema>;
/**
 * Dimension-typed assertion payload: `exposure`/`internality` carry a
 * boolean or category string, `plane` a plane name, `identity` the
 * ORDERED primary-key columns, `delete-semantics` `hard|archive`,
 * `archive-state` the owner-owned archived field values, lifecycle
 * dimensions a boolean.
 */
export declare const SignalAssertionSchema: z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodArray<z.ZodString>, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>]>;
/** Inferred signal-assertion type. */
export type SignalAssertion = z.infer<typeof SignalAssertionSchema>;
/**
 * One classification signal (ADR 0003 D1). Strict: unknown fields are
 * detector bugs and must fail validation, not ride along.
 */
export declare const ClassificationSignalSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    target: z.ZodObject<{
        resourceName: z.ZodOptional<z.ZodString>;
        resourceId: z.ZodOptional<z.ZodString>;
        symbol: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    dimension: z.ZodEnum<{
        exposure: "exposure";
        plane: "plane";
        identity: "identity";
        "lifecycle.create": "lifecycle.create";
        "lifecycle.read": "lifecycle.read";
        "lifecycle.update": "lifecycle.update";
        "lifecycle.delete": "lifecycle.delete";
        "delete-semantics": "delete-semantics";
        "archive-state": "archive-state";
        "adapter-binding": "adapter-binding";
        internality: "internality";
    }>;
    assertion: z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodArray<z.ZodString>, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>]>;
    basis: z.ZodEnum<{
        "code-positive": "code-positive";
        "code-negative-closed-world": "code-negative-closed-world";
        declaration: "declaration";
        "organization-policy": "organization-policy";
    }>;
    source: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
    detector: z.ZodObject<{
        id: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
/** Inferred classification-signal shape. */
export type ClassificationSignal = z.infer<typeof ClassificationSignalSchema>;
/**
 * Canonical signal identity (ADR 0003 D1): sha256 over the GF-canonical
 * JSON of the full signal document. Any change of location, assertion,
 * basis, or detector version changes the id — which is what makes
 * `decisionFingerprint`s stale-aware (plan goal 8).
 *
 * Args:
 *   signal: a validated classification signal.
 *
 * Returns:
 *   string: 64-char lowercase sha256 hex.
 */
export declare function signalId(signal: ClassificationSignal): string;
/**
 * The plane-assertion payload narrowed, for signals that assert a plane.
 */
export declare function planeAssertion(signal: ClassificationSignal): string | null;
//# sourceMappingURL=classification-signal.d.ts.map