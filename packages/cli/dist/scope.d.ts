import { type GateforgeConfig } from '@gateforge/core';
/** One effective evaluation scope, decided before grading. */
export interface ScopeDecision {
    /** `all` = evaluate every obligation and blocker; `changed` = diff-narrowed. */
    mode: 'all' | 'changed';
    /** Actual normalized diff list from the provider (kept for reporting). */
    changedFiles: string[];
    /** Sorted matched gate-defining inputs/reasons that forced expansion. */
    expandedBecause: string[];
    /**
     * Phase 4 (E15, strict E2E mode only): changed source files no
     * detector/resource join can attribute AND no mapping covers — each
     * becomes a `CHANGE_UNMAPPED` blocking entry in the caller. Empty in
     * non-strict mode (the historical contract is unchanged there).
     */
    unmappedFiles: string[];
}
/**
 * Computes one effective evaluation scope for a `--changed` run.
 *
 * Args:
 *   input: config, actual normalized diff list, and the optional Phase 4
 *     expansion inputs — catalog test files (with their directories for
 *     fixture/helper expansion), runner config file names, whether the
 *     mapping sidecar is present, the known resource source files, and
 *     whether strict E2E mode is on (unclassified changes then expand
 *     AND surface as CHANGE_UNMAPPED).
 *
 * Returns:
 *   ScopeDecision: `all` with sorted `expandedBecause` reasons when any
 *   changed file is gate-defining, test/fixture/runner-config/mapping
 *   related, or (strict mode) unclassified; otherwise the narrowed
 *   `changed` scope with `unmappedFiles` populated (strict mode only).
 */
export declare function computeEvaluationScope(input: {
    config: GateforgeConfig;
    changedFiles: readonly string[];
    testFiles?: readonly string[];
    runnerConfigs?: readonly string[];
    mappingSidecar?: boolean;
    knownSourceFiles?: readonly string[];
    strictE2E?: boolean;
}): ScopeDecision;
/**
 * Lists files whose staged (index) bytes differ from working-tree bytes.
 * The local-staged provider reports index-vs-HEAD, but discovery reads
 * working-tree bytes — certifying "staged" scope from worktree bytes
 * would be dishonest, so these files need an explicit blocking/usage
 * diagnostic (plan §12.3). No isolated index snapshot is evaluated in
 * this repair, and no isolated worktree is added to dodge the diagnostic.
 *
 * Args:
 *   cwd: repo root.
 *   env: process environment (GIT_* threading, like the providers).
 *
 * Returns:
 *   string[]: normalized, sorted mismatch list (empty when clean).
 */
export declare function detectStagedWorkingTreeMismatches(cwd: string, env: NodeJS.ProcessEnv): string[];
//# sourceMappingURL=scope.d.ts.map