/**
 * Deterministic glob matching for classification-policy scan roots and
 * internal-rule name patterns. Supports the `*` (within one segment),
 * `**` (across segments), and `?` (single character) wildcards; all
 * other characters are literal. Path separators are posix `/`.
 *
 * Pure string machinery — no filesystem, clock, or network access — so
 * core stays deterministic (Phase 1 anti-pattern guards).
 */
/** Escapes a literal string for embedding in a regular expression. */
function escapeLiteral(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Cache of compiled patterns; bounded by the policy document size. */
const compileCache = new Map();
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
export function compileGlob(pattern) {
    const cached = compileCache.get(pattern);
    if (cached !== undefined)
        return cached;
    const segments = pattern.split('/');
    const regexParts = [];
    let afterGlobStar = false;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i] ?? '';
        if (segment === '**') {
            if (i === segments.length - 1) {
                // Trailing `**`: everything after the prefix (`backend/**` matches
                // `backend/api/x.py`); a bare leading `**` matches everything.
                if (i > 0 && !afterGlobStar)
                    regexParts.push('/');
                regexParts.push('.*');
            }
            else {
                // Interior `**`: zero or more whole segments (`a/**/b` matches
                // `a/b` and `a/x/y/b`); the construct ends with its own '/'.
                regexParts.push('(?:.*/)?');
                afterGlobStar = true;
            }
            continue;
        }
        if (i > 0 && !afterGlobStar)
            regexParts.push('/');
        afterGlobStar = false;
        let segmentRegex = '';
        for (const ch of segment) {
            if (ch === '*')
                segmentRegex += '[^/]*';
            else if (ch === '?')
                segmentRegex += '[^/]';
            else
                segmentRegex += escapeLiteral(ch);
        }
        regexParts.push(segmentRegex);
    }
    const regex = new RegExp(`^${regexParts.join('')}$`);
    compileCache.set(pattern, regex);
    return regex;
}
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
export function globMatch(path, pattern) {
    return compileGlob(pattern).test(path);
}
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
export function pathInScope(path, roots) {
    for (const root of roots) {
        if (globMatch(path, root))
            return true;
    }
    return false;
}
//# sourceMappingURL=glob.js.map