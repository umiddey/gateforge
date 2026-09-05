/**
 * The pack's discover entry: a thin TypeScript GPP/3 client over the
 * Python AST detector, usable from BOTH CLI transports.
 *
 * - **in-process**: `.gateforge.yml` declares
 *   `transport: in-process, module: "@gateforge/pack-sqlalchemy"`; the
 *   CLI imports this package's default export and calls
 *   `discover(paths)`. The implementation spawns the SAME python
 *   detector (GPP/3, hardened host) with a computed `PYTHONPATH`, so
 *   one detector implementation serves both transports.
 * - **subprocess**: `.gateforge.yml` declares
 *   `transport: subprocess, command: ["python3","-m","gateforge_sqlalchemy_detector"]`
 *   (with the pack's `python/` dir on `PYTHONPATH`); the CLI drives the
 *   plugin directly — see the README.
 *
 * Determinism: the python scan is pure over (paths, file bytes). Plane
 * attribution is opt-in through detector options or the declarative
 * `.gateforge/planes.json` document (see `planes.ts`); core owns
 * business meaning.
 */
import { fileURLToPath } from 'node:url';
import { delimiter, resolve } from 'node:path';
import { PluginSession, } from '@gateforge/plugin-protocol';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
import { NO_PLANE_MAPPING, PLANES_CONFIG_PATH, readPlanesConfigOrNull, resolvePlaneByRules, } from './planes.js';
/** Absolute dir of this pack's `python/` tree (the detector package). */
const PACK_PYTHON_DIR = fileURLToPath(new URL('../python', import.meta.url));
/** Absolute dir of the sibling `@gateforge/plugin-protocol` python client. */
const PROTOCOL_PYTHON_DIR = fileURLToPath(new URL('../../../plugin-protocol/python', import.meta.url));
/** The subprocess command the in-process transport spawns (G4 surface). */
export const DEFAULT_COMMAND = ['python3', '-m', 'gateforge_sqlalchemy_detector'];
/**
 * Builds the environment the python detector runs under: the host env
 * plus a `PYTHONPATH` that makes both this pack's detector and the
 * GPP/3 client importable.
 *
 * Args:
 *   extra: Additional leading `PYTHONPATH` entries (for tests).
 *
 * Returns:
 *   NodeJS.ProcessEnv: host env + deterministic PYTHONPATH.
 */
export function pythonEnvironment(extra = []) {
    const entries = [...extra, PACK_PYTHON_DIR, PROTOCOL_PYTHON_DIR];
    return { ...process.env, PYTHONPATH: entries.join(delimiter) };
}
/** The table facts of one resource, or null when it is not a named table. */
function tableFactsOf(resource) {
    const name = resource.attributes['resourceName'];
    if (resource.kind !== 'sqlalchemy.table' || typeof name !== 'string') {
        return null;
    }
    const classQname = typeof resource.attributes['classQname'] === 'string'
        ? resource.attributes['classQname']
        : null;
    return {
        tableName: name,
        classQname,
        classSimpleName: classQname === null ? null : (classQname.split('.').pop() ?? null),
        provenance: typeof resource.attributes['tablenameProvenance'] === 'string'
            ? resource.attributes['tablenameProvenance']
            : 'literal',
        sourcePath: resource.source,
    };
}
/**
 * Shared table-mapping pass: rebuilds exactly the resources whose
 * decider returns a plane (`attributes.plane` added; order, ids, and
 * every other field preserved). `gateforge.class` symbols never carry a
 * plane. Pure over its inputs — deterministic.
 */
function mapTablePlanes(outcome, decide) {
    const resources = outcome.resources.map((resource) => {
        const facts = tableFactsOf(resource);
        if (facts === null)
            return resource;
        const mapped = decide(facts);
        if (mapped === null)
            return resource;
        return { ...resource, attributes: { ...resource.attributes, plane: mapped } };
    });
    return {
        resources,
        unresolved: outcome.unresolved,
        findings: outcome.findings,
        classificationSignals: outcome.classificationSignals,
        ...(outcome.scannedPaths !== undefined ? { scannedPaths: outcome.scannedPaths } : {}),
    };
}
/**
 * Attaches `attributes.plane` to each table the rule maps (a mirror of
 * the graph's classification binding; disambiguates same-name
 * multi-plane classification). Pure over its inputs — deterministic.
 *
 * Args:
 *   outcome: The python discovery outcome.
 *   plane: The plane rule to apply.
 *
 * Returns:
 *   RawOutcome: New outcome; tables the rule maps carry `plane`.
 */
export function applyPlaneMapping(outcome, plane) {
    return mapTablePlanes(outcome, (facts) => plane({
        tableName: facts.tableName,
        classQname: facts.classQname,
        provenance: facts.provenance,
    }));
}
/** The code of the blocking declarative-plane conflict finding. */
export const PLANE_RULE_CONTRADICTION = 'PLANE_RULE_CONTRADICTION';
/**
 * Builds the conflict finding: it names the table, EVERY conflicting
 * plane, EVERY human reason, and EVERY rule index (the review artifact
 * is the config; the diagnostic points straight at its lines).
 */
function planeContradictionFinding(facts, location, hits) {
    const described = hits
        .map((hit) => `rule ${hit.index} (${hit.plane}, "${hit.reason}")`)
        .join(' vs ');
    return {
        code: PLANE_RULE_CONTRADICTION,
        detail: `table '${facts.tableName}' matches ${hits.length} declarative plane rules with ` +
            `conflicting planes: ${described}; fix ${PLANES_CONFIG_PATH} so exactly one plane ` +
            'remains — the table stays plane-unresolved and blocks until then',
        locations: [{ file: location.file, line: location.line, col: location.col }],
    };
}
/** Finding order: first location (file, line, col), then code, then detail. */
function compareFindings(a, b) {
    const locationA = a.locations[0];
    const locationB = b.locations[0];
    const fileA = locationA?.file ?? '';
    const fileB = locationB?.file ?? '';
    if (fileA !== fileB)
        return fileA < fileB ? -1 : 1;
    const lineA = locationA?.line ?? 0;
    const lineB = locationB?.line ?? 0;
    if (lineA !== lineB)
        return lineA - lineB;
    const colA = locationA?.col ?? 0;
    const colB = locationB?.col ?? 0;
    if (colA !== colB)
        return colA - colB;
    if (a.code !== b.code)
        return a.code < b.code ? -1 : 1;
    if (a.detail === b.detail)
        return 0;
    return a.detail < b.detail ? -1 : 1;
}
/**
 * Applies the declarative `.gateforge/planes.json` rules to business
 * `sqlalchemy.table` resources. Deterministic and fail-closed, in two
 * tiers with explicit-beats-general precedence: a table claimed by any
 * `tables` rule resolves only against `tables` rules (glob rules are
 * ignored for it — an enumeration is a more specific human claim, and
 * a glob's `exclude` prunes source files, not table names); glob rules
 * apply only to tables no explicit rule claims. Within the deciding
 * tier: agreement → the plane is applied (the graph then qualifies the
 * id as `plane.name`); conflict → a blocking
 * {@link PLANE_RULE_CONTRADICTION} finding is appended (sorted) and NO
 * plane is applied; no match → nothing (the resource stays
 * plane-unresolved and the core classifier blocks it — the config must
 * cover every table). Pure over its inputs.
 *
 * Args:
 *   outcome: The python discovery outcome.
 *   config: The validated declarative plane config.
 *
 * Returns:
 *   RawOutcome: New outcome with agreed planes and any conflict findings.
 */
export function applyPlanesConfig(outcome, config) {
    const contradictionFindings = [];
    const resources = outcome.resources.map((resource) => {
        const facts = tableFactsOf(resource);
        if (facts === null)
            return resource;
        const resolution = resolvePlaneByRules(config, {
            sourcePath: facts.sourcePath,
            tableName: facts.tableName,
            classSimpleName: facts.classSimpleName,
        });
        if (resolution.conflict) {
            contradictionFindings.push(planeContradictionFinding(facts, resource.location, resolution.hits));
        }
        if (resolution.plane === null)
            return resource;
        return { ...resource, attributes: { ...resource.attributes, plane: resolution.plane } };
    });
    contradictionFindings.sort(compareFindings);
    return {
        resources,
        unresolved: outcome.unresolved,
        findings: [...outcome.findings, ...contradictionFindings],
        classificationSignals: outcome.classificationSignals,
        ...(outcome.scannedPaths !== undefined ? { scannedPaths: outcome.scannedPaths } : {}),
    };
}
/**
 * Creates a discover-capable detector module. The default export of the
 * pack is `createSqlalchemyDetector()` — the CLI in-process contract.
 *
 * Plane channels, in strict precedence order: the programmatic
 * `options.plane` rule (config channel not read at all), then the
 * explicit `options.planesConfig`, then the `.gateforge/planes.json`
 * document read from the working directory at discover time (absence
 * normal → `NO_PLANE_MAPPING` behavior byte-identical; malformed
 * throws).
 *
 * Args:
 *   options: Plane mapping, spawn command/env, and handshake identity.
 *
 * Returns:
 *   SqlalchemyDetector: the pinned `{ discover(paths) }` module.
 */
export function createSqlalchemyDetector(options = {}) {
    const plane = options.plane;
    const command = options.command ?? DEFAULT_COMMAND;
    const env = options.env ?? pythonEnvironment();
    const pluginId = options.pluginId ?? PACK_PLUGIN_ID;
    const pluginVersion = options.pluginVersion ?? PACK_VERSION;
    return {
        async discover(paths) {
            if (paths.length === 0) {
                return { resources: [], unresolved: [], findings: [], classificationSignals: [] };
            }
            const session = new PluginSession({
                command: [...command],
                pluginId,
                pluginVersion,
                cwd: process.cwd(),
                env,
                timeouts: { handshakeMs: 10_000, requestMs: 30_000, shutdownMs: 10_000 },
            });
            try {
                await session.start();
                const outcome = await session.discover([...paths]);
                const withSignals = {
                    resources: outcome.resources,
                    unresolved: outcome.unresolved,
                    findings: outcome.findings,
                    classificationSignals: outcome.classificationSignals,
                    ...(outcome.scannedPaths !== undefined ? { scannedPaths: outcome.scannedPaths } : {}),
                };
                if (plane !== undefined) {
                    return planeIsNoop(plane) ? withSignals : applyPlaneMapping(withSignals, plane);
                }
                const config = options.planesConfig ??
                    readPlanesConfigOrNull(resolve(process.cwd(), options.planesConfigPath ?? PLANES_CONFIG_PATH));
                if (config.rules.length === 0) {
                    return withSignals; // no rules: byte-identical to NO_PLANE_MAPPING
                }
                return applyPlanesConfig(withSignals, config);
            }
            finally {
                await session.dispose();
            }
        },
    };
}
/** True when a plane rule can never map anything. */
function planeIsNoop(plane) {
    return plane === NO_PLANE_MAPPING;
}
//# sourceMappingURL=detector.js.map