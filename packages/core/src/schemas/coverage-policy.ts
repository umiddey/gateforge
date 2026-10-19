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
import { dispositionShape, TABLE_DISPOSITION_KINDS } from './disposition.js';

/** The four real-UI operations a table may require coverage for. */
export const COVERAGE_OPERATIONS = ['create', 'read', 'update', 'delete'] as const;

/** The operation union a coverage policy may require. */
export const CoverageOperationSchema = z.enum(COVERAGE_OPERATIONS);

/** Inferred coverage-operation type. */
export type CoverageOperation = (typeof COVERAGE_OPERATIONS)[number];

/**
 * An OWNER disposition (plan §3.6): the recorded reason a table owes no
 * real-UI coverage for its required operations. The ONE shared
 * disposition shape (plan 2026-10-19) over the table kind subset:
 * `{ kind, reason, expiresAt? }`. `reason` is the canonical field.
 * The pre-shape `note` field is accepted as a DEPRECATED alias for
 * `reason` for one release (owner decision 2026-10-18): it still loads,
 * its value is mapped onto `reason`, and `gateforge check` prints a
 * deprecation advisory (`coverageDispositionDeprecations`). Giving both
 * with different values is refused — the recorded reason must be
 * unambiguous.
 *
 * A pre-shape entry that recorded neither field still loads, except
 * `kind: other`, which has always required a recorded reason (the old
 * `note` rule). Those kind-only entries warn on the same check channel
 * (`coverageDispositionDeprecations`): `reason` will be required.
 * Inventing a reason for them would rewrite owner policy; consumers
 * read `reason` only when one was recorded.
 * Approving a disposition is a trusted-policy act, never an agent
 * self-approval.
 */
export const CoverageDispositionSchema = dispositionShape({
  kind: z.enum(TABLE_DISPOSITION_KINDS),
  /** Why the disposition applies. Canonical field; `note` is the deprecated alias. */
  reason: z.string().min(1).optional(),
  /**
   * DEPRECATED alias for `reason`, accepted this release only; mapped
   * onto `reason` on load and flagged by
   * `coverageDispositionDeprecations`.
   */
  note: z.string().min(1).optional(),
})
  .superRefine((disposition, ctx) => {
    // `other` has always required a recorded reason (the pre-shape rule
    // was "kind other requires note"). Every other table kind loaded
    // with neither field — rejecting those breaks existing configs.
    if (
      disposition.kind === 'other' &&
      disposition.reason === undefined &&
      disposition.note === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message:
          "disposition kind 'other' requires 'reason' (the owner's reason must be recorded; " +
          "'note' is accepted as a deprecated alias this release)",
      });
    }
    if (
      disposition.reason !== undefined &&
      disposition.note !== undefined &&
      disposition.reason !== disposition.note
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message:
          "disposition 'note' and 'reason' disagree — remove the deprecated 'note' " +
          'so the recorded reason is unambiguous',
      });
    }
  })
  .transform((disposition) => {
    const recorded = disposition.reason ?? disposition.note;
    // Leave a pre-shape entry that recorded neither field alone. Setting
    // reason to '' would fail the blank-reason check on any re-parse
    // (disposition extend validates the parsed value through this schema).
    if (recorded === undefined) return disposition;
    return { ...disposition, reason: recorded };
  });

/** Inferred coverage-disposition type. */
export type CoverageDisposition = z.infer<typeof CoverageDispositionSchema>;

/**
 * Deprecation lines for coverage dispositions still on the one-release
 * compatibility window — `gateforge check` prints these as stderr
 * advisories on the same channel (plan 2026-10-19).
 *
 * Two advisories, in policy order, one line each:
 * - a disposition still carried by the `note` alias;
 * - a non-`other` disposition that recorded no reason (pre-shape
 *   configs keep loading; `reason` will be required).
 *
 * `kind: other` without a recorded reason never loads, so it has no
 * advisory. A `note` that mapped onto `reason` is not "no reason".
 *
 * Args:
 *   tables: the validated coveragePolicy tables.
 *
 * Returns:
 *   string[]: human advisories, in policy order.
 */
export function coverageDispositionDeprecations(tables: readonly CoverageTable[]): string[] {
  const warnings: string[] = [];
  for (const table of tables) {
    const disposition = table.disposition;
    if (disposition === undefined) continue;
    if (disposition.note !== undefined) {
      warnings.push(
        `coveragePolicy table '${table.name}' disposition uses the deprecated 'note' alias — ` +
          "rename it to 'reason' ('note' support is removed in the next release)",
      );
    }
    if (disposition.reason === undefined && disposition.kind !== 'other') {
      warnings.push(
        `coveragePolicy table '${table.name}' disposition records no 'reason' — ` +
          "'reason' will be required",
      );
    }
  }
  return warnings;
}

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
