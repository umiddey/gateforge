/**
 * RED-PROBE discipline (fixture harness, G7): a green suite proves
 * nothing unless the same guard FAILS against deliberately broken
 * behavior. Every gate/fixture guard ships as a probe pair — the guard
 * against correct behavior (must pass) and the identical guard against a
 * deliberately broken variant (must fail) — and a broken probe that
 * PASSES is a fake green: the loudest possible failure.
 *
 * Suite-level proof (CI-proof mode) runs the actual vitest suite twice —
 * normal vs deliberately-broken sources — via {@link spawnVitest} and
 * {@link writeProbeSuite}; the broken run must exit non-zero. See
 * `docs/testing/RED_PROBE.md` for the per-phase recording discipline.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Thrown by {@link runRedProbe} when a probe is not honest. */
export class RedProbeFailure extends Error {
    /** The failing record. */
    record;
    constructor(record) {
        super(record.failure ?? `red-probe '${record.name}' is not honest`);
        this.name = 'RedProbeFailure';
        this.record = record;
    }
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
export async function runRedProbe(probe) {
    let greenPassed = true;
    let greenError;
    try {
        await probe.green();
    }
    catch (error) {
        greenPassed = false;
        greenError = error;
    }
    let brokenFailed = false;
    let brokenError;
    try {
        await probe.broken();
    }
    catch (error) {
        brokenFailed = true;
        brokenError = error;
    }
    const record = {
        name: probe.name,
        greenPassed,
        brokenFailed,
        ok: greenPassed && brokenFailed,
    };
    if (!greenPassed) {
        record.failure =
            `guard FAILS on correct behavior (the guard itself is broken): ${errorMessage(greenError)}`;
    }
    else if (!brokenFailed) {
        record.failure =
            `FAKE GREEN: the guard passed against deliberately broken behavior — it asserts nothing. ${errorMessage(brokenError)}`;
    }
    return record;
}
/**
 * Extracts a one-line message from a thrown value.
 *
 * Args:
 *   error: anything thrown.
 *
 * Returns:
 *   string: the message, or a fallback description.
 */
function errorMessage(error) {
    if (error === undefined)
        return '(no error thrown)';
    if (error instanceof Error)
        return error.message.split('\n')[0] ?? error.message;
    return String(error);
}
/** Thrown by {@link runRedProbes} when any probe is not honest. */
export class RedProbeSuiteError extends Error {
    /** All records, honest or not. */
    records;
    constructor(records) {
        const bad = records.filter((record) => !record.ok);
        super(`red-probe suite FAILED: ${bad.length} of ${records.length} probe(s) are fake-green or broken guards\n` +
            bad.map((record) => `  - ${record.name}: ${record.failure}`).join('\n'));
        this.name = 'RedProbeSuiteError';
        this.records = records;
    }
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
export async function runRedProbes(probes, { throwOnFailure = true } = {}) {
    const records = [];
    for (const probe of probes) {
        records.push(await runRedProbe(probe));
    }
    if (throwOnFailure && records.some((record) => !record.ok)) {
        throw new RedProbeSuiteError(records);
    }
    return records;
}
/**
 * Renders probe records as a markdown table — the body of a run record.
 *
 * Args:
 *   records: probe outcomes.
 *
 * Returns:
 *   string: markdown table (probe / green passed / broken failed / verdict).
 */
export function formatProbeRecords(records) {
    const rows = records.map((record) => `| ${record.name} | ${record.greenPassed ? 'yes' : 'NO'} | ${record.brokenFailed ? 'yes' : 'NO'} | ${record.ok ? 'ok' : 'FAKE GREEN / BROKEN GUARD'} |`);
    return [
        '| probe | green passed | broken failed | verdict |',
        '| --- | --- | --- | --- |',
        ...rows,
        '',
    ].join('\n');
}
/**
 * Writes a red-probe run record (markdown) to an explicit file path,
 * creating parent directories. The path is caller-owned so the harness
 * never writes outside its permission.
 *
 * Args:
 *   path: destination file path.
 *   records: probe outcomes to record.
 */
export function writeProbeRecords(path, records) {
    mkdirSync(dirname(path), { recursive: true });
    const stamp = new Date().toISOString();
    const header = `# Red-probe run record\n\nRecorded: ${stamp}\n\n`;
    writeFileSync(path, header + formatProbeRecords(records), 'utf8');
}
/** The absolute path of the workspace's `node_modules/vitest/vitest.mjs`. */
let cachedVitestCli;
/**
 * Locates the vitest CLI by walking up from this module to the nearest
 * `node_modules` that contains vitest (works under npm workspaces
 * hoisting regardless of package layout).
 *
 * Returns:
 *   string: absolute path to vitest's CLI entry.
 * @throws Error when vitest cannot be found above this module.
 */
function vitestCliPath() {
    if (cachedVitestCli !== undefined)
        return cachedVitestCli;
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const candidate = join(directory, 'node_modules', 'vitest', 'vitest.mjs');
        if (existsSync(candidate)) {
            cachedVitestCli = candidate;
            return candidate;
        }
        const parent = dirname(directory);
        if (parent === directory) {
            throw new Error('vitest installation not found above the testing harness');
        }
        directory = parent;
    }
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
export function spawnVitest(args, options = {}) {
    const result = spawnSync(process.execPath, [vitestCliPath(), 'run', ...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, CI: '1' },
        timeout: options.timeoutMs ?? 120_000,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return {
        exitCode: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.signal === 'SIGTERM',
    };
}
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
export function writeProbeSuite(dir, files) {
    mkdirSync(dir, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
        const absolute = join(dir, ...relative.split('/'));
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content, 'utf8');
    }
    const link = join(dir, 'node_modules');
    if (!existsSync(link)) {
        symlinkSync(dirname(vitestCliPath()), link, 'dir');
    }
    return dir;
}
/** Test-only: drops the cached vitest CLI path (path resolution tests). */
export function resetVitestCliCache() {
    cachedVitestCli = undefined;
}
/**
 * Removes a probe-suite directory created by {@link writeProbeSuite}.
 *
 * Args:
 *   dir: directory to remove.
 */
export function cleanupProbeSuite(dir) {
    rmSync(dir, { recursive: true, force: true });
}
//# sourceMappingURL=red-probe.js.map