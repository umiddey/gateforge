import { type HttpRouteCandidate, type Obligation, type ResourceGraph, type RunManifest } from '@gateforge/core';
/** Default run-state directory, repo-root-relative. */
export declare const DEFAULT_STATE_DIR = ".gateforge/test-gates";
/** Resolves the run-state directory: override (absolute or relative) or default. */
export declare function resolveStateDir(cwd: string, override?: string): string;
/**
 * Builds the COMPLETE runtime route inventory for HTTP attribution
 * (plan §9, D2): one candidate per `http.endpoint` graph resource —
 * including routes with no frontend consumer and no generated
 * obligation. Derived from the graph only; never from a claim or
 * evidence payload. Sorted by resourceId codepoint-wise so the
 * context is deterministic (Phase 6 snapshots it).
 *
 * A malformed endpoint resource (missing method/canonicalPath) is
 * NEVER dropped: it is carried with empty fields so the core resolver
 * flags the inventory incomplete instead of claiming completeness.
 *
 * Args:
 *   graph: built resource graph.
 *
 * Returns:
 *   HttpRouteCandidate[]: sorted complete candidate list.
 */
export declare function httpRoutesView(graph: ResourceGraph): HttpRouteCandidate[];
/** One obligation as the suite must see it (identity + fingerprint). */
export interface StateObligation {
    id: string;
    resourceId: string;
    contract: string;
    policyId: string;
    lifecycle: {
        create: boolean;
        read: boolean;
        update: boolean;
        delete: boolean;
    };
    fingerprint: string;
    source: string;
    location: {
        file: string;
        line: number;
        col: number;
    } | null;
}
/**
 * Builds the suite-visible obligation list: pin-#2 fingerprints plus the
 * resource source/location from the graph (empty when the resource is
 * gone — the reporter still sees the obligation id it must cover).
 *
 * Args:
 *   obligations: policy-generated obligations.
 *   graph: built resource graph (source/location lookup).
 *
 * Returns:
 *   StateObligation[]: one entry per obligation.
 */
export declare function stateObligations(obligations: readonly Obligation[], graph: ResourceGraph): StateObligation[];
/** The ambient env record written to `env.json` and exported to the suite. */
export interface TestGatesEnv {
    GATEFORGE_RUN_ID: string;
    GATEFORGE_RUN_TOKEN: string;
    GATEFORGE_STATE_DIR: string;
    GATEFORGE_OBLIGATIONS: string;
    /** Witness-service URL; null until G6 wires the loopback service. */
    GATEFORGE_WITNESS_URL: string | null;
}
/** Reads an optional JSON array state file; absent → [], invalid → error. */
export declare function readJsonArray(stateDir: string, name: string): unknown[];
/** Persists the validated run manifest. */
export declare function writeManifest(stateDir: string, manifest: RunManifest): void;
/** Persists the suite-visible obligations document (sorted by id). */
export declare function writeObligations(stateDir: string, obligations: readonly StateObligation[]): void;
/**
 * Persists the derived runtime route inventory (plan §9, D2) for the
 * suite-side reporter: advisory context ONLY so the reporter can show
 * useful per-claim rows. The authoritative CLI recomputes this list
 * from the graph on every run and never reads this file.
 */
export declare function writeHttpRoutesView(stateDir: string, routes: readonly HttpRouteCandidate[]): void;
/**
 * Persists the run's effective-classification view (plan phase 5) as a
 * derived artifact for the verifier side (e.g. the witness service's
 * `GET /classifications` surface). NEVER authoritative engine input: the
 * engine recomputes classifications from signals on every run.
 */
export declare function writeClassificationsView(stateDir: string, view: Record<string, unknown>): void;
/** Persists the ambient env record and returns it (fresh token unless adopted). */
export declare function writeEnv(stateDir: string, manifest: RunManifest, witnessUrl: string | null, runToken?: string): TestGatesEnv;
/** Persists the canonical json-format run report. */
export declare function writeReport(stateDir: string, report: string): void;
//# sourceMappingURL=state.d.ts.map