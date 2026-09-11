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
//# sourceMappingURL=adoption.d.ts.map