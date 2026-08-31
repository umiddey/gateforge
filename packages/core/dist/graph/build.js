/**
 * Resource-graph construction (Phase 1 "resource graph construction",
 * plan §11). Pure function: detector contributions + classifications +
 * watched artifact populations → normalized, deterministically ordered
 * {@link ResourceGraph}.
 *
 * Determinism contract: same inputs → identical graph, byte-for-byte
 * under `canonicalJson`. All output arrays carry a total order; all
 * lookups iterate in sorted order; no clock, randomness, network, or
 * filesystem access happens here.
 *
 * Normalization rules (ADR 0001):
 * - D5.3: resource id = plane-qualified `plane.name`; `source` paths
 *   are repo-root-relative (posix, no `./`, no escape).
 * - Plane resolution per resource: its classification entry's `plane`
 *   (looked up by exact bare-name key, then by a unique
 *   `<plane>.<name>` key), falling back to a valid `attributes.plane`
 *   from the detector. Resources with neither stay id-less and are
 *   reported unclassified downstream — never dropped.
 * - Invariant 9 / GF-06: classifications, claims, adapter files, and
 *   waivers pointing at removed/renamed resources surface as typed
 *   `stale` entries.
 */
import { z } from 'zod';
import { ClassificationFileSchema } from '../schemas/classification.js';
import { ClaimSchema } from '../schemas/claim.js';
import { LocationSchema } from '../schemas/common.js';
import { ResourceSchema } from '../schemas/resource.js';
import { WaiverSchema } from '../schemas/waiver.js';
import { CLASS_SYMBOL_KIND, RESOURCE_NAME_ATTRIBUTE } from './schema.js';
import { buildSymbolTable, locationIndex, resolveInheritedName, sortUnresolved } from './symbols.js';
import { compareStrings, compareLocations } from './util.js';
/** Detector id stamped onto every graph-issued finding/entry. */
export const GRAPH_DETECTOR_ID = 'gateforge.graph';
/** Names must not break the `<plane>.<name>` id or `<id>:<contract>` grammar. */
const RESOURCE_NAME_PATTERN = /^[^.]+$/;
/**
 * Builds the resource graph. See the module doc for the normalization
 * rules; see `ResourceGraphSchema` for the output shape.
 *
 * Args:
 *   input: detector contributions, classifications document, and the
 *     claim/adapter/waiver populations to watch for staleness.
 *
 * Returns:
 *   ResourceGraph: normalized, sorted, byte-for-byte deterministic.
 * @throws z.ZodError when the classifications document is invalid —
 *   classification config fails closed (ADR 0001 D5.1).
 */
export function buildResourceGraph(input) {
    const classifications = parseClassifications(input.classifications);
    const findings = [];
    const symbolTable = buildSymbolTable(input.detectors, findings);
    const resources = [];
    const unresolved = [];
    const declaredNames = new Set();
    for (const detector of input.detectors) {
        ingestDetector(detector, symbolTable, classifications, resources, unresolved, declaredNames, findings);
    }
    const stale = collectStaleReferences(input, classifications, resources, declaredNames, idLessNames(resources, declaredNames), findings);
    return {
        schemaVersion: 1,
        resources: sortResources(resources),
        unresolved: sortUnresolved(unresolved),
        findings: sortFindings([...findings, ...detectDuplicateIds(resources)]),
        stale: sortStale(stale),
    };
}
/**
 * Declared names whose entry carries NO plane-qualified id — either
 * the entry is id-less (unclassified) or it was excluded while
 * malformed (bad path/name). References to such a resource bind by
 * name so they stay visible but never read as stale.
 */
function idLessNames(resources, declaredNames) {
    const idNames = new Set();
    for (const resource of resources) {
        if (resource.id !== null)
            idNames.add(resource.name);
    }
    const idLess = new Set();
    for (const name of declaredNames) {
        if (!idNames.has(name))
            idLess.add(name);
    }
    return idLess;
}
function parseClassifications(raw) {
    if (raw === undefined)
        return {};
    return ClassificationFileSchema.parse(raw).resources;
}
function ingestDetector(detector, symbolTable, classifications, resources, unresolved, declaredNames, findings) {
    const symbols = symbolsOf(symbolTable, detector.detectorId);
    const symbolAt = locationIndex(symbols);
    // Inheritance resolution first: symbols the table can resolve emit
    // concrete resources; `resolvedQnames` drives which of this
    // detector's unresolved entries are retired this run.
    const resolvedQnames = new Set();
    for (const symbol of symbols) {
        if (symbol.tableName !== null)
            continue;
        const resolution = resolveInheritedName(symbol, symbolTable);
        if (!resolution.ok) {
            if (symbol.tablenameUnresolved) {
                unresolved.push({
                    reason: {
                        code: 'inherited_tablename_unresolved',
                        detail: `class '${symbol.qname}' inherits its tablename but the symbol table could not resolve it statically: ${resolution.cause}`,
                        location: symbol.location,
                    },
                    detectorId: GRAPH_DETECTOR_ID,
                    detectorVersion: null,
                });
            }
            continue;
        }
        resolvedQnames.add(symbol.qname);
        emitEntry({
            name: resolution.name,
            kind: symbol.resourceKind,
            source: symbol.source,
            location: symbol.location,
            attributes: {
                [RESOURCE_NAME_ATTRIBUTE]: resolution.name,
                classQname: symbol.qname,
                provenance: `inherited-from-abstract:${resolution.baseQname}`,
            },
        }, detector, classifications, declaredNames, resources, unresolved, findings);
    }
    for (const rawResource of detector.resources) {
        if (rawResource.kind === CLASS_SYMBOL_KIND)
            continue; // symbol-table input, not a business resource
        const parsed = ResourceSchema.safeParse(rawResource);
        if (!parsed.success) {
            findings.push({
                code: 'INVALID_RESOURCE',
                detail: `resource from ${detector.detectorId} failed schema validation: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
                locations: [validLocationOrUnknown(rawResource)],
                detectorId: detector.detectorId,
            });
            continue;
        }
        const resource = parsed.data;
        const name = resource.attributes[RESOURCE_NAME_ATTRIBUTE];
        if (typeof name !== 'string' || name === '') {
            unresolved.push({
                reason: {
                    code: 'no_resource_name',
                    detail: `resource kind '${resource.kind}' at ${resource.location.file}:${resource.location.line} carries no '${RESOURCE_NAME_ATTRIBUTE}' attribute; identity cannot be normalized`,
                    location: resource.location,
                },
                detectorId: detector.detectorId,
                detectorVersion: detector.detectorVersion,
            });
            continue;
        }
        emitEntry({
            name,
            kind: resource.kind,
            source: resource.source,
            location: resource.location,
            attributes: resource.attributes,
        }, detector, classifications, declaredNames, resources, unresolved, findings);
    }
    for (const detectorFinding of detector.findings) {
        findings.push({
            ...detectorFinding,
            locations: [...detectorFinding.locations].sort(compareLocations),
            detectorId: detector.detectorId,
        });
    }
    for (const reason of detector.unresolved) {
        const symbol = symbolAt.get(locationKey(reason.location));
        if (symbol !== undefined && resolvedQnames.has(symbol.qname))
            continue;
        unresolved.push({
            reason,
            detectorId: detector.detectorId,
            detectorVersion: detector.detectorVersion,
        });
    }
}
/**
 * Normalizes one named declaration into a graph resource and appends
 * it (or its typed diagnostic) to the accumulators. Failures produce
 * findings/unresolved entries — never silent drops. The declared name
 * is recorded even when the entry is excluded, so references to it do
 * not read as stale while the resource is merely malformed.
 */
function emitEntry(seed, detector, classifications, declaredNames, resources, unresolved, findings) {
    declaredNames.add(seed.name);
    const path = normalizeSourcePath(seed.source);
    if (!path.ok) {
        findings.push({
            code: 'NON_REPO_RELATIVE_PATH',
            detail: `resource '${seed.name}' source '${seed.source}' is not repo-root-relative: ${path.error}`,
            locations: [seed.location],
            detectorId: detector.detectorId,
        });
        return;
    }
    if (!RESOURCE_NAME_PATTERN.test(seed.name)) {
        findings.push({
            code: 'INVALID_RESOURCE_NAME',
            detail: `resource name '${seed.name}' must not contain '.' or ':' (breaks the plane.name / id:contract grammars)`,
            locations: [seed.location],
            detectorId: detector.detectorId,
        });
        return;
    }
    const bound = bindClassification(seed.name, seed.location, seed.attributes, classifications, findings);
    resources.push({
        schemaVersion: 1,
        id: bound === null ? null : `${bound.plane}.${seed.name}`,
        name: seed.name,
        plane: bound?.plane ?? null,
        kind: seed.kind,
        source: path.path,
        location: seed.location,
        exposure: bound?.classification?.exposure ?? null,
        classification: bound?.classification ?? null,
        detector: { id: detector.detectorId, version: detector.detectorVersion },
        attributes: seed.attributes,
    });
}
/**
 * Resolves a resource's plane and classification entry. Lookup order:
 * exact bare-name key; then `<plane>.<name>` suffix keys — unique wins,
 * and when several planes classify the same name (the reason ids are
 * plane-qualified at all) a valid detector-emitted `attributes.plane`
 * disambiguates, otherwise `AMBIGUOUS_CLASSIFICATION_KEY`; finally a
 * lone valid `attributes.plane` binds identity only (classification
 * stays `null` — business meaning still unclassified). Returns `null`
 * when no plane can be derived at all.
 */
function bindClassification(name, location, attributes, classifications, findings) {
    const exact = classifications[name];
    if (exact !== undefined)
        return { plane: exact.plane, classification: exact };
    const suffix = `.${name}`;
    const matchingKeys = Object.keys(classifications)
        .sort(compareStrings)
        .filter((key) => key.endsWith(suffix));
    const attributePlane = attributes['plane'];
    const attributePlaneValid = attributePlane === 'tenant' || attributePlane === 'master' || attributePlane === 'global';
    if (matchingKeys.length > 1) {
        if (attributePlaneValid) {
            const byPlane = classifications[`${String(attributePlane)}.${name}`];
            if (byPlane !== undefined)
                return { plane: byPlane.plane, classification: byPlane };
        }
        findings.push({
            code: 'AMBIGUOUS_CLASSIFICATION_KEY',
            detail: `resource name '${name}' matches ${matchingKeys.length} classification keys (${matchingKeys.join(', ')}); no plane can be derived`,
            locations: [location],
            detectorId: GRAPH_DETECTOR_ID,
        });
        return null;
    }
    if (matchingKeys.length === 1) {
        const classification = classifications[matchingKeys[0]];
        if (classification !== undefined) {
            return { plane: classification.plane, classification };
        }
    }
    if (attributePlaneValid) {
        return { plane: attributePlane, classification: null };
    }
    return null;
}
/**
 * Normalizes a detector-supplied source path to repo-root-relative
 * posix form: backslashes become slashes, leading `./` is stripped.
 * Absolute, drive-qualified, and `..`-escaping paths are rejected with
 * a single-cause error.
 */
function normalizeSourcePath(raw) {
    let path = raw.replaceAll('\\', '/');
    while (path.startsWith('./'))
        path = path.slice(2);
    if (path === '')
        return { ok: false, error: 'path is empty' };
    if (path.startsWith('/'))
        return { ok: false, error: 'absolute paths are not repo-root-relative' };
    if (/^[A-Za-z]:/.test(path))
        return { ok: false, error: 'drive-qualified paths are not repo-root-relative' };
    if (path === '..' || path.startsWith('../') || path.includes('/../') || path.endsWith('/..')) {
        return { ok: false, error: "paths escaping the repo root ('..') are not repo-root-relative" };
    }
    return { ok: true, path };
}
function symbolsOf(table, detectorId) {
    const symbols = [];
    for (const symbol of table.byQname.values()) {
        if (symbol.detectorId === detectorId)
            symbols.push(symbol);
    }
    symbols.sort((a, b) => compareStrings(a.source, b.source) || compareLocations(a.location, b.location));
    return symbols;
}
function locationKey(location) {
    return `${location.file}:${location.line}`;
}
/**
 * Best-effort location from a resource that FAILED schema validation:
 * the raw value is untrusted, so anything that does not itself parse
 * as a Location degrades to a synthetic `<unknown>` location.
 */
function validLocationOrUnknown(resource) {
    const parsed = LocationSchema.safeParse(resource.location);
    return parsed.success
        ? parsed.data
        : { file: '<unknown>', line: 1, col: 0 };
}
/**
 * Duplicate-table-name detection (GF-20 groundwork): group normalized
 * entries by id (`plane.name`). Any id declared by more than one entry
 * — across files or within one file — yields one finding listing every
 * declaration location. The same name on different planes is
 * legitimate (plane qualification exists precisely to disambiguate it)
 * and is not flagged.
 */
function detectDuplicateIds(resources) {
    const byId = new Map();
    for (const resource of resources) {
        if (resource.id === null)
            continue;
        const bucket = byId.get(resource.id);
        if (bucket === undefined)
            byId.set(resource.id, [resource]);
        else
            bucket.push(resource);
    }
    const findings = [];
    for (const id of [...byId.keys()].sort(compareStrings)) {
        const bucket = byId.get(id);
        if (bucket === undefined || bucket.length < 2)
            continue;
        const first = bucket[0];
        if (first === undefined)
            continue;
        const locations = bucket.map((r) => r.location).sort(compareLocations);
        const files = [...new Set(bucket.map((r) => r.source))].sort(compareStrings);
        findings.push({
            code: 'DUPLICATE_TABLE_NAME',
            detail: `table name '${first.name}' declared ${bucket.length} time(s) across ${files.length} file(s) in plane '${String(first.plane)}' (files: ${files.join(', ')}); declarations collapse onto one identity — review required`,
            locations,
            detectorId: GRAPH_DETECTOR_ID,
        });
    }
    return findings;
}
/**
 * Stale-reference validation (invariant 9 / GF-06): every watched
 * artifact still pointing at a removed/renamed resource is reported.
 * Matching rules:
 * - classification keys match via the lookup convention (bare name, or
 *   a `<plane>.<name>` key over declared bare names) — a key matching
 *   no declared name is stale;
 * - claims, adapters, and waivers reference FINAL plane-qualified ids
 *   and match strictly — a plane change or rename is exactly the
 *   rename invariant 9 exists to catch. A reference also binds when
 *   its resource NAME was declared but currently carries no id
 *   (unclassified, or excluded while malformed): the resource exists,
 *   so references must not rot while the blocking entry is being fixed.
 */
function collectStaleReferences(input, classifications, resources, declaredNames, idLessNames, findings) {
    const stale = [];
    const knownIds = new Set();
    for (const resource of resources) {
        if (resource.id !== null)
            knownIds.add(resource.id);
    }
    const bindsResource = (referenceId) => {
        if (knownIds.has(referenceId))
            return true;
        for (const name of idLessNames) {
            if (referenceId === name || referenceId.endsWith(`.${name}`))
                return true;
        }
        return false;
    };
    for (const key of Object.keys(classifications).sort(compareStrings)) {
        let binds = false;
        for (const name of declaredNames) {
            if (key === name || key.endsWith(`.${name}`)) {
                binds = true;
                break;
            }
        }
        if (!binds) {
            stale.push({
                kind: 'classification',
                reference: key,
                detail: `classification '${key}' references no declared resource; the resource was removed or renamed`,
            });
        }
    }
    if (input.claims !== undefined) {
        for (const raw of input.claims) {
            const parsed = ClaimSchema.safeParse(raw);
            if (!parsed.success) {
                findings.push(invalidArtifactFinding('INVALID_CLAIM', 'claim', parsed.error));
                continue;
            }
            const claim = parsed.data;
            const resourceId = claim.obligationId.slice(0, claim.obligationId.indexOf(':'));
            if (!bindsResource(resourceId)) {
                stale.push({
                    kind: 'claim',
                    reference: claim.obligationId,
                    detail: `claim by test '${claim.testId}' references resource '${resourceId}' which no longer exists`,
                });
            }
        }
    }
    if (input.adapters !== undefined) {
        for (const adapter of input.adapters) {
            const name = adapterName(adapter);
            if (!bindsResource(name)) {
                stale.push({
                    kind: 'adapter',
                    reference: name,
                    detail: `adapter file '${adapter}' references resource '${name}' which no longer exists`,
                });
            }
        }
    }
    if (input.waivers !== undefined) {
        for (const raw of input.waivers) {
            const parsed = WaiverSchema.safeParse(raw);
            if (!parsed.success) {
                findings.push(invalidArtifactFinding('INVALID_WAIVER', 'waiver', parsed.error));
                continue;
            }
            const waiver = parsed.data;
            if (!bindsResource(waiver.scope.resourceId)) {
                stale.push({
                    kind: 'waiver',
                    reference: waiver.scope.resourceId,
                    detail: `waiver owned by '${waiver.owner}' is scoped to resource '${waiver.scope.resourceId}' which no longer exists`,
                });
            }
        }
    }
    return stale;
}
function invalidArtifactFinding(code, what, error) {
    return {
        code,
        detail: `watched ${what} failed schema validation: ${error.issues[0]?.message ?? 'unknown issue'}`,
        locations: [],
        detectorId: GRAPH_DETECTOR_ID,
    };
}
/** Strips adapter paths/extensions: `.gateforge/adapters/<id>.mjs` → `<id>`. */
function adapterName(adapter) {
    const base = adapter.replaceAll('\\', '/').split('/').at(-1) ?? adapter;
    return base.replace(/\.mjs$/, '');
}
function sortResources(resources) {
    return [...resources].sort((a, b) => {
        if (a.id !== null && b.id !== null) {
            const byId = compareStrings(a.id, b.id);
            if (byId !== 0)
                return byId;
        }
        if (a.id !== null)
            return -1; // id-bearing entries sort before id-less ones
        if (b.id !== null)
            return 1;
        return (compareStrings(a.name, b.name) ||
            compareStrings(a.source, b.source) ||
            compareLocations(a.location, b.location));
    });
}
function sortFindings(findings) {
    return [...findings].sort((a, b) => compareStrings(a.code, b.code) ||
        compareStrings(a.detail, b.detail) ||
        compareStrings(a.detectorId, b.detectorId) ||
        compareLocations(a.locations[0] ?? { file: '', line: 0, col: 0 }, b.locations[0] ?? { file: '', line: 0, col: 0 }));
}
function sortStale(stale) {
    return [...stale].sort((a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.reference, b.reference));
}
//# sourceMappingURL=build.js.map