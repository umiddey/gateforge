/** One filesystem failure encountered while expanding the scan. */
export interface ExpandError {
    /** The repo-root-relative path that could not be read. */
    path: string;
    /** What failed (readdir vs stat) and the OS cause. */
    detail: string;
}
/**
 * Expands include globs minus exclude globs into concrete repo-root-
 * relative file paths.
 *
 * FAIL-CLOSED (red-team F3): filesystem failures are never silent. An
 * unreadable directory or a failed stat means files MAY exist that the
 * scan could not see — they are collected in `errors` so the pipeline
 * can block the gate and invalidate closed-world proofs instead of
 * letting them vanish from both the requested and scanned sets.
 *
 * Args:
 *   include: include globs (at least one, schema-enforced).
 *   exclude: exclude globs (possibly empty).
 *   root: absolute repo root to walk.
 *   errors: out-array collecting every unreadable path.
 *
 * Returns:
 *   string[]: deduplicated, codepoint-sorted posix paths. Empty when no
 *   included file exists.
 */
export declare function expandIncludePaths(include: readonly string[], exclude: readonly string[], root: string, errors?: ExpandError[]): string[];
//# sourceMappingURL=glob.d.ts.map