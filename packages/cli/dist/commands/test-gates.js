/**
 * `gateforge test-gates`: orchestrate a full evidence run — plugin
 * discovery → obligations → run-state materialization → suite execution
 * → verdict evaluation → report.
 *
 * This is the surface G6's Playwright pack consumes (see
 * packages/cli/README.md "test-gates protocol"). The CLI implements the
 * orchestration; the Playwright side — the loopback witness service and
 * the claims/records reporter — is a documented contract G6 fills:
 *
 * 1. Before the suite runs, `.gateforge/test-gates/` (or `--out`)
 *    contains `manifest.json`, `obligations.json` (with pin-#2
 *    fingerprints), and `env.json` carrying
 *    `GATEFORGE_RUN_ID`/`GATEFORGE_RUN_TOKEN`/`GATEFORGE_STATE_DIR`/
 *    `GATEFORGE_OBLIGATIONS`, plus `GATEFORGE_WITNESS_URL` when a
 *    witness service URL was provided (`--witness-url`).
 * 2. The suite command (`--suite`) runs with those env vars; its
 *    reporter writes `claims.json` + `records.json` into the state dir.
 * 3. After the suite, the verifier evaluates the obligations against
 *    those claims/records and prints the report; `report.json` (canonical
 *    json format) is written for downstream consumers.
 *
 * A nonzero suite exit fails the run (exit 1) even when verdicts happen
 * to be clean — a broken run must never report success.
 */
import { spawnSync } from 'node:child_process';
import { renderRun, runExitCode } from '@gateforge/core';
import { parseArgs, stringFlag } from '../args.js';
import { writeLine } from '../io.js';
import { evaluateRun } from '../evaluate.js';
import { runPipeline } from '../pipeline.js';
import { resolveStateDir, stateObligations, writeEnv, writeManifest, writeObligations, writeReport, } from '../state.js';
import { loadConfigAt, parseRunFormat, rejectUnknownFlags, VERSION } from './common.js';
export const TEST_GATES_USAGE = 'usage: gateforge test-gates [--suite <command>] [--out <dir>] ' +
    '[--format text|json|sarif] [--witness-url <url>] [--run-token <token>]';
/**
 * Runs the test-gates subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved or suite failure,
 *   2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function testGatesCommand(io, argv) {
    const { options } = parseArgs(argv);
    if (options['help'] === true) {
        writeLine(io.stdout, TEST_GATES_USAGE);
        return 0;
    }
    rejectUnknownFlags(options, ['suite', 'out', 'format', 'witness-url', 'run-token', 'help'], TEST_GATES_USAGE);
    const suite = stringFlag(options, 'suite');
    const out = stringFlag(options, 'out');
    const format = parseRunFormat(stringFlag(options, 'format') ?? 'text');
    const witnessUrl = stringFlag(options, 'witness-url');
    // An external witness (loopback service started by a test harness)
    // already holds its own token; the CLI must adopt it or every
    // fixture call answers 401 (x-gateforge-run mismatch).
    const runToken = stringFlag(options, 'run-token');
    const config = loadConfigAt(io.cwd);
    const stateDir = resolveStateDir(io.cwd, out);
    const pipeline = await runPipeline({
        cwd: io.cwd,
        env: io.env,
        config,
        provider: 'all-files',
        stateDir,
    });
    // Run identity: an external witness (loopback service) OWNS the run —
    // every record it stamps carries its runId, and pin-#4 provenance
    // binds records to THIS manifest. The CLI therefore adopts the
    // witness's runId instead of minting its own. Fail closed: an
    // explicitly wired witness must answer /health with a runId.
    let manifest = pipeline.manifest;
    if (witnessUrl !== undefined) {
        if (runToken === undefined) {
            throw new Error('test-gates: --witness-url requires --run-token (the witness authenticates every call)');
        }
        manifest = await adoptWitnessRunId(manifest, witnessUrl, runToken);
    }
    writeManifest(stateDir, manifest);
    writeObligations(stateDir, stateObligations(pipeline.policy.obligations, pipeline.graph));
    const envRecord = writeEnv(stateDir, manifest, witnessUrl ?? null, runToken);
    let suiteFailed = false;
    if (suite !== undefined) {
        const suiteEnv = {
            GATEFORGE_RUN_ID: envRecord.GATEFORGE_RUN_ID,
            GATEFORGE_RUN_TOKEN: envRecord.GATEFORGE_RUN_TOKEN,
            GATEFORGE_STATE_DIR: envRecord.GATEFORGE_STATE_DIR,
            GATEFORGE_OBLIGATIONS: envRecord.GATEFORGE_OBLIGATIONS,
        };
        if (envRecord.GATEFORGE_WITNESS_URL !== null) {
            suiteEnv['GATEFORGE_WITNESS_URL'] = envRecord.GATEFORGE_WITNESS_URL;
        }
        const result = spawnSync('sh', ['-c', suite], {
            cwd: io.cwd,
            env: { ...io.env, ...suiteEnv },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        });
        if (result.stdout !== null && result.stdout.length > 0) {
            io.stdout.write(result.stdout);
        }
        if (result.stderr !== null && result.stderr.length > 0) {
            io.stderr.write(result.stderr);
        }
        if (result.error !== undefined) {
            throw new Error(`test-gates suite could not be started: ${result.error.message}`);
        }
        suiteFailed = result.status !== 0;
        if (suiteFailed) {
            writeLine(io.stderr, `test-gates: suite exited with status ${String(result.status)}`);
        }
    }
    const evaluated = evaluateRun({
        cwd: io.cwd,
        config,
        graph: pipeline.graph,
        obligations: pipeline.policy.obligations,
        blocking: pipeline.policy.blocking,
        stateDir,
        now: pipeline.now,
        changedFiles: null,
    });
    const report = renderRun(evaluated.verdicts, {
        format,
        blocking: evaluated.blocking,
        waiverCounts: evaluated.waiverCounts,
        run: manifest,
        toolVersion: VERSION,
    });
    writeLine(io.stdout, report);
    writeReport(stateDir, renderRun(evaluated.verdicts, {
        format: 'json',
        blocking: evaluated.blocking,
        waiverCounts: evaluated.waiverCounts,
        run: manifest,
        toolVersion: VERSION,
    }));
    const gateCode = runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
    return suiteFailed && gateCode === 0 ? 1 : gateCode;
}
/**
 * Adopts an external witness's runId as the run-manifest identity.
 *
 * Args:
 *   manifest: the pipeline-generated run manifest.
 *   witnessUrl: the wired witness base URL.
 *   runToken: the witness's auth token.
 *
 * Returns:
 *   RunManifest: the manifest with the witness's runId.
 *
 * Throws:
 *   Error: fail-closed when the witness is unreachable or answers
 *   without a runId — a wired witness that cannot prove its run
 *   identity can never produce provenance-valid records.
 */
async function adoptWitnessRunId(manifest, witnessUrl, runToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let response;
    try {
        response = await fetch(`${witnessUrl}/health`, {
            headers: { 'x-gateforge-run': runToken, accept: 'application/json' },
            signal: controller.signal,
        });
    }
    catch (error) {
        clearTimeout(timer);
        throw new Error(`test-gates: wired witness ${witnessUrl} is unreachable: ${error.message}`);
    }
    clearTimeout(timer);
    if (!response.ok) {
        throw new Error(`test-gates: wired witness ${witnessUrl} answered HTTP ${response.status} on /health`);
    }
    const body = (await response.json());
    if (typeof body['runId'] !== 'string' || body['runId'].length === 0) {
        throw new Error(`test-gates: wired witness ${witnessUrl} /health carried no runId`);
    }
    return { ...manifest, runId: body['runId'] };
}
//# sourceMappingURL=test-gates.js.map