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
export const COVERAGE_OPERATIONS = ['create', 'read', 'update', 'delete'] as const;

/** The operation union a coverage policy may require. */
export const CoverageOperationSchema = z.enum(COVERAGE_OPERATIONS);

/** Inferred coverage-operation type. */
export type CoverageOperation = (typeof COVERAGE_OPERATIONS)[number];

/**
 * An OWNER disposition (plan §3.6): the recorded reason a table owes no
 * real-UI coverage for its required operations. Kinds are closed-world;
 * `other` requires the note to stay auditable. Approving one is a
 * trusted-policy act, never an agent self-approval.
 */
export const CoverageDispositionSchema = z
  .object({
    kind: z.enum(['read-only-surface', 'admin-plane-unreachable', 'not-user-facing', 'other']),
    /** Why the disposition applies; REQUIRED for `other` (auditability). */
    note: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((disposition, ctx) => {
    if (disposition.kind === 'other' && (disposition.note === undefined || disposition.note.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: "disposition kind 'other' requires 'note' (the owner's reason must be recorded)",
      });
    }
  });

/** Inferred coverage-disposition type. */
export type CoverageDisposition = z.infer<typeof CoverageDispositionSchema>;

/** One policy-enumerated user-facing table. */
export const CoverageTableSchema = z
  .object({
    /** The resource inventory's bare table name (exact match). */
    name: z.string().min(1),
    /**
     * Operations requiring mapped browser-e2e coverage unless a
     * disposition excuses the table. A subset of the four real-UI
     * operations; empty would enforce nothing and is rejected.
     */
    requiredOperations: z.array(CoverageOperationSchema).min(1),
    /** Owner disposition recorded in trusted config (when coverage is excused). */
    disposition: CoverageDispositionSchema.optional(),
  })
  .strict();

/** Inferred coverage-table type. */
export type CoverageTable = z.infer<typeof CoverageTableSchema>;

/**
 * The `coveragePolicy` config section (plan §3.6). Absent or empty
 * (`tables: []`) means the feature is OFF — enabling it is an explicit,
 * tracked owner decision. Table names must be unique (a duplicate would
 * make the enforcement scope ambiguous); each name is validated against
 * the current run's resource inventory on every run.
 */
export const CoveragePolicySchema = z
  .object({
    /** User-facing tables the policy governs. */
    tables: z.array(CoverageTableSchema),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < policy.tables.length; index += 1) {
      const name = policy.tables[index]?.name;
      if (name === undefined) continue;
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tables', index, 'name'],
          message: `duplicate coverage-policy table '${name}': the enforcement scope must be unambiguous`,
        });
      }
      seen.add(name);
    }
  });

/** Inferred coverage-policy section type. */
export type CoveragePolicy = z.infer<typeof CoveragePolicySchema>;
