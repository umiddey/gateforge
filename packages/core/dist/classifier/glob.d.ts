/**
 * Deterministic glob matching for classification-policy scan roots and
 * internal-rule name patterns. Supports the `*` (within one segment),
 * `**` (across segments), and `?` (single character) wildcards; all
 * other characters are literal. Path separators are posix `/`.
 *
 * Pure string machinery — no filesystem, clock, or network access — so
 * core stays deterministic (Phase 1 anti-pattern guards).
 */
/**
 * Compiles one glob pattern to a whole-string regular expression.
 * A `**` segment matches across segment boundaries: as the last segment
 * it matches everything after the prefix (`backend/STAR-STAR` matches
 * `backend/api/x.py`); in the middle it matches zero or more whole
 * segments (`a/STAR-STAR/b` matches `a/b` and `a/x/y/b`). `*` matches
 * within a single segment; `?` matches one non-separator character.
 *
 * Args:
 *   pattern: glob pattern, e.g. `backend/**` or `*_audit`.
 *
 * Returns:
 *   RegExp: anchored, case-sensitive matcher.
 */
export declare function compileGlob(pattern: string): RegExp;
/**
 * Whether a repo-root-relative path matches one glob pattern.
 *
 * Args:
 *   path: posix repo-root-relative path.
 *   pattern: glob pattern.
 *
 * Returns:
 *   boolean: true when the whole path matches.
 */
export declare function globMatch(path: string, pattern: string): boolean;
/**
 * Whether a path falls inside ANY of the given roots (the complete-scan
 * scope test of ADR 0003 D4).
 *
 * Args:
 *   path: posix repo-root-relative path.
 *   roots: scan-root globs.
 *
 * Returns:
 *   boolean: true when at least one root matches the path.
 */
export declare function pathInScope(path: string, roots: readonly string[]): boolean;
//# sourceMappingURL=glob.d.ts.map