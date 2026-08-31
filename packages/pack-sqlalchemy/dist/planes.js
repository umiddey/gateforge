/**
 * Configurable tenant/master/global plane mapping for discovered tables.
 *
 * The authoritative plane mapping in a Gateforge run is the declarative
 * classifications file referenced by `.gateforge.yml` (ADR 0002:
 * classifications are declarative YAML); the graph binds every resource
 * to a plane there. This module gives the pack two ways to ALSO make the
 * detector output self-describing:
 *
 * - {@link planeRuleFromProjectConfig}: the default — read the project
 *   config (`.gateforge.yml`, then its classifications document) and
 *   attach ``attributes.plane`` to every table the mapping names. This
 *   is the "configurable tenant/master plane mapping from the project
 *   config" surface; it also deterministically disambiguates
 *   `AMBIGUOUS_CLASSIFICATION_KEY` cases (a name classified on several
 *   planes) because the detector pins the plane at discovery time.
 * - {@link byTableName} / a custom {@link PlaneRule}: programmatic
 *   mapping for users of {@link createSqlalchemyDetector}.
 *
 * The graph re-derives classification regardless; `attributes.plane` is
 * a valid disambiguator (and a lone valid plane binds identity only).
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@gateforge/core';
import { ClassificationFileSchema } from '@gateforge/core';
import { parse as parseYaml } from 'yaml';
/** The empty rule: no plane attribution; the graph classifies alone. */
export const NO_PLANE_MAPPING = () => null;
/** Rule that maps table names to planes; unmapped tables stay null. */
export function byTableName(mapping) {
    const table = new Map(Object.entries(mapping));
    return (context) => table.get(context.tableName) ?? null;
}
/** Sentinel for a name classified on more than one plane. */
const AMBIGUOUS = Symbol('ambiguous-plane');
/**
 * Builds a plane rule from a parsed classifications document, using the
 * graph's binding convention: a bare-name key wins; otherwise the unique
 * `<plane>.<name>` suffix key. A name classified on several planes
 * yields no plane here (the graph's `AMBIGUOUS_CLASSIFICATION_KEY`
 * finding stays authoritative).
 *
 * Args:
 *   document: The parsed classifications document (schema `1`).
 *
 * Returns:
 *   PlaneRule | null: A rule over the document's classifications, or
 *     `null` when the document is not a valid classifications file.
 */
export function fromClassificationsDocument(document) {
    const parsed = ClassificationFileSchema.safeParse(document);
    if (!parsed.success)
        return null;
    const byName = new Map();
    for (const [key, entry] of Object.entries(parsed.data.resources)) {
        const dot = key.indexOf('.');
        const name = dot === -1 ? key : key.slice(dot + 1);
        const existing = byName.get(name);
        if (existing === undefined) {
            byName.set(name, entry.plane);
        }
        else if (existing !== entry.plane && existing !== AMBIGUOUS) {
            byName.set(name, AMBIGUOUS);
        }
    }
    if (byName.size === 0)
        return null;
    return (context) => {
        const plane = byName.get(context.tableName);
        return plane === undefined || plane === AMBIGUOUS ? null : plane;
    };
}
/**
 * Loads the plane rule configured by the project config in `cwd`.
 *
 * Best-effort by design: the CLASSIFIATIONS file is the authoritative
 * plane mapping; `attributes.plane` is a mirror/disambiguator, so any
 * config read problem (missing `.gateforge.yml`, unreadable or invalid
 * classifications document) degrades to {@link NO_PLANE_MAPPING} — the
 * downstream graph fails closed or classifies on its own either way.
 *
 * Args:
 *   cwd: Repo root (process working directory for a CLI run).
 *
 * Returns:
 *   PlaneRule: never throws.
 */
export function planeRuleFromProjectConfig(cwd) {
    const configPath = join(cwd, '.gateforge.yml');
    if (!existsSync(configPath))
        return NO_PLANE_MAPPING;
    let config;
    try {
        config = loadConfig(configPath);
    }
    catch {
        return NO_PLANE_MAPPING;
    }
    const classificationsPath = join(cwd, config.classifications);
    if (!existsSync(classificationsPath))
        return NO_PLANE_MAPPING;
    try {
        const document = parseYaml(readFileSync(classificationsPath, 'utf8'));
        return fromClassificationsDocument(document) ?? NO_PLANE_MAPPING;
    }
    catch {
        return NO_PLANE_MAPPING;
    }
}
//# sourceMappingURL=planes.js.map