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
 *   adapter, so `evidenceAdapter` is mandatory for user-facing entries —
 *   on the BUSINESS-resource lane. `http.endpoint` resources are witnessed
 *   through the claims/witness-proxy lane (`http:frontend-request-observed`
 *   etc.), not through entity persistence adapters (whose contract — read
 *   by id, normalize body, deletion kind — is about business entities), so
 *   a user-facing classification may instead declare
 *   `evidenceLane: 'claims'` and omit the adapter.
 */
import { z } from 'zod';
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
export declare const LifecycleSchema: z.ZodObject<{
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
/** Inferred lifecycle shape. */
export type Lifecycle = z.infer<typeof LifecycleSchema>;
/**
 * Classification entry for a single resource id.
 */
export declare const ClassificationSchema: z.ZodObject<{
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
    evidenceLane: z.ZodOptional<z.ZodEnum<{
        adapter: "adapter";
        claims: "claims";
    }>>;
    notes: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Inferred per-resource classification shape. */
export type Classification = z.infer<typeof ClassificationSchema>;
/**
 * The classifications document: `.gateforge` classification YAML mapping
 * resource ids to their classification. Resources discovered but absent
 * here are `unclassified` and fail closed downstream.
 */
export declare const ClassificationFileSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    resources: z.ZodRecord<z.ZodString, z.ZodObject<{
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
        evidenceLane: z.ZodOptional<z.ZodEnum<{
            adapter: "adapter";
            claims: "claims";
        }>>;
        notes: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Inferred classifications-document shape. */
export type ClassificationFile = z.infer<typeof ClassificationFileSchema>;
//# sourceMappingURL=classification.d.ts.map