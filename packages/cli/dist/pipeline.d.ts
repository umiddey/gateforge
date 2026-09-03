import { type ChangedProvider, type ClassificationFile, type ClassificationResult, type DetectorOutput, type GateforgeConfig, type PolicyEvaluationResult, type ResourceGraph, type RunManifest } from '@gateforge/core';
import { type EndpointInventory } from './endpoint-compiler.js';
/** Everything one pipeline run needs. */
export interface PipelineOptions {
    /** Repo root; all repo-relative paths resolve against it. */
    cwd: string;
    /** Process environment (CI provider variables, …). */
    env: NodeJS.ProcessEnv;
    /** Validated `.gateforge.yml`. */
    config: GateforgeConfig;
    /** Changed-provider identity stamped into the manifest (pin #4). */
    provider: ChangedProvider;
    /** Absolute run-state directory (claims source; may not exist). */
    stateDir: string;
    /** Fixed run id; default is a fresh random UUID. */
    runId?: string;
}
/** The complete pipeline result. */
export interface PipelineResult {
    /** One validated contribution per configured plugin (config order). */
    contributions: DetectorOutput[];
    /** Compiled endpoint inventory (ADR 0004 D6): facts, endpoints, blocks. */
    endpointInventory: EndpointInventory;
    /** The built resource graph with effective classifications bound. */
    graph: ResourceGraph;
    /** Policy evaluation: obligations, blocking entries, claim assessments. */
    policy: PolicyEvaluationResult;
    /** Run manifest (pin #4), validated. */
    manifest: RunManifest;
    /** The injected run instant (used for verdicts and waivers too). */
    now: string;
    /** Changed files per the chosen provider ([] for all-files). */
    changedFiles: string[];
    /** The raw classifier result (decisions with traces, stale/invalid signals). */
    classification: ClassificationResult;
    /**
     * The effective-classification view (plan phase 5): every resolved
     * resource's classification keyed by plane-qualified id. Derived
     * artifact — the engine recomputes it from signals on every run and
     * never reads it back as input.
     */
    classificationsView: ClassificationFile;
}
/** Source-file map resourceId → repo-relative source (for diff scoping). */
export declare function sourceByResourceId(graph: ResourceGraph): Map<string, string>;
/**
 * Join-aware change sources (plan phase 7.4): an endpoint obligation is
 * in scope when the backend route source OR any joined frontend-call
 * source changed — a change on either end of the join pulls the joined
 * endpoint's obligations into scope.
 */
export declare function sourcesByResourceId(graph: ResourceGraph): Map<string, string[]>;
/** Reads the HEAD sha of the repo in `cwd`, or null when unavailable. */
export declare function headSha(cwd: string): string | null;
/** Reads a YAML document fail-closed (missing/unparsable → UsageError). */
export declare function loadYaml(path: string, label: string): unknown;
/** Lists adapter names (basenames sans `.mjs`) from the adapters dir. */
export declare function loadAdapterNames(cwd: string, dir: string): string[];
/** Resolves a repo-root-relative config path against the cwd. */
export declare function resolveRepoPath(cwd: string, repoRelative: string): string;
/**
 * Runs the full pipeline.
 *
 * Args:
 *   options: cwd, env, validated config, provider identity, state dir.
 *
 * Returns:
 *   PipelineResult: contributions, graph, policy result, manifest, the
 *   injected run instant, and changed files.
 *
 * Throws:
 *   UsageError (exit 2): fail-closed problems — plugin failures, missing
 *   policy/classification-policy documents, invalid documents, or an
 *   unreadable git state for the chosen provider.
 */
export declare function runPipeline(options: PipelineOptions): Promise<PipelineResult>;
/**
 * Projects the bound effective classifications into the derived
 * view document (plan phase 5): every resource whose classification the
 * classifier resolved, keyed by plane-qualified id. The pipeline never
 * reads this back as input — recomputed from signals on every run.
 */
export declare function effectiveClassifications(graph: ResourceGraph, classification: ClassificationResult): ClassificationFile;
//# sourceMappingURL=pipeline.d.ts.map