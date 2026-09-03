/**
 * Classification schemas (plan §4.3): business meaning attached to
 * discovered resources that cannot be safely inferred — exposure, plane,
 * lifecycle, identity columns, and the trusted evidence adapter.
 *
 * ADR 0001 encoded here:
 * - composite identity = column-keyed `entityId` + mandatory ordered
 *   `primaryKey` attribute;
 * - internal resources default to NO CRUD obligations and their claims
 *   are invalid (enforced downstream by the verdict engine, not here);
 * - a user-facing resource cannot be proven without a trusted evidence
 *   adapter, so `evidenceAdapter` is mandatory for user-facing entries.
 */
import { z } from 'zod';
import { ExposureSchema, PlaneSchema, SchemaVersionField } from './common.js';

/**
 * Lifecycle surface of a resource. `create`/`read`/`update` are plain
 * switches; `delete` additionally declares its semantics because archive
 * and hard delete have different evidence contracts (plan §5.3).
 *
 * `archiveFields` is the OWNER-DECLARED archived state (audit round 5):
 * the expected post-archive field values come from the classification —
 * never from the tested suite — so a suite cannot bless an unarchived
 * entity by declaring its current state as the expected result.
 */
export const LifecycleSchema = z
  .object({
    /** New entities can be created through the UI. */
    create: z.boolean(),
    /** Entities can be read/viewed through the UI. */
    read: z.boolean(),
    /** Declared entity fields can be changed through the UI. */
    update: z.boolean(),
    /** Entities can be removed (hard) or archived (soft) through the UI. */
    delete: z.boolean(),
    /** Required when `delete` is true: how removal manifests. */
    deleteSemantics: z.enum(['hard', 'archive']).optional(),
    /**
     * Required when `deleteSemantics` is 'archive': the owner-declared
     * field values that identify the archived state (e.g. `{status:
     * 'archived'}`). Graded by the engine against the witness's own
     * engine-side observation.
     */
    archiveFields: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    /**
     * Owner-declared fields whose change constitutes a real update
     * (audit round 6). `persistence:update` is satisfied only when the
     * engine-observed before/after delta touches at least one of these —
     * bookkeeping columns (e.g. `updated_at`) alone never satisfy.
     * Optional in the schema; the engine fails closed on update
     * obligations for resources that omit it.
     */
    updateableFields: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((lifecycle, ctx) => {
    if (lifecycle.delete && lifecycle.deleteSemantics === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['deleteSemantics'],
        message:
          "lifecycle.delete is true: 'deleteSemantics' must be 'hard' or 'archive'",
      });
    }
    if (lifecycle.deleteSemantics === 'archive' && lifecycle.archiveFields === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['archiveFields'],
        message:
          "lifecycle.deleteSemantics is 'archive': 'archiveFields' must declare the " +
          'owner-owned archived state (e.g. {status: archived})',
      });
    }
    // An empty archiveFields map passes no postcondition check, so it is
    // a config error, not a dormant one (fail closed at authoring time).
    if (
      lifecycle.archiveFields !== undefined &&
      Object.keys(lifecycle.archiveFields).length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['archiveFields'],
        message:
          'archiveFields must declare at least one field (an empty map can never ' +
          'satisfy the archive postcondition)',
      });
    }
  });

/** Inferred lifecycle shape. */
export type Lifecycle = z.infer<typeof LifecycleSchema>;

/**
 * Classification entry for a single resource id.
 */
export const ClassificationSchema = z
  .object({
    /** Whether the resource is exposed to end users. */
    exposure: ExposureSchema,
    /** Deployment plane the resource lives on. */
    plane: PlaneSchema,
    /** Lifecycle operations the UI supports for this resource. */
    lifecycle: LifecycleSchema,
    /**
     * Mandatory ordered entity-identity columns (ADR 0001): a single
     * column for simple identity, ordered lowest-index-first for
     * composite identity.
     */
    primaryKey: z.array(z.string().min(1)).min(1),
    /**
     * Trusted evidence adapter name (resolved against
     * `.gateforge/adapters/<name>.mjs`). Required for user-facing
     * resources; internal resources are never CRUD-obligated, so the
     * adapter is optional there.
     */
    evidenceAdapter: z.string().min(1).optional(),
    /** Free-form classification note shown in reports. */
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.exposure === 'user-facing' && entry.evidenceAdapter === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceAdapter'],
        message:
          "user-facing resources require an 'evidenceAdapter' (claims are not proof; trusted adapters collect evidence)",
      });
    }
  });

/** Inferred per-resource classification shape. */
export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * The classifications document: `.gateforge` classification YAML mapping
 * resource ids to their classification. Resources discovered but absent
 * here are `unclassified` and fail closed downstream.
 */
export const ClassificationFileSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Classification per resource id. */
    resources: z.record(z.string().min(1), ClassificationSchema),
  })
  .strict();

/** Inferred classifications-document shape. */
export type ClassificationFile = z.infer<typeof ClassificationFileSchema>;
