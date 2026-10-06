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
import { ADOPTION_RECORD_FILENAME, loadAdoptionRecord, loadBaseline } from '@gate-forge/core';
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
 *
 * Args:
 *   cwd: repository root.
 *   baselinesPath: configured baseline path.
 *
 * Returns:
 *   adopted baseline fingerprint and identity metadata, or null when not adopted.
 */
export function resolveAdoptedBaseline(
  cwd: string,
  baselinesPath: string,
):
  | {
      fingerprints: ReadonlySet<string>;
      classificationBlocked?: ReadonlySet<string>;
      adoptedAt: string;
      obligationFingerprintsById?: ReadonlyMap<string, string>;
      obligationSourcesById?: ReadonlyMap<string, readonly string[]>;
    }
  | null {
  const baselinePath = resolveRepoPath(cwd, baselinesPath);
  const adoption = loadAdoptionRecord(join(dirname(baselinePath), ADOPTION_RECORD_FILENAME));
  if (adoption === null) return null;
  // Adopted families (0.13 pages rollout): a family's `forgiven`
  // fingerprints are sanctioned by the RECEIPT alone — the migration that
  // records them never touches the baseline document — so they fold into
  // the forgiveness set HERE, gated on the same receipt whose existence
  // sanctions the document. The fold cannot widen anything: `forgiven` is
  // the shrink-only subset recorded at family adoption, every entry was a
  // then-current page fingerprint, and the marker is permanent (a repeat
  // migration adds nothing). A receipt without the family field predates
  // families and forgives nothing family-shaped (fail closed).
  const fingerprints = new Set(loadBaseline(baselinePath).fingerprints);
  for (const family of Object.values(adoption.families ?? {})) {
    for (const fingerprint of family.forgiven) fingerprints.add(fingerprint);
  }
  const obligationFingerprintsById =
    adoption.obligationFingerprintsById === undefined
      ? undefined
      : new Map(
          Object.entries(adoption.obligationFingerprintsById).filter(([, fingerprint]) =>
            fingerprints.has(fingerprint),
          ),
        );
  const obligationSourcesById =
    adoption.obligationSourcesById === undefined || obligationFingerprintsById === undefined
      ? undefined
      : new Map(
          Object.entries(adoption.obligationSourcesById).filter(([id]) =>
            obligationFingerprintsById.has(id),
          ),
        );
  return {
    fingerprints,
    classificationBlocked:
      adoption.classificationBlocked !== undefined
        ? new Set(adoption.classificationBlocked)
        : undefined,
    adoptedAt: adoption.adoptedAt,
    obligationFingerprintsById,
    obligationSourcesById,
  };
}
