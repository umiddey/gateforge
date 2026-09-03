/**
 * The pack's discover entry: a thin TypeScript GPP/3 client over the
 * Python AST detector, usable from BOTH CLI transports (the pack-sqlalchemy
 * pattern; see ADR 0002 for the two-tier boundary).
 *
 * - **in-process**: `.gateforge.yml` declares
 *   `transport: in-process, module: "@gateforge/pack-fastapi"`; the CLI
 *   imports this package's default export and calls `discover(paths)`.
 *   The implementation spawns the SAME python detector (GPP/3, hardened
 *   host) with a computed `PYTHONPATH`, so one detector implementation
 *   serves both transports.
 * - **subprocess**: `.gateforge.yml` declares
 *   `transport: subprocess, command: ["python3","-m","gateforge_fastapi_detector"]`
 *   (with the pack's `python/` dir on `PYTHONPATH`); the CLI drives the
 *   plugin directly — see the README.
 *
 * Post-processing (`facts.ts`): effective paths are canonicalized with the
 * shared `@gateforge/http-contract` rules and exposure/lifecycle signals
 * are minted — always under this pack's pinned detector identity, which the
 * GPP/3 host enforces.
 *
 * Determinism: the python scan is pure over (paths, file bytes).
 */
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginSession } from '@gateforge/plugin-protocol';
import { canonicalizeFacts } from './facts.js';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
/** Absolute dir of this pack's `python/` tree (the detector package). */
const PACK_PYTHON_DIR = fileURLToPath(new URL('../python', import.meta.url));
/** Absolute dir of the sibling `@gateforge/plugin-protocol` python client. */
const PROTOCOL_PYTHON_DIR = fileURLToPath(new URL('../../../plugin-protocol/python', import.meta.url));
/** The subprocess command the in-process transport spawns (G4 surface). */
export const DEFAULT_COMMAND = ['python3', '-m', 'gateforge_fastapi_detector'];
/**
 * Builds the environment the python detector runs under: the host env
 * plus a `PYTHONPATH` that makes both this pack's detector and the GPP/3
 * client importable.
 */
export function pythonEnvironment(extra = []) {
    const entries = [...extra, PACK_PYTHON_DIR, PROTOCOL_PYTHON_DIR];
    return { ...process.env, PYTHONPATH: entries.join(delimiter) };
}
/**
 * Creates a discover-capable detector module. The default export of the
 * pack is `createFastapiDetector()` — the CLI in-process contract.
 */
export function createFastapiDetector(options = {}) {
    const command = options.command ?? DEFAULT_COMMAND;
    const env = options.env ?? pythonEnvironment();
    const cwd = options.cwd ?? process.cwd();
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
                cwd,
                env,
                timeouts: { handshakeMs: 10_000, requestMs: 30_000, shutdownMs: 10_000 },
            });
            try {
                await session.start();
                const outcome = await session.discover([...paths]);
                return postprocess(outcome);
            }
            finally {
                await session.dispose();
            }
        },
    };
}
/**
 * Canonicalizes facts and merges the wrapper's unresolved entries with the
 * python scanner's, keeping the whole outcome deterministic.
 */
function postprocess(outcome) {
    const canonical = canonicalizeFacts(outcome.resources);
    const unresolved = [
        ...outcome.unresolved,
        ...canonical.unresolved,
    ].sort((a, b) => {
        const locationA = a['location'];
        const locationB = b['location'];
        const fileA = locationA?.['file'] ?? '';
        const fileB = locationB?.['file'] ?? '';
        if (fileA !== fileB)
            return fileA < fileB ? -1 : 1;
        const lineA = locationA?.['line'] ?? 0;
        const lineB = locationB?.['line'] ?? 0;
        if (lineA !== lineB)
            return lineA - lineB;
        const codeA = String(a['code'] ?? '');
        const codeB = String(b['code'] ?? '');
        if (codeA !== codeB)
            return codeA < codeB ? -1 : 1;
        const detailA = String(a['detail'] ?? '');
        const detailB = String(b['detail'] ?? '');
        if (detailA === detailB)
            return 0;
        return detailA < detailB ? -1 : 1;
    });
    return {
        resources: canonical.resources,
        unresolved,
        findings: outcome.findings,
        classificationSignals: canonical.classificationSignals,
        ...(outcome.scannedPaths !== undefined ? { scannedPaths: outcome.scannedPaths } : {}),
    };
}
//# sourceMappingURL=detector.js.map