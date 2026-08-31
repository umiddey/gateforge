/** One red-probe pair: the same guard, correct vs deliberately broken. */
export interface RedProbe {
    /** Stable probe name (appears in the run record). */
    name: string;
    /** Guard run against correct behavior — must pass. */
    green: () => void | Promise<void>;
    /** Identical guard run against deliberately broken behavior — must fail. */
    broken: () => void | Promise<void>;
}
/** Outcome of one probe. `ok` is true only for an honest guard. */
export interface RedProbeRecord {
    /** Probe name. */
    name: string;
    /** The guard passed against correct behavior. */
    greenPassed: boolean;
    /** The guard failed against deliberately broken behavior. */
    brokenFailed: boolean;
    /** greenPassed && brokenFailed — the probe proved something. */
    ok: boolean;
    /** Human cause when not ok (fake green vs broken guard). */
    failure?: string;
}
/** Thrown by {@link runRedProbe} when a probe is not honest. */
export declare class RedProbeFailure extends Error {
    /** The failing record. */
    readonly record: RedProbeRecord;
    constructor(record: RedProbeRecord);
}
/**
 * Runs one probe pair and classifies the outcome.
 *
 * Args:
 *   probe: the green/broken guard pair.
 *
 * Returns:
 *   RedProbeRecord: the classified outcome (never throws).
 */
export declare function runRedProbe(probe: RedProbe): Promise<RedProbeRecord>;
/** Thrown by {@link runRedProbes} when any probe is not honest. */
export declare class RedProbeSuiteError extends Error {
    /** All records, honest or not. */
    readonly records: RedProbeRecord[];
    constructor(records: RedProbeRecord[]);
}
/**
 * Runs probes sequentially and throws {@link RedProbeSuiteError} when any
 * is not honest (pass `{throwOnFailure: false}` to only collect).
 *
 * Args:
 *   probes: probe pairs, run in order.
 *   options: `throwOnFailure` default true.
 *
 * Returns:
 *   RedProbeRecord[]: one record per probe, in order.
 */
export declare function runRedProbes(probes: RedProbe[], { throwOnFailure }?: {
    throwOnFailure?: boolean;
}): Promise<RedProbeRecord[]>;
/**
 * Renders probe records as a markdown table — the body of a run record.
 *
 * Args:
 *   records: probe outcomes.
 *
 * Returns:
 *   string: markdown table (probe / green passed / broken failed / verdict).
 */
export declare function formatProbeRecords(records: RedProbeRecord[]): string;
/**
 * Writes a red-probe run record (markdown) to an explicit file path,
 * creating parent directories. The path is caller-owned so the harness
 * never writes outside its permission.
 *
 * Args:
 *   path: destination file path.
 *   records: probe outcomes to record.
 */
export declare function writeProbeRecords(path: string, records: RedProbeRecord[]): void;
/** Result of one spawned vitest run. */
export interface VitestRunResult {
    /** Process exit code (-1 when killed before exit). */
    exitCode: number;
    /** Captured stdout. */
    stdout: string;
    /** Captured stderr. */
    stderr: string;
    /** True when the child was terminated by a timeout signal. */
    timedOut: boolean;
}
/** Options for {@link spawnVitest}. */
export interface VitestRunOptions {
    /** Working directory (defaults to process cwd). */
    cwd?: string;
    /** Extra environment variables layered over `process.env`. */
    env?: Record<string, string | undefined>;
    /** Kill timeout in milliseconds. Default 120000. */
    timeoutMs?: number;
}
/**
 * Runs the workspace's vitest suite as a child process (`vitest run`),
 * fully offline. CI-proof mode runs a probe suite twice — normal vs
 * deliberately-broken sources — and requires the broken run to exit
 * non-zero.
 *
 * Args:
 *   args: extra CLI arguments (file filters, --config, …).
 *   options: cwd, env additions, timeout.
 *
 * Returns:
 *   VitestRunResult: exit code and captured output.
 */
export declare function spawnVitest(args: string[], options?: VitestRunOptions): VitestRunResult;
/**
 * Materializes a probe suite in a directory and symlinks the workspace's
 * `node_modules` into it, so probe files can `import ... from 'vitest'`
 * even though the directory lives in the OS tmpdir. Clean up with
 * `rmSync(dir, {recursive: true, force: true})` — removing the symlink
 * never traverses into the real node_modules.
 *
 * Args:
 *   dir: target directory (created recursively).
 *   files: file-tree spec relative to `dir` (e.g. a `vitest.config.mjs`
 *     exporting a plain object and one or more `*.test.mjs` probes).
 *
 * Returns:
 *   string: the directory, ready for {@link spawnVitest} with `cwd: dir`.
 */
export declare function writeProbeSuite(dir: string, files: Record<string, string>): string;
/** Test-only: drops the cached vitest CLI path (path resolution tests). */
export declare function resetVitestCliCache(): void;
/**
 * Removes a probe-suite directory created by {@link writeProbeSuite}.
 *
 * Args:
 *   dir: directory to remove.
 */
export declare function cleanupProbeSuite(dir: string): void;
//# sourceMappingURL=red-probe.d.ts.map