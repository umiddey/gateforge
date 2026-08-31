import { type ChangedProvider, type DetectorOutput, type GateforgeConfig, type PolicyEvaluationResult, type ResourceGraph, type RunManifest } from '@gateforge/core';
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
    /** The built resource graph (deterministic). */
    graph: ResourceGraph;
    /** Policy evaluation: obligations, blocking entries, claim assessments. */
    policy: PolicyEvaluationResult;
    /** Run manifest (pin #4), validated. */
    manifest: RunManifest;
    /** The injected run instant (used for verdicts and waivers too). */
    now: string;
    /** Changed files per the chosen provider ([] for all-files). */
    changedFiles: string[];
}
/** Source-file map resourceId → repo-relative source (for diff scoping). */
export declare function sourceByResourceId(graph: ResourceGraph): Map<string, string>;
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
 *   policy/classification documents, invalid policy documents, or an
 *   unreadable git state for the chosen provider.
 */
export declare function runPipeline(options: PipelineOptions): Promise<PipelineResult>;
//# sourceMappingURL=pipeline.d.ts.map