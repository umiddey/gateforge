import type { Io } from '../io.js';
export declare const CHECK_USAGE: string;
/**
 * Resolves the adopted-baseline forgiveness set for this repo (phase 8 C).
 *
 * Fail-closed semantics:
 * - NO adoption record (the normal pre-adoption state) → nothing is
 *   forgiven, even if a baseline file exists: an unrecorded bulk-add is
 *   unsanctioned and forgives nothing.
 * - Record present but baseline missing/corrupt → throws (exit 2): the
 *   receipt without the document it sanctions is a broken adoption.
 * - Record present and baseline valid → the recorded fingerprint set,
 *   plus the classification layer (two-layer adoption) when the receipt
 *   carries it. A pre-layer receipt (no `classificationBlocked` field) is
 *   simply NOT ADOPTED for that layer — nothing classification-shaped is
 *   waived without the recorded set (fail closed, backward compatible).
 */
export declare function resolveAdoptedBaseline(cwd: string, baselinesPath: string): {
    fingerprints: ReadonlySet<string>;
    classificationBlocked?: ReadonlySet<string>;
} | null;
/**
 * Runs the check subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved (or a blocked staged
 *   candidate), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export declare function checkCommand(io: Io, argv: readonly string[]): Promise<number>;
//# sourceMappingURL=check.d.ts.map