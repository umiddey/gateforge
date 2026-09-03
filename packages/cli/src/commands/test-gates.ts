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
import { renderRun, runExitCode, verifyLedgerMac, type RunManifest } from '@gateforge/core';
import { parseArgs, stringFlag } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { evaluateRun } from '../evaluate.js';
import { runPipeline } from '../pipeline.js';
import {
  resolveStateDir,
  stateObligations,
  writeClassificationsView,
  writeEnv,
  writeManifest,
  writeObligations,
  writeReport,
} from '../state.js';
import { loadConfigAt, parseRunFormat, rejectUnknownFlags, VERIFIER_KEY_ENV, VERSION } from './common.js';

export const TEST_GATES_USAGE =
  'usage: gateforge test-gates [--suite <command>] [--out <dir>] ' +
  '[--format text|json|sarif] [--witness-url <url>] [--run-token <token>] ' +
  '(verifier key via GATEFORGE_WITNESS_VERIFIER_KEY env)';

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
export async function testGatesCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, TEST_GATES_USAGE);
    return 0;
  }
  rejectUnknownFlags(
    options,
    ['suite', 'out', 'format', 'witness-url', 'run-token', 'help'],
    TEST_GATES_USAGE,
  );
  const suite = stringFlag(options, 'suite');
  const out = stringFlag(options, 'out');
  const format = parseRunFormat(stringFlag(options, 'format') ?? 'text');
  const witnessUrl = stringFlag(options, 'witness-url');
  // An external witness (loopback service started by a test harness)
  // already holds its own token; the CLI must adopt it or every
  // fixture call answers 401 (x-gateforge-run mismatch).
  const runToken = stringFlag(options, 'run-token');
  // Verifier key for the attestation surface (GF-23, audit round 3):
  // read from the environment — never argv, whose /proc cmdline is
  // world-readable. Shared by the orchestrator with the witness and
  // this CLI, never with the suite; without it no suite-writable
  // artifact can prove issuance and the gate fails closed.
  const witnessVerifierKey = io.env[VERIFIER_KEY_ENV];

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
  // The effective-classification view (plan phase 5): derived from this
  // run's signals, for verifier-side consumers only — never engine input.
  writeClassificationsView(stateDir, pipeline.classificationsView);
  const envRecord = writeEnv(stateDir, manifest, witnessUrl ?? null, runToken);

  let suiteFailed = false;
  if (suite !== undefined) {
    const suiteEnv: Record<string, string> = {
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
      // The verifier key must NEVER reach the suite: strip it from the
      // ambient env the child inherits (audit round 3).
      env: { ...io.env, [VERIFIER_KEY_ENV]: undefined, ...suiteEnv },
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
    witnessVerifierKey,
    witnessAttestation: await fetchWitnessLedgerAttestation(
      witnessUrl,
      runToken,
      witnessVerifierKey,
    ),
  });

  const report = renderRun(evaluated.verdicts, {
    format,
    blocking: evaluated.blocking,
    waiverCounts: evaluated.waiverCounts,
    run: manifest,
    toolVersion: VERSION,
  });
  writeLine(io.stdout, report);

  writeReport(
    stateDir,
    renderRun(evaluated.verdicts, {
      format: 'json',
      blocking: evaluated.blocking,
      waiverCounts: evaluated.waiverCounts,
      run: manifest,
      toolVersion: VERSION,
    }),
  );

  const gateCode = runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
  return suiteFailed && gateCode === 0 ? 1 : gateCode;
}

/**
 * Fetches the live ledger attestation from a still-running wired witness
 * (pin #7, GF-23). A wired witness appends its ids to the run manifest
 * only at its own shutdown — which typically happens AFTER `test-gates`
 * evaluates — so while it is up, the verifier-authenticated
 * `GET /ledger-attestation` response is the issuance attestation of
 * record. The response is MAC-verified here, and the gate verifies
 * again at evaluation; a response that fails either check contributes
 * no trust. Best-effort: any failure (already stopped, unreachable,
 * wrong key, malformed body) yields null and the MAC-verified manifest
 * append remains the sole durable channel; with neither, witnessed
 * records demote to claimed-tier (fail closed — the suite-writable
 * manifest alone never proves issuance).
 *
 * Args:
 *   witnessUrl: the wired witness base URL, when provided.
 *   runToken: the witness's run token (outer auth gate), when provided.
 *   verifierKey: the witness verifier key (attestation auth), when provided.
 *
 * Returns:
 *   {runId, recordIds, mac} | null: the attestation, or null when
 *   unavailable or unverified.
 */
async function fetchWitnessLedgerAttestation(
  witnessUrl: string | undefined,
  runToken: string | undefined,
  verifierKey: string | undefined,
): Promise<{ runId: string; recordIds: string[]; mac: string } | null> {
  if (witnessUrl === undefined || runToken === undefined || verifierKey === undefined) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${witnessUrl}/ledger-attestation`, {
      headers: { 'x-gateforge-run': runToken, 'x-gateforge-verifier': verifierKey, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      runId?: unknown;
      recordIds?: unknown;
      mac?: unknown;
    };
    if (
      typeof body.runId !== 'string' ||
      body.runId.length === 0 ||
      !Array.isArray(body.recordIds) ||
      !body.recordIds.every((id) => typeof id === 'string') ||
      typeof body.mac !== 'string'
    ) {
      return null;
    }
    const recordIds = body.recordIds as string[];
    // Verify before handing it to the gate; the gate re-verifies.
    if (!verifyLedgerMac(verifierKey, body.runId, recordIds, body.mac)) return null;
    return { runId: body.runId, recordIds, mac: body.mac };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
async function adoptWitnessRunId(
  manifest: RunManifest,
  witnessUrl: string,
  runToken: string,
): Promise<RunManifest> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let response: Response;
  try {
    response = await fetch(`${witnessUrl}/health`, {
      headers: { 'x-gateforge-run': runToken, accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`test-gates: wired witness ${witnessUrl} is unreachable: ${(error as Error).message}`);
  }
  clearTimeout(timer);
  if (!response.ok) {
    throw new Error(`test-gates: wired witness ${witnessUrl} answered HTTP ${response.status} on /health`);
  }
  const body = (await response.json()) as { runId?: unknown };
  if (typeof body['runId'] !== 'string' || body['runId'].length === 0) {
    throw new Error(`test-gates: wired witness ${witnessUrl} /health carried no runId`);
  }
  return { ...manifest, runId: body['runId'] };
}