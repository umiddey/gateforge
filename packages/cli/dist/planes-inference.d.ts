/**
 * Plane-config inference for `gateforge init --planes`.
 *
 * Unconfigured repos block every table with `PLANE_UNRESOLVED` — the
 * classifier never guesses across tenant/master/global (ADR 0003 D5) —
 * so init can PROPOSE `.gateforge/planes.json` from what discovery
 * actually saw: the source directories of the discovered business
 * tables. The proposal is a review artifact, never a silent decision:
 * every rule carries a reason naming the directory it was inferred
 * from, init writes the file only on explicit consent, and the user is
 * told to review it before the next run.
 *
 * Semantics (deterministic, conservative):
 * - tables under conventional test directories (`tests/`, `test/`) are
 *   EXCLUDED from inference: they are fixtures, not business tables,
 *   and a rule endorsing them would misclassify them as business
 *   surface (they stay plane-less and gate-visible instead);
 * - source directories are grouped into MODEL TREES under the longest
 *   common directory prefix, one non-overlapping `match` glob per tree;
 * - a tree whose path names a control-plane segment (`admin`, `master`,
 *   `control`, `root`, `operator`) proposes `master`; everything else
 *   proposes `tenant`. A keyword heuristic IS a guess — but a
 *   reviewable one, written into the file with its evidence, never a
 *   runtime inference.
 */
import type { PlanesConfig } from '@gate-forge/pack-sqlalchemy';
/** The outcome of one inference pass. */
export interface PlaneInference {
    /** The proposed config, or null when there is nothing to propose. */
    readonly config: PlanesConfig | null;
    /** Human explanation when `config` is null (tip text input). */
    readonly note: string | null;
    /** How many test-directory tables were excluded from inference. */
    readonly skippedTestTables: number;
}
/**
 * Derives a proposed planes config from discovered table source paths.
 * Pure over its input; the caller owns consent and the write.
 *
 * Args:
 *   tableSources: Repo-root-relative source paths of discovered
 *     `sqlalchemy.table` resources.
 *
 * Returns:
 *   PlaneInference: The proposal with diagnostics; `config` is null
 *     when no table was discovered (nothing to map) — the note says so.
 */
export declare function inferPlanesConfig(tableSources: readonly string[]): PlaneInference;
//# sourceMappingURL=planes-inference.d.ts.map