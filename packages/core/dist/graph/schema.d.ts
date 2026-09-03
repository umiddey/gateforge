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
/**
 * Canonical detector attribute vocabulary (camelCase). The graph reads
 * `resourceName` as THE identity attribute of every resource; detectors
 * set it to the table name for table kinds. Class-symbol resources
 * additionally use the attribute keys declared in
 * {@link ClassSymbolAttributesSchema}.
 */
export declare const RESOURCE_NAME_ATTRIBUTE = "resourceName";
/**
 * Reserved resource `kind` marking a class-symbol declaration used by
 * the graph's symbol table for cross-module inheritance resolution
 * (go/no-go first action #2). Detectors emit one per table candidate
 * class whose identity the graph may need to resolve through base
 * classes; these resources are consumed by the symbol table and are
 * NOT emitted as business resources.
 */
export declare const CLASS_SYMBOL_KIND = "gateforge.class";
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
export declare const EVIDENCE_ONLY_RESOURCE_KINDS: readonly string[];
/** True when a raw resource kind is engine-owned evidence-only. */
export declare function isEvidenceOnlyKind(kind: string): boolean;
/** Attribute payload of a {@link CLASS_SYMBOL_KIND} resource. */
export declare const ClassSymbolAttributesSchema: z.ZodObject<{
    qname: z.ZodString;
    resourceKind: z.ZodString;
    baseNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tableName: z.ZodOptional<z.ZodString>;
    abstract: z.ZodOptional<z.ZodBoolean>;
    tablenameUnresolved: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
/** Inferred class-symbol attribute shape. */
export type ClassSymbolAttributes = z.infer<typeof ClassSymbolAttributesSchema>;
/**
 * Detector finding (discovery-spike lineage, e.g.
 * `DUPLICATE_TABLE_NAME`): a non-resource observation about the
 * scanned sources. This is the canonical home of the shape;
 * `@gateforge/plugin-protocol` carries a wire-compatible copy.
 */
export declare const FindingSchema: z.ZodObject<{
    code: z.ZodString;
    detail: z.ZodString;
    locations: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred finding shape. */
export type Finding = z.infer<typeof FindingSchema>;
/**
 * A finding with provenance: graph-issued findings use `gateforge.graph`.
 */
export declare const GraphFindingSchema: z.ZodObject<{
    code: z.ZodString;
    detail: z.ZodString;
    locations: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>>;
    detectorId: z.ZodString;
}, z.core.$strict>;
/** Inferred graph-finding shape. */
export type GraphFinding = z.infer<typeof GraphFindingSchema>;
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
export declare const DetectorOutputSchema: z.ZodObject<{
    detectorId: z.ZodString;
    detectorVersion: z.ZodString;
    resources: z.ZodArray<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodString;
        kind: z.ZodString;
        source: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
        detectorVersion: z.ZodString;
        attributes: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    unresolved: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        detail: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    findings: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        detail: z.ZodString;
        locations: z.ZodArray<z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    classificationSignals: z.ZodArray<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        target: z.ZodObject<{
            resourceName: z.ZodOptional<z.ZodString>;
            resourceId: z.ZodOptional<z.ZodString>;
            symbol: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        dimension: z.ZodEnum<{
            exposure: "exposure";
            plane: "plane";
            identity: "identity";
            "lifecycle.create": "lifecycle.create";
            "lifecycle.read": "lifecycle.read";
            "lifecycle.update": "lifecycle.update";
            "lifecycle.delete": "lifecycle.delete";
            "delete-semantics": "delete-semantics";
            "archive-state": "archive-state";
            "adapter-binding": "adapter-binding";
            internality: "internality";
        }>;
        assertion: z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodArray<z.ZodString>, z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>]>;
        basis: z.ZodEnum<{
            "code-positive": "code-positive";
            "code-negative-closed-world": "code-negative-closed-world";
            declaration: "declaration";
            "organization-policy": "organization-policy";
        }>;
        source: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
        detector: z.ZodObject<{
            id: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    scannedPaths: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/** Inferred detector-contribution shape. */
export type DetectorOutput = z.infer<typeof DetectorOutputSchema>;
/**
 * Everything the graph ingests: one or more detector contributions and
 * the artifact populations stale-reference validation watches
 * (invariant 9 / GF-06). Since the automatic-classification cutover
 * (plan phase 5, ADR 0003 D5) the graph binds NO business meaning —
 * business meaning comes only from the deterministic classifier
 * (`runClassification`) over detector signals; the manual
 * classifications document no longer exists.
 *
 * `claims` and `waivers` are deliberately typed `unknown`-tolerant: the
 * graph validates each entry individually and converts invalid ones
 * into `INVALID_CLAIM`/`INVALID_WAIVER` findings instead of aborting
 * the run (fail visible, never crash).
 */
export interface ResourceGraphInput {
    /** Detector contributions; ≥1. */
    detectors: DetectorOutput[];
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
export declare const GraphResourceSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    id: z.ZodNullable<z.ZodString>;
    name: z.ZodString;
    plane: z.ZodNullable<z.ZodEnum<{
        tenant: "tenant";
        master: "master";
        global: "global";
    }>>;
    kind: z.ZodString;
    source: z.ZodString;
    location: z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        col: z.ZodNumber;
    }, z.core.$strict>;
    exposure: z.ZodNullable<z.ZodEnum<{
        "user-facing": "user-facing";
        internal: "internal";
    }>>;
    classification: z.ZodNullable<z.ZodObject<{
        exposure: z.ZodEnum<{
            "user-facing": "user-facing";
            internal: "internal";
        }>;
        plane: z.ZodEnum<{
            tenant: "tenant";
            master: "master";
            global: "global";
        }>;
        lifecycle: z.ZodObject<{
            create: z.ZodBoolean;
            read: z.ZodBoolean;
            update: z.ZodBoolean;
            delete: z.ZodBoolean;
            deleteSemantics: z.ZodOptional<z.ZodEnum<{
                hard: "hard";
                archive: "archive";
            }>>;
            archiveFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
            updateableFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>;
        primaryKey: z.ZodArray<z.ZodString>;
        evidenceAdapter: z.ZodOptional<z.ZodString>;
        notes: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    classificationTrace: z.ZodNullable<z.ZodObject<{
        rules: z.ZodArray<z.ZodString>;
        defaultsApplied: z.ZodArray<z.ZodString>;
        contributingSignalIds: z.ZodArray<z.ZodString>;
        contributingDetectors: z.ZodArray<z.ZodString>;
        contradictions: z.ZodArray<z.ZodObject<{
            dimension: z.ZodString;
            detail: z.ZodString;
            locations: z.ZodArray<z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                col: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        unresolvedDimensions: z.ZodArray<z.ZodString>;
        decisionFingerprint: z.ZodString;
    }, z.core.$strict>>;
    detector: z.ZodObject<{
        id: z.ZodString;
        version: z.ZodString;
    }, z.core.$strict>;
    attributes: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.core.$strict>;
/** Inferred normalized-resource shape. */
export type GraphResource = z.infer<typeof GraphResourceSchema>;
/** One gate-visible unresolved entry with its detector provenance. */
export declare const GraphUnresolvedSchema: z.ZodObject<{
    reason: z.ZodObject<{
        code: z.ZodString;
        detail: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
    }, z.core.$strict>;
    detectorId: z.ZodString;
    detectorVersion: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/** Inferred graph-unresolved shape. */
export type GraphUnresolved = z.infer<typeof GraphUnresolvedSchema>;
/** Artifact kinds stale-reference validation watches (invariant 9). */
export declare const StaleReferenceKindSchema: z.ZodEnum<{
    claim: "claim";
    adapter: "adapter";
    waiver: "waiver";
}>;
/** Inferred stale-reference-kind shape. */
export type StaleReferenceKind = z.infer<typeof StaleReferenceKindSchema>;
/**
 * A reference to a resource that no longer exists. `reference` is the
 * stale pointer itself: an obligation id, an adapter name, or a
 * waiver-scoped resource id.
 */
export declare const StaleReferenceSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        claim: "claim";
        adapter: "adapter";
        waiver: "waiver";
    }>;
    reference: z.ZodString;
    detail: z.ZodString;
}, z.core.$strict>;
/** Inferred stale-reference shape. */
export type StaleReference = z.infer<typeof StaleReferenceSchema>;
/**
 * The built resource graph. Deterministic: every array is sorted by a
 * total order, so identical inputs serialize byte-for-byte identically
 * under `canonicalJson`.
 */
export declare const ResourceGraphSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    resources: z.ZodArray<z.ZodObject<{
        schemaVersion: z.ZodLiteral<1>;
        id: z.ZodNullable<z.ZodString>;
        name: z.ZodString;
        plane: z.ZodNullable<z.ZodEnum<{
            tenant: "tenant";
            master: "master";
            global: "global";
        }>>;
        kind: z.ZodString;
        source: z.ZodString;
        location: z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>;
        exposure: z.ZodNullable<z.ZodEnum<{
            "user-facing": "user-facing";
            internal: "internal";
        }>>;
        classification: z.ZodNullable<z.ZodObject<{
            exposure: z.ZodEnum<{
                "user-facing": "user-facing";
                internal: "internal";
            }>;
            plane: z.ZodEnum<{
                tenant: "tenant";
                master: "master";
                global: "global";
            }>;
            lifecycle: z.ZodObject<{
                create: z.ZodBoolean;
                read: z.ZodBoolean;
                update: z.ZodBoolean;
                delete: z.ZodBoolean;
                deleteSemantics: z.ZodOptional<z.ZodEnum<{
                    hard: "hard";
                    archive: "archive";
                }>>;
                archiveFields: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
                updateableFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>;
            primaryKey: z.ZodArray<z.ZodString>;
            evidenceAdapter: z.ZodOptional<z.ZodString>;
            notes: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        classificationTrace: z.ZodNullable<z.ZodObject<{
            rules: z.ZodArray<z.ZodString>;
            defaultsApplied: z.ZodArray<z.ZodString>;
            contributingSignalIds: z.ZodArray<z.ZodString>;
            contributingDetectors: z.ZodArray<z.ZodString>;
            contradictions: z.ZodArray<z.ZodObject<{
                dimension: z.ZodString;
                detail: z.ZodString;
                locations: z.ZodArray<z.ZodObject<{
                    file: z.ZodString;
                    line: z.ZodNumber;
                    col: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
            unresolvedDimensions: z.ZodArray<z.ZodString>;
            decisionFingerprint: z.ZodString;
        }, z.core.$strict>>;
        detector: z.ZodObject<{
            id: z.ZodString;
            version: z.ZodString;
        }, z.core.$strict>;
        attributes: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strict>>;
    unresolved: z.ZodArray<z.ZodObject<{
        reason: z.ZodObject<{
            code: z.ZodString;
            detail: z.ZodString;
            location: z.ZodObject<{
                file: z.ZodString;
                line: z.ZodNumber;
                col: z.ZodNumber;
            }, z.core.$strict>;
        }, z.core.$strict>;
        detectorId: z.ZodString;
        detectorVersion: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    findings: z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        detail: z.ZodString;
        locations: z.ZodArray<z.ZodObject<{
            file: z.ZodString;
            line: z.ZodNumber;
            col: z.ZodNumber;
        }, z.core.$strict>>;
        detectorId: z.ZodString;
    }, z.core.$strict>>;
    stale: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            claim: "claim";
            adapter: "adapter";
            waiver: "waiver";
        }>;
        reference: z.ZodString;
        detail: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred resource-graph shape. */
export type ResourceGraph = z.infer<typeof ResourceGraphSchema>;
//# sourceMappingURL=schema.d.ts.map