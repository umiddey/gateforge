/**
 * Expands include globs minus exclude globs into concrete repo-root-
 * relative file paths.
 *
 * Args:
 *   include: include globs (at least one, schema-enforced).
 *   exclude: exclude globs (possibly empty).
 *   root: absolute repo root to walk.
 *
 * Returns:
 *   string[]: deduplicated, codepoint-sorted posix paths. Empty when no
 *   included file exists.
 */
export declare function expandIncludePaths(include: readonly string[], exclude: readonly string[], root: string): string[];
//# sourceMappingURL=glob.d.ts.map