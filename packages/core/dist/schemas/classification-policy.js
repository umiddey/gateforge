/**
 * `classification-policy.yml` schema (ADR 0003 D5): the repository-wide
 * deterministic rules replacing hand-authored per-resource
 * classifications. The policy never decides anything by itself — it is
 * one INPUT to the classifier lattice, and organization internal rules
 * are certificate-checked like declarations (a matching name rule alone
 * NEVER proves internality, ADR 0003 D2 exposure rule 3).
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';
/** One trusted internal entry-point category (worker, migration, …). */
export const InternalEntryPointCategorySchema = z
    .object({
    /** Stable category name signals assert, e.g. `worker`. */
    category: z.string().min(1),
    /**
     * Repo-root-relative glob patterns files of this category live in
     * (advisory; detectors categorize, the classifier checks the name).
     */
    patterns: z.array(z.string().min(1)).optional(),
    /**
     * The ONLY bundled detector allowed to assert this category's
     * reachability (red-team round 5). Reachability evidence is
     * load-bearing for the internality certificate — suppressive in
     * effect — so it is accepted only from this detector, only at
     * locations the detector's own coverage report includes. Absent ⇒
     * no plugin may assert the category (reachability unavailable).
     */
    detector: z.string().min(1).optional(),
})
    .strict();
/** Match keys an organization internal rule can scope itself by. */
export const InternalRuleMatchSchema = z
    .object({
    /** Glob over the bare resource name (e.g. `*_audit`). Name rules alone are NOT proof. */
    resourceName: z.string().min(1).optional(),
    /** Exact detector kind the rule applies to (e.g. `sqlalchemy.table`). */
    resourceKind: z.string().min(1).optional(),
})
    .strict()
    .refine((match) => match.resourceName !== undefined || match.resourceKind !== undefined, {
    message: 'internal rule must match on at least one of resourceName / resourceKind',
});
/** One organization internal rule — an input to the certificate, not an override. */
export const InternalRuleSchema = z
    .object({
    /** What the rule matches. */
    match: InternalRuleMatchSchema,
    /** Why the organization classifies these resources internal (rendered in traces). */
    reason: z.string().min(1),
})
    .strict();
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
export const CoverageRuleSchema = z
    .object({
    /**
     * The capability this rule grants over its files, e.g.
     * `exposure.http`. Negative proofs are capability-scoped: a
     * closed-world EXPOSURE proof requires every requested file to be
     * covered by an `exposure.*` rule. A rule without an exposure
     * capability (model discovery, task linkage, …) can never serve an
     * exposure negative proof, whatever it scanned.
     */
    capability: z.string().min(1),
    /** Plugin id of the detector whose coverage is required. */
    detector: z.string().min(1),
    /** Repo-root-relative globs: the files this detector must examine. */
    appliesTo: z.array(z.string().min(1)).min(1),
    /**
     * Declares the detector an EXHAUSTIVE parser for the capability over
     * these files — an organization assertion the engine enforces as
     * written (bundled detector, reported coverage). Only exhaustive
     * rules may serve negative proofs. A regex heuristic must NOT be
     * declared exhaustive; without an exhaustive exposure rule, internality
     * stays unavailable for the scope (red-team round 6).
     */
    exhaustive: z.boolean().optional(),
})
    .strict();
/**
 * The classification-policy document: scan roots (complete-scan scope),
 * trusted internal entry-point categories, organization internal rules,
 * the supported source declaration syntax, and volatile fields.
 */
export const ClassificationPolicySchema = z
    .object({
    schemaVersion: SchemaVersionField,
    /**
     * Repo-root-relative globs defining the scope a closed-world proof
     * must cover. A non-empty list is the prerequisite of every
     * complete-scan attestation (ADR 0003 D4); findings or unresolved
     * entries inside these roots invalidate the attestation.
     */
    scanRoots: z.array(z.string().min(1)).min(1),
    /** Entry-point categories counted as trusted-internal reachability. */
    trustedInternalEntryPoints: z.array(InternalEntryPointCategorySchema),
    /** Organization internal rules — certificate inputs, never overrides. */
    internalRules: z.array(InternalRuleSchema),
    /**
     * Coverage requirements for COMPLETE-scan proofs (ADR 0003 D4). A
     * closed-world attestation holds only when every rule's detector is
     * configured, reports coverage, and covers every applicable requested
     * file. Declaring none means no scan is provably complete — closed-
     * world proofs stay unavailable (fail closed).
     */
    coverage: z.array(CoverageRuleSchema).optional(),
    /**
     * Supported source declaration syntax: the machine-readable keys
     * detectors may translate into declaration signals (e.g.
     * `internality: 'gateforge:internal'`). Declarations are assertions
     * consumed by the classifier — contradictory code signals still block.
     */
    declarations: z.record(z.string(), z.string().min(1)),
    /**
     * Bookkeeping columns that never satisfy an update by themselves
     * (mirrors the verdict engine's `updateableFields` fail-closed rule).
     */
    volatileFields: z.array(z.string().min(1)),
})
    .strict();
//# sourceMappingURL=classification-policy.js.map