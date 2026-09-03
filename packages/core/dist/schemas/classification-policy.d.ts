/**
 * `classification-policy.yml` schema (ADR 0003 D5): the repository-wide
 * deterministic rules replacing hand-authored per-resource
 * classifications. The policy never decides anything by itself — it is
 * one INPUT to the classifier lattice, and organization internal rules
 * are certificate-checked like declarations (a matching name rule alone
 * NEVER proves internality, ADR 0003 D2 exposure rule 3).
 */
import { z } from 'zod';
/** One trusted internal entry-point category (worker, migration, …). */
export declare const InternalEntryPointCategorySchema: z.ZodObject<{
    category: z.ZodString;
    patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    detector: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Inferred internal entry-point category shape. */
export type InternalEntryPointCategory = z.infer<typeof InternalEntryPointCategorySchema>;
/** Match keys an organization internal rule can scope itself by. */
export declare const InternalRuleMatchSchema: z.ZodObject<{
    resourceName: z.ZodOptional<z.ZodString>;
    resourceKind: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Inferred internal-rule match shape. */
export type InternalRuleMatch = z.infer<typeof InternalRuleMatchSchema>;
/** One organization internal rule — an input to the certificate, not an override. */
export declare const InternalRuleSchema: z.ZodObject<{
    match: z.ZodObject<{
        resourceName: z.ZodOptional<z.ZodString>;
        resourceKind: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    reason: z.ZodString;
}, z.core.$strict>;
/** Inferred internal-rule shape. */
export type InternalRule = z.infer<typeof InternalRuleSchema>;
/**
 * One coverage requirement (red-team round 3): the named detector must
 * report examining every applicable file for a scan to count as COMPLETE.
 * Coverage is per-detector by capability — never a flattened union
 * (a detector that cannot see routes reading a file proves nothing about
 * route coverage). A rule naming a detector that is not configured, or
 * that does not report coverage, fails the attestation — so removing a
 * required detector from the config cannot silently pass a closed-world
 * proof.
 */
export declare const CoverageRuleSchema: z.ZodObject<{
    capability: z.ZodString;
    detector: z.ZodString;
    appliesTo: z.ZodArray<z.ZodString>;
    exhaustive: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
/** Inferred coverage-rule shape. */
export type CoverageRule = z.infer<typeof CoverageRuleSchema>;
/**
 * The classification-policy document: scan roots (complete-scan scope),
 * trusted internal entry-point categories, organization internal rules,
 * the supported source declaration syntax, and volatile fields.
 */
export declare const ClassificationPolicySchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    scanRoots: z.ZodArray<z.ZodString>;
    trustedInternalEntryPoints: z.ZodArray<z.ZodObject<{
        category: z.ZodString;
        patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        detector: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    internalRules: z.ZodArray<z.ZodObject<{
        match: z.ZodObject<{
            resourceName: z.ZodOptional<z.ZodString>;
            resourceKind: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        reason: z.ZodString;
    }, z.core.$strict>>;
    coverage: z.ZodOptional<z.ZodArray<z.ZodObject<{
        capability: z.ZodString;
        detector: z.ZodString;
        appliesTo: z.ZodArray<z.ZodString>;
        exhaustive: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>>;
    declarations: z.ZodRecord<z.ZodString, z.ZodString>;
    volatileFields: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** Inferred classification-policy shape. */
export type ClassificationPolicy = z.infer<typeof ClassificationPolicySchema>;
//# sourceMappingURL=classification-policy.d.ts.map