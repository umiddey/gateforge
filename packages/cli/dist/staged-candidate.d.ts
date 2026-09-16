import { type CauseCode } from '@gate-forge/core';
/** The verify argument a generated hook accepts to prove activation. */
export declare const HOOK_VERIFY_ARG = "--gateforge-verify";
/** Marker lines delimiting the gateforge-managed block of a hook file. */
export declare const HOOK_MARKER_BEGIN = "# >>> gateforge pre-commit v1 >>>";
export declare const HOOK_MARKER_END = "# <<< gateforge pre-commit v1 <<<";
/** One staged change (frozen index vs base), NUL-delimited plumbing data. */
export interface StagedChange {
    /** Destination path (the path the candidate carries). */
    path: string;
    /** Git one-letter change status (A/M/D/T/R/C). */
    status: 'A' | 'M' | 'D' | 'T' | 'R' | 'C';
    /** Source path for renames/copies (R/C statuses only). */
    oldPath?: string;
}
/**
 * A typed staged-candidate block (plan §5.4): the candidate cannot be
 * verified, so the gate blocks with a stable cause code instead of
 * falling back to weaker evidence. Never thrown for ordinary config or
 * git failures — those stay {@link UsageError} (exit 2).
 */
export declare class StagedCandidateBlockError extends Error {
    /** The §5.4 cause code this block reports. */
    readonly causeCode: CauseCode;
    /** The §5.4 next action text. */
    readonly nextAction: string;
    /**
     * Args:
     *   causeCode: the typed cause (e.g. ENFORCEMENT_UNTRUSTED).
     *   detail: precise human-readable reason (names the offending path).
     *   nextAction: actionable next step; defaults to the §5.4 action for
     *     the cause.
     */
    constructor(causeCode: CauseCode, detail: string, nextAction?: string);
}
/** A frozen staged candidate (identity + materialized checkout). */
export interface StagedCandidate {
    /** Frozen index tree id (40-char hex). */
    treeId: string;
    /** HEAD at freeze time, or null for an initial commit. */
    headSha: string | null;
    /** MERGE_HEAD at freeze time, or null outside merge commits. */
    mergeHeadSha: string | null;
    /** Parents the staged candidate would be committed onto: [], [HEAD], or [HEAD, MERGE_HEAD]. */
    parentShas: string[];
    /** Staged changes (frozen index vs base), sorted by path. */
    changed: StagedChange[];
    /** Normalized union of changed paths (including rename sources). */
    changedPaths: string[];
    /** Scratch directory owning the index copy and the checkout (absolute). */
    scratchDir: string;
    /** Absolute path of the materialized candidate checkout (after materialization). */
    checkoutDir: string | null;
}
/**
 * Freezes the staged candidate (plan Phase 5 item 3): records the index
 * tree identity, parent/base identity (HEAD, MERGE_HEAD, or none for an
 * initial commit), and the staged change set vs the base — without
 * writing anything to the user's repository. Partial staging is fine:
 * the candidate is exactly what is staged.
 *
 * Args:
 *   cwd: absolute repository root.
 *   env: process environment.
 *
 * Returns:
 *   StagedCandidate: the frozen identity (checkoutDir not yet set).
 *
 * Throws:
 *   StagedCandidateBlockError: unmerged index, symlink, or submodule.
 *   UsageError: outside a git repository or on plumbing failure.
 */
export declare function freezeStagedCandidate(cwd: string, env: NodeJS.ProcessEnv): StagedCandidate;
/**
 * Materializes an isolated checkout of the frozen tree (plan Phase 5
 * item 3): `git read-tree` + `git checkout-index` into a scratch
 * directory, then a throwaway Git repository is initialized inside it so
 * the regular gate pipeline (config load, input snapshot, run state) runs
 * against the staged bytes unchanged. The user's worktree/index/refs are
 * never modified.
 *
 * Args:
 *   cwd: absolute repository root the tree objects live in.
 *   env: process environment.
 *   frozen: the frozen candidate from {@link freezeStagedCandidate}.
 *
 * Returns:
 *   string: absolute path of the candidate checkout.
 */
export declare function materializeStagedCandidate(cwd: string, env: NodeJS.ProcessEnv, frozen: StagedCandidate): string;
/**
 * Re-checks the candidate immediately before authorizing (plan Phase 5
 * item 4): recomputes the index tree from a FRESH copy of the user's
 * index and re-resolves HEAD/MERGE_HEAD. ANY drift is a typed block —
 * different bytes never receive authorization.
 *
 * Args:
 *   cwd: absolute repository root.
 *   env: process environment.
 *   frozen: the frozen candidate.
 *
 * Returns:
 *   {ok: true} | {ok: false, detail}: the typed recheck outcome.
 */
export declare function recheckStagedCandidate(cwd: string, env: NodeJS.ProcessEnv, frozen: StagedCandidate): {
    ok: true;
} | {
    ok: false;
    detail: string;
};
/**
 * Removes the candidate scratch directory (checkout + index copies).
 *
 * Args:
 *   frozen: the frozen candidate (idempotent).
 */
export declare function releaseStagedCandidate(frozen: StagedCandidate): void;
/**
 * Resolves the repository's hook directory (`core.hooksPath` honored via
 * `git rev-parse --git-path hooks`), as an absolute path.
 *
 * Args:
 *   cwd: repository root (relative hooksPath values resolve against it).
 *   env: process environment.
 *
 * Returns:
 *   string | null: absolute hooks directory, or null outside a repo.
 */
export declare function resolveHooksDir(cwd: string, env: NodeJS.ProcessEnv): string | null;
/** The strict staged gate invocation hooks execute (same gate as CI). */
export declare const HOOK_GATE_COMMAND = "check --staged --require-e2e";
/**
 * Builds the generated pre-commit hook script (plan Phase 5 items 1–2):
 * activates with `--gateforge-verify`, resolves the engine robustly
 * (repo-local node_modules/.bin, then PATH, then $GATEFORGE_CLI — a
 * missing engine BLOCKS the commit, fail closed), and execs the strict
 * staged gate (`check --staged --require-e2e`) — the same gate CI runs —
 * so the hook always gates the exact staged candidate. The script states
 * the honest standard-mode limit (ADR 0005 D1): `--no-verify` bypasses
 * the local hook.
 *
 * Returns:
 *   string: the hook script text (marker-delimited, POSIX sh).
 */
export declare function gateforgeHookScript(): string;
/** Whether a hook file body carries the gateforge marker block. */
export declare function hasGateforgeMarker(body: string): boolean;
/**
 * Verifies hook ACTIVATION (plan Phase 5 item 1) beyond mere existence:
 * regular file, exec bit set, gateforge marker present, and the script
 * actually executes its verify mode (`--gateforge-verify`) successfully.
 *
 * Args:
 *   hookPath: absolute path of the pre-commit hook.
 *
 * Returns:
 *   {ok, detail}: the typed activation outcome.
 */
export declare function verifyHookActivation(hookPath: string): {
    ok: boolean;
    detail: string;
};
//# sourceMappingURL=staged-candidate.d.ts.map