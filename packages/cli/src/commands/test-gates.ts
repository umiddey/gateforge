/**
 * `gateforge test-gates`: orchestrate a full evidence run — plugin
 * discovery → obligations → run-state materialization → suite execution
 * → verdict evaluation → report.
 *
 * Two modes:
 *
 * **Legacy `--suite` mode** — the orchestration surface G6's Playwright
 * pack consumes (see packages/cli/README.md "test-gates protocol"). The
 * CLI implements the orchestration; the Playwright side — the loopback
 * witness service and the claims/records reporter — is a documented
 * contract G6 fills:
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
 *
 * **Supervised `--changed` mode** (plan 2026-09-13 Phase 4, ADR 0005
 * D2/D3, ADR 0006) — the CLI becomes the TRUSTED RUNNER SUPERVISOR: it
 * resolves the catalog + mappings, fixes the expected test set BEFORE
 * the run, spawns the observer (witness + observation machinery),
 * executes the suite through the adapter under trusted-config synthesis
 * (the consumer config file is never loaded; the engine reporter is
 * forced with parent-side paths), enforces planned-vs-executed
 * completeness, seals an execution result, runs the configured pytest
 * diagnostic suites as a separate advisory step, and issues an
 * authenticated gate receipt ONLY after complete success.
 * Identical authenticated inputs may reuse a prior receipt (printed as
 * `reused receipt <id>`); any changed input forces a fresh run or a
 * precise block.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AttestationSchema,
  CAUSE_NEXT_ACTIONS,
  canonicalJson,
  renderRun,
  runExitCode,
  sha256Canonical,
  selectionDigestOf,
  verifyAttestationMac,
  type Attestation,
  type BlockingEntry,
  type GateforgeConfig,
  type RunManifest,
  type RunnerExecutionEnvelope,
  type TestCatalog,
  type TracedTestInput,
} from '@gateforge/core';
import {
  discoverTestCatalog,
  listNativePlaywrightTests,
  PlaywrightAdapter,
  readRunnerOutcomes,
  startSupervisorSpoolDrain,
  startWitnessProcess,
  SupervisorClient,
  TestDiscoveryError,
} from '@gateforge/pack-playwright';
import { parseArgs, stringFlag } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { runDiagnosticSuites } from '../diagnostics.js';
import {
  claimInjectionsFor,
  trustedPolicyDigestForConfig,
  issueGateReceipt,
  parentSha,
  planExpectedSet,
  sealExecutionResult,
  supervisionBlocking,
  SUPERVISED_INVOCATION,
  type PlannedRow,
} from '../execution.js';
import { evaluateRun } from '../evaluate.js';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  type SnapshotFileEntry,
} from '../input-snapshot.js';
import { mappingBlocking, resolveRepositoryMappings, TEST_MAP_RELATIVE } from '../mapping.js';
import { runPipeline } from '../pipeline.js';
import { tryReuseReceipt } from '../receipts.js';
import { assertReceiptApprovedPolicy, evaluateApprovedPolicy, resolveApprovedPolicyDigest } from '../trusted-policy.js';
import {
  clearGateReceipt,
  httpRoutesView,
  resolveStateDir,
  stateObligations,
  writeClaimInjections,
  writeClassificationsView,
  writeEnv,
  writeExecutionResult,
  writeGateReceipt,
  writeHttpRoutesView,
  writeManifest,
  writeObligations,
  writeReport,
} from '../state.js';
import { loadConfigAt, parseRunFormat, rejectUnknownFlags, VERIFIER_KEY_ENV, VERSION } from './common.js';

export const TEST_GATES_USAGE =
  'usage: gateforge test-gates [--changed] [--suite <command>] [--out <dir>] ' +
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
    ['suite', 'out', 'format', 'witness-url', 'run-token', 'changed', 'help'],
    TEST_GATES_USAGE,
  );
  const suite = stringFlag(options, 'suite');
  const out = stringFlag(options, 'out');
  const format = parseRunFormat(stringFlag(options, 'format') ?? 'text');
  const witnessUrl = stringFlag(options, 'witness-url');
  const changed = options['changed'] === true;
  if (changed && suite !== undefined) {
    throw new UsageError(
      'test-gates: --changed runs the configured suite through the supervised adapter; ' +
        '--suite is the legacy escape hatch and cannot be combined',
    );
  }
  if (changed) {
    return supervisedTestGates(io, {
      out,
      format,
      witnessUrl,
      runToken: stringFlag(options, 'run-token'),
    });
  }
  return legacyTestGates(io, { suite, out, format, witnessUrl, runToken: stringFlag(options, 'run-token') });
}

/** Options of the legacy (`--suite`) orchestration path. */
interface LegacyOptions {
  /** The user suite command, when provided. */
  suite: string | undefined;
  /** State-dir override. */
  out: string | undefined;
  /** Report format. */
  format: 'text' | 'json' | 'sarif';
  /** External witness URL. */
  witnessUrl: string | undefined;
  /** External witness run token. */
  runToken: string | undefined;
}

/**
 * The legacy `--suite` orchestration (unchanged behavior): materialize
 * run state, run the user's suite command, evaluate, report.
 *
 * Args:
 *   io: process context.
 *   options: the parsed flags.
 *
 * Returns:
 *   Promise<number>: exit code.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
async function legacyTestGates(io: Io, options: LegacyOptions): Promise<number> {
  const { suite, out, format, witnessUrl } = options;
  // An external witness (loopback service started by a test harness)
  // already holds its own token; the CLI must adopt it or every
  // fixture call answers 401 (x-gateforge-run mismatch).
  const runToken = options.runToken;
  // Verifier key for the attestation surface (GF-23, audit round 3):
  // read from the environment — never argv, whose /proc cmdline is
  // world-readable. Shared by the orchestrator with the witness and
  // this CLI, never with the suite; without it no suite-writable
  // artifact can prove issuance and the gate fails closed.
  const witnessVerifierKey = io.env[VERIFIER_KEY_ENV];

  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd, out);

  // 1. Inventory/hash inputs BEFORE discovery (plan §11.5). Only file
  // bytes exist yet; the gate context joins after discovery. Unsafe
  // --out overlap and uncapturable inputs fail closed (exit 2) before
  // witness binding, suite start, or any state artifact write.
  let preFiles: SnapshotFileEntry[] | null = null;
  let snapshotUnavailable = false;
  try {
    preFiles = collectInputFiles(io.cwd, config, stateDir);
  } catch (error) {
    if (error instanceof SnapshotUnavailableError) {
      snapshotUnavailable = true;
    } else if (error instanceof UnsupportedSnapshotError) {
      throw new UsageError(`unsupported input snapshot: ${error.message}`);
    } else {
      throw error;
    }
  }

  // 2. Run discovery and compile the gate context.
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });

  // 3. Stability around discovery + full input digest. A tree that moved
  // under discovery cannot establish a reliable digest — fail closed
  // before binding or writing state.
  const httpRoutes = httpRoutesView(pipeline.graph);
  let trustedDigest: string | null = null;
  if (!snapshotUnavailable) {
    try {
      const postDiscovery = collectInputFiles(io.cwd, config, stateDir);
      const drift =
        preFiles === null ? [] : diffInputFiles(preFiles, postDiscovery);
      if (drift.length > 0) {
        throw new UsageError(
          `input tree changed around discovery (${drift.slice(0, 3).join('; ')}${drift.length > 3 ? '; …' : ''}); ` +
            'no reliable digest can be established — refusing the run',
        );
      }
      trustedDigest = computeInputSnapshot({
        cwd: io.cwd,
        config,
        stateDir,
        classifications: pipeline.classificationsView.resources,
        obligations: pipeline.policy.obligations,
        httpRoutes,
        plugins: pipeline.manifest.plugins.map((plugin) => ({
          id: plugin.id,
          version: plugin.version,
        })),
      }).inputDigest;
    } catch (error) {
      if (error instanceof UsageError) throw error;
      if (error instanceof SnapshotUnavailableError) {
        snapshotUnavailable = true;
      } else if (error instanceof UnsupportedSnapshotError) {
        throw new UsageError(`unsupported input snapshot: ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  // 4. Mint the fresh invocation ID and establish the witness context in
  // trusted process memory (plan §11.4) — never by rereading env.json
  // or manifest.json after the suite runs.
  const invocationId = randomUUID();
  const expectedDigest = snapshotUnavailable ? null : trustedDigest;

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
  if (expectedDigest !== null) {
    manifest = { ...manifest, invocationId, inputDigest: expectedDigest };
  }

  // Bind the trusted context BEFORE the suite starts (plan §11.4): the
  // witness freezes runId/invocationId/inputDigest and only then may
  // observe or issue. A witness already used by an older invocation is
  // rejected — start a fresh witness for a new invocation. Without a
  // verifier key there is nothing to bind with: the run proceeds, but
  // no attestation can ever authorize its witnessed records.
  if (
    witnessUrl !== undefined &&
    runToken !== undefined &&
    witnessVerifierKey !== undefined &&
    expectedDigest !== null
  ) {
    await bindWitnessContext(witnessUrl, runToken, witnessVerifierKey, {
      runId: manifest.runId,
      invocationId,
      inputDigest: expectedDigest,
    });
  }

  writeManifest(stateDir, manifest);
  writeObligations(stateDir, stateObligations(pipeline.policy.obligations, pipeline.graph));
  // Derived route inventory (plan §9, D2) for the suite-side reporter:
  // advisory context only — the verifier recomputes it from the graph
  // and never reads this file.
  writeHttpRoutesView(stateDir, httpRoutesView(pipeline.graph));
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
    // The supervisor spool drain (enforcement-review fix 3) performs the
    // witness's session open/close WHILE the suite runs, so the CLI event
    // loop must stay live: the suite child is spawned asynchronously (a
    // sync spawn would block the drain's polls and starve the runner of
    // session opens). Without the verifier key there is no supervisor
    // capability and no drain — sessions then never open and the witness
    // rejects every submission fail-closed (the boundary, not a bug).
    const drain =
      witnessUrl !== undefined && runToken !== undefined && witnessVerifierKey !== undefined
        ? startSupervisorSpoolDrain({
            stateDir,
            runId: manifest.runId,
            witnessUrl,
            runToken,
            verifierKey: witnessVerifierKey,
          })
        : null;
    try {
      const suiteStatus = await spawnSuite(io, suite, {
        cwd: io.cwd,
        // The verifier key must NEVER reach the suite: strip it from the
        // ambient env the child inherits (audit round 3).
        env: { ...io.env, [VERIFIER_KEY_ENV]: undefined, ...suiteEnv },
      });
      suiteFailed = suiteStatus !== 0;
      if (suiteFailed) {
        writeLine(io.stderr, `test-gates: suite exited with status ${String(suiteStatus)}`);
      }
    } finally {
      // Final spool sweep + force-close of runner-left-open sessions,
      // while the witness is still up.
      await drain?.stop();
    }
  }

  // 6. Recompute the input snapshot after the suite (plan §11.5).
  // Source or configuration changes make this run blocking — the
  // pre-change evidence must not certify the changed tree. The flag
  // flows into evaluation, which demotes every witnessed record and
  // raises an explicit evidence-context blocker (exit 1, never a pass).
  let changedInputs = false;
  if (!snapshotUnavailable && preFiles !== null) {
    try {
      const postSuite = collectInputFiles(io.cwd, config, stateDir);
      changedInputs = diffInputFiles(preFiles, postSuite).length > 0;
    } catch {
      // A post-suite inventory failure is itself evidence the tree is
      // no longer the tested one — block rather than certify.
      changedInputs = true;
    }
  }

  // 7–8. Fetch and validate the live attestation, persisting the
  // authenticated v2 envelope as the durable fallback before the
  // witness stops; then require digest/run/invocation match from
  // trusted memory (never reread).
  const liveAttestation = await fetchWitnessAttestation(
    io,
    witnessUrl,
    runToken,
    witnessVerifierKey,
    expectedDigest === null
      ? null
      : { runId: manifest.runId, invocationId, inputDigest: expectedDigest },
  );
  if (liveAttestation !== null) {
    persistLiveAttestation(stateDir, liveAttestation);
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
    witnessAttestation: liveAttestation,
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      expectedInvocationId: expectedDigest === null ? null : invocationId,
      requireInvocationId: true,
      changedInputs,
    },
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

/** Options of the supervised (`--changed`) path. */
interface SupervisedOptions {
  /** State-dir override. */
  out: string | undefined;
  /** Report format. */
  format: 'text' | 'json' | 'sarif';
  /** External witness URL (the caller owns the witness). */
  witnessUrl: string | undefined;
  /** External witness run token. */
  runToken: string | undefined;
}

/**
 * The supervised `--changed` path (plan Phase 4, ADR 0005 D2/D3):
 * resolve catalog + mappings → fix the expected set → prepare the
 * observer → REGISTER the expected set with the witness from an
 * independent `playwright --list` child (scrubbed env, finite timeout) →
 * execute through the adapter under the supervisor spool drain → enforce
 * planned vs executed + the witness-side session trace → seal the
 * execution result → run diagnostics (separate, advisory) → evaluate →
 * issue the gate receipt only on complete success. Identical
 * authenticated inputs reuse a prior receipt (printed, exit reflects the
 * current gate evaluation); any changed input forces a fresh run.
 *
 * Args:
 *   io: process context.
 *   options: parsed flags.
 *
 * Returns:
 *   Promise<number>: exit code — 0 clean (or reused clean receipt), 1
 *   supervision/evidence failure, 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
async function supervisedTestGates(io: Io, options: SupervisedOptions): Promise<number> {
  const { out, format, witnessUrl } = options;
  const witnessVerifierKey = io.env[VERIFIER_KEY_ENV];
  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd, out);

  // 1. Inventory + stability + input digest (same discipline as check).
  let preFiles: SnapshotFileEntry[] | null = null;
  let snapshotUnavailable = false;
  try {
    preFiles = collectInputFiles(io.cwd, config, stateDir);
  } catch (error) {
    if (error instanceof SnapshotUnavailableError) snapshotUnavailable = true;
    else if (error instanceof UnsupportedSnapshotError) throw new UsageError(`unsupported input snapshot: ${error.message}`);
    else throw error;
  }
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });
  const httpRoutes = httpRoutesView(pipeline.graph);
  let expectedDigest: string | null = null;
  if (!snapshotUnavailable) {
    const postDiscovery = collectInputFiles(io.cwd, config, stateDir);
    const drift = preFiles === null ? [] : diffInputFiles(preFiles, postDiscovery);
    if (drift.length > 0) {
      throw new UsageError(
        `input tree changed around discovery (${drift.slice(0, 3).join('; ')}${drift.length > 3 ? '; …' : ''}); ` +
          'no reliable digest can be established — refusing the run',
      );
    }
    expectedDigest = computeInputSnapshot({
      cwd: io.cwd,
      config,
      stateDir,
      classifications: pipeline.classificationsView.resources,
      obligations: pipeline.policy.obligations,
      httpRoutes,
      plugins: pipeline.manifest.plugins.map((plugin) => ({ id: plugin.id, version: plugin.version })),
    }).inputDigest;
  }
  const invocationId = randomUUID();

  // 2. Catalog + mappings (Phase 3 resolver) → expected set + claim
  // injections + typed mapping blockers. A failed discovery blocks the
  // gate (E16) — never an empty-success fallback.
  let discoveryError: string | null = null;
  let catalog: TestCatalog | null = null;
  try {
    catalog = (await discoverTestCatalog({ cwd: io.cwd, config })).catalog;
  } catch (error) {
    discoveryError = error instanceof TestDiscoveryError ? error.message : (error as Error).message;
  }
  const trustedPolicy = trustedPolicyDigestForConfig(io.cwd, config);
  // Policy-revision ownership (review 2026-09-13 P1 #5, ADR 0005 D6):
  // the candidate's policy digest is compared against the OWNER-APPROVED
  // digest resolved from outside the candidate (protected env / trusted
  // config) BEFORE any witness binding, expected-set registration, cache
  // reuse, or suite execution. A provisioned pin binds EVERY run here;
  // strict mode without a pin fails closed; a candidate whose revision
  // is not the approved one never reaches the runner.
  const policyGate = evaluateApprovedPolicy(
    resolveApprovedPolicyDigest({ env: io.env, candidateCwd: io.cwd, candidateConfig: config }),
    trustedPolicy,
    config.enforcement?.strictE2E === true,
  );
  if (policyGate.status === 'blocked') {
    clearGateReceipt(stateDir);
    writeLine(io.stderr, `test-gates: ${policyGate.cause}: ${policyGate.detail}`);
    writeLine(io.stderr, `next action: ${policyGate.nextAction}`);
    return 1;
  }
  // When the pin is provisioned and matches, the approved revision is
  // bound into any freshly sealed receipt and demanded from any reused
  // one — a receipt sealed under a since-revoked revision cannot pass.
  const approvedPolicyDigest = policyGate.status === 'enforced' ? policyGate.approved : null;
  let mappingBlockers: BlockingEntry[] = [];
  let plannedRows: PlannedRow[] = [];
  let injections: Record<string, string[]> = {};
  if (catalog !== null) {
    const mapped = await resolveRepositoryMappings({
      cwd: io.cwd,
      config,
      stateDir,
      obligations: pipeline.policy.obligations,
      catalog,
    });
    mappingBlockers = mappingBlocking(mapped.resolution.problems);
    plannedRows = planExpectedSet(catalog);
    injections = claimInjectionsFor(mapped.resolution, catalog);
  }
  const inventoryBlocking: BlockingEntry[] =
    discoveryError !== null
      ? [
          {
            kind: 'finding',
            resourceId: null,
            name: null,
            detail: `test inventory could not be enumerated: ${discoveryError} — a failed discovery blocks the gate (no empty-success fallback)`,
            location: null,
            cause: 'TEST_INVENTORY_INCOMPLETE',
            nextAction: CAUSE_NEXT_ACTIONS.TEST_INVENTORY_INCOMPLETE,
          },
        ]
      : !catalog?.inventoryComplete
        ? [
            {
              kind: 'finding',
              resourceId: null,
              name: null,
              detail:
                'test inventory incomplete (parse errors, budget cuts, or unenumerated cases) — the expected set cannot be sealed over an incomplete inventory',
              location: null,
              cause: 'TEST_INVENTORY_INCOMPLETE',
              nextAction: CAUSE_NEXT_ACTIONS.TEST_INVENTORY_INCOMPLETE,
            },
          ]
        : [];
  const selection = {
    runner: 'playwright',
    mode: 'full-relevant-suite' as const,
    logicalKeys: plannedRows.map((row) => row.planned.logicalKey),
  };
  const selectionDigest = selectionDigestOf(selection);
  const catalogDigest = catalog === null ? NO_CATALOG_DIGEST : sha256Canonical(catalog as unknown as Record<string, never>);

  // 3. Cache reuse (plan Phase 4 item 8): identical authenticated input
  // digests + complete result only. Never reuse across changed inputs.
  const reuse = tryReuseReceipt(stateDir, witnessVerifierKey ?? null, {
    inputDigest: expectedDigest ?? NO_DIGEST,
    trustedPolicyDigest: trustedPolicy,
    selectionDigest,
    catalogDigest,
  });
  if (reuse.reuse) {
    // Under a provisioned pin the reused receipt must bind the CURRENT
    // approved revision (policy revision changed after sealing → rerun).
    if (approvedPolicyDigest !== null) {
      const binding = assertReceiptApprovedPolicy(reuse.receipt, approvedPolicyDigest);
      if (!binding.ok) {
        writeLine(io.stderr, `test-gates: ${binding.cause}: ${binding.detail}`);
        writeLine(io.stderr, `next action: ${binding.nextAction}`);
        return 1;
      }
    }
    writeLine(io.stderr, `reused receipt ${reuse.receipt.receiptId} (identical authenticated inputs; complete result)`);
    await runDiagnosticsStep(io, config, io.cwd, stateDir, expectedDigest, pipeline.now);
    const evaluated = evaluateRun({
      cwd: io.cwd,
      config,
      graph: pipeline.graph,
      obligations: pipeline.policy.obligations,
      blocking: [...pipeline.policy.blocking, ...mappingBlockers, ...inventoryBlocking],
      stateDir,
      now: pipeline.now,
      changedFiles: null,
      witnessVerifierKey,
      evidenceContext: {
        expectedInputDigest: expectedDigest,
        snapshotUnavailable,
        requireInvocationId: false,
        changedInputs: false,
      },
    });
    const report = renderRun(evaluated.verdicts, {
      format,
      blocking: evaluated.blocking,
      waiverCounts: evaluated.waiverCounts,
      run: { ...pipeline.manifest, invocationId, inputDigest: expectedDigest ?? undefined },
      toolVersion: VERSION,
    });
    writeLine(io.stdout, report);
    return runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
  }

  // 4. Prepare the observer: spawn the loopback witness (unless the
  // caller wired one), adopt identities, bind the trusted context, and
  // materialize run state + claim injections BEFORE any test starts.
  // The derived views (obligations, routes, classifications) are written
  // BEFORE the spawn: the spawned witness loads its adapters and
  // classifications at startup, so they must already exist. (The manifest
  // is rewritten after adoption below; the views are content-stable.)
  let manifest = pipeline.manifest;
  writeManifest(stateDir, manifest);
  writeObligations(stateDir, stateObligations(pipeline.policy.obligations, pipeline.graph));
  writeHttpRoutesView(stateDir, httpRoutes);
  writeClassificationsView(stateDir, pipeline.classificationsView);
  let runToken = options.runToken ?? randomUUID();
  let spawnedWitness: Awaited<ReturnType<typeof startWitnessProcess>> | null = null;
  if (witnessUrl !== undefined) {
    if (options.runToken === undefined) {
      throw new UsageError('test-gates: --witness-url requires --run-token (the witness authenticates every call)');
    }
    manifest = await adoptWitnessRunId(manifest, witnessUrl, options.runToken);
  } else {
    try {
      // The attested subject the engine browser drives and the adapters
      // read (trusted orchestrator env, never the candidate): explicit
      // TARGET/ADAPTER bases win; APP_BASE_URL is the fallback subject
      // so existing setups that only name the app keep working.
      const appBase = io.env['GATEFORGE_APP_BASE_URL'] ?? '';
      const targetBase =
        io.env['GATEFORGE_TARGET_BASE_URL'] !== undefined && io.env['GATEFORGE_TARGET_BASE_URL'] !== ''
          ? io.env['GATEFORGE_TARGET_BASE_URL']
          : appBase;
      const adapterBase =
        io.env['GATEFORGE_ADAPTER_BASE_URL'] !== undefined && io.env['GATEFORGE_ADAPTER_BASE_URL'] !== ''
          ? io.env['GATEFORGE_ADAPTER_BASE_URL']
          : targetBase;
      spawnedWitness = await startWitnessProcess({
        GATEFORGE_RUN_ID: manifest.runId,
        GATEFORGE_RUN_TOKEN: runToken,
        GATEFORGE_STATE_DIR: stateDir,
        // Engine-side evidence needs the reviewed adapters, the
        // classifications view, and the attested app base: without them
        // the spawned witness can observe nothing (fail closed
        // downstream). Absolute paths — never repo-relative guesses.
        GATEFORGE_ADAPTERS_DIR: join(io.cwd, ...config.adapters.split('/')),
        GATEFORGE_CLASSIFICATIONS: join(stateDir, 'classifications.json'),
        ...(targetBase !== '' ? { GATEFORGE_TARGET_BASE_URL: targetBase } : {}),
        ...(adapterBase !== '' ? { GATEFORGE_ADAPTER_BASE_URL: adapterBase } : {}),
        ...(io.env['GATEFORGE_TARGET_FINGERPRINT'] !== undefined && io.env['GATEFORGE_TARGET_FINGERPRINT'] !== ''
          ? { GATEFORGE_TARGET_FINGERPRINT: io.env['GATEFORGE_TARGET_FINGERPRINT'] }
          : {}),
        ...(witnessVerifierKey !== undefined ? { [VERIFIER_KEY_ENV]: witnessVerifierKey } : {}),
      });
    } catch (error) {
      throw new UsageError(`test-gates: the observer (witness service) could not start: ${(error as Error).message}`);
    }
  }
  const effectiveWitnessUrl = witnessUrl ?? spawnedWitness?.url;
  if (expectedDigest !== null) {
    manifest = { ...manifest, invocationId, inputDigest: expectedDigest };
  }
  if (
    effectiveWitnessUrl !== undefined &&
    witnessVerifierKey !== undefined &&
    expectedDigest !== null
  ) {
    await bindWitnessContext(effectiveWitnessUrl, runToken, witnessVerifierKey, {
      runId: manifest.runId,
      invocationId,
      inputDigest: expectedDigest,
    });
  }
  writeManifest(stateDir, manifest);
  writeObligations(stateDir, stateObligations(pipeline.policy.obligations, pipeline.graph));
  writeHttpRoutesView(stateDir, httpRoutes);
  writeClassificationsView(stateDir, pipeline.classificationsView);
  const envRecord = writeEnv(stateDir, manifest, effectiveWitnessUrl ?? null, runToken);
  writeClaimInjections(stateDir, injections);

  // 4.5 Supervisor credentials are REQUIRED in supervised mode (review
  // fixes 2/3): the expected-set registration, the session-lifecycle
  // drain, and the execution trace are all verifier-key authenticated,
  // and NONE of that authority may be reconstructed after the fact. A
  // supervised run without the key would silently degrade to accepting
  // the suite's own account of execution — refuse it instead.
  if (effectiveWitnessUrl === undefined || witnessVerifierKey === undefined) {
    if (spawnedWitness !== null) {
      await stopWitnessProcess(spawnedWitness);
    }
    throw new UsageError(
      'test-gates --changed requires GATEFORGE_WITNESS_VERIFIER_KEY in the orchestrating environment: ' +
        'the witness supervisor surface (expected set, session lifecycle, execution trace) is ' +
        'verifier-key authenticated and the key never reaches the suite or the runner child',
    );
  }
  const supervisor = new SupervisorClient(effectiveWitnessUrl, runToken, witnessVerifierKey);

  // 4.6 Expected-set registration BEFORE the run (review fix 2a): the
  // expected tests come from an INDEPENDENT enumeration — a separate
  // `playwright --list` child with a scrubbed (GATEFORGE-free) env and a
  // finite timeout — never from suite-writable state. The witness binds
  // the set to this run; from now on /sessions/open accepts only tests
  // in it, and the execution trace groups sessions by these identities.
  const enumeration = await listNativePlaywrightTests({ cwd: io.cwd });
  const registered = await supervisor.registerExpectedSet({
    tests: enumeration.instances.map((instance) => ({
      testId: instance.frameworkId,
      project: instance.project.length > 0 ? instance.project : null,
      file: instance.file,
      titlePath: instance.titlePath,
    })),
  });
  // Progress goes to stderr: with --format json, stdout carries ONLY the
  // machine-readable report.
  writeLine(
    io.stderr,
    `expected set registered (${String(registered.count)} test(s), digest ${registered.enumerationDigest.slice(0, 12)}…)`,
  );

  // 5. Advisory diagnostics step FIRST (plan Phase 4 item 7): isolated
  // processes with every GATEFORGE_* variable stripped, so pytest
  // fixtures cannot contaminate browser evidence. Results are displayed
  // and saved but never change the required E2E decision.
  await runDiagnosticsStep(io, config, io.cwd, stateDir, expectedDigest, pipeline.now);

  // 6. Execute through the adapter under trusted-config synthesis (see
  // `@gateforge/pack-playwright` trusted-config.ts): the consumer config
  // file is never loaded; the engine reporter is forced with parent-side
  // paths as constructor options. The child env therefore carries ONLY
  // the witness URL + run token + app base — never run-state paths
  // (execution-authority fix; `buildRunnerChildEnv` refuses them).
  const adapter = new PlaywrightAdapter({
    config,
    run: {
      testFiles: plannedRows.map((row) => row.planned.file),
      projects: [
        ...new Set(
          plannedRows.map((row) => row.planned.project).filter((project): project is string => project !== null),
        ),
      ],
    },
  });
  const suiteEnv: Record<string, string> = {
    GATEFORGE_RUN_TOKEN: envRecord.GATEFORGE_RUN_TOKEN,
  };
  if (envRecord.GATEFORGE_WITNESS_URL !== null) {
    suiteEnv['GATEFORGE_WITNESS_URL'] = envRecord.GATEFORGE_WITNESS_URL;
  }
  // App-base wiring comes from the orchestrating environment (io.env —
  // the app under test is provided externally, never by the candidate);
  // only non-empty values cross to the child, and never any run-state
  // path.
  for (const name of ['GATEFORGE_APP_BASE_URL', 'GATEFORGE_TARGET_BASE_URL', 'GATEFORGE_TARGET_FINGERPRINT'] as const) {
    const value = io.env[name];
    if (typeof value === 'string' && value !== '') suiteEnv[name] = value;
  }
  // 6. Execute through the adapter under trusted-config synthesis (the
  // consumer config file is never loaded) under the SUPERVISOR SPOOL
  // DRAIN (review fix 3): while the runner executes, the CLI polls the
  // engine-reporter lifecycle spool (`<stateDir>/spool/<runId>/events.jsonl`
  // — identities and outcomes only, no secrets, at paths the child never
  // learns) and performs the witness's session open/close itself. The
  // runner child holds no supervisor rights; on stop the drain
  // force-closes any session the runner left open (crash safety — it can
  // never grade as passed) and reports lifecycle CONFLICTS (duplicate
  // begins, lone ends) that fail the run closed downstream.
  const drain = startSupervisorSpoolDrain({
    stateDir,
    runId: manifest.runId,
    witnessUrl: effectiveWitnessUrl,
    runToken,
    verifierKey: witnessVerifierKey,
  });
  let envelope: RunnerExecutionEnvelope;
  // The witness-side execution trace (review fix 2b) — THE execution
  // authority supervision grades completeness from. Fetched while the
  // witness is still up; `null` (unfetchable) blocks the run downstream.
  let sessionTrace: readonly TracedTestInput[] | null = null;
  let lifecycleConflicts: string[] = [];
  try {
    envelope = await adapter.execute({ logicalKeys: selection.logicalKeys }, {
      stateDir,
      runId: manifest.runId,
      vars: suiteEnv,
    });
  } finally {
    // Final spool sweep + force-close of runner-left-open sessions,
    // BEFORE the witness stops (the close calls need it alive).
    const drained = await drain.stop();
    lifecycleConflicts = drained.conflicts;
    try {
      const trace = await supervisor.executionTrace();
      sessionTrace = trace === null ? null : trace.tests;
    } catch {
      sessionTrace = null; // fail closed: a missing authority never grades success
    }
    if (spawnedWitness !== null) {
      // Graceful stop (the same contract as the consumer teardown): the
      // witness appends its attested manifest envelope at shutdown, so
      // the durable evidence channel is sealed before evaluation.
      await stopWitnessProcess(spawnedWitness);
    }
  }
  const outcomesDoc =
    readRunnerOutcomes(join(stateDir, 'runner-outcomes.json'));
  const sealed = sealExecutionResult({
    runId: manifest.runId,
    invocationId,
    inputDigest: expectedDigest ?? NO_DIGEST,
    trustedPolicyDigest: trustedPolicy,
    runner: 'playwright',
    logicalKeys: selection.logicalKeys,
    catalog: catalog ?? EMPTY_CATALOG,
    plannedRows,
    envelope,
    outcomesDoc,
    sessionTrace,
    enumerationDigest: registered.enumerationDigest,
    startedAt: pipeline.now,
    finishedAt: pipeline.now,
  });
  writeExecutionResult(stateDir, sealed.result);

  // 7. Post-run stability: the tested tree must still be the run's tree.
  let changedInputs = false;
  if (!snapshotUnavailable && preFiles !== null) {
    try {
      const postSuite = collectInputFiles(io.cwd, config, stateDir);
      changedInputs = diffInputFiles(preFiles, postSuite).length > 0;
    } catch {
      changedInputs = true;
    }
  }

  // 8. Live attestation (same discipline as the legacy path).
  const liveAttestation = await fetchWitnessAttestation(
    io,
    effectiveWitnessUrl,
    runToken,
    witnessVerifierKey,
    expectedDigest === null
      ? null
      : { runId: manifest.runId, invocationId, inputDigest: expectedDigest },
  );
  if (liveAttestation !== null) {
    persistLiveAttestation(stateDir, liveAttestation);
  }

  // 9. Evaluate + project supervision/mapping/inventory/lifecycle findings
  // into blocking entries (never diff-scoped, never waived). Lifecycle
  // conflicts (duplicate begins, lone ends) are worker-side forgery or
  // runner confusion — they fail the run closed here, not in the verdict
  // engine (the engine never saw a trustworthy lifecycle to grade).
  const supervisionFindings = sealed.result.causes.map((cause) => ({
    cause: cause.cause,
    detail: cause.detail,
    logicalKey: cause.logicalKey,
  }));
  const lifecycleBlocking: BlockingEntry[] = lifecycleConflicts.map((detail) => ({
    kind: 'finding' as const,
    resourceId: null,
    name: null,
    detail,
    location: null,
    cause: 'RUN_INCOMPLETE' as const,
    nextAction: CAUSE_NEXT_ACTIONS['RUN_INCOMPLETE'],
  }));
  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    obligations: pipeline.policy.obligations,
    blocking: [
      ...pipeline.policy.blocking,
      ...mappingBlockers,
      ...inventoryBlocking,
      ...supervisionBlocking(supervisionFindings),
      ...lifecycleBlocking,
    ],
    stateDir,
    now: pipeline.now,
    changedFiles: null,
    witnessVerifierKey,
    witnessAttestation: liveAttestation,
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      expectedInvocationId: expectedDigest === null ? null : invocationId,
      requireInvocationId: true,
      changedInputs,
    },
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

  // 10. Seal the gate: receipt ONLY after complete supervision success
  // and clean evidence grading; any failure invalidates the cached
  // receipt (E07 — a later failing run blocks a subsequent check too).
  const gateCode = runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
  if (gateCode !== 0 || !sealed.result.complete || changedInputs || snapshotUnavailable || expectedDigest === null) {
    clearGateReceipt(stateDir);
    return gateCode === 0 ? 1 : gateCode;
  }
  if (witnessVerifierKey === undefined) {
    // No verifier key: the receipt cannot be signed by the same
    // authority as witness records — never mint an unverifiable one.
    clearGateReceipt(stateDir);
    writeLine(io.stderr, 'test-gates: no witness verifier key — no gate receipt can be sealed (require-e2e consumers will block)');
    return gateCode;
  }
  const satisfied = evaluated.verdicts.filter((entry) => entry.verdict === 'satisfied').length;
  const waived = evaluated.verdicts.filter((entry) => entry.verdict === 'waived').length;
  const receipt = issueGateReceipt({
    verifierKey: witnessVerifierKey,
    runId: manifest.runId,
    invocationId,
    inputDigest: expectedDigest,
    gitSha: manifest.gitSha,
    parentSha: parentSha(io.cwd),
    trustedPolicyDigest: trustedPolicy,
    approvedPolicyDigest,
    invocation: SUPERVISED_INVOCATION,
    selectionDigest,
    catalogDigest,
    executionResultDigest: sealed.digest,
    evidenceAttestationDigest: liveAttestation === null ? null : sha256Canonical(liveAttestation as unknown as Record<string, never>),
    verdictSummary: {
      total: evaluated.verdicts.length,
      satisfied,
      waived,
      blocking: 0,
    },
    issuedAt: pipeline.now,
  });
  writeGateReceipt(stateDir, receipt);
  writeLine(io.stderr, `receipt ${receipt.receiptId} sealed (complete run, evidence graded, inputs bound)`);
  return 0;
}

/** Runs the configured diagnostic suites as a separate advisory step. */
async function runDiagnosticsStep(
  io: Io,
  config: GateforgeConfig,
  cwd: string,
  stateDir: string,
  inputDigest: string | null,
  now: string,
): Promise<void> {
  const suites = config.diagnostics?.suites ?? [];
  if (suites.length === 0) return;
  const run = await runDiagnosticSuites({ config, cwd, stateDir, inputDigest, now });
  for (const result of run.results) {
    const line =
      `diagnostic ${result.suite}: ${result.status} (passed=${String(result.counts.passed)}` +
      ` failed=${String(result.counts.failed)} errors=${String(result.counts.errors)}` +
      ` skipped=${String(result.counts.skipped)} xfail=${String(result.counts.xfailed)})`;
    if (result.status === 'completed') {
      writeLine(io.stderr, `${line} — advisory only, never E2E satisfaction`);
    } else {
      writeLine(io.stderr, `${line} — ${result.status === 'failures' ? 'DIAGNOSTIC_TEST_FAILURE' : 'DIAGNOSTIC_RUN_INCOMPLETE'}: advisory alarm, the E2E decision is unchanged`);
    }
  }
  if (run.previousReportStale) {
    writeLine(io.stderr, 'diagnostic report was stale for the previous inputs (DIAGNOSTIC_RESULT_STALE) — refreshed by this run');
  }
}

/** Constants used only where a real digest cannot exist (fail-closed holes). */
const NO_DIGEST = '0'.repeat(64);
const NO_CATALOG_DIGEST = '0'.repeat(64);

/** A schema-valid empty catalog (used only when discovery itself failed). */
const EMPTY_CATALOG: TestCatalog = {
  schemaVersion: 1,
  entries: [],
  unresolved: [],
  parseErrors: [],
  inventoryComplete: false,
  runnerSummaries: [],
};

/**
 * Gracefully stops a witness this command spawned (the same contract as
 * the consumer teardown): SIGTERM with a short grace period so the
 * witness appends its attested manifest envelope, then SIGKILL.
 *
 * Args:
 *   handle: the spawned witness handle.
 */
async function stopWitnessProcess(handle: { child: ChildProcess }): Promise<void> {
  handle.child.kill('SIGTERM');
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(() => {
      handle.child.kill('SIGKILL');
      resolveWait();
    }, 2000);
    handle.child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

/**
 * Binds the trusted run context on a wired witness (plan §11.4):
 * authenticated `POST /run-context` with the run token AND the
 * verifier key, freezing the current runId/invocationId/inputDigest
 * before any observation or issuance.
 *
 * Args:
 *   witnessUrl: the wired witness base URL.
 *   runToken: the witness's run token (outer auth gate).
 *   verifierKey: the witness verifier key (attestation auth; never the
 *     suite run token).
 *   body: the validated current runId, fresh invocationId, and tested
 *     inputDigest from trusted caller memory.
 *
 * Throws:
 *   Error: fail-closed when the witness refuses (used witness, changed
 *   rebinding, missing key) or is unreachable — without a bound context
 *   no attestation can authorize this run's evidence. Diagnostics name
 *   only the failure class, never verifier material.
 *
 * Transport note: every witness fetch sends `connection: close`. The
 * CLI's calls straddle a multi-second suite run, far beyond the
 * server's idle keep-alive — reusing a pooled socket the server
 * already closed fails with a transport error (observed under
 * full-suite load), so no witness connection is ever pooled.
 */
async function bindWitnessContext(
  witnessUrl: string,
  runToken: string,
  verifierKey: string,
  body: { runId: string; invocationId: string; inputDigest: string },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${witnessUrl}/run-context`, {
      method: 'POST',
      headers: {
        'x-gateforge-run': runToken,
        'x-gateforge-verifier': verifierKey,
        'content-type': 'application/json',
        accept: 'application/json',
        connection: 'close',
      },
      body: canonicalJson(body),
      signal: controller.signal,
    });
    if (response.ok) return;
    const status = response.status;
    let detail = '';
    try {
      const errorBody = (await response.json()) as { error?: unknown };
      if (typeof errorBody.error === 'string') detail = `: ${errorBody.error}`;
    } catch {
      detail = '';
    }
    throw new Error(
      `test-gates: witness ${witnessUrl} refused run-context binding (HTTP ${status})${detail}; ` +
        'start a fresh witness for a new invocation',
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('test-gates: witness')) throw error;
    throw new Error(
      `test-gates: witness ${witnessUrl} run-context binding failed (transport): ${(error as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the live v2 attestation from a still-running wired witness
 * (pin #7, GF-23, plan §11.3/§11.5). A wired witness appends its
 * envelope to the run manifest only at its own shutdown — which
 * typically happens AFTER `test-gates` evaluates — so while it is up,
 * the verifier-authenticated `GET /ledger-attestation` response is the
 * issuance attestation of record. The response must be the versioned
 * envelope the shutdown append would write (same signed object), and it
 * is validated here against the trusted expected context (runId,
 * invocationId, inputDigest from caller memory) plus its MAC; the gate
 * verifies again at evaluation. A response that fails any check
 * contributes no trust. Best-effort: any failure yields null and the
 * MAC-verified manifest append remains the sole durable channel; with
 * neither, witnessed records demote to claimed-tier (fail closed — the
 * suite-writable manifest alone never proves issuance).
 *
 * Args:
 *   io: process context (one-line failure-class diagnostics go to
 *     stderr; never verifier material).
 *   witnessUrl: the wired witness base URL, when provided.
 *   runToken: the witness's run token (outer auth gate), when provided.
 *   verifierKey: the witness verifier key (attestation auth), when provided.
 *   expected: the trusted runId/invocationId/inputDigest, or null when
 *     the snapshot is unavailable (then no live envelope can validate).
 *
 * Returns:
 *   Attestation | null: the validated envelope, or null when
 *   unavailable or unverified.
 */
async function fetchWitnessAttestation(
  io: Io,
  witnessUrl: string | undefined,
  runToken: string | undefined,
  verifierKey: string | undefined,
  expected: { runId: string; invocationId: string; inputDigest: string } | null,
): Promise<Attestation | null> {
  if (witnessUrl === undefined || runToken === undefined || verifierKey === undefined) {
    return null;
  }
  if (expected === null) {
    writeLine(io.stderr, 'test-gates: live attestation unavailable (snapshot-unavailable)');
    return null;
  }
  // Bounded live-attestation budget: full-suite load can exceed a tight
  // bound while records stay valid. No retry, no weakened validation.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${witnessUrl}/ledger-attestation`, {
      headers: {
        'x-gateforge-run': runToken,
        'x-gateforge-verifier': verifierKey,
        accept: 'application/json',
        connection: 'close',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      writeLine(io.stderr, `test-gates: live attestation unavailable (status ${response.status})`);
      return null;
    }
    const body: unknown = await response.json();
    const parsed = AttestationSchema.safeParse(body);
    if (!parsed.success) {
      writeLine(io.stderr, 'test-gates: live attestation unavailable (schema)');
      return null;
    }
    const attestation = parsed.data;
    if (
      attestation.runId !== expected.runId ||
      attestation.invocationId !== expected.invocationId ||
      attestation.inputDigest !== expected.inputDigest
    ) {
      writeLine(io.stderr, 'test-gates: live attestation rejected (context)');
      return null;
    }
    // Verify before handing it to the gate; the gate re-verifies.
    if (
      !verifyAttestationMac(
        verifierKey,
        {
          runId: attestation.runId,
          invocationId: attestation.invocationId,
          inputDigest: attestation.inputDigest,
          recordIds: attestation.recordIds,
        },
        attestation.mac,
      )
    ) {
      writeLine(io.stderr, 'test-gates: live attestation rejected (mac)');
      return null;
    }
    return attestation;
  } catch {
    writeLine(io.stderr, 'test-gates: live attestation unavailable (transport)');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persists a validated live v2 attestation into the run manifest as the
 * durable fallback (plan §11.5): the witness may still be serving at
 * evaluation time, so the manifest must already carry the current
 * envelope before witness shutdown. Only a fully validated envelope is
 * ever written; all other manifest fields are preserved.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   attestation: the validated v2 envelope.
 */
function persistLiveAttestation(stateDir: string, attestation: Attestation): void {
  const manifestPath = join(stateDir, 'manifest.json');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return; // missing/unreadable manifest: durable channel stays unavailable
  }
  const updated: Record<string, unknown> = {
    ...manifest,
    invocationId: attestation.invocationId,
    inputDigest: attestation.inputDigest,
    attestation: attestation as unknown as Record<string, unknown>,
  };
  delete updated['recordIdsMac'];
  writeFileSync(manifestPath, `${canonicalJson(updated as Parameters<typeof canonicalJson>[0])}\n`, 'utf8');
}

/**
 * Spawns the suite command through `sh -c` asynchronously and forwards
 * its streams (the async form keeps the CLI event loop live for the
 * supervisor spool drain while the suite runs; a sync spawn would block
 * the drain's polls). Exit is nonzero → the run fails.
 *
 * Args:
 *   io: process context (suite stdout/stderr stream through).
 *   suite: the user suite command line.
 *   options: cwd + the child environment (verifier-key-stripped).
 *
 * Returns:
 *   Promise<number>: the suite's exit status (null kills count as
 *   nonzero so a broken run never reports success).
 */
async function spawnSuite(
  io: Io,
  suite: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise((resolveStatus, rejectStart) => {
    const child = spawn('sh', ['-c', suite], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      io.stdout.write(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      io.stderr.write(chunk.toString('utf8'));
    });
    child.once('error', (error) => {
      rejectStart(new Error(`test-gates suite could not be started: ${error.message}`));
    });
    child.once('exit', (status) => {
      resolveStatus(status === null ? 1 : status);
    });
  });
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
      headers: { 'x-gateforge-run': runToken, accept: 'application/json', connection: 'close' },
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