import { type Waiver } from '../schemas/waiver.js';
import { type WaiverRef } from '../verdict/index.js';
/** One fail-closed waiver-loading problem (file-scoped, actionable). */
export interface WaiverProblem {
    /** Waiver file the problem was found in (basename). */
    file: string;
    /** Single-cause human explanation. */
    detail: string;
}
/**
 * Error raised for any fail-closed waiver configuration problem
 * (GF-15): missing mandatory fields, unparsable JSON, duplicate exact
 * scopes, or an over-long waiver duration. Carries every problem found
 * across the directory so one run reports all of them.
 */
export declare class GateforgeWaiverError extends Error {
    /** Every problem found, file-scoped, in deterministic order. */
    readonly problems: readonly WaiverProblem[];
    constructor(problems: readonly WaiverProblem[]);
}
/** Result of loading a waivers directory against the injected clock. */
export interface WaiverLoadResult {
    /** Valid waivers at `now`: five fields present, unexpired, owner checked. */
    waivers: WaiverRef[];
    /**
     * Structurally valid waivers whose owner failed the owner check
     * (GF-17); the verdict engine yields `stale` for their obligations.
     */
    staleOwner: WaiverRef[];
    /**
     * Waivers expired at the injected `now` (GF-16); the verdict engine
     * yields `invalid` for their obligations (ADR 0001 D4).
     */
    expired: Waiver[];
}
/** Options for {@link loadWaivers}. */
export interface WaiverLoadOptions {
    /**
     * Injected clock instant (Date or ISO-8601 string) expiry is judged
     * against — the wall clock never participates (GF-16, invariant 7).
     */
    now: Date | string;
    /**
     * Stale-owner hook (GF-17): return false when the waiver's owner no
     * longer exists (left the team, dissolved CODEOWNERS entry). Default:
     * no owner checking — every structurally valid owner passes.
     */
    ownerExists?: (waiver: Waiver) => boolean;
    /**
     * Optional maximum allowed waiver duration in milliseconds
     * (config-supplied constant; the concrete number is deferred to the
     * interview program per ADR 0001 D4). When set, a waiver whose
     * `expiresAt - now` exceeds it is a configuration error.
     */
    maxDurationMs?: number;
}
/**
 * Loads and validates every `*.json` waiver file in `dir` (sorted by
 * filename for determinism). A missing directory yields an empty result —
 * projects may simply have no waivers. Any problem (unparsable JSON,
 * missing mandatory field, duplicate scope, over-long duration) fails
 * closed: {@link GateforgeWaiverError} listing every problem found.
 *
 * Args:
 *   dir: the configured waivers directory (e.g. `.gateforge/waivers/`).
 *   options: injected clock, optional owner checker, optional max duration.
 *
 * Returns:
 *   WaiverLoadResult: valid / stale-owner / expired partitions.
 *
 * Throws:
 *   GateforgeWaiverError: when any waiver file fails closed (GF-15).
 */
export declare function loadWaivers(dir: string, options: WaiverLoadOptions): WaiverLoadResult;
/**
 * Serializes a waiver for on-disk storage: 2-space JSON with a trailing
 * newline (the `serializeBaseline` house style — reviewable in diffs and
 * PRs). Loading is canonical through {@link loadWaivers}'s plain
 * `JSON.parse`, so key order is irrelevant to the engine; the pretty
 * form exists for the humans who must review every exception.
 *
 * Args:
 *   waiver: the schema-valid document to serialize.
 *
 * Returns:
 *   string: the file content.
 */
export declare function serializeWaiver(waiver: Waiver): string;
/**
 * Writes a waiver to disk, creating parent directories as needed (the
 * waivers directory may not exist yet — first waiver in a repo).
 * Fail-closed: a write failure surfaces as a {@link GateforgeWaiverError}
 * (config-error → exit 2), never a half-written silent success.
 *
 * Args:
 *   path: destination file path.
 *   waiver: the schema-valid document to write.
 *
 * Throws:
 *   GateforgeWaiverError: when the file cannot be written.
 */
export declare function writeWaiver(path: string, waiver: Waiver): void;
//# sourceMappingURL=index.d.ts.map