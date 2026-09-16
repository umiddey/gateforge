import { type DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import { type PlanesConfig, type PlaneRule } from './planes.js';
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
     * Optional programmatic plane mapping. Takes precedence over the
     * declarative config channel: when given, `.gateforge/planes.json` is
     * not read at all. The default is `NO_PLANE_MAPPING`.
     */
    plane?: PlaneRule;
    /**
     * Explicit declarative plane config; overrides the
     * `.gateforge/planes.json` document entirely when given (and is
     * ignored while `plane` is given).
     */
    planesConfig?: PlanesConfig;
    /**
     * Repo-relative path of the declarative plane config document (JSON),
     * resolved against the working directory at discover time (default:
     * `.gateforge/planes.json`). Absence is normal — the outcome is then
     * byte-identical to `NO_PLANE_MAPPING`; a malformed document throws.
     */
    planesConfigPath?: string;
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
/** The code of the blocking declarative-plane conflict finding. */
export declare const PLANE_RULE_CONTRADICTION = "PLANE_RULE_CONTRADICTION";
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
export declare function applyPlanesConfig(outcome: RawOutcome, config: PlanesConfig): RawOutcome;
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
export declare function createSqlalchemyDetector(options?: SqlalchemyDetectorOptions): SqlalchemyDetector;
export {};
//# sourceMappingURL=detector.d.ts.map