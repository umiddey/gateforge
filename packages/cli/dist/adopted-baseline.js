/**
 * The adopted-baseline resolution seam (phase 8 C), shared by every gate
 * surface that applies baseline forgiveness: `check` and the supervised
 * `test-gates --changed` evaluation sites.
 *
 * Deliberately a STANDALONE module (not folded into evaluate.ts or the
 * commands): the fail-closed adoption gate — a baseline forgives ONLY
 * when its sibling adoption record exists — must be the ONE function
 * both commands call, so neither surface can drift into forgiving
 * without a record or loading the baseline differently.
 *
 * Shrink-only semantics live in core (`baseline update`); this module
 * only RESOLVES what the current adoption sanctions and never widens it.
 */
import { dirname, join } from 'node:path';
import { ADOPTION_RECORD_FILENAME, loadAdoptionRecord, loadBaseline } from '@gateforge/core';
import { resolveRepoPath } from './pipeline.js';
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
export function resolveAdoptedBaseline(cwd, baselinesPath) {
    const baselinePath = resolveRepoPath(cwd, baselinesPath);
    const adoption = loadAdoptionRecord(join(dirname(baselinePath), ADOPTION_RECORD_FILENAME));
    if (adoption === null)
        return null;
    return {
        fingerprints: new Set(loadBaseline(baselinePath).fingerprints),
        classificationBlocked: adoption.classificationBlocked !== undefined
            ? new Set(adoption.classificationBlocked)
            : undefined,
    };
}
//# sourceMappingURL=adopted-baseline.js.map