/** The subprocess command the in-process transport spawns (G4 surface). */
export declare const DEFAULT_COMMAND: string[];
/**
 * The detector's config channel: a JSON document read from the repo root
 * (same precedent as pack-http's `.gateforge/http-clients.json`). Absence
 * is normal; a malformed document throws (fail closed).
 */
export declare const FASTAPI_SCAN_CONFIG_PATH = ".gateforge/fastapi.json";
/** Parsed `.gateforge/fastapi.json` document (strict schema). */
export interface FastapiScanConfig {
    /**
     * Repo-root-relative directories that act as Python import roots for
     * ABSOLUTE imports — the central-router-registry pattern
     * (`from api.v1.endpoints import activities` +
     * `app.include_router(activities.router, prefix=...)`). Resolution is
     * unique or typed-unresolved: an import matching more than one scanned
     * file across the roots never guesses.
     */
    importRoots?: readonly string[];
}
export declare const DEFAULT_FASTAPI_SCAN_CONFIG: FastapiScanConfig;
/**
 * Reads a fastapi detector config document. Returns the default config
 * when the file is absent; malformed documents throw (fail closed — the
 * CLI surfaces the error instead of scanning with partial trust).
 */
export declare function readFastapiScanConfigOrNull(path: string | null): FastapiScanConfig;
/**
 * Builds the environment the python detector runs under: the host env
 * plus a `PYTHONPATH` that makes both this pack's detector and the GPP/3
 * client importable.
 */
export declare function pythonEnvironment(extra?: readonly string[]): NodeJS.ProcessEnv;
/** Options for {@link createFastapiDetector}. */
export interface FastapiDetectorOptions {
    /** Subprocess argv (default: `python3 -m gateforge_fastapi_detector`). */
    command?: readonly string[];
    /** Subprocess environment (default: {@link pythonEnvironment}). */
    env?: NodeJS.ProcessEnv;
    /** Working directory the repo-relative paths resolve against. */
    cwd?: string;
    /** Handshake-pinned plugin id (default: the pack id). */
    pluginId?: string;
    /** Handshake-pinned plugin version (default: the pack version). */
    pluginVersion?: string;
    /**
     * Explicit import roots (repo-root-relative); overrides the config
     * document entirely when given.
     */
    importRoots?: readonly string[];
    /**
     * Repo-relative path of a config document (JSON) read from `cwd` when
     * `importRoots` is not given (default: `.gateforge/fastapi.json`;
     * absence is normal, malformed throws).
     */
    importRootsConfigPath?: string;
}
/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export interface FastapiDetector {
    discover(paths: readonly string[]): Promise<{
        resources: unknown[];
        unresolved: unknown[];
        findings: unknown[];
        classificationSignals: unknown[];
        scannedPaths?: string[];
    }>;
}
/**
 * Creates a discover-capable detector module. The default export of the
 * pack is `createFastapiDetector()` — the CLI in-process contract.
 */
export declare function createFastapiDetector(options?: FastapiDetectorOptions): FastapiDetector;
//# sourceMappingURL=detector.d.ts.map