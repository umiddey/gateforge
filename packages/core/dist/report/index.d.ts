import type { BlockingEntry } from '../policy/index.js';
import type { RunManifest } from '../schemas/run-manifest.js';
import { type ObligationVerdict } from '../verdict/index.js';
/** Waiver-population counts for report summaries (from the waivers loader). */
export interface WaiverCounts {
    /** All waivers found in the configured directory. */
    total: number;
    /** Valid at the injected `now` (five fields, unexpired, owner checked). */
    active: number;
    /** Expired at the injected `now` (GF-16) — blocking as `invalid`. */
    expired: number;
    /** Failed the owner check (GF-17) — blocking as `stale`. */
    staleOwner: number;
}
/** Options for {@link renderRun}. */
export interface RenderRunOptions {
    /** Output format. */
    format: 'json' | 'sarif' | 'text';
    /** Unclassified/unresolved blocking entries (invariants 1, 8). */
    blocking?: readonly BlockingEntry[];
    /** Waiver-population counts; included in json/text when provided. */
    waiverCounts?: WaiverCounts;
    /** Run manifest; included in the json report when provided. */
    run?: RunManifest;
    /** Tool version stamped into SARIF `tool.driver.version`. */
    toolVersion?: string;
}
/** A run's exit code (architecture contract 4). */
export type RunExitCode = 0 | 1 | 2;
/**
 * Maps a run outcome to its exit code: 2 for config/usage errors,
 * 1 when any blocking verdict or blocking entry exists, else 0
 * (clean or waived).
 *
 * Args:
 *   input: verdicts, optional blocking entries, optional config-error flag.
 *
 * Returns:
 *   RunExitCode: 0 clean/waived, 1 unresolved, 2 config.
 */
export declare function runExitCode(input: {
    verdicts: readonly ObligationVerdict[];
    blocking?: readonly BlockingEntry[];
    configError?: boolean;
}): RunExitCode;
/**
 * Renders a run's verdicts in the requested format. Output is canonical
 * JSON for `json`/`sarif` and deterministic text for `text`.
 *
 * Args:
 *   verdicts: per-obligation verdicts (any order; output is sorted).
 *   options: format, blocking entries, waiver counts, run manifest.
 *
 * Returns:
 *   string: the rendered report.
 *
 * Throws:
 *   Error: when `format` is not one of the three supported formats.
 */
export declare function renderRun(verdicts: readonly ObligationVerdict[], options: RenderRunOptions): string;
//# sourceMappingURL=index.d.ts.map