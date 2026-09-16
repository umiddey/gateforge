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
//# sourceMappingURL=adopted-baseline.d.ts.map