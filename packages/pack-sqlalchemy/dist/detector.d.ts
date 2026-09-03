import { type DiscoveryOutcome } from '@gateforge/plugin-protocol';
import { type PlaneRule } from './planes.js';
/** The subprocess command the in-process transport spawns (G4 surface). */
export declare const DEFAULT_COMMAND: string[];
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
export declare function pythonEnvironment(extra?: readonly string[]): NodeJS.ProcessEnv;
/** Options for {@link createSqlalchemyDetector}. */
export interface SqlalchemyDetectorOptions {
    /**
     * Optional programmatic plane mapping. The default is `NO_PLANE_MAPPING`.
     */
    plane?: PlaneRule;
    /** Subprocess argv (default: `python3 -m gateforge_sqlalchemy_detector`). */
    command?: readonly string[];
    /** Subprocess environment (default: {@link pythonEnvironment}). */
    env?: NodeJS.ProcessEnv;
    /** Handshake-pinned plugin id (default: the pack id). */
    pluginId?: string;
    /** Handshake-pinned plugin version (default: the pack version). */
    pluginVersion?: string;
}
/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export interface SqlalchemyDetector {
    discover(paths: readonly string[]): Promise<{
        resources: unknown[];
        unresolved: unknown[];
        findings: unknown[];
        classificationSignals: unknown[];
        scannedPaths?: string[];
    }>;
}
/** One discovery outcome with a typed resource list. */
type RawOutcome = DiscoveryOutcome;
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
export declare function applyPlaneMapping(outcome: RawOutcome, plane: PlaneRule): RawOutcome;
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
export declare function createSqlalchemyDetector(options?: SqlalchemyDetectorOptions): SqlalchemyDetector;
export {};
//# sourceMappingURL=detector.d.ts.map