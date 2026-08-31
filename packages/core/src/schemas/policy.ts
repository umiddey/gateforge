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

/** The policies document loaded from the path in `.gateforge.yml`. */
export const PolicyFileSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Policy list, evaluated in order. */
    policies: z.array(PolicySchema).min(1),
  })
  .strict();

/** Inferred policies-document shape. */
export type PolicyFile = z.infer<typeof PolicyFileSchema>;
