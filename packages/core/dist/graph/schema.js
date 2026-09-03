/**
 * Resource-graph input/output schemas (Phase 1 "resource graph
 * construction"). The graph consumes detector contributions — the
 * discovery-spike output shape pinned by GPP/3 (`resources`,
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
import { ClassificationSignalSchema } from '../schemas/classification-signal.js';
import { ClassificationDecisionTraceSchema } from '../classifier/schema.js';
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
/**
 * Evidence-only resource kinds beyond the class-symbol channel (ADR 0004
 * D1). Resources of these kinds are consumed by the engine's endpoint
 * compiler, never emitted as business resources, and never classified —
 * keeping route facts out of the business-identity namespace (the
 * route/table collision red probe). This set is ENGINE-OWNED and closed:
 * a detector cannot invent a new evidence-only kind or flag arbitrary
 * resources out of classification, because that would be a
 * detector-controlled suppressive-authority leak.
 */
export const EVIDENCE_ONLY_RESOURCE_KINDS = ['http.contract'];
/**
 * Resource `kind` the engine's endpoint compiler emits for joined
 * endpoints (ADR 0004 D1/D5). Endpoints ARE classified and carry their
 * own HTTP obligations, but `crud:*`/`persistence:*` contracts never
 * generate against them: CRUD state flows through the LINKED business
 * resource's own obligations — routes are never conflated with tables.
 * Mirrors `HTTP_ENDPOINT_KIND` in `@gateforge/http-contract` (core cannot
 * depend on it); keep the two in lockstep.
 */
export const HTTP_ENDPOINT_RESOURCE_KIND = 'http.endpoint';
/** True when a raw resource kind is engine-owned evidence-only. */
export function isEvidenceOnlyKind(kind) {
    return kind === CLASS_SYMBOL_KIND || EVIDENCE_ONLY_RESOURCE_KINDS.includes(kind);
}
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
/**
 * One detector's contribution to the graph: its pinned identity plus
 * the discovery-spike output shape. `resources` entries are validated
 * individually by the graph — invalid entries become `INVALID_RESOURCE`
 * findings instead of aborting the run (fail visible, never crash).
 *
 * Since GPP/3 (ADR 0003 D6) every contribution also carries
 * `classificationSignals` — the GPP/2 discovery shape is rejected
 * fail-closed with an actionable diagnostic naming the missing field.
 */
export const DetectorOutputSchema = z
    .strictObject({
    /** Plugin id pinned at the GPP/3 handshake (or in-process loader). */
    detectorId: z.string().min(1),
    /** Plugin version pinned at the handshake. */
    detectorVersion: z.string().min(1),
    /** Discovered resources (frozen core `Resource` shape). */
    resources: z.array(ResourceSchema),
    /** Typed reasons parts of the input could not be resolved. */
    unresolved: z.array(UnresolvedReasonSchema),
    /** Non-resource observations (duplicates, ambiguities). */
    findings: z.array(FindingSchema),
    /**
     * Classification-signal facts (ADR 0003 D1) for the discovered
     * resources. Detectors that cannot emit signals contribute an empty
     * array — conservative defaults classify their resources.
     */
    classificationSignals: z.array(ClassificationSignalSchema),
    /**
     * Repo-root-relative files the detector actually examined
     * successfully (coverage evidence, ADR 0003 D4). Optional: a
     * contribution that omits it leaves the complete-scan attestation
     * unknown, which fails closed.
     */
    scannedPaths: z.array(z.string().min(1)).optional(),
});
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
    /**
     * Explainability provenance of an automatically classified resource
     * (ADR 0003 D1): decision fingerprint, contributing signal ids,
     * rules, defaults, contradictions. Sibling metadata — NEVER
     * smuggled into detector attributes, never authoritative input.
     * `null` while the resource is unclassified or the classifier has
     * not produced a decision for it (manual classifications carry no
     * trace).
     */
    classificationTrace: ClassificationDecisionTraceSchema.nullable(),
    /** Detector provenance (handshake-pinned id + version). */
    detector: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }),
    /** Detector-specific attributes, open payload. */
    attributes: z.record(z.string(), z.unknown()),
});
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
/** Artifact kinds stale-reference validation watches (invariant 9). */
export const StaleReferenceKindSchema = z.enum(['claim', 'adapter', 'waiver']);
/**
 * A reference to a resource that no longer exists. `reference` is the
 * stale pointer itself: an obligation id, an adapter name, or a
 * waiver-scoped resource id.
 */
export const StaleReferenceSchema = z
    .strictObject({
    kind: StaleReferenceKindSchema,
    /** The stale pointer (key / obligation id / adapter name / resourceId). */
    reference: z.string().min(1),
    /** Single-cause human explanation. */
    detail: z.string().min(1),
});
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
//# sourceMappingURL=schema.js.map