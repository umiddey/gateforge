/**
 * Classification loading for the witness (engine-side).
 *
 * The witness needs each resource's `primaryKey` (to bind/stamp
 * persistence records consistently with ADR 0001 D3) and the
 * `evidenceAdapter` alias (resourceId -> adapter file name). It loads
 * the SAME classifications document the run's pipeline uses —
 * `GATEFORGE_CLASSIFICATIONS` — validated fail-closed with the frozen
 * core schema. The map is exposed (primaryKey only) on
 * `GET /classifications` so the reporter can compute faithful per-claim
 * ledger verdicts via `evaluateObligation`.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ClassificationFileSchema, } from '@gateforge/core';
import { AdapterRegistryError } from './adapter-registry.js';
/**
 * Loads the classifications document.
 *
 * Args:
 *   path: absolute path to the classifications YAML (or null/'' = none).
 *
 * Returns:
 *   Record<string, Classification>: validated per-resource map (empty
 *   when no document is configured).
 *
 * Throws:
 *   AdapterRegistryError: fail-closed load/validation problems.
 */
export function loadClassifications(path) {
    if (path === null || path === undefined || path === '')
        return {};
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        throw new AdapterRegistryError(`cannot read classifications file '${path}': ${error.message}`);
    }
    let document;
    try {
        document = parseYaml(raw);
    }
    catch (error) {
        throw new AdapterRegistryError(`classifications file '${path}' is not valid YAML: ${error.message}`);
    }
    const parsed = ClassificationFileSchema.safeParse(document);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new AdapterRegistryError(`classifications file '${path}' is invalid: ` +
            `${issue === undefined ? 'unknown issue' : `${issue.path.join('.')}: ${issue.message}`}`);
    }
    // Normalize keys to plane-qualified resource ids (ADR 0001 D5.3):
    // a bare `accounts:` entry with `plane: tenant` is keyed
    // `tenant.accounts`; an already-qualified key passes through.
    const qualified = {};
    for (const [key, entry] of Object.entries(parsed.data.resources)) {
        qualified[key.includes('.') ? key : `${entry.plane}.${key}`] = entry;
    }
    return qualified;
}
/** Projects a classification for the reporter surface. */
export function toClassificationView(entry) {
    return {
        primaryKey: [...entry.primaryKey],
        exposure: entry.exposure,
        plane: entry.plane,
        ...(entry.evidenceAdapter === undefined ? {} : { evidenceAdapter: entry.evidenceAdapter }),
        lifecycle: {
            create: entry.lifecycle.create,
            read: entry.lifecycle.read,
            update: entry.lifecycle.update,
            delete: entry.lifecycle.delete,
            ...(entry.lifecycle.deleteSemantics === undefined
                ? {}
                : { deleteSemantics: entry.lifecycle.deleteSemantics }),
            ...(entry.lifecycle.archiveFields === undefined
                ? {}
                : { archiveFields: entry.lifecycle.archiveFields }),
            ...(entry.lifecycle.updateableFields === undefined
                ? {}
                : { updateableFields: [...entry.lifecycle.updateableFields] }),
        },
    };
}
//# sourceMappingURL=classifications.js.map