import { type Obligation, type ResourceGraph, type RunManifest } from '@gateforge/core';
/** Default run-state directory, repo-root-relative. */
export declare const DEFAULT_STATE_DIR = ".gateforge/test-gates";
/** Resolves the run-state directory: override (absolute or relative) or default. */
export declare function resolveStateDir(cwd: string, override?: string): string;
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
/** Persists the ambient env record and returns it (fresh token unless adopted). */
export declare function writeEnv(stateDir: string, manifest: RunManifest, witnessUrl: string | null, runToken?: string): TestGatesEnv;
/** Persists the canonical json-format run report. */
export declare function writeReport(stateDir: string, report: string): void;
//# sourceMappingURL=state.d.ts.map