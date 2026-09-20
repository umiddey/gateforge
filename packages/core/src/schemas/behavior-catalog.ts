/**
 * Compiled behavior catalog (plan 2026-09-19 §4.7, §15.3): the
 * deterministic, sorted requirement set derived from an approved
 * behavior document plus the current resource graph.
 *
 * The catalog is derived run state, not a tracked authority document.
 * Tampering with a copy on disk cannot alter the controller-bound
 * catalog digest.
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';
import { FingerprintHexSchema } from './baseline.js';
import {
  BehaviorCaseSchema,
  EffectScopeSchema,
} from './behavior-policy.js';

/** Domain hashed into the catalog digest. */
export const BEHAVIOR_CATALOG_DOMAIN = 'gateforge.behavior-catalog.v1';

/** Domain hashed into an obligation's requirementsDigest. */
export const BEHAVIOR_REQUIREMENTS_DOMAIN = 'gateforge.requirements.v1';

/** One compiled case with stable identity and specification digest. */
export const CompiledBehaviorCaseSchema = z
  .object({
    /** 64-hex identity: sha256Canonical({domain, resourceId, id}). */
    caseId: FingerprintHexSchema,
    /** 64-hex digest of the complete canonical case specification. */
    specDigest: FingerprintHexSchema,
    /** Subject resource the case belongs to (normalized graph id). */
    resourceId: z
      .string()
      .min(1)
      .regex(/^[^:]+$/, "resourceId must not contain ':'"),
    /** Endpoint resource id when the subject is an HTTP endpoint. */
    endpointResourceId: z
      .string()
      .min(1)
      .regex(/^[^:]+$/, "endpointResourceId must not contain ':'")
      .nullable(),
    /** Sorted, deduplicated current obligation ids this case supports. */
    obligationIds: z.array(z.string().min(1)),
    /** Canonical case definition (owner document after compile normalize). */
    definition: BehaviorCaseSchema,
    /** Declared effects of the subject, sorted by id. */
    effects: z.array(EffectScopeSchema),
    /** Sorted approved dependency/source paths. */
    sourceFiles: z.array(z.string().min(1)),
  })
  .strict();

/** Inferred compiled-case shape. */
export type CompiledBehaviorCase = z.infer<typeof CompiledBehaviorCaseSchema>;

/**
 * Compiled catalog: sorted cases, obligation→case requirements, and the
 * subject→effect dependency index used by changed-file selection.
 */
export const BehaviorCatalogSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    catalogDigest: FingerprintHexSchema,
    /** Sorted by caseId. */
    cases: z.array(CompiledBehaviorCaseSchema),
    /** obligationId → required caseIds (sorted). */
    requirements: z.record(z.string(), z.array(z.string().min(1))),
    /** subject resourceId → effect/domain resourceIds (sorted, unique). */
    dependencies: z.record(z.string(), z.array(z.string().min(1))),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    for (let index = 1; index < catalog.cases.length; index += 1) {
      const previous = catalog.cases[index - 1]?.caseId;
      const current = catalog.cases[index]?.caseId;
      if (previous === undefined || current === undefined) continue;
      if (current < previous) {
        ctx.addIssue({
          code: 'custom',
          path: ['cases', index, 'caseId'],
          message: 'compiled cases must be sorted by caseId',
        });
        return;
      }
      if (current === previous) {
        ctx.addIssue({
          code: 'custom',
          path: ['cases', index, 'caseId'],
          message: `duplicate compiled caseId '${current}'`,
        });
        return;
      }
    }
  });

/** Inferred behavior-catalog shape. */
export type BehaviorCatalog = z.infer<typeof BehaviorCatalogSchema>;

/** One route row of the complete inventory for principal attribution. */
export const BehaviorRouteRowSchema = z
  .object({
    resourceId: z.string().min(1),
    method: z.string().min(1),
    canonicalPath: z.string().min(1),
  })
  .strict();

/** Supervisor registration body for POST /runs/behavior-catalog. */
export const BehaviorCatalogRegistrationSchema = z
  .object({
    catalog: BehaviorCatalogSchema,
    assignments: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
    routes: z.array(BehaviorRouteRowSchema).min(1),
    authorityProfileDigest: FingerprintHexSchema,
  })
  .strict();

/** Inferred catalog-registration body. */
export type BehaviorCatalogRegistration = z.infer<typeof BehaviorCatalogRegistrationSchema>;
