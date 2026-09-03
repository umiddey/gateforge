/** The subprocess command the in-process transport spawns (G4 surface). */
export declare const DEFAULT_COMMAND: string[];
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