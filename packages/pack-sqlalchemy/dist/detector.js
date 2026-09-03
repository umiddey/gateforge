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
 * attribution is opt-in through detector options; core owns business meaning.
 */
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import { PluginSession } from '@gateforge/plugin-protocol';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
import { NO_PLANE_MAPPING } from './planes.js';
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
    const resources = outcome.resources.map((resource) => {
        const name = resource.attributes['resourceName'];
        if (resource.kind !== 'sqlalchemy.table' || typeof name !== 'string') {
            return resource;
        }
        const context = {
            tableName: name,
            classQname: typeof resource.attributes['classQname'] === 'string'
                ? resource.attributes['classQname']
                : null,
            provenance: typeof resource.attributes['tablenameProvenance'] === 'string'
                ? resource.attributes['tablenameProvenance']
                : 'literal',
        };
        const mapped = plane(context);
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
 * Creates a discover-capable detector module. The default export of the
 * pack is `createSqlalchemyDetector()` — the CLI in-process contract.
 *
 * Args:
 *   options: Plane mapping, spawn command/env, and handshake identity.
 *
 * Returns:
 *   SqlalchemyDetector: the pinned `{ discover(paths) }` module.
 */
export function createSqlalchemyDetector(options = {}) {
    const plane = options.plane ?? NO_PLANE_MAPPING;
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
                if (!planeIsNoop(plane)) {
                    return applyPlaneMapping(withSignals, plane);
                }
                return withSignals;
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