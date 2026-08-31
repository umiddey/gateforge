/**
 * Resource-graph input/output schemas (Phase 1 "resource graph
 * construction"). The graph consumes detector contributions — the
 * discovery-spike output shape pinned by GPP/2 (`resources`,
 * `unresolved`, `findings`) plus detector provenance — and produces the
 * normalized, deterministically ordered graph the policy engine and
 * verdict engine speak.
 *
 * ADR 0001 encoded here:
 * - D5.3: resource ids are plane-qualified `plane.name`; `source`
 *   paths are normalized repo-root-relative (discovery-spike
 *   limitation 5: spike ids embed command-line-relative paths);
 * - D1: `unresolved` entries stay first-class and gate-visible;
 * - invariant 9: references to removed/renamed resources surface as
 *   typed `stale` entries, never silent disappearance.
 */
import { z } from 'zod';
import { ExposureSchema, LocationSchema, PlaneSchema, SchemaVersionField } from '../schemas/common.js';
import { ClassificationSchema } from '../schemas/classification.js';
import { ResourceSchema } from '../schemas/resource.js';
import { UnresolvedReasonSchema } from '../schemas/verdict.js';

/**
 * Canonical detector attribute vocabulary (camelCase). The graph reads
 * `resourceName` as THE identity attribute of every resource; detectors
 * set it to the table name for table kinds. Class-symbol resources
 * additionally use the attribute keys declared in
 * {@link ClassSymbolAttributesSchema}.
 */
export const RESOURCE_NAME_ATTRIBUTE = 'resourceName';

/**
 * Reserved resource `kind` marking a class-symbol declaration used by
 * the graph's symbol table for cross-module inheritance resolution
 * (go/no-go first action #2). Detectors emit one per table candidate
 * class whose identity the graph may need to resolve through base
 * classes; these resources are consumed by the symbol table and are
 * NOT emitted as business resources.
 */
export const CLASS_SYMBOL_KIND = 'gateforge.class';

/** Attribute payload of a {@link CLASS_SYMBOL_KIND} resource. */
export const ClassSymbolAttributesSchema = z
  .strictObject({
    /** Scope-qualified class name (dotted), e.g. `pkg.models.Base`. */
    qname: z.string().min(1),
    /** `kind` the graph must use for a table materialized from this class. */
    resourceKind: z.string().min(1),
    /** Direct base classes as written in source, in declaration order. */
    baseNames: z.array(z.string().min(1)).optional(),
    /** Literal `__tablename__` declared on the class itself, if any. */
    tableName: z.string().min(1).optional(),
    /** True for `__abstract__ = True` bases (never materialize directly). */
    abstract: z.boolean().optional(),
    /**
     * Detector assertion that this class's tablename is unresolved;
     * when the symbol table cannot resolve it either, the graph
     * synthesizes a typed `inherited_tablename_unresolved` entry so
     * the class never vanishes silently.
     */
    tablenameUnresolved: z.boolean().optional(),
  });

/** Inferred class-symbol attribute shape. */
export type ClassSymbolAttributes = z.infer<typeof ClassSymbolAttributesSchema>;

/**
 * Detector finding (discovery-spike lineage, e.g.
 * `DUPLICATE_TABLE_NAME`): a non-resource observation about the
 * scanned sources. This is the canonical home of the shape;
 * `@gateforge/plugin-protocol` carries a wire-compatible copy.
 */
export const FindingSchema = z
  .strictObject({
    /** Short stable finding code, e.g. `DUPLICATE_TABLE_NAME`. */
    code: z.string().min(1),
    /** Single-cause human explanation. */
    detail: z.string().min(1),
    /** Source locations the finding points at (≥1, deterministically ordered). */
    locations: z.array(LocationSchema).min(1),
  });

/** Inferred finding shape. */
export type Finding = z.infer<typeof FindingSchema>;

/**
 * A finding with provenance: graph-issued findings use `gateforge.graph`.
 */
export const GraphFindingSchema = z
  .strictObject({
    code: z.string().min(1),
    detail: z.string().min(1),
    /**
     * Source locations the finding points at. Detector findings carry
     * ≥1 (the pinned shape); graph-issued findings may carry zero when
     * no single source location applies (e.g. schema-invalid claims).
     */
    locations: z.array(LocationSchema),
    /** Detector that issued the finding. */
    detectorId: z.string().min(1),
  });

/** Inferred graph-finding shape. */
export type GraphFinding = z.infer<typeof GraphFindingSchema>;

/**
 * One detector's contribution to the graph: its pinned identity plus
 * the discovery-spike output shape. `resources` entries are validated
 * individually by the graph — invalid entries become `INVALID_RESOURCE`
 * findings instead of aborting the run (fail visible, never crash).
 */
export const DetectorOutputSchema = z
  .strictObject({
    /** Plugin id pinned at the GPP/2 handshake (or in-process loader). */
    detectorId: z.string().min(1),
    /** Plugin version pinned at the handshake. */
    detectorVersion: z.string().min(1),
    /** Discovered resources (frozen core `Resource` shape). */
    resources: z.array(ResourceSchema),
    /** Typed reasons parts of the input could not be resolved. */
    unresolved: z.array(UnresolvedReasonSchema),
    /** Non-resource observations (duplicates, ambiguities). */
    findings: z.array(FindingSchema),
  });

/** Inferred detector-contribution shape. */
export type DetectorOutput = z.infer<typeof DetectorOutputSchema>;

/**
 * Everything the graph ingests: one or more detector contributions,
 * the declarative classifications file (validated fail-closed at build
 * time via `ClassificationFileSchema`), and the artifact populations
 * stale-reference validation watches (invariant 9 / GF-06).
 *
 * `classifications`, `claims`, and `waivers` are deliberately typed
 * `unknown`-tolerant: the graph validates each entry individually and
 * converts invalid ones into `INVALID_CLAIM`/`INVALID_WAIVER` findings
 * instead of aborting the run (fail visible, never crash).
 */
export interface ResourceGraphInput {
  /** Detector contributions; ≥1. */
  detectors: DetectorOutput[];
  /** `.gateforge` classifications document (keys: names or plane-qualified ids). */
  classifications?: unknown;
  /** Claims to watch for stale references (obligation ids). */
  claims?: unknown[];
  /** Adapter file names or paths (`.gateforge/adapters/<resourceId>.mjs`). */
  adapters?: string[];
  /** Waivers to watch for stale references (exact-scope resourceIds). */
  waivers?: unknown[];
}

/**
 * A normalized graph resource. `id` is the plane-qualified `plane.name`
 * identity (D5.3); it is `null` while the resource is unclassified and
 * no plane could be derived. `classification`/`exposure` are `null`
 * until a classification entry binds the resource. Class-symbol
 * resources never appear here (consumed by the symbol table).
 */
export const GraphResourceSchema = z
  .strictObject({
    schemaVersion: SchemaVersionField,
    /** `plane.name`, or `null` while the plane is unknown (unclassified). */
    id: z.string().min(1).nullable(),
    /** Bare resource name (`resourceName` attribute). */
    name: z.string().min(1),
    /** Resolved plane, or `null` while unclassified-without-plane. */
    plane: PlaneSchema.nullable(),
    /** Detector framework kind, e.g. `sqlalchemy.table`. */
    kind: z.string().min(1),
    /** Repo-root-relative source path (posix separators, no `./`). */
    source: z.string().min(1),
    /** Exact declaration location in `source`. */
    location: LocationSchema,
    /** Classification exposure, or `null` while unclassified. */
    exposure: ExposureSchema.nullable(),
    /** Bound classification entry, or `null` while unclassified. */
    classification: ClassificationSchema.nullable(),
    /** Detector provenance (handshake-pinned id + version). */
    detector: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }),
    /** Detector-specific attributes, open payload. */
    attributes: z.record(z.string(), z.unknown()),
  });

/** Inferred normalized-resource shape. */
export type GraphResource = z.infer<typeof GraphResourceSchema>;

/** One gate-visible unresolved entry with its detector provenance. */
export const GraphUnresolvedSchema = z
  .strictObject({
    /** Typed reason, verbatim from the detector or graph-synthesized. */
    reason: UnresolvedReasonSchema,
    /** Issuing detector; graph-synthesized entries use `gateforge.graph`. */
    detectorId: z.string().min(1),
    /** Issuing detector version; `null` for graph-synthesized entries. */
    detectorVersion: z.string().min(1).nullable(),
  });

/** Inferred graph-unresolved shape. */
export type GraphUnresolved = z.infer<typeof GraphUnresolvedSchema>;

/** Artifact kinds stale-reference validation watches (invariant 9). */
export const StaleReferenceKindSchema = z.enum([
  'classification',
  'claim',
  'adapter',
  'waiver',
]);

/** Inferred stale-reference-kind shape. */
export type StaleReferenceKind = z.infer<typeof StaleReferenceKindSchema>;

/**
 * A reference to a resource that no longer exists. `reference` is the
 * stale pointer itself: a classification key, an obligation id, an
 * adapter name, or a waiver-scoped resource id.
 */
export const StaleReferenceSchema = z
  .strictObject({
    kind: StaleReferenceKindSchema,
    /** The stale pointer (key / obligation id / adapter name / resourceId). */
    reference: z.string().min(1),
    /** Single-cause human explanation. */
    detail: z.string().min(1),
  });

/** Inferred stale-reference shape. */
export type StaleReference = z.infer<typeof StaleReferenceSchema>;

/**
 * The built resource graph. Deterministic: every array is sorted by a
 * total order, so identical inputs serialize byte-for-byte identically
 * under `canonicalJson`.
 */
export const ResourceGraphSchema = z
  .strictObject({
    schemaVersion: SchemaVersionField,
    /** Normalized resources, sorted by id (id-less entries last, by name). */
    resources: z.array(GraphResourceSchema),
    /** Gate-visible unresolved entries, sorted by location then code. */
    unresolved: z.array(GraphUnresolvedSchema),
    /** Detector findings + graph-issued findings, sorted deterministically. */
    findings: z.array(GraphFindingSchema),
    /** References to removed/renamed resources (invariant 9), sorted. */
    stale: z.array(StaleReferenceSchema),
  });

/** Inferred resource-graph shape. */
export type ResourceGraph = z.infer<typeof ResourceGraphSchema>;
