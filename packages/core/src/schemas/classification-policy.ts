/**
 * `classification-policy.yml` schema (ADR 0003 D5): the repository-wide
 * deterministic rules replacing hand-authored per-resource
 * classifications. The policy never decides anything by itself — it is
 * one INPUT to the classifier lattice, and organization internal rules
 * are certificate-checked like declarations (a matching name rule alone
 * NEVER proves internality, ADR 0003 D2 exposure rule 3).
 */
import { z } from 'zod';
import { compareStrings } from '../graph/util.js';
import { SchemaVersionField } from './common.js';
import { BusinessRulesSchema } from './business-rules.js';

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

/** Inferred internal entry-point category shape. */
export type InternalEntryPointCategory = z.infer<typeof InternalEntryPointCategorySchema>;

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

/** Inferred internal-rule match shape. */
export type InternalRuleMatch = z.infer<typeof InternalRuleMatchSchema>;

/** One organization internal rule — an input to the certificate, not an override. */
export const InternalRuleSchema = z
  .object({
    /** What the rule matches. */
    match: InternalRuleMatchSchema,
    /** Why the organization classifies these resources internal (rendered in traces). */
    reason: z.string().min(1),
  })
  .strict();

/** Inferred internal-rule shape. */
export type InternalRule = z.infer<typeof InternalRuleSchema>;

/** Lifecycle operations an owner may explicitly disable for one resource. */
export const LIFECYCLE_OPERATIONS = ['create', 'read', 'update', 'delete'] as const;

/** Union of owner lifecycle operation names. */
export type LifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number];

/** Exact plane-qualified resource identity used by lifecycle policy rules. */
const ExactResourceIdSchema = z
  .string()
  .min(1, 'resourceId must not be empty')
  .refine((value) => value === value.trim(), {
    message: 'resourceId must not have leading or trailing whitespace',
  })
  .regex(
    /^(?:tenant|master|global)\.[^.:/\\\s]+$/,
    "resourceId must be an exact '<plane>.<resource>' identity without wildcards, paths, or delimiters",
  )
  .refine((value) => !/[?*\[\]{}]/.test(value), {
    message: 'resourceId must not contain wildcard or pattern characters',
  });

/** Exact resource match for an owner lifecycle rule. */
export const LifecycleRuleMatchSchema = z
  .object({
    /** Plane-qualified resource id; globs and bare names are unsafe here. */
    resourceId: ExactResourceIdSchema,
  })
  .strict();

/** Inferred lifecycle-rule match shape. */
export type LifecycleRuleMatch = z.infer<typeof LifecycleRuleMatchSchema>;

/** One owner policy rule disabling selected operations for one exact resource. */
export const LifecycleRuleSchema = z
  .object({
    /** Exact resource identity this rule applies to. */
    match: LifecycleRuleMatchSchema,
    /** Operations that are structurally unavailable for the matched resource. */
    disable: z
      .array(z.enum(LIFECYCLE_OPERATIONS))
      .min(1, 'disable must list at least one lifecycle operation')
      .superRefine((operations, ctx) => {
        const seen = new Set<string>();
        for (let index = 0; index < operations.length; index += 1) {
          const operation = operations[index];
          if (operation === undefined) continue;
          if (seen.has(operation)) {
            ctx.addIssue({
              code: 'custom',
              path: [index],
              message: `duplicate disabled lifecycle operation '${operation}'`,
            });
          }
          seen.add(operation);
        }
      }),
    /** Owner explanation rendered in classifier traces and diagnostics. */
    reason: z
      .string()
      .min(1, 'reason must not be empty')
      .refine((value) => value === value.trim(), {
        message: 'reason must not have leading or trailing whitespace',
      })
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
        message: 'reason must not contain control characters',
      }),
  })
  .strict();

/** Inferred lifecycle-rule shape. */
export type LifecycleRule = z.infer<typeof LifecycleRuleSchema>;

/** Lifecycle rules with duplicate exact identities rejected as ambiguous. */
export const LifecycleRulesSchema = z
  .array(LifecycleRuleSchema)
  .superRefine((rules, ctx) => {
    const seen = new Map<string, number>();
    for (let index = 0; index < rules.length; index += 1) {
      const resourceId = rules[index]?.match.resourceId;
      if (resourceId === undefined) continue;
      const first = seen.get(resourceId);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'match', 'resourceId'],
          message:
            `duplicate lifecycle rule for '${resourceId}' (already declared at index ${first}); ` +
            'one exact identity must have one unambiguous rule',
        });
      } else {
        seen.set(resourceId, index);
      }
    }
  });

/** Deterministic rule ordering for authority minting and explanations. */
export function sortLifecycleRules(rules: readonly LifecycleRule[]): LifecycleRule[] {
  const order = new Map<string, number>(LIFECYCLE_OPERATIONS.map((operation, index) => [operation, index]));
  return [...rules]
    .map((rule) => ({
      ...rule,
      disable: [...rule.disable].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    }))
    .sort((a, b) => compareStrings(a.match.resourceId, b.match.resourceId));
}

/**
 * How removal manifests for the resources an owner rule matches. Only
 * these two exist: the engine never invents a third, and never picks
 * between them on its own.
 */
export const DeleteSemanticsSchema = z.enum(['hard', 'archive']);

/** Inferred delete-semantics union. */
export type DeleteSemantics = z.infer<typeof DeleteSemanticsSchema>;

/**
 * A repo-root-relative glob over the SOURCE FILE of the resources the
 * rule declares semantics for. A glob (not one exact id) is safe here
 * because declaring semantics is an evidence CONTRACT, never a
 * suppression: it can only resolve DELETE_SEMANTICS_UNRESOLVED, never
 * remove an obligation on its own (contradicting detector evidence still
 * blocks).
 */
const DeleteRuleMatchSchema = z
  .string()
  .min(1, 'match must not be empty')
  .refine((value) => value === value.trim(), {
    message: 'match must not have leading or trailing whitespace',
  })
  .refine((value) => !value.includes('\\'), {
    message: 'match must use posix "/" separators',
  })
  .refine((value) => !value.startsWith('/'), {
    message: 'match must be repo-relative, never absolute',
  })
  .refine((value) => !value.split('/').includes('..'), {
    message: 'match must not escape the repository',
  });

/** The owner-owned archived field values an archive rule declares. */
const ArchiveFieldsSchema = z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()]));

/** One owner-declared delete-semantics rule over a source glob. */
export const DeleteRuleSchema = z
  .object({
    /** Repo-root-relative glob over the matched resources' source file. */
    match: DeleteRuleMatchSchema,
    /** How removal manifests for every resource this rule matches. */
    semantics: DeleteSemanticsSchema,
    /**
     * Required, and never empty, when `semantics` is `archive`: the
     * owner-owned archived state (e.g. `{status: archived}`) the engine
     * grades removal against. `hard` removal has no archived state and
     * must not carry the key.
     */
    archiveFields: ArchiveFieldsSchema.optional(),
    /** Owner explanation rendered in classifier traces and diagnostics. */
    reason: z
      .string()
      .min(1, 'reason must not be empty')
      .refine((value) => value === value.trim(), {
        message: 'reason must not have leading or trailing whitespace',
      })
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
        message: 'reason must not contain control characters',
      }),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.semantics === 'archive' && Object.keys(rule.archiveFields ?? {}).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['archiveFields'],
        message:
          "delete rule semantics is 'archive': 'archiveFields' must declare the owner-owned " +
          'archived state (e.g. {status: archived}); removal is never guessed',
      });
    }
    if (rule.semantics === 'hard' && rule.archiveFields !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['archiveFields'],
        message:
          "delete rule semantics is 'hard': a permanent removal has no archived state, so " +
          "'archiveFields' must be absent",
      });
    }
  });

/** Inferred delete-rule shape. */
export type DeleteRule = z.infer<typeof DeleteRuleSchema>;

/** Delete rules with duplicate match patterns rejected as ambiguous. */
export const DeleteRulesSchema = z
  .array(DeleteRuleSchema)
  .superRefine((rules, ctx) => {
    const seen = new Map<string, number>();
    for (let index = 0; index < rules.length; index += 1) {
      const match = rules[index]?.match;
      if (match === undefined) continue;
      const first = seen.get(match);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'match'],
          message:
            `duplicate delete rule for '${match}' (already declared at index ${first}); ` +
            'one source pattern must have one unambiguous semantics',
        });
      } else {
        seen.set(match, index);
      }
    }
  });

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

/** Inferred coverage-rule shape. */
export type CoverageRule = z.infer<typeof CoverageRuleSchema>;

/**
 * One owner-declared PLANE rule list — the `planes:` section of the
 * answers document (0.11.0, was `.gateforge/planes.json`). The section
 * keeps the document shape it always had (`{ rules: [...] }`) so
 * `gateforge migrate` is a pure text move, but the RULES themselves stay
 * validated by the pack that applies them (one validation source, the
 * same fail-closed reader that has always guarded them): this schema
 * rejects a wrong document SHAPE and the owning reader rejects a wrong
 * rule. Absent = no plane channel, byte-identical to today.
 */
export const PlanesSectionSchema = z
  .object({
    /** Owner-declared plane rules; validated by the SQLAlchemy pack. */
    rules: z.array(z.unknown()),
  })
  .strict();

/** Inferred `planes:` section shape. */
export type PlanesSection = z.infer<typeof PlanesSectionSchema>;

/**
 * One owner-declared ENDPOINT-CAPABILITY rule list — the `endpoints:`
 * section of the answers document (0.11.0, was `.gateforge/endpoints.json`).
 * Same posture as {@link PlanesSectionSchema}: shape here, rules validated
 * by the endpoint compiler that applies them.
 */
export const EndpointsSectionSchema = z
  .object({
    /** Owner-declared endpoint-capability rules; validated by the compiler. */
    rules: z.array(z.unknown()),
  })
  .strict();

/** Inferred `endpoints:` section shape. */
export type EndpointsSection = z.infer<typeof EndpointsSectionSchema>;

/**
 * Repo-root-relative location of the ONE owner-answers document. Named
 * once, in the package that owns the document, so every diagnostic that
 * has to point the owner at a declaration — the refusals, the migrator,
 * the packs — names the same path.
 */
export const OWNER_ANSWERS_PATH = '.gateforge/classification-policy.yml';

/**
 * The classification-policy document: the ONE owner-answers file
 * (`.gateforge/classification-policy.yml`, name kept by owner decision).
 * Since 0.11.0 it holds every owner answer — trusted internal
 * entry-point categories, organization internal rules, exact lifecycle
 * disables, delete semantics, plane rules, endpoint capabilities, and
 * the owner's business `rules:`.
 *
 * The SCANNER settings (`scanRoots`, `coverage`, `declarations`,
 * `volatileFields`) MOVED OUT to `.gateforge.yml` under `scan:`, next to
 * the other machine-wide declarations. They are no longer accepted here:
 * a repository still carrying them fails closed naming `gateforge
 * migrate` rather than silently running on a setting the engine cannot
 * see.
 */
export const ClassificationPolicySchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Entry-point categories counted as trusted-internal reachability. */
    trustedInternalEntryPoints: z.array(InternalEntryPointCategorySchema),
    /** Organization internal rules — certificate inputs, never overrides. */
    internalRules: z.array(InternalRuleSchema),
    /** Exact owner lifecycle disables; suppressive effects require scan proof. */
    lifecycleRules: LifecycleRulesSchema.optional(),
    /**
     * Owner-declared delete semantics (hard|archive) per source glob.
     * Declaring semantics ADDS an evidence contract — it can resolve
     * DELETE_SEMANTICS_UNRESOLVED, never remove an obligation: detector
     * evidence that disagrees still blocks as a contradiction.
     *
     * This is the ONE place the hard/archive answer exists (0.11.0);
     * `endpoints:` no longer takes `crud-delete`/`crud-archive`.
     */
    deleteRules: DeleteRulesSchema.optional(),
    /** Owner-declared data-plane rules (was `.gateforge/planes.json`). */
    planes: PlanesSectionSchema.optional(),
    /** Owner-declared endpoint capabilities (was `.gateforge/endpoints.json`). */
    endpoints: EndpointsSectionSchema.optional(),
    /**
     * The owner's BUSINESS RULES (0.11.0). Each rule names the test type
 * that must prove it and its observable cases. Absent = the feature is
     off, byte for byte: no finding, no report row, no digest change.
     */
    rules: BusinessRulesSchema.optional(),
  })
  .strict();

/** Inferred classification-policy shape. */
export type ClassificationPolicy = z.infer<typeof ClassificationPolicySchema>;
