import { type GateforgeConfig } from '@gateforge/core';
/** One effective evaluation scope, decided before grading. */
export interface ScopeDecision {
    /** `all` = evaluate every obligation and blocker; `changed` = diff-narrowed. */
    mode: 'all' | 'changed';
    /** Actual normalized diff list from the provider (kept for reporting). */
    changedFiles: string[];
    /** Sorted matched gate-defining inputs/reasons that forced expansion. */
    expandedBecause: string[];
}
/**
 * Computes one effective evaluation scope for a `--changed` run.
 *
 * Args:
 *   config: validated `.gateforge.yml` (custom policy/classification
 *     paths included by construction — they are read from the config,
 *     never compared against defaults).
 *   changedFiles: actual normalized diff list from the diff provider.
 *
 * Returns:
 *   ScopeDecision: `all` with sorted `expandedBecause` reasons when any
 *   changed file is gate-defining (deleted files included — they are
 *   still in the diff list); otherwise the narrowed `changed` scope.
 */
export declare function computeEvaluationScope(input: {
    config: GateforgeConfig;
    changedFiles: readonly string[];
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