/**
 * Deterministic comparison helpers for the resource graph and policy
 * engine. All orderings in gateforge MUST go through these so that
 * outputs are byte-for-byte stable across locales, runtimes, and
 * process runs (same inputs → identical graph + obligations).
 */
/**
 * Codepoint-wise string comparison (`a < b ? -1 : a > b ? 1 : 0`).
 * Never use `localeCompare` — its result varies by ICU locale.
 *
 * Args:
 *   a: first string
 *   b: second string
 *
 * Returns:
 *   number: negative when a < b, positive when a > b, 0 when equal
 */
export declare function compareStrings(a: string, b: string): number;
/**
 * Total order over source locations: file (codepoints), then 1-based
 * line, then 0-based col. Used to keep finding/unresolved location
 * lists deterministic.
 *
 * Args:
 *   a: first location {file, line, col}
 *   b: second location {file, line, col}
 *
 * Returns:
 *   number: negative/zero/positive per the ordering above
 */
export declare function compareLocations(a: {
    file: string;
    line: number;
    col: number;
}, b: {
    file: string;
    line: number;
    col: number;
}): number;
//# sourceMappingURL=util.d.ts.map