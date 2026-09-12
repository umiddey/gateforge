/**
 * Adoption record persistence (phase 8 workstream C): load/write
 * `.gateforge/baselines/adoption.json` — the one-time, loud record that
 * sanctions the baseline's initial bulk-add (see schemas/adoption.ts for
 * the sibling-file decision). Loading and writing are synchronous,
 * matching `loadBaseline`'s convention.
 *
 * Trust semantics (fail closed): a MISSING record is the legitimate
 * pre-adoption state and loads as `null`; a PRESENT but unparsable or
 * schema-violating record throws — the gate must never guess whether an
 * unreadable adoption record does or does not sanction the baseline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareStrings } from '../graph/util.js';
import { GateforgeBaselineError } from './index.js';
import { AdoptionRecordSchema, ClassificationBlockedIdsSchema, } from '../schemas/adoption.js';
/** The adoption record's fixed file name, beside the baseline document. */
export const ADOPTION_RECORD_FILENAME = 'adoption.json';
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
export function loadAdoptionRecord(path) {
    if (!existsSync(path))
        return null;
    let document;
    try {
        document = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (error) {
        throw new GateforgeBaselineError(`adoption record '${path}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = AdoptionRecordSchema.safeParse(document);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `${issue.path.join('.') || '<adoption>'}: ${issue.message}`)
            .join('; ');
        throw new GateforgeBaselineError(`adoption record '${path}' failed validation: ${issues}`);
    }
    return result.data;
}
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
export function writeAdoptionRecord(path, record) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    }
    catch (error) {
        throw new GateforgeBaselineError(`adoption record '${path}' could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
}
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
export function adoptClassificationBlocked(resourceIds) {
    const seen = {};
    const unique = [];
    for (const id of resourceIds) {
        if (id in seen)
            continue;
        seen[id] = true;
        unique.push(id);
    }
    unique.sort(compareStrings);
    const result = ClassificationBlockedIdsSchema.safeParse(unique);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `${issue.path.join('.') || '<classificationBlocked>'}: ${issue.message}`)
            .join('; ');
        throw new GateforgeBaselineError(`adoption classification set failed validation: ${issues}`);
    }
    return result.data;
}
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
export function shrinkClassificationBlocked(current, resourceIds) {
    const seen = {};
    const unique = [];
    for (const id of resourceIds) {
        if (id in seen)
            continue;
        seen[id] = true;
        unique.push(id);
    }
    if (unique.length !== resourceIds.length) {
        throw new GateforgeBaselineError('classification shrink input contains duplicate resource ids');
    }
    const currentSet = current.classificationBlocked ?? [];
    const known = {};
    for (const id of currentSet)
        known[id] = true;
    const unknown = unique.filter((id) => !(id in known));
    if (unique.length >= currentSet.length || unknown.length > 0) {
        throw new GateforgeBaselineError(`classification shrink rejected: not a strict subset of the adopted set ` +
            `(the adopted classification set is shrink-only) — unknown or added id(s): ` +
            `${(unknown.length > 0 ? unknown : unique).join(', ') || '<none>'}`);
    }
    const validated = adoptClassificationBlocked(unique);
    const next = validated.length > 0
        ? { ...current, classificationBlocked: validated }
        : { ...current, classificationBlocked: [] };
    return AdoptionRecordSchema.parse(next);
}
//# sourceMappingURL=adoption.js.map