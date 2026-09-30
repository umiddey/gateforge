/**
 * Policy schemas (plan §4.4): declarative YAML mapping resource
 * attributes to required test obligations. Policies are pure data —
 * there is no code escape hatch (ADR 0002).
 */
import { z } from 'zod';
import { ContractNameSchema, ExposureSchema, PlaneSchema, SchemaVersionField } from './common.js';

/**
 * Attribute matchers a resource must satisfy for the policy to apply.
 * All provided matchers must match (AND semantics); omitted matchers are
 * wildcard.
 */
export const PolicyWhenSchema = z
  .object({
    /** Resource kind, e.g. `sqlalchemy.table`. */
    kind: z.string().min(1).optional(),
    /** Resource exposure. */
    exposure: ExposureSchema.optional(),
    /** Resource plane. */
    plane: PlaneSchema.optional(),
    /** Endpoint capability match: true when the resource's `capabilities` attribute contains this value. Non-endpoint resources never match. */
    capability: z.string().min(1).optional(),
    /** Endpoint consumption match: `true` matches resources whose `frontendConsumed` attribute is exactly `true`; `false` matches everything else (including non-endpoints). Omitted = wildcard. */
    consumed: z.boolean().optional(),
  })
  .strict();

/** Inferred policy matcher shape. */
export type PolicyWhen = z.infer<typeof PolicyWhenSchema>;

/** One policy: when matched, require the listed contracts as obligations. */
export const PolicySchema = z
  .object({
    /** Stable policy id; appears in obligation ids, reports, and SARIF rules. */
    id: z.string().min(1),
    /** Attribute matchers selecting the resources this policy applies to. */
    when: PolicyWhenSchema,
    /** Contract names to require (each becomes `<resourceId>:<contract>`). */
    require: z.array(ContractNameSchema).min(1),
  })
  .strict();

/** Inferred single-policy shape. */
export type Policy = z.infer<typeof PolicySchema>;

/**
 * Document-level policy options (plan Phase 4c, E60). Additive and
 * opt-in: a document with no `options` section is byte-for-byte and
 * behavior-for-behavior today's document.
 */
export const PolicyFileOptionsSchema = z
  .object({
    /**
     * Which `http.endpoint` resources owe the observation contracts
 * (`http:request-observed` / `http:response-status-ok`) demanded by a
     * `consumed: true` policy:
     * - `consumed` (default, today's behavior): only endpoints the
     *   frontend statically consumes. A route no UI calls owes nothing,
     *   so a new untested route is invisible to the gate.
     * - `all`: EVERY discovered endpoint owes them, so a new route with
     *   no test blocks (`TEST_MAPPING_MISSING`) until it is mapped or
     *   the baseline is adopted. Existing debt is handled by the
     *   adopted baseline, so this makes NEW routes visible without
     *   re-litigating old ones.
     *
     * The key lives in `.gateforge/policies.yml`, the pinned trusted
     * policy document: widening (or narrowing) the observation scope
     * is an owner-approved policy revision, never an agent-editable
     * toggle. The value only ever changes WHICH endpoint resources a
     * declared policy selects — it never adds a contract, a cause code
     * or an exit code.
     */
    'http.endpoint.requireObservation': z.enum(['consumed', 'all']).default('consumed'),
  })
  .strict();

/** Inferred policy-options shape. */
export type PolicyFileOptions = z.infer<typeof PolicyFileOptionsSchema>;

/** The policies document loaded from the path in `.gateforge.yml`. */
export const PolicyFileSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Policy list, evaluated in order. */
    policies: z.array(PolicySchema).min(1),
    /**
     * Document-level options (plan Phase 4c, E60). ABSENT = every
     * option at its default, so a document without the section behaves
     * exactly as it did before the option existed.
     */
    options: PolicyFileOptionsSchema.optional(),
  })
  .strict();

/** Inferred policies-document shape. */
export type PolicyFile = z.infer<typeof PolicyFileSchema>;
