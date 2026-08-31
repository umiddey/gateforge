import { CLASS_SYMBOL_KIND, ClassSymbolAttributesSchema } from './schema.js';
import { compareStrings, compareLocations } from './util.js';
/**
 * Extracts class symbols from detector resources. Resources that claim
 * the reserved class-symbol kind but carry malformed attributes are
 * reported as `INVALID_RESOURCE` findings and skipped — a hostile or
 * broken symbol payload degrades to "unresolved stays unresolved",
 * never to a crash or silent drop.
 *
 * Args:
 *   detectors: all detector contributions (symbol table is repo-wide).
 *   findings: accumulator; malformed class-symbol resources append here.
 *
 * Returns:
 *   SymbolTable: qname and last-name indexes of the valid symbols.
 */
export function buildSymbolTable(detectors, findings) {
    const candidates = [];
    for (const detector of detectors) {
        for (const resource of detector.resources) {
            if (resource.kind !== CLASS_SYMBOL_KIND)
                continue;
            const parsed = ClassSymbolAttributesSchema.safeParse(resource.attributes);
            if (!parsed.success) {
                findings.push({
                    code: 'INVALID_RESOURCE',
                    detail: `class-symbol resource from ${detector.detectorId} has malformed attributes: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
                    locations: [resource.location],
                    detectorId: detector.detectorId,
                });
                continue;
            }
            candidates.push({
                qname: parsed.data.qname,
                resourceKind: parsed.data.resourceKind,
                baseNames: parsed.data.baseNames ?? [],
                tableName: parsed.data.tableName ?? null,
                abstract: parsed.data.abstract ?? false,
                tablenameUnresolved: parsed.data.tablenameUnresolved ?? false,
                source: resource.source,
                location: resource.location,
                detectorId: detector.detectorId,
                detectorVersion: detector.detectorVersion,
            });
        }
    }
    candidates.sort((a, b) => compareStrings(a.source, b.source) ||
        compareLocations(a.location, b.location));
    const byQname = new Map();
    const byLastName = new Map();
    for (const symbol of candidates) {
        const existing = byQname.get(symbol.qname);
        if (existing !== undefined) {
            findings.push({
                code: 'DUPLICATE_CLASS_QNAME',
                detail: `class qname '${symbol.qname}' declared by ${symbol.detectorId} duplicates an earlier declaration from ${existing.detectorId}; the earlier symbol (sorted by source, line, col) wins`,
                locations: [existing.location, symbol.location],
                detectorId: symbol.detectorId,
            });
            continue;
        }
        byQname.set(symbol.qname, symbol);
        const lastName = symbol.qname.split('.').at(-1) ?? symbol.qname;
        const bucket = byLastName.get(lastName);
        if (bucket === undefined)
            byLastName.set(lastName, [symbol]);
        else
            bucket.push(symbol);
    }
    return { byQname, byLastName };
}
/**
 * Resolves the inherited tablename of a class through the symbol
 * table, following declared base names in order. Per base name:
 * exact qname match, then unique same-file last-name match, then
 * unique repo-wide last-name match. The first literal tablename on
 * any followed chain wins; all failure causes of the first failing
 * base are reported when none succeeds.
 *
 * Args:
 *   symbol: the class whose tablename is missing.
 *   table: the repo-wide symbol table.
 *
 * Returns:
 *   InheritanceResolution: the literal name + defining base qname on
 *   success, or a single-cause typed explanation on failure.
 */
export function resolveInheritedName(symbol, table) {
    return walk(symbol, new Set([symbol.qname]), table);
}
function walk(symbol, visited, table) {
    let firstFailure = null;
    for (const baseName of symbol.baseNames) {
        const base = lookupBase(baseName, symbol, table);
        if (base === undefined) {
            const failure = {
                ok: false,
                cause: `base class '${baseName}' of '${symbol.qname}' not found in the symbol table`,
            };
            firstFailure ??= failure;
            continue;
        }
        if (base.tableName !== null) {
            return { ok: true, name: base.tableName, baseQname: base.qname };
        }
        if (visited.has(base.qname)) {
            const failure = {
                ok: false,
                cause: `inheritance cycle at '${base.qname}' while resolving '${symbol.qname}'`,
            };
            firstFailure ??= failure;
            continue;
        }
        visited.add(base.qname);
        const nested = walk(base, visited, table);
        if (nested.ok)
            return nested;
        firstFailure ??= nested;
    }
    return (firstFailure ?? {
        ok: false,
        cause: `'${symbol.qname}' declares no base carrying a literal tablename`,
    });
}
function lookupBase(baseName, from, table) {
    const exact = table.byQname.get(baseName);
    if (exact !== undefined)
        return exact;
    const candidates = table.byLastName.get(baseName) ?? [];
    const sameFile = candidates.filter((c) => c.source === from.source);
    if (sameFile.length === 1)
        return sameFile[0];
    if (candidates.length === 1)
        return candidates[0];
    return undefined;
}
/**
 * Builds a lookup of `file:line` → class symbol for one detector's
 * symbols. Detector unresolved entries whose location points at a
 * class statement are matched through this map, which is how a
 * resolved symbol retires its detector's unresolved entry.
 *
 * Args:
 *   symbols: the detector's own class symbols.
 *
 * Returns:
 *   Map<string, ClassSymbol>: keyed by `${file}:${line}`.
 */
export function locationIndex(symbols) {
    const index = new Map();
    for (const symbol of symbols) {
        index.set(`${symbol.location.file}:${symbol.location.line}`, symbol);
    }
    return index;
}
/**
 * Sorts unresolved entries into their deterministic output order:
 * location (file, line, col), then reason code, then detail, then
 * detector id.
 *
 * Args:
 *   entries: unresolved entries in any order.
 *
 * Returns:
 *   GraphUnresolved[]: a new sorted array.
 */
export function sortUnresolved(entries) {
    return [...entries].sort((a, b) => {
        const byLocation = compareLocations(a.reason.location, b.reason.location);
        if (byLocation !== 0)
            return byLocation;
        return (compareStrings(a.reason.code, b.reason.code) ||
            compareStrings(a.reason.detail, b.reason.detail) ||
            compareStrings(a.detectorId, b.detectorId));
    });
}
//# sourceMappingURL=symbols.js.map