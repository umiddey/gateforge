/**
 * Witness-side data shapes (pin #7 wire + adapter contract, pin #8).
 */
import type { EvidenceRecord, TrustTier } from '@gateforge/core';
/**
 * `POST /records` body (pin #7): a test-side primitive submitting
 * UI-observed evidence. `claimId` is the claimed obligation id — the
 * annotation's `<resourceId>:<contract>` — and `testId` binds the record
 * to the test that produced the claim (the reporter writes claims keyed
 * by the same testId, so the verdict engine can attribute records).
 */
export interface RecordsRequest {
    claimId: string;
    kind: string;
    payload: unknown;
    testId: string;
}
/** `POST /records` response (pin #7, minimal wire contract). */
export interface RecordsResponse {
    recordId: string;
    trust: TrustTier;
    runId: string;
}
/**
 * `POST /witness/persistence` body (pin #7): the fixture asks the
 * engine-side witness to run the resource's reviewed adapter (GET-only)
 * for one entity. The issued record carries the ENGINE OBSERVATION
 * (`found`, adapter-normalized `fields`, and a `before` link when a
 * pre-observation was consumed) — expectations NEVER come from the
 * suite (audit round 5).
 *
 * `preObservationId` references a witness-issued pre-observation (`POST
 * /witness/pre-observation`): an id-set snapshot for create
 * postconditions (`before: {entityAbsent}`), or an entity-fields
 * snapshot for update postconditions (`before: {found, fields}`).
 */
export interface PersistenceRequest {
    resourceId: string;
    entityId: unknown;
    preObservationId?: string;
}
/** `POST /witness/pre-observation` body: an engine-side snapshot taken
 * BEFORE a claimed action. With `entityId` the witness snapshots that
 * entity's observed fields (update postconditions); without it, the
 * resource's observed id set (create postconditions). */
export interface PreObservationRequest {
    resourceId: string;
    testId: string;
    claimId: string;
    entityId?: unknown;
}
/** `POST /witness/pre-observation` response. */
export interface PreObservationResponse {
    observationId: string;
    observed: number;
}
/** `POST /witness/persistence` response (pin #7). */
export interface PersistenceResponse {
    recordId: string;
    runId: string;
    verdictRelevant: {
        found: boolean;
        fieldsMatch: boolean;
        mismatches?: string[];
    };
}
/** Witness runtime configuration (env-derived by the bin, explicit in tests). */
export interface WitnessOptions {
    /** Run manifest identity (pin #4). */
    runId: string;
    /** Per-run token; every call must carry `x-gateforge-run: <token>`. */
    token: string;
    /**
     * Verifier key for the attestation surface (`GET /ledger-attestation`
     * and the manifest `recordIdsMac`): shared by the orchestrator with
     * the witness and the evaluating CLI, NEVER with the tested suite.
     * When absent the witness serves no attestation and its manifest
     * append stays unauthenticated (downstream evaluation fails closed
     * for witnessed records).
     */
    verifierKey?: string | null;
    /** Run-state dir; the witness appends its issued recordIds to manifest.json at shutdown. */
    stateDir?: string | null;
    /** Directory of reviewed `.mjs` adapters (default `.gateforge/adapters`). */
    adaptersDir?: string | null;
    /** Classifications document path (YAML) for the primaryKey map + adapter aliases. */
    classificationsPath?: string | null;
    /**
     * Attestation subject (the SUT the UI drives). MUST be loopback
     * (GF-10); the witness probes its env-fingerprint marker at startup
     * when `targetFingerprint` is set (GF-13 minimal v1 attestation).
     */
    targetBaseUrl?: string | null;
    /** Expected `x-gateforge-env-fingerprint` marker at the attestation subject. */
    targetFingerprint?: string | null;
    /** Default base for adapter reads; a per-adapter `baseUrl` wins. */
    adapterBaseUrl?: string | null;
    /** Per-witness-call timeout (pin #7 default 5s). */
    requestTimeoutMs?: number;
    /** Injected clock for `issuedAt` (ISO-8601); default = system now. */
    now?: () => string;
    /** Host to bind; default `127.0.0.1` (loopback). */
    host?: string;
}
/** The normalized adapter module contract (pin #8). */
export interface EvidenceAdapter {
    /** GET-only transport. Returns the raw entity body, or null when absent. */
    read: (ctx: AdapterContext, id: unknown) => Promise<unknown> | unknown;
    /**
     * Optional GET-only listing of the resource's entities (raw bodies).
     * Powers engine-side pre-observations for create postconditions; when
     * absent the witness refuses pre-observations for the resource.
     */
    list?: (ctx: AdapterContext) => Promise<unknown[]> | unknown[];
    /** Projects the raw body onto {entityId, fields} — stamped from the RESPONSE. */
    normalize: (body: unknown) => {
        entityId: unknown;
        fields: unknown;
    };
    /** Removal semantics the adapter's resource uses. */
    deletion: 'hard' | 'archive';
    /** Fingerprint the adapter's target environment must present. */
    environmentFingerprint: string;
    /** Optional base override for THIS adapter's reads. */
    baseUrl?: string;
}
/** The transport handed to `read` (GET-only, engine-mediated). */
export interface AdapterContext {
    /** The resolved read base for this adapter. */
    baseUrl: string;
    /** The resource this adapter serves. */
    resourceId: string;
    /**
     * The ONLY outbound primitive available to adapters: a GET returning
     * a minimal response view (status + JSON/text body + headers).
     */
    get: (path: string) => Promise<{
        status: number;
        json(): Promise<unknown>;
        text(): Promise<string>;
        headers: Headers;
    }>;
}
/** Full witness-issued record (superset of the pinned wire response). */
export type IssuedRecord = EvidenceRecord;
/** Result of spawning/attaching a witness service. */
export interface WitnessHandle {
    /** Base URL (loopback, OS-assigned port). */
    url: string;
    /** Stop the server; appends issued recordIds to the run manifest (pin #4/#7). */
    stop: () => Promise<void>;
}
//# sourceMappingURL=types.d.ts.map