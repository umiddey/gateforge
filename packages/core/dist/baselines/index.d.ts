import { type Baseline } from '../schemas/baseline.js';
/**
 * Error raised for any fail-closed baseline problem: missing file,
 * unparsable JSON, schema violation, or a non-strict-subset update
 * (GF-07's count-preserving debt laundering).
 */
export declare class GateforgeBaselineError extends Error {
    constructor(message: string);
}
/**
 * Loads and validates a baseline document. Fail-closed: a missing,
 * unparsable, or schema-violating file throws — callers decide whether
 * that means "no baseline yet" for their flow.
 *
 * Args:
 *   path: baseline file path (default `.gateforge/baselines/obligations.json`).
 *
 * Returns:
 *   Baseline: the validated document (sorted, duplicate-free fingerprints).
 *
 * Throws:
 *   GateforgeBaselineError: on any load or validation failure.
 */
export declare function loadBaseline(path: string): Baseline;
/**
 * Whether a baseline update is a strict subset (invariant 4): every
 * fingerprint in `next` exists in `current` AND at least one fingerprint
 * is removed. `[A, B] → [A, B]` is not an update (nothing was resolved)
 * and `[A, B] → [A, NEW]` fails (GF-07); `[A, B] → [A]` passes (GF-08).
 *
 * Args:
 *   current: the baseline on disk.
 *   next: the proposed replacement.
 *
 * Returns:
 *   boolean: true only for a non-empty proper subset.
 */
export declare function canUpdate(current: Baseline, next: Baseline): boolean;
/**
 * Builds the next baseline from raw fingerprints, enforcing the strict-
 * subset rule (invariant 4) against `current`. Input order is irrelevant:
 * the result is sorted; duplicates in the input are an error.
 *
 * Args:
 *   current: the baseline on disk.
 *   fingerprints: the resolved fingerprints to keep.
 *
 * Returns:
 *   Baseline: the validated next document.
 *
 * Throws:
 *   GateforgeBaselineError: on duplicates or a non-strict-subset update
 *   (naming the added fingerprints — GF-07's laundering attempt).
 */
export declare function updateBaseline(current: Baseline, fingerprints: readonly string[]): Baseline;
/**
 * Serializes a baseline for on-disk storage: sorted 2-space JSON with a
 * trailing newline (reviewable in diffs; canonical hashing is a separate
 * pin-#1 concern and does not apply to this file's formatting).
 *
 * Args:
 *   baseline: the document to serialize.
 *
 * Returns:
 *   string: the file content.
 */
export declare function serializeBaseline(baseline: Baseline): string;
/**
 * Writes a baseline to disk, creating parent directories as needed.
 *
 * Args:
 *   path: destination file path.
 *   baseline: the document to write.
 *
 * Throws:
 *   GateforgeBaselineError: when the file cannot be written.
 */
export declare function writeBaseline(path: string, baseline: Baseline): void;
//# sourceMappingURL=index.d.ts.map