import { type AdoptionRecord } from '../schemas/adoption.js';
/** The adoption record's fixed file name, beside the baseline document. */
export declare const ADOPTION_RECORD_FILENAME = "adoption.json";
/**
 * Loads the adoption record for a repo.
 *
 * Args:
 *   path: adoption-record file path (`.gateforge/baselines/adoption.json`).
 *
 * Returns:
 *   AdoptionRecord | null: the validated record, or null when absent
 *   (pre-adoption repo).
 *
 * Throws:
 *   GateforgeBaselineError: when the file exists but is unparsable or
 *   fails schema validation (fail closed — never silently unsanctioned).
 */
export declare function loadAdoptionRecord(path: string): AdoptionRecord | null;
/**
 * Writes an adoption record to disk, creating parent directories as
 * needed. Serialized sorted 2-space JSON with a trailing newline
 * (reviewable in diffs, like the baseline document).
 *
 * Args:
 *   path: destination file path.
 *   record: the validated adoption record.
 *
 * Throws:
 *   GateforgeBaselineError: when the file cannot be written.
 */
export declare function writeAdoptionRecord(path: string, record: AdoptionRecord): void;
/**
 * The classification layer of the sanctioned bulk-add (two-layer
 * adoption): normalizes the classification-blocked resource ids captured
 * at adoption time into the receipt's canonical form — sorted, duplicate-
 * free, schema-validated. Input order is irrelevant; duplicates are
 * collapsed (the ids are collected from blocking entries, so exact
 * duplicates are expected to be absent, not an error).
 *
 * Args:
 *   resourceIds: the classification-blocked resource ids captured at
 *     adoption time (entries with kind 'classification' and a derived id).
 *
 * Returns:
 *   string[]: the validated, sorted, unique id list for the receipt.
 *
 * Throws:
 *   GateforgeBaselineError: when any id fails schema validation.
 */
export declare function adoptClassificationBlocked(resourceIds: readonly string[]): string[];
/**
 * The classification set's ONLY mutation after adoption (the shrink path,
 * mirroring `updateBaseline`'s GF-07/08 semantics): replaces the receipt's
 * `classificationBlocked` with the given ids, which must be a STRICT
 * SUBSET of the current set — every id kept must exist today AND at least
 * one id must be removed. A resource leaves the set only when it gained a
 * real classification; adding or re-listing ids fails closed (the adopted
 * set can never grow, so new classification debt can never be laundered
 * into the sanctioned starting point).
 *
 * Args:
 *   current: the adopted record on disk (its effective classification set,
 *     [] when the field is absent).
 *   resourceIds: the ids to keep (duplicates are an error, as in
 *     `updateBaseline`).
 *
 * Returns:
 *   AdoptionRecord: the next record — identical to `current` except for
 *   the (always-present, possibly empty) shrunk `classificationBlocked`.
 *
 * Throws:
 *   GateforgeBaselineError: on duplicate input, schema-invalid ids, or a
 *   non-strict-subset update (naming the added ids).
 */
export declare function shrinkClassificationBlocked(current: AdoptionRecord, resourceIds: readonly string[]): AdoptionRecord;
//# sourceMappingURL=adoption.d.ts.map