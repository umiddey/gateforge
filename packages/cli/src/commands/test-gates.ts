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
 *
 * **Scoped sealing (`--scope changed`, opt-in)** — the expected set is
 * narrowed to the SLICE of tests whose files claim obligations affected
 * by the resolved changed-file set (the same diff providers
 * `check --changed` uses): affected resources join through the detector
 * graph's source map, obligations through the policy, tests through the
 * ONE mapping resolver. The slice is planned before the run, registered
 * with the witness, enforced for planned-vs-executed completeness, and
 * sealed as a `changed`-scope receipt naming the covered obligation
 * fingerprints. Selection is FILE-grained and never guesses: an affected
 * obligation with no testable declared claim is a typed
 * EVIDENCE_SCOPE_INCOMPLETE block, and an empty slice seals nothing.
 * Without the flag the mode stays `full` — byte-identical behavior.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AttestationSchema,
  BEHAVIOR_CASE_KIND,
  BehaviorCasePayloadSchema,
  CAUSE_NEXT_ACTIONS,
  canonicalJson,
  caseExecutionDigestOf,
  EMPTY_BEHAVIOR_CATALOG_DIGEST,
  engineBundleDigestOf,
  EvidenceRecordSchema,
  GateReceiptSchema,
  ExecutionResultSchema,
  executionBoundaryDigestOf,
  LOCAL_UNISOLATED_BOUNDARY,
  humanMessage,
  isWitnessedRecord,
  renderRun,
  requiredCaseSetDigestOf,
  runExitCode,
  sha256Canonical,
  selectionDigestOf,
  targetArtifactDigestOf,
  verifyAttestationMac,
  type Attestation,
  type BehaviorCatalog,
  type BlockingEntry,
  type ExecutionResult,
  type GateforgeConfig,
  type GateReceipt,
  type Claim,
  type JsonValue,
  type ObligationVerdict,
  executionResultDigestOf,
  testOutcomesDigestOf,
  verifyRunRecord,
  type RunManifest,
  type RunRecord,
  type ResolvedMappings,
  type RunExecutionSummary,
  type RunnerExecutionEnvelope,
  BLOCKING_VERDICTS,
  decideStrictness,
  loadQuarantines,
  QUARANTINE_DIR,
  resolveStrictnessMode,
  strictnessSummaryLine,
  withoutQuarantinedBindings,
  type LoadedQuarantine,
  type Obligation,
  type TestCatalog,
  type TracedTestInput,
} from '@gate-forge/core';
import {
  buildWitnessedPytestChildEnv,
  CypressRunnerAdapter,
  diffNativePlaywrightTests,
  discoverTestCatalog,
  findPlaywrightConfig,
  listNativePlaywrightTests,
  PlaywrightAdapter,
  PytestRunnerAdapter,
  readRunnerOutcomes,
  startSupervisorSpoolDrain,
  startWitnessProcess,
  SupervisorClient,
  TestDiscoveryError,
  VitestRunnerAdapter,
  RUN_HEADER,
  DEFAULT_RUN_TIMEOUT_MS,
  ENV_PROXY_TARGET,
  type ExpectedSetResponse,
  type NativeInstance,
  type NativeListResult,
  type RunnerEnumeration,
  type RunnerExecuteRequest,
  type RunnerTestIdentity,
} from '@gate-forge/pack-playwright';
import { parseArgs, repeatableStringFlag, stringFlag } from '../args.js';
import { resolveAdoptedBaseline } from '../adopted-baseline.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { runDiagnosticSuites, runWitnessedPytestSuites } from '../diagnostics.js';
import {
  claimInjectionsFor,
  planScopedExpectedSet,
  trustedPolicyDigestForConfig,
  issueGateReceipt,
  issueRunRecord,
  parentSha,
  planExpectedSet,
  sealExecutionResult,
  supervisionBlocking,
  SUPERVISED_INVOCATION,
  type PlannedRow,
} from '../execution.js';
import { evaluateRun, scopeBlocking, type EvaluateInput } from '../evaluate.js';
import { installedPlaywrightCompatibilityError } from '../package-compatibility.js';
import { DOCS_EXCLUSIONS_GUARANTEE, loadDocsExclusions } from '../docs-exclusions.js';
import { CACHE_EXCLUSIONS_GUARANTEE, loadCacheExclusions } from '../cache-exclusions.js';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  type InputSnapshot,
  type SnapshotFileEntry,
} from '../input-snapshot.js';
import { findRunnerConfigPath, mappingBlocking, mappedCoverageFrom, nativeInventoryBlocking, nativeInventoryProblem, observeObligationIds, resolveRepositoryMappings, serverE2eObligationIds, TEST_MAP_RELATIVE } from '../mapping.js';
import { runPipeline, sourcesByResourceId } from '../pipeline.js';
import { loadReceiptFor, receiptScope, tryReuseReceipt, type ReceiptLoad } from '../receipts.js';
import { carryDiffIsWithinScope, classifyResealChange, type ResealChangeClassification } from '../reseal.js';
import {
  clearResealChain,
  RESEAL_CHAIN_MAX_HOPS,
  resealChainHopCount,
  writeResealChainHop,
} from '../reseal-chain.js';
import { obligationFingerprint } from '../evaluate.js';
import { computeEvaluationScope } from '../scope.js';
import { candidateTreeCoversCommit, computeCandidateTreeId, computeCandidateTreeSnapshot, resolveGitDir, sanitizedAuthorityEnv } from '../candidate-tree.js';
import type { RuntimeReuseMount } from '../runtime-reuse.js';
import { resolveProvider } from '../providers.js';
import { engineIdentity } from '../engine-identity.js';
import { assertReceiptApprovedPolicy, evaluateApprovedPolicy, resolveApprovedPolicyDigest } from '../trusted-policy.js';
import {
  clearGateReceipt,
  clearRunRecord,
  httpRoutesView,
  readJsonArray,
  readStateDocument,
  resolveStateDir,
  stateObligations,
  writeClaimInjections,
  writeClassificationsView,
  writeEnv,
  writeExecutionResult,
  writeCandidateTreeEntries,
  writeGateReceipt,
  writeHttpRoutesView,
  writeInputSnapshot,
  writeManifest,
  writeObligations,
  writeLastFullRunSummary,
  writeReport,
  writeRunRecord,
} from '../state.js';
import {
  loadConfigAt,
  parseRunFormat,
  rejectUnknownFlags,
  VERIFIER_KEY_ENV,
  VERIFIER_KEY_FILE_ENV,
  VERSION,
} from './common.js';
import { resolveVerifierKeyring, type VerifierKeyring } from '../verifier-keys.js';
import { hostLoadFailureNotices, startHostLoadSampler, type HostLoadCollector, type HostLoadSample, type HostLoadTestTiming } from '../host-load.js';
import {
  captureServiceLogs,
  runHarnessSetup,
  runHarnessTeardown,
  type HarnessFailure,
} from '../run-reliability.js';
import { pruneRunHistory, recordRunHistory } from '../history.js';

export const TEST_GATES_USAGE =
  'usage: gateforge test-gates [--changed] [--scope full|changed] [--suite <command>] [--out <dir>] ' +
  '[--result-only] [--test <selector>] [--format text|json|sarif] [--witness-url <url>] [--run-token <token>] ' +
  '[--run-timeout-min <minutes>] ' +
  `(verifier key via ${VERIFIER_KEY_ENV} or ${VERIFIER_KEY_FILE_ENV})\n` +
  '       --scope changed (supervised --changed only): plan, execute, and seal only the slice of tests\n' +
  '       claiming obligations affected by the resolved changed-file set; an affected obligation with no\n' +
  '       testable declared mapping blocks (EVIDENCE_SCOPE_INCOMPLETE) — narrower selection is never guessed\n' +
  '       --result-only (requires --changed --scope changed, or --test): report selected results without gate\n' +
  '       authority or receipt changes; external witnesses require a separate --out directory and --run-token\n' +
  '       --test <selector> (repeatable, requires --result-only): run only the named tests, witnessed. A\n' +
  '       selector is a logical key or a unique substring of one. A hand-picked test list never seals a\n' +
  '       receipt, so it is refused without --result-only. An unknown or ambiguous selector exits 2 with\n' +
  '       the candidate keys listed — a narrower selection is never guessed';

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
    ['suite', 'out', 'format', 'witness-url', 'run-token', 'run-timeout-min', 'changed', 'scope', 'result-only', 'test', 'help'],
    TEST_GATES_USAGE,
  );
  const compatibilityError = installedPlaywrightCompatibilityError();
  if (compatibilityError !== null) {
    writeLine(io.stderr, compatibilityError);
    return 2;
  }
  const suite = stringFlag(options, 'suite');
  const out = stringFlag(options, 'out');
  const format = parseRunFormat(stringFlag(options, 'format') ?? 'text');
  const witnessUrl = stringFlag(options, 'witness-url');
  const changed = options['changed'] === true;
  const resultOnly = options['result-only'] === true;
  if (changed && suite !== undefined) {
    throw new UsageError(
      'test-gates: --changed runs the configured suite through the supervised adapter; ' +
        '--suite is the legacy escape hatch and cannot be combined',
    );
  }
  // --scope (Goal 2, opt-in scoped sealing): `full` is the unchanged
  // default; `changed` narrows the supervised run to the affected slice.
  // Strictly supervised-only — the legacy --suite path has no receipt to
  // scope and must never grow one silently.
  let scope: 'full' | 'changed' = 'full';
  const scopeFlag = stringFlag(options, 'scope');
  if (scopeFlag !== undefined) {
    if (!changed) {
      throw new UsageError('test-gates: --scope is a supervised `--changed` option and cannot be used without it');
    }
    if (scopeFlag !== 'full' && scopeFlag !== 'changed') {
      throw new UsageError(`test-gates: --scope must be 'full' or 'changed' (got '${scopeFlag}')`);
    }
    scope = scopeFlag;
  }
  // --test (repeatable): the hand-picked, witnessed single-test check.
  // Resolution against the planned rows happens later, once the plan is
  // fixed; here we only read the raw list and guard the contract that a
  // named run can never carry gate authority.
  const testSelectors = repeatableStringFlag(options, 'test');
  if (testSelectors !== undefined && !resultOnly) {
    throw new UsageError(
      'test-gates: --test requires --result-only — a hand-picked test list never seals a receipt, ' +
        'so run the full or scoped gate to issue one',
    );
  }
  if (testSelectors !== undefined && suite !== undefined) {
    throw new UsageError(
      'test-gates: --test runs through the supervised runner adapter and cannot be combined with --suite',
    );
  }
  // A named run builds its plan from the FULL planned rows and then
  // narrows to the named keys, so it relaxes the diff-linked
  // `--changed --scope changed` requirement --result-only otherwise has.
  const namedSelection = testSelectors !== undefined;
  if (resultOnly && !namedSelection && (!changed || scope !== 'changed' || suite !== undefined)) {
    throw new UsageError(
      'test-gates: --result-only requires --changed --scope changed (or --test <selector>) and cannot be combined with --suite',
    );
  }
  if (resultOnly && witnessUrl === undefined && out !== undefined) {
    throw new UsageError(
      'test-gates: --result-only accepts --out only with --witness-url; without an external witness it owns a private temporary state directory',
    );
  }
  if (resultOnly && witnessUrl !== undefined) {
    if (out === undefined) {
      throw new UsageError(
        'test-gates: --result-only with --witness-url requires --out <dir> shared with the external witness; ' +
          'use a separate non-authoritative state directory, not the configured gate state directory',
      );
    }
    if (stringFlag(options, 'run-token') === undefined) {
      throw new UsageError('test-gates: --result-only with --witness-url requires --run-token <token>');
    }
    const externalStateDir = canonicalizeStateDir(resolveStateDir(io.cwd, out));
    const authoritativeStateDir = canonicalizeStateDir(resolveStateDir(io.cwd));
    const relativeOut = relative(authoritativeStateDir, externalStateDir);
    if (
      relativeOut === '' ||
      (relativeOut !== '..' && !relativeOut.startsWith(`..${sep}`) && !isAbsolute(relativeOut))
    ) {
      throw new UsageError(
        `test-gates: --result-only --out '${out}' must be a separate non-authoritative state directory, ` +
          `not the configured authoritative state directory '${resolveStateDir(io.cwd)}'`,
      );
    }
  }
  const verifierKeyring = resolveVerifierKeyring(io.cwd, io.env, [resolveStateDir(io.cwd, out)]);
  if (changed || namedSelection) {
    const isolatedStateDir = resultOnly && witnessUrl === undefined ? mkdtempSync(join(tmpdir(), 'gateforge-selected-result-')) : undefined;
    try {
      return await runSupervisedTestGates(io, {
        out: isolatedStateDir ?? out,
        format,
        witnessUrl,
        runToken: stringFlag(options, 'run-token'),
        runTimeoutMs: parseRunTimeoutMin(stringFlag(options, 'run-timeout-min')),
        scope,
        resultOnly,
        testSelectors,
        verifierKeyring,
      });
    } finally {
      if (isolatedStateDir !== undefined) rmSync(isolatedStateDir, { recursive: true, force: true });
    }
  }
  return legacyTestGates(io, {
    suite,
    out,
    format,
    witnessUrl,
    runToken: stringFlag(options, 'run-token'),
    verifierKeyring,
  });
}

/**
 * Resolves a path through existing symlinks and appends a not-yet-existing
 * suffix so state-directory comparisons cannot be bypassed with aliases.
 *
 * Args:
 *   path: absolute or relative state-directory path.
 *
 * Returns:
 *   string: canonical absolute path.
 */
function canonicalizeStateDir(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...suffix.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

/**
 * Parses `--run-timeout-min` into a whole-run wall-clock bound.
 * The 30-minute default stands when the flag is absent; an explicit
 * bound never weakens verification (same expected set, same
 * completeness rules — only the kill timer moves, under operator
 * control for multi-hour suites). Bounded above so the value always
 * fits the runner's timer range (larger values would overflow it and
 * kill the run immediately — fail-open by accident is worse than a
 * documented cap).
 *
 * Args:
 *   raw: the flag value, or undefined when absent.
 *
 * Returns:
 *   Milliseconds, or undefined for the default bound.
 * @throws UsageError on non-integer, out-of-range, or repeated values.
 */
export function parseRunTimeoutMin(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`test-gates: --run-timeout-min must be a positive integer number of minutes (got '${raw}')`);
  }
  const minutes = Number(raw);
  if (minutes < 1 || minutes > 2880) {
    throw new UsageError('test-gates: --run-timeout-min must be between 1 and 2880 minutes (48h)');
  }
  return minutes * 60_000;
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
  /** Trusted key ring resolved before run-state creation. */
  verifierKeyring: VerifierKeyring | null;
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
  const config = loadConfigAt(io.cwd);
  const cacheExclusions = loadCacheExclusions(io.cwd, config);
  const cachePolicyDigest = cacheExclusions.length > 0 ? trustedPolicyDigestForConfig(io.cwd, config) : null;
  const cacheApprovalResolution =
    cacheExclusions.length > 0
      ? resolveApprovedPolicyDigest({ env: io.env, candidateCwd: io.cwd, candidateConfig: config })
      : null;
  const cachePolicyGate =
    cachePolicyDigest === null || cacheApprovalResolution === null
      ? null
      : evaluateApprovedPolicy(cacheApprovalResolution, cachePolicyDigest, true);
  if (cachePolicyGate?.status === 'blocked') {
    writeLine(io.stderr, `test-gates: ${cachePolicyGate.cause}: ${cachePolicyGate.detail}`);
    writeLine(io.stderr, `next action: ${cachePolicyGate.nextAction}`);
    return 1;
  }
  const cacheApprovalDigest = cachePolicyGate?.status === 'enforced' ? cachePolicyGate.approved : null;
  const stateDir = resolveStateDir(io.cwd, out);
  const verifierKeyring = options.verifierKeyring ?? resolveVerifierKeyring(io.cwd, io.env, [stateDir]);
  const witnessVerifierKey = verifierKeyring?.active.key;

  // 1. Inventory/hash inputs BEFORE discovery (plan §11.5). Only file
  // bytes exist yet; the gate context joins after discovery. Unsafe
  // --out overlap and uncapturable inputs fail closed (exit 2) before
  // witness binding, suite start, or any state artifact write.
  let preFiles: SnapshotFileEntry[] | null = null;
  let snapshotUnavailable = false;
  try {
    preFiles = collectInputFiles(io.cwd, config, stateDir, [], [], cacheExclusions);
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
      const postDiscovery = collectInputFiles(io.cwd, config, stateDir, [], [], cacheExclusions);
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
        cacheExclusions,
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
  const envRecord = writeEnv(stateDir, manifest, witnessUrl ?? null, runToken, io.env);

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
        env: {
          ...io.env,
          [VERIFIER_KEY_ENV]: undefined,
          [VERIFIER_KEY_FILE_ENV]: undefined,
          ...suiteEnv,
        },
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
      const postSuite = collectInputFiles(io.cwd, config, stateDir, [], [], cacheExclusions);
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
    behaviorCatalog: pipeline.behaviorCatalog,
    obligations: pipeline.policy.obligations,
    blocking: pipeline.policy.blocking,
    stateDir,
    now: pipeline.now,
    engineAlembicRecords: pipeline.engineAlembicRecords,
    changedFiles: null,
    witnessVerifierKey,
    witnessVerifierKeys: verifierKeyring?.keys.map((entry) => entry.key),
    witnessAttestation: liveAttestation,
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      expectedInvocationId: expectedDigest === null ? null : invocationId,
      requireInvocationId: true,
      changedInputs,
    },
  });
  const diagnosticContext =
    cacheExclusions.length === 0
      ? undefined
      : {
          scope: 'full' as const,
          candidateTreeId: null,
          inputDigest: expectedDigest,
          evidenceState: snapshotUnavailable
            ? 'snapshot-unavailable'
            : changedInputs
              ? 'inputs-changed-during-run'
              : 'observed',
          authority: 'non-authoritative' as const,
          cacheExclusions: {
            files: cacheExclusions,
            approvalDigest: cacheApprovalDigest,
            approvalStatus: 'matched' as const,
            guarantee: CACHE_EXCLUSIONS_GUARANTEE,
          },
        };

  const report = renderRun(evaluated.verdicts, {
    format,
    blocking: evaluated.blocking,
    waiverCounts: evaluated.waiverCounts,
    run: manifest,
    toolVersion: VERSION,
    engine: engineIdentity(),
    lifecycleDerivation: pipeline.lifecycleDerivation,
    diagnosticContext,
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
      engine: engineIdentity(),
      lifecycleDerivation: pipeline.lifecycleDerivation,
      diagnosticContext,
    }),
  );

  const gateCode = runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
  return suiteFailed && gateCode === 0 ? 1 : gateCode;
}

/** Options of the supervised (`--changed`) path. */
export interface SupervisedOptions {
  /** State-dir override. */
  out: string | undefined;
  /** Report format. */
  format: 'text' | 'json' | 'sarif';
  /** External witness URL (the caller owns the witness). */
  witnessUrl: string | undefined;
  /** External witness run token. */
  runToken: string | undefined;
  /** Whole-run wall-clock bound ms (undefined = 30-minute default). */
  runTimeoutMs: number | undefined;
  /**
   * Evaluation scope (Goal 2): `full` (default, unchanged behavior) runs
   * the whole relevant suite and seals a whole-repo receipt; `changed`
   * runs and seals only the affected slice.
   */
  scope: 'full' | 'changed';
  /** Report the selected slice without writing or clearing a gate receipt. */
  resultOnly?: boolean;
  /**
   * Hand-picked test selectors (`--test`), resolved against the planned
   * rows. Only ever combined with `resultOnly`: a named run reports, it
   * never seals.
   */
  testSelectors?: readonly string[];
  /** Trusted key ring resolved before candidate materialization, when provided. */
  verifierKeyring?: VerifierKeyring | null;
  /** Trusted staged-candidate changed paths supplied by the pre-commit orchestrator. */
  fixedChangedFiles?: readonly string[];
  /** Trusted staged-candidate tree id supplied by the pre-commit orchestrator. */
  fixedCandidateTreeId?: string;
  /** Trusted parent sha supplied by the pre-commit orchestrator. */
  fixedParentSha?: string | null;
  /** Digest of dependency bytes reused by the staged candidate runtime. */
  runtimeReuseDigest?: string | null;
  /** Exact owner-approved external dependency mounts in a staged checkout. */
  runtimeReuseMounts?: readonly RuntimeReuseMount[];
  /** Recomputes the external reuse digest at the end of a staged run. */
  runtimeReuseCheck?: () => string | null;
}

/** One resolved `--test` selector and the planned logical keys it named. */
export interface NamedTestSelection {
  /** The selector exactly as the operator typed it. */
  selector: string;
  /** The planned logical keys it resolved to (sorted, never empty). */
  logicalKeys: string[];
}

/** Candidate keys listed in an unresolved-selector error are capped at this many. */
const SELECTOR_CANDIDATE_LIMIT = 20;

/**
 * Next action of an unresolvable `--test` selector. `tests discover
 * --json` prints the derived catalog — the ONLY surface that lists
 * every test logical key a selector can resolve to (`discover --json`
 * dumps the resource graph instead, which never names a test).
 */
const SELECTOR_NEXT_ACTION = 'gateforge tests discover --json';

/**
 * Renders the candidate logical keys for an unresolved `--test`
 * selector. Never guess a selection: the operator gets the exact keys
 * to pick from.
 *
 * Args:
 *   keys: every planned logical key of the run.
 *
 * Returns:
 *   string: the capped, sorted candidate list.
 */
function selectorCandidates(keys: readonly string[]): string {
  const sorted = [...keys].sort();
  const shown = sorted.slice(0, SELECTOR_CANDIDATE_LIMIT).map((key) => `  - ${key}`).join('\n');
  const hidden = sorted.length - Math.min(sorted.length, SELECTOR_CANDIDATE_LIMIT);
  return hidden > 0 ? `${shown}\n  ... and ${String(hidden)} more` : shown;
}

/**
 * Resolves hand-picked `--test` selectors against the PLANNED rows (the
 * expected set fixed before the run), never against raw runner output:
 * a selector can only ever name a test the gate already planned.
 *
 * A selector matches an exact logical key first, then a
 * case-insensitive substring of one. Zero matches and ambiguous
 * substrings both fail closed (exit 2) with the candidate keys listed.
 *
 * Args:
 *   selectors: the selectors as typed, in argv order.
 *   rows: the planned rows (only their logical keys are read).
 *
 * Returns:
 *   NamedTestSelection[]: one entry per selector, in argv order.
 * @throws UsageError (exit 2) when a selector matches nothing or more
 *   than one planned test.
 */
export function resolveTestSelectors(
  selectors: readonly string[],
  rows: readonly { logicalKey: string }[],
): NamedTestSelection[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.logicalKey)) continue;
    seen.add(row.logicalKey);
    keys.push(row.logicalKey);
  }
  return selectors.map((selector) => {
    const exact = keys.filter((key) => key === selector);
    const candidates = exact.length > 0 ? exact : keys.filter((key) => key.toLowerCase().includes(selector.toLowerCase()));
    if (candidates.length === 0) {
      throw new UsageError(
        humanMessage({
          detail: `no planned test matches the selector '${selector}' — nothing ran`,
          nextAction: SELECTOR_NEXT_ACTION,
          type: 'test-selector-unknown',
        }) +
          (keys.length === 0
            ? ' (this run planned no tests)'
            : `\ncandidate logical keys:\n${selectorCandidates(keys)}`),
      );
    }
    if (candidates.length > 1) {
      throw new UsageError(
        humanMessage({
          detail: `the selector '${selector}' matches ${String(candidates.length)} planned tests — pick one exact logical key`,
          nextAction: SELECTOR_NEXT_ACTION,
          type: 'test-selector-ambiguous',
        }) + `\ncandidate logical keys:\n${selectorCandidates(candidates)}`,
      );
    }
    return { selector, logicalKeys: candidates };
  });
}

interface VerifiedCarryForwardParent {
  receipt: GateReceipt;
  receiptDigest: string;
  treeId: string;
  /** The parent's own complete execution result (its attested outcomes). */
  execution: ExecutionResult;
}

/**
 * Resolves the exact merge-base commit from a supported CI diff provider.
 *
 * Args:
 *   io: process context with CI provider environment.
 *   provider: configured changed-file provider identity.
 *
 * Returns:
 *   string | null: verified 40-character base commit, or null when unavailable.
 */
function resolveCarryForwardBaseSha(
  io: Io,
  provider: 'github-pr' | 'gitlab-mr' | 'local-staged' | 'all-files',
): string | null {
  if (provider === 'gitlab-mr') {
    const sha = io.env['CI_MERGE_REQUEST_DIFF_BASE_SHA']?.trim() ?? '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }
  if (provider !== 'github-pr') return null;
  const baseRef = io.env['GITHUB_BASE_REF']?.trim() ?? '';
  if (baseRef.length === 0 || baseRef.startsWith('-') || /[\\s\\0]/.test(baseRef)) return null;
  const result = spawnSync('git', ['--no-replace-objects', 'merge-base', 'HEAD', baseRef], {
    cwd: io.cwd,
    env: sanitizedAuthorityEnv(io.env),
    encoding: 'utf8',
  });
  const sha = (result.stdout ?? '').trim();
  return result.error === undefined && result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * The outcome of verifying one parent document: the verified parent, or
 * the FIRST binding that failed, named in plain words.
 *
 * A refused re-seal must be visible, so every verifier reports why. The
 * null-returning shape the plain carry-forward path uses is derived from
 * it and never sees a reason.
 */
type ParentVerification<T> = { parent: T; reason: null } | { parent: null; reason: string };

/**
 * Builds a refusal naming the first binding that failed.
 *
 * Args:
 *   reason: plain words — no cause code, no digest.
 *
 * Returns:
 *   ParentVerification: the refusal.
 */
function refuse<T>(reason: string): ParentVerification<T> {
  return { parent: null, reason };
}

/**
 * Shortens a commit for a human-facing line.
 *
 * Args:
 *   sha: a commit, or null when none is known.
 *
 * Returns:
 *   string: the 7-character prefix, or words when there is no commit.
 */
function shortSha(sha: string | null | undefined): string {
  const trimmed = (sha ?? '').trim();
  return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed.slice(0, 7) : 'an unknown commit';
}

/**
 * Whether the run state holds a document under this name at all — the
 * difference between "the previous run cannot be re-sealed" (something
 * to explain) and "there is no previous run" (nothing to say).
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   name: the state document's file name.
 *
 * Returns:
 *   boolean: true when the document exists and parses as JSON.
 */
function hasStateDocument(stateDir: string, name: string): boolean {
  try {
    return readStateDocument(stateDir, name) !== null;
  } catch {
    return false;
  }
}

/** The repository coordinates the plain carry-forward parent is held to. */
interface CarryForwardParentInput {
  io: Io;
  config: GateforgeConfig;
  stateDir: string;
  verifierKeyring: VerifierKeyring | null;
  baseSha: string;
  trustedPolicyDigest: string;
  approvedPolicyDigest: string;
  executionBoundaryDigest: string;
  /** Authority object store (the parent tree is diffed inside it). */
  gitDir: string | null;
  /** Owner-approved exclusions that are never inside a candidate tree. */
  docsExclusions: readonly string[];
  cacheExclusions: readonly string[];
}

/**
 * Authenticates a clean full-scope receipt for the exact merge-base commit.
 *
 * Args:
 *   input: candidate policy, external pin, key ring, state directory, and merge base.
 *
 * Returns:
 *   ParentVerification: the verified uncarried root receipt, or the first
 *   binding that failed in plain words.
 */
function verifyCarryForwardParent(input: CarryForwardParentInput): ParentVerification<VerifiedCarryForwardParent> {
  try {
    if (input.verifierKeyring === null) return refuse('no verifier key is available to authenticate it');
    const parsed = GateReceiptSchema.safeParse(readStateDocument(input.stateDir, 'receipt.json'));
    if (!parsed.success) return refuse('it is not a gate receipt Gateforge can read');
    const receipt = parsed.data;
    // The sealed candidate is a WORKSPACE tree (it carries the repo's
    // untracked and gitignored bytes too), so it is never equal to the
    // commit's tree. What must hold is that it COVERS the merge-base
    // commit's committed content: the parent proves those exact bytes,
    // and everything else it sealed is diffed against this run's tree.
    const treeId = receipt.candidateTreeId;
    if (
      input.gitDir === null ||
      treeId === null ||
      !candidateTreeCoversCommit(
        input.gitDir,
        input.io.env,
        treeId,
        `${input.baseSha}^{tree}`,
        input.docsExclusions,
        input.cacheExclusions,
      )
    ) {
      return refuse(
        `its sealed tree is not the tree of commit ${shortSha(input.baseSha)} (uncommitted changes were tested)`,
      );
    }
    if (receipt.gitSha !== input.baseSha) {
      return refuse(
        `it was sealed at commit ${shortSha(receipt.gitSha)}, the merge base is ${shortSha(input.baseSha)}`,
      );
    }
    if (receipt.verifierKeyId !== input.verifierKeyring.active.keyId) {
      return refuse('it was signed with a different verifier key');
    }
    if (receipt.trustedPolicyDigest !== input.trustedPolicyDigest) return refuse('the trusted policy changed');
    if (receipt.approvedPolicyDigest !== input.approvedPolicyDigest) return refuse('the approved policy changed');
    if (receipt.receiptStage !== input.config.enforcement?.receiptStage) return refuse('the receipt stage changed');
    if (
      receipt.carriedFrom !== undefined ||
      receipt.parentReceiptDigest !== undefined ||
      (receipt.scope !== undefined && receipt.scope !== 'full')
    ) {
      return refuse('a carried or sliced run never re-seals');
    }
    if (
      receipt.engine === undefined ||
      receipt.engine.version !== engineIdentity().version ||
      receipt.engine.source !== engineIdentity().source ||
      receipt.engine.unpublished !== engineIdentity().unpublished ||
      receipt.engineBundleDigest !== engineBundleDigestOf(VERSION, input.trustedPolicyDigest)
    ) {
      return refuse('the engine changed');
    }
    if (receipt.targetArtifactDigest !== targetArtifactDigestOf(treeId)) {
      return refuse('its sealed target artifact is not the tree it names');
    }
    if (
      receipt.verdictSummary.blocking !== 0 ||
      receipt.verdictSummary.satisfied + receipt.verdictSummary.waived !== receipt.verdictSummary.total
    ) {
      return refuse('it was not a clean run');
    }
    const loaded = loadReceiptFor(input.stateDir, input.verifierKeyring, {
      inputDigest: receipt.inputDigest,
      trustedPolicyDigest: input.trustedPolicyDigest,
      candidateTreeId: treeId,
      executionBoundaryDigest: input.executionBoundaryDigest,
      scope: 'full',
    });
    if (loaded.status !== 'ok') return refuse(receiptLoadRefusal(loaded.status));
    const approved = assertReceiptApprovedPolicy(loaded.receipt, input.approvedPolicyDigest);
    if (!approved.ok) return refuse('the approved policy changed');
    return {
      parent: {
        receipt: loaded.receipt,
        receiptDigest: sha256Canonical(loaded.receipt as unknown as Record<string, never>),
        treeId,
        execution: loaded.executionResult,
      },
      reason: null,
    };
  } catch {
    return refuse('it could not be read');
  }
}

/**
 * Names, in plain words, why a stored gate receipt no longer loads.
 *
 * Args:
 *   status: the receipt loader's own verdict.
 *
 * Returns:
 *   string: the first binding that failed, in words.
 */
function receiptLoadRefusal(status: ReceiptLoad['status']): string {
  if (status === 'execution-mismatch') return 'its execution result was replaced by a later run';
  if (status === 'unverified' || status === 'unknown-key' || status === 'key-mismatch') {
    return 'its signature does not verify with this keyring';
  }
  if (status === 'malformed') return 'it is not a gate receipt Gateforge can read';
  if (status === 'stale') return 'it is bound to a different run than this one';
  return 'it does not describe a whole-suite run of this repository';
}

/**
 * Authenticates a clean full-scope receipt for the exact merge-base commit.
 *
 * Args:
 *   input: candidate policy, external pin, key ring, state directory, and merge base.
 *
 * Returns:
 *   VerifiedCarryForwardParent | null: verified uncarried root receipt, or null to keep current behavior.
 */
function verifiedCarryForwardParent(input: CarryForwardParentInput): VerifiedCarryForwardParent | null {
  return verifyCarryForwardParent(input).parent;
}

/** The sealed parent a re-seal carries from, and what it proved. */
export interface ResealParent {
  /** Which kind of document the parent is: a gate receipt or a run record. */
  kind: 'receipt' | 'run-record';
  /** Canonical digest of the parent document (the receipt/record's own hash). */
  digest: string;
  /** The parent receipt, or null for a run-record parent. */
  receipt: GateReceipt | null;
  /** The parent run record, or null for a receipt parent. */
  record: RunRecord | null;
  /** The parent document's sealed candidate tree. */
  treeId: string;
  /** The commit the parent run/receipt sealed. */
  sha: string;
  /** The parent's own execution result (its attested outcomes). */
  execution: ExecutionResult;
}

/** The repository coordinates BOTH parent verifiers are held to. */
export interface ResealParentCoordinates {
  /** Process context (cwd, env). */
  io: Io;
  /** Loaded configuration (the receipt stage binding). */
  config: GateforgeConfig;
  /** Absolute run-state directory holding the parent documents. */
  stateDir: string;
  /** The consumer's own trusted key ring. */
  verifierKeyring: VerifierKeyring | null;
  /** Verified merge-base commit the parent must have sealed. */
  baseSha: string;
  /** Trusted policy/config revision digest of this run. */
  trustedPolicyDigest: string;
  /** Owner-approved policy revision digest of this run. */
  approvedPolicyDigest: string;
  /** Execution-boundary digest of this run. */
  executionBoundaryDigest: string;
  /** Authority object store (the parent tree is diffed inside it). */
  gitDir: string | null;
  /** Owner-approved exclusions that are never inside a candidate tree. */
  docsExclusions: readonly string[];
  /** Owner-approved cache exclusions. */
  cacheExclusions: readonly string[];
}

/**
 * Authenticates the run record a FAILED whole-suite run left behind as
 * the re-seal parent. A failing run seals no receipt (and clears the
 * old one), so without this the exact case a test-only re-seal exists
 * for could never re-seal.
 *
 * Every binding a receipt parent is held to is demanded here too — the
 * MAC under the active key, the same merge-base commit, the same
 * approved policy, engine bundle, execution boundary and target
 * artifact, the same candidate-tree coverage — and the execution result
 * must be the one the record names, with its own recomputed outcome
 * digest. A run record is a parent, never proof: it is accepted only as
 * the document a re-seal recomputes from.
 *
 * Args:
 *   input: the same coordinates a receipt parent is verified against.
 *
 * Returns:
 *   ParentVerification: the verified run-record parent, or the first
 *   binding that failed in plain words.
 */
function verifyRunRecordParent(input: ResealParentCoordinates): ParentVerification<ResealParent> {
  try {
    if (input.verifierKeyring === null) return refuse('no verifier key is available to authenticate it');
    const document = readStateDocument(input.stateDir, 'run-record.json');
    if (document === null) return refuse('the previous run left no run record');
    const verified = verifyRunRecord(input.verifierKeyring.active.key, document);
    if (!verified.ok) return refuse('its signature does not verify with this keyring');
    const record = verified.record;
    const treeId = record.candidateTreeId;
    if (
      input.gitDir === null ||
      treeId === null ||
      !candidateTreeCoversCommit(
        input.gitDir,
        input.io.env,
        treeId,
        `${input.baseSha}^{tree}`,
        input.docsExclusions,
        input.cacheExclusions,
      )
    ) {
      return refuse(
        `its sealed tree is not the tree of commit ${shortSha(input.baseSha)} (uncommitted changes were tested)`,
      );
    }
    if (record.gitSha !== input.baseSha) {
      return refuse(
        `it was sealed at commit ${shortSha(record.gitSha)}, the merge base is ${shortSha(input.baseSha)}`,
      );
    }
    if (record.verifierKeyId !== input.verifierKeyring.active.keyId) {
      return refuse('it was signed with a different verifier key');
    }
    if (record.trustedPolicyDigest !== input.trustedPolicyDigest) return refuse('the trusted policy changed');
    if (record.approvedPolicyDigest !== input.approvedPolicyDigest) return refuse('the approved policy changed');
    if (record.engineBundleDigest !== engineBundleDigestOf(VERSION, input.trustedPolicyDigest)) {
      return refuse('the engine changed');
    }
    if (record.executionBoundaryDigest !== input.executionBoundaryDigest) {
      return refuse('the execution boundary changed');
    }
    const execution = ExecutionResultSchema.safeParse(readStateDocument(input.stateDir, 'execution-result.json'));
    if (!execution.success) return refuse('its execution result was replaced by a later run');
    const result = execution.data as ExecutionResult;
    // The record is only a parent for the run it actually describes:
    // the execution result must be the one it names, carry the whole
    // suite it planned, and grade to the outcome digest it bound.
    if (
      executionResultDigestOf(result) !== record.executionResultDigest ||
      result.catalogDigest !== record.catalogDigest ||
      result.planned.length !== record.plannedTests ||
      result.outcomes.filter((outcome) => outcome.status === 'passed').length !== record.passedTests ||
      testOutcomesDigestOf(result.outcomes) !== record.testOutcomesDigest
    ) {
      return refuse('its execution result was replaced by a later run');
    }
    return {
      parent: {
        kind: 'run-record',
        digest: sha256Canonical(record as unknown as Record<string, never>),
        receipt: null,
        record,
        treeId,
        sha: record.gitSha,
        execution: result,
      },
      reason: null,
    };
  } catch {
    return refuse('it could not be read');
  }
}

/**
 * Resolves the sealed parent a re-seal may carry from, preferring the
 * stronger document: a verified gate receipt when the last run was
 * clean, else the run record a failed run left behind. Both are
 * authenticated the same way, and neither is ever accepted anywhere
 * else as proof.
 *
 * Args:
 *   input: the repository coordinates both verifiers are held to.
 *
 * Returns:
 *   ParentVerification: the verified parent, or — when neither document
 *   qualifies — the first failed binding of the document the run state
 *   actually holds, so the refusal is never silent.
 */
function resolveResealParent(input: ResealParentCoordinates): ParentVerification<ResealParent> {
  const receiptParent = verifyCarryForwardParent(input);
  if (receiptParent.parent !== null) {
    return {
      parent: {
        kind: 'receipt',
        digest: receiptParent.parent.receiptDigest,
        receipt: receiptParent.parent.receipt,
        record: null,
        treeId: receiptParent.parent.treeId,
        sha: receiptParent.parent.receipt.gitSha ?? '',
        execution: receiptParent.parent.execution,
      },
      reason: null,
    };
  }
  const recordParent = verifyRunRecordParent(input);
  if (recordParent.parent !== null) return recordParent;
  // Neither qualifies. A run record IS the previous run when one is
  // there; a receipt only speaks for it when no record was left.
  return hasStateDocument(input.stateDir, 'run-record.json') ? recordParent : receiptParent;
}

/** The sealed parent a re-seal carries from, plus what it proved. */
export interface ResealPlan {
  /** How Gateforge itself classified the sealed change set. */
  classification: ResealChangeClassification;
  /** Which kind of document the parent is (a receipt or a run record). */
  parentKind: 'receipt' | 'run-record';
  /** Digest of the verified parent document this run re-seals from. */
  parentDigest: string;
  /** The parent document's sealed candidate tree. */
  parentTreeId: string;
  /** The commit the parent run/receipt sealed. */
  parentSha: string;
  /** Test files whose tests this run re-runs. */
  affectedFiles: string[];
  /** How many parent outcomes this run carries unchanged. */
  carriedTests: number;
}

/**
 * Decides the test-only re-seal: may this `--scope changed` run re-run
 * exactly the tests the sealed change set can affect and re-seal from
 * the verified parent?
 *
 * The parent is EITHER a verified gate receipt (the run was clean) or a
 * verified run record (the run failed a test and therefore sealed no
 * receipt — the consumer's 563/562 case). A run record is a weaker
 * proof in exactly one way that matters: it may hold a failure. So the
 * rule that makes it usable is that every test which did NOT pass in
 * it must be INSIDE the affected set — the change must have touched it
 * — and must pass in this re-run. Anything else is a full run.
 *
 * Every other rule is checked by Gateforge itself, never by the
 * candidate: the change set is diffed from the two sealed trees, the
 * paths are classified from the runner's own catalog, the parent's
 * outcomes must be clean for every test outside the affected set, and a
 * vanished test must be explained by a changed file. Any doubt returns
 * one plain reason line, and the caller then runs exactly as it did
 * before.
 *
 * Args:
 *   input: the sealed parent, the frozen tree, the catalog, the current
 *     obligations, and the repository coordinates.
 *
 * Returns:
 *   the re-seal plan, or the single reason it is refused (both null
 *   when no parent exists at all, which keeps a run without a parent
 *   byte-identical to before).
 */
export function decideTestOnlyReseal(input: {
  io: Io;
  gitDir: string;
  parent: ResealParent | null;
  currentTreeId: string;
  catalog: TestCatalog;
  obligations: readonly Obligation[];
  enabled: boolean;
}): { plan: ResealPlan | null; reason: string | null } {
  const parent = input.parent;
  if (parent === null) return { plan: null, reason: null };
  if (!input.enabled) {
    return {
      plan: null,
      reason: 'the re-seal path is off (`enforcement.reseal` is not true) → full run',
    };
  }
  if (parent.kind === 'receipt' && parent.receipt !== null) {
    if (receiptScope(parent.receipt) !== 'full') {
      return { plan: null, reason: 'the previous receipt sealed a slice, not a whole-suite run → full run' };
    }
    if (parent.receipt.verdictSummary.total !== input.obligations.length) {
      return {
        plan: null,
        reason:
          `the previous receipt graded ${String(parent.receipt.verdictSummary.total)} obligation(s) ` +
          `while this candidate declares ${String(input.obligations.length)} → full run`,
      };
    }
  } else if (parent.execution.planned.length === 0) {
    // A run record is only a whole-suite parent when the run it
    // describes actually planned the suite. Obligations cannot have
    // drifted under it either: the record binds the trusted policy and
    // the owner-approved policy digest this run is pinned to.
    return { plan: null, reason: "the previous run's record planned no test, so it proves no whole-suite run → full run" };
  }
  const classification = classifyResealChange({
    gitDir: input.gitDir,
    env: input.io.env,
    cwd: input.io.cwd,
    parentTreeId: parent.treeId,
    currentTreeId: input.currentTreeId,
    testFiles: [...new Set(input.catalog.entries.map((entry) => entry.file))],
  });
  if (!classification.eligible) {
    return { plan: null, reason: classification.reason };
  }
  const affectedFiles = new Set(classification.affectedTestFiles);
  const catalogKeys = new Set(input.catalog.entries.map((entry) => entry.logicalKey));
  const affectedKeys = new Set(
    input.catalog.entries.filter((entry) => affectedFiles.has(entry.file)).map((entry) => entry.logicalKey),
  );
  const changedFiles = new Set(classification.changedPaths);
  const previousRun = parent.kind === 'run-record';
  for (const planned of parent.execution.planned) {
    if (catalogKeys.has(planned.logicalKey) || changedFiles.has(planned.file)) continue;
    return {
      plan: null,
      reason:
        `the previous ${previousRun ? 'run' : 'receipt'}'s test ${planned.logicalKey} no longer exists and ` +
        'no changed file explains it → full run',
    };
  }
  const statusByKey = new Map(parent.execution.outcomes.map((outcome) => [outcome.logicalKey, outcome.status]));
  for (const planned of parent.execution.planned) {
    if (affectedKeys.has(planned.logicalKey) || !catalogKeys.has(planned.logicalKey)) continue;
    if (statusByKey.get(planned.logicalKey) !== 'passed') {
      return {
        plan: null,
        // A receipt only ever exists for a clean run, so a receipt
        // parent can only fail this rule on a doctored outcome; a run
        // record fails it the ordinary way, one test that did not pass.
        reason: previousRun
          ? `the previous run's test ${planned.logicalKey} failed outside the affected set → full run`
          : `the previous receipt's test ${planned.logicalKey} did not pass outside the affected set → full run`,
      };
    }
  }
  return {
    plan: {
      classification,
      parentKind: parent.kind,
      parentDigest: parent.digest,
      parentTreeId: parent.treeId,
      parentSha: parent.sha,
      affectedFiles: classification.affectedTestFiles,
      carriedTests: parent.execution.planned.filter(
        (planned) => catalogKeys.has(planned.logicalKey) && !affectedKeys.has(planned.logicalKey),
      ).length,
    },
    reason: null,
  };
}
/** Runs configured harness setup and teardown around one supervised suite.
 *
 * Args:
 *   io: process context.
 *   options: parsed supervised-run flags.
 *
 * Returns:
 *   Promise<number>: the suite result, or 1 when harness setup/teardown fails.
 */
export async function runSupervisedTestGates(io: Io, options: SupervisedOptions): Promise<number> {
  const config = loadConfigAt(io.cwd);
  const startedAtMs = Date.now();
  const historyStateDir = resolveStateDir(io.cwd, options.out);
  pruneRunHistory(join(historyStateDir, 'history'), config.history?.retentionDays);
  const diagnosticsDir = join(historyStateDir, 'diagnostics');
  mkdirSync(diagnosticsDir, { recursive: true });
  writeFileSync(join(diagnosticsDir, 'adapter-timing.jsonl'), '', 'utf8');
  writeFileSync(join(diagnosticsDir, 'test-timing.jsonl'), '', 'utf8');
  const setupFailure = await runHarnessSetup(config.harness, io.cwd, io.env);
  if (setupFailure !== null) {
    writeLine(
      io.stderr,
      `HARNESS_FAILED ${setupFailure.step}: command exited ${String(setupFailure.exitCode)}\n${setupFailure.output}`,
    );
    const teardownFailure = await runHarnessTeardown(config.harness, io.cwd, io.env);
    if (teardownFailure !== null) {
      writeLine(io.stderr, `HARNESS_FAILED down: command exited ${String(teardownFailure.exitCode)}\n${teardownFailure.output}`);
    }
    recordRunHistory(
      historyStateDir,
      config.history?.retentionDays,
      {
        runId: randomUUID(),
        finishedAt: new Date().toISOString(),
        status: 'failed',
        testCount: 0,
        failedCount: 0,
      },
      [],
    );
    return 1;
  }
  let runCode = 1;
  let teardownFailure: HarnessFailure | null = null;
  try {
    runCode = await runSupervisedTestGatesInner(io, options);
    if (config.diagnostics?.hostLoad === true) {
      const loadPath = join(diagnosticsDir, 'host-load.json');
      const timingPath = join(diagnosticsDir, 'test-timing.jsonl');
      if (existsSync(loadPath) && existsSync(timingPath)) {
        try {
          const load = JSON.parse(readFileSync(loadPath, 'utf8')) as { samples: HostLoadSample[] };
          const tests = readFileSync(timingPath, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line) as HostLoadTestTiming];
              } catch {
                return [];
              }
            });
          for (const notice of hostLoadFailureNotices(load.samples, tests)) {
            writeLine(io.stderr, notice);
          }
        } catch (error) {
          writeLine(io.stderr, `warning: host-load failure annotations could not be read: ${(error as Error).message}`);
        }
      }
    }
  } finally {
    if (runCode !== 0) {
      try {
        const artifact = await captureServiceLogs(
          config.harness?.serviceLogs,
          historyStateDir,
          io.cwd,
          io.env,
        );
        if (artifact !== null) writeLine(io.stderr, `service logs saved: ${artifact}`);
      } catch (error) {
        writeLine(io.stderr, `warning: service logs could not be captured: ${(error as Error).message}`);
      }
    }
    teardownFailure = await runHarnessTeardown(config.harness, io.cwd, io.env);
    if (teardownFailure !== null) {
      writeLine(io.stderr, `HARNESS_FAILED down: command exited ${String(teardownFailure.exitCode)}\n${teardownFailure.output}`);
    }
  }
  const effectiveRunCode = teardownFailure !== null && runCode === 0 ? 1 : runCode;
  let executionHistory: ExecutionResult | null = null;
  const executionPath = join(historyStateDir, 'execution-result.json');
  if (existsSync(executionPath)) {
    try {
      const parsed = ExecutionResultSchema.safeParse(JSON.parse(readFileSync(executionPath, 'utf8')));
      if (parsed.success && Date.parse(parsed.data.startedAt) >= startedAtMs) executionHistory = parsed.data;
    } catch (error) {
      writeLine(io.stderr, `warning: run history could not read execution outcomes: ${(error as Error).message}`);
    }
  }
  const latestOutcomes = new Map<string, ExecutionResult['outcomes'][number]>();
  for (const outcome of executionHistory?.outcomes ?? []) {
    const previous = latestOutcomes.get(outcome.logicalKey);
    if (previous === undefined || outcome.attempt >= previous.attempt) latestOutcomes.set(outcome.logicalKey, outcome);
  }
  const historyTests = [...latestOutcomes.values()].map((outcome) => ({
    logicalKey: outcome.logicalKey,
    status: outcome.status,
  }));
  const failedCount = historyTests.filter((test) => test.status === 'failed').length;
  recordRunHistory(
    historyStateDir,
    config.history?.retentionDays,
    {
      runId: executionHistory?.runId ?? randomUUID(),
      finishedAt: new Date().toISOString(),
      status: effectiveRunCode === 0 ? 'passed' : 'failed',
      testCount: executionHistory?.planned.length ?? 0,
      failedCount,
    },
    historyTests,
  );
  return effectiveRunCode;
}

/**
 * The supervised `--changed` path (plan Phase 4, ADR 0005 D2/D3):
 * resolve catalog + mappings → fix the expected set → prepare the
 * observer → REGISTER the expected set with the witness from an
 * independent `playwright --list` child (scrubbed env, finite timeout) →
 * execute through the adapter under the supervisor spool drain → enforce
 * planned vs executed + the witness-side session trace → seal the
 * execution result → run diagnostics (separate, advisory) → evaluate.
 * Normal gate mode issues a receipt only on complete success and may
 * reuse an identical prior receipt; `--result-only` only reports the
 * selected scope and never reads, creates, replaces, or clears receipts.
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
/**
 * Projects every EXPIRED owner quarantine into a blocking finding that
 * names the test and its expiry (plan 20260925_2013 Phase 2). An expired
 * quarantine is not silently ignored: it is a stale escape hatch, and
 * the required test is back in the run.
 *
 * Args:
 *   expired: the expired partition of the loaded quarantine population.
 *
 * Returns:
 *   BlockingEntry[]: one typed `QUARANTINE_EXPIRED` finding per expiry,
 *   sorted by test key (the loader's order).
 */
export function expiredQuarantineBlocking(
  expired: readonly LoadedQuarantine[],
): BlockingEntry[] {
  return expired.map((entry) => ({
    kind: 'finding' as const,
    resourceId: null,
    name: entry.quarantine.testKey,
    detail:
      `quarantine of '${entry.quarantine.testKey}' expired at ${entry.quarantine.expiresAt} ` +
      `(file ${QUARANTINE_DIR}/${entry.file}) — it is ignored and the test is required again; ` +
      'renew it with an owner approval or delete it',
    location: null,
    cause: 'QUARANTINE_EXPIRED' as const,
    nextAction: CAUSE_NEXT_ACTIONS.QUARANTINE_EXPIRED,
  }));
}

/**
 * The `<file>#<title path>` instance identities of every quarantined
 * catalog row — the form both the runner-outcomes document and the
 * witness session trace report.
 *
 * Args:
 *   catalog: the current test catalog (null when discovery failed).
 *   quarantinedKeys: logical keys the owner quarantined.
 *
 * Returns:
 *   Set<string>: instance identities of quarantined tests.
 */
function quarantinedInstanceKeys(
  catalog: TestCatalog | null,
  quarantinedKeys: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  if (catalog === null || quarantinedKeys.size === 0) return keys;
  for (const entry of catalog.entries) {
    if (!quarantinedKeys.has(entry.logicalKey)) continue;
    keys.add(`${entry.file}#${entry.titlePath.join('>')}`);
  }
  return keys;
}

/**
 * The framework test ids (`parameterIdentity`) of every quarantined
 * catalog row: the identity claims and evidence records carry, so the
 * evaluator can discard that test's proof before any verifier sees it.
 *
 * Args:
 *   catalog: the current test catalog.
 *   quarantinedKeys: logical keys the owner quarantined.
 *
 * Returns:
 *   Set<string>: framework ids belonging to quarantined tests (empty
 *   ids are skipped — a row without a framework id claims nothing).
 */
function quarantinedFrameworkIds(
  catalog: TestCatalog,
  quarantinedKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  if (quarantinedKeys.size === 0) return ids;
  for (const entry of catalog.entries) {
    const identity = entry.parameterIdentity;
    if (identity === null || identity.length === 0) continue;
    if (quarantinedKeys.has(entry.logicalKey)) ids.add(identity);
  }
  return ids;
}

/**
 * Builds one planned row from a contract-enumerated test identity
 * (plan 2026-09-25, runner-agnostic evidence): the adapter's logical
 * key (`<file>#<title path>`), null project, and the runner's own
 * framework id. Supervision joins planned, executed, and traced rows
 * on (project, file, title path) — the same identity join the
 * Playwright plan uses.
 *
 * Args:
 *   test: the enumerated test identity.
 *
 * Returns:
 *   PlannedRow: the planned instance plus its supervision input.
 */
function plannedRowOfIdentity(test: RunnerTestIdentity): PlannedRow {
  return {
    planned: {
      logicalKey: test.logicalKey,
      project: test.project,
      file: test.file,
      titlePath: [...test.titlePath],
      frameworkId: test.frameworkId ?? null,
    },
    input: {
      logicalKey: test.logicalKey,
      project: test.project,
      file: test.file,
      titlePath: [...test.titlePath],
      blockingAnnotations: [...test.blockingAnnotations],
    },
  };
}

/**
 * Constructs the contract adapter for the configured runner (plan
 * 2026-09-25, runner-agnostic evidence). Enumeration needs no trusted
 * wiring; execution receives it through the constructor options so the
 * runner child never reads more than the non-secret run identity.
 *
 * Args:
 *   runner: the configured runner name (`config.runner`).
 *   wiring: run-scoped, non-secret witness wiring for `execute`.
 *
 * Returns:
 *   RunnerAdapter: the adapter serving that runner.
 * @throws UsageError on a runner name with no adapter (the config
 *   schema rejects unknown values first — this is a defensive seam).
 */
function runnerAdapterFor(
  runner: string,
  wiring: { witnessUrl?: string; runToken?: string; appBaseUrl?: string } = {},
): RunnerAdapterHolder {
  const witness = {
    ...(wiring.witnessUrl !== undefined && wiring.witnessUrl !== '' ? { url: wiring.witnessUrl } : {}),
    ...(wiring.runToken !== undefined && wiring.runToken !== '' ? { token: wiring.runToken } : {}),
  };
  // The app origin the session proxy fronts crosses INSIDE the wiring
  // object every adapter reads (`witness.appBaseUrl`), except pytest,
  // whose option is declared at the top level. Passing it beside the
  // witness object (a spread) type-checks and is then SILENTLY DROPPED
  // by the vitest and cypress adapters, which left their runner child
  // with an empty GATEFORGE_APP_BASE_URL and every supertest/Cypress
  // request refused as in-process.
  const appBaseUrl =
    wiring.appBaseUrl !== undefined && wiring.appBaseUrl !== '' ? { appBaseUrl: wiring.appBaseUrl } : {};
  const sessionWiring = { ...witness, ...appBaseUrl };
  switch (runner) {
    case 'pytest':
      return new PytestRunnerAdapter({ witness, ...appBaseUrl });
    case 'vitest':
      return new VitestRunnerAdapter({ witness: sessionWiring });
    case 'cypress':
      return new CypressRunnerAdapter({ witness: sessionWiring });
    default:
      throw new UsageError(`test-gates: no runner adapter for '${runner}' (expected playwright | pytest | vitest | cypress)`);
  }
}

/** Any contract adapter the supervised run can enumerate and execute. */
type RunnerAdapterHolder = PytestRunnerAdapter | VitestRunnerAdapter | CypressRunnerAdapter;

/**
 * Writes the WITNESS-ISSUED ledger into the run's `records.json` for the
 * non-Playwright runners.
 *
 * The Playwright pack's engine reporter performs this copy itself
 * (GF-23: the evaluator only ever reads the witness ledger, never a
 * suite-authored file). The pytest/vitest/cypress adapters have no such
 * in-suite reporter, so without this copy the evaluator sees an empty
 * ledger and grades EVERY obligation `missing` even when the witness
 * stamped a record. The trusted CLI performs the identical fetch while
 * the witness is still alive; a transport failure writes nothing (the
 * run stays fail-closed through the verdicts) and names itself on
 * stderr.
 *
 * Args:
 *   io: the CLI IO (stderr carries the diagnostic).
 *   stateDir: the run state directory.
 *   witnessUrl: the running witness base URL.
 *   runToken: the run token authenticating the ledger read.
 *
 * Returns:
 *   Promise<void>: resolves once the document is written (or the fetch
 *     failed and said so).
 */
async function writeWitnessLedgerDocument(
  io: Io,
  stateDir: string,
  witnessUrl: string,
  runToken: string,
): Promise<void> {
  try {
    const response = await fetch(`${witnessUrl}/records`, {
      headers: { [RUN_HEADER]: runToken },
    });
    if (!response.ok) {
      writeLine(
        io.stderr,
        `test-gates: the witness ledger could not be read (HTTP ${String(response.status)}) — evidence stays uncredited`,
      );
      return;
    }
    const body = (await response.json()) as { records?: unknown };
    const records = Array.isArray(body.records) ? body.records : [];
    writeFileSync(join(stateDir, 'records.json'), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  } catch (error) {
    writeLine(
      io.stderr,
      `test-gates: the witness ledger could not be read (${(error as Error).message}) — evidence stays uncredited`,
    );
  }
}

async function runSupervisedTestGatesInner(io: Io, options: SupervisedOptions): Promise<number> {
  const { out, format, witnessUrl, runTimeoutMs } = options;
  const runtimeReuseDigest = options.runtimeReuseDigest;
  const runtimeReuseMounts = options.runtimeReuseMounts ?? [];
  const config = loadConfigAt(io.cwd);
  // The configured runner (plan 2026-09-25, runner-agnostic evidence):
  // `playwright` (the default) keeps the byte-identical supervised path;
  // pytest/vitest/cypress enumerate, execute, and report through the
  // RunnerAdapter contract behind the SAME witness session, run token,
  // supervision, receipts, and strictness machinery.
  const runnerName = config.runner;
  if (runnerName === 'pytest') {
    const configured = (config.diagnostics?.suites ?? []).filter((suite) => suite.runner === 'pytest');
    if (configured.length > 1) {
      throw new UsageError(
        `test-gates: runner 'pytest' executes exactly one configured pytest suite, but ${String(configured.length)} are ` +
          `configured (${configured.map((suite) => suite.name).join(', ')}) — keep a single suite under runner 'pytest' ` +
          '(a second suite would run under the wrong argv; narrower selection is never guessed)',
      );
    }
  }
  // Owner-chosen strictness (plan 20260925_2013 Phase 1). Absent key =
  // `strict` = today's exact behavior; the decision below only ever
  // maps an ALREADY-COMPUTED strict result onto the owner's exit code,
  // never changes what was executed or graded.
  const gateMode = resolveStrictnessMode(config);
  const docsExclusions = loadDocsExclusions(io.cwd, config);
  const cacheExclusions = loadCacheExclusions(io.cwd, config);
  const stateDir = resolveStateDir(io.cwd, out);
  const verifierKeyring = options.verifierKeyring ?? resolveVerifierKeyring(io.cwd, io.env, [stateDir]);
  const witnessVerifierKey = verifierKeyring?.active.key;
  const executionBoundary = io.env['GATEFORGE_AUTHORITY_BOUNDARY']?.trim() || LOCAL_UNISOLATED_BOUNDARY;
  const executionBoundaryDigest = executionBoundaryDigestOf(executionBoundary);
  // Scoped sealing (Goal 2): resolve the changed-file basis through the
  // SAME configured provider `check --changed` uses (auto → GHA/GitLab/
  // staged), and stamp the resolved identity into the run manifest so a
  const providerIdentity =
    options.fixedChangedFiles !== undefined
      ? 'local-staged'
      : resolveProvider(config.changed.provider, io.cwd, io.env).provider;

  // 1. Inventory + stability + input digest (same discipline as check).
  let preFiles: SnapshotFileEntry[] | null = null;
  let snapshotUnavailable = false;
  try {
    preFiles = collectInputFiles(io.cwd, config, stateDir, runtimeReuseMounts, docsExclusions, cacheExclusions);
  } catch (error) {
    if (error instanceof SnapshotUnavailableError) snapshotUnavailable = true;
    else if (error instanceof UnsupportedSnapshotError) throw new UsageError(`unsupported input snapshot: ${error.message}`);
    else throw error;
  }
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: providerIdentity,
    stateDir,
    ...(options.fixedChangedFiles !== undefined
      ? { changedFilesOverride: options.fixedChangedFiles }
      : {}),
  });
  // Owner quarantine (plan 20260925_2013 Phase 2): loaded against the
  // INJECTED run clock, never the wall clock. ACTIVE quarantines remove
  // their test from the REQUIRED set and its evidence is discarded;
  // EXPIRED ones are ignored and each BLOCKS, naming the test.
  const quarantines = loadQuarantines(join(io.cwd, ...QUARANTINE_DIR.split('/')), { now: pipeline.now });
  const quarantinedKeys = new Set<string>(quarantines.active.map((entry) => entry.quarantine.testKey));
  const providerChangedFiles = options.fixedChangedFiles ?? pipeline.changedFiles;
  // The scoped slice's changed set: exactly what the resolved provider
  // reported for THIS tree (the pipeline already ran it — one resolution,
  // one diff basis stamped in the manifest).
  const scopeChangedFiles =
    options.scope === 'changed'
      ? options.fixedChangedFiles ?? pipeline.changedFiles
      : null;
  const httpRoutes = httpRoutesView(pipeline.graph);
  let expectedDigest: string | null = null;
  let inputSnapshot: InputSnapshot | null = null;
  if (!snapshotUnavailable) {
    const postDiscovery = collectInputFiles(io.cwd, config, stateDir, runtimeReuseMounts, docsExclusions, cacheExclusions);
    const drift = preFiles === null ? [] : diffInputFiles(preFiles, postDiscovery);
    if (drift.length > 0) {
      throw new UsageError(
        `input tree changed around discovery (${drift.slice(0, 3).join('; ')}${drift.length > 3 ? '; …' : ''}); ` +
          'no reliable digest can be established — refusing the run',
      );
    }
    inputSnapshot = computeInputSnapshot({
      cwd: io.cwd,
      config,
      stateDir,
      classifications: pipeline.classificationsView.resources,
      obligations: pipeline.policy.obligations,
      httpRoutes,
      plugins: pipeline.manifest.plugins.map((plugin) => ({ id: plugin.id, version: plugin.version })),
      runtimeReuseDigest,
      runtimeReuseMounts,
      docsExclusions,
      cacheExclusions,
    });
    expectedDigest = inputSnapshot.evidenceInputDigest;
  }
  if (options.runtimeReuseCheck !== undefined) {
    let currentReuseDigest: string | null;
    try {
      currentReuseDigest = options.runtimeReuseCheck();
    } catch {
      currentReuseDigest = null;
    }
    if (currentReuseDigest !== runtimeReuseDigest) {
      if (!options.resultOnly) clearGateReceipt(stateDir);
      writeLine(io.stderr, 'test-gates: reused dependency bytes changed during discovery; refusing the run');
      return 1;
    }
  }
  const invocationId = randomUUID();

  // Phase 3 freeze (immutable candidate): the tree and parent the run
  // EVALUATED are pinned before any suite execution. At seal time the
  // same values are recomputed — a live-workspace edit mid-run is an
  // explicit drift block, never a mixed-bytes seal.
  const freezeGitDir = resolveGitDir(io.cwd, io.env);
  const frozenTreeId =
    options.fixedCandidateTreeId ??
    (freezeGitDir === null
      ? null
      : computeCandidateTreeId(
          freezeGitDir,
          io.cwd,
          io.env,
          stateDir,
          'record',
          runtimeReuseMounts,
          docsExclusions,
          cacheExclusions,
        ));
  const frozenParentSha = options.fixedParentSha !== undefined ? options.fixedParentSha : parentSha(io.cwd);

  // 2. Catalog + mappings (Phase 3 resolver) → expected set + claim
  // injections + typed mapping blockers. A failed discovery blocks the
  // gate (E16) — never an empty-success fallback.
  let discoveryError: string | null = null;
  let catalog: TestCatalog | null = null;
  let nativeClaims: Claim[] = [];
  let nativeErrors: string[] = [];
  let nativeInstances: NativeInstance[] = [];
  try {
    // collectPytest is REQUIRED here (GAP 1 fix, server-witnessed
    // channel): the supervised run's expected set, mapping resolution,
    // and seal are all judged against this catalog, so a server-e2e
    // mapping whose test lives in a configured pytest suite must resolve
    // against the suite's collected rows (otherwise the declaration reads
    // TEST_MAPPING_STALE and blocks a test that exists). Collection
    // failure is honest data: the suite's runner summary turns
    // `unavailable`, `inventoryComplete` goes false, and the gate blocks
    // TEST_INVENTORY_INCOMPLETE — never a silently narrower inventory.
    const discovered = await discoverTestCatalog({ cwd: io.cwd, config, collectPytest: true });
    catalog = discovered.catalog;
    nativeClaims = discovered.nativeClaims;
    nativeErrors = discovered.nativeErrors;
    nativeInstances = discovered.nativeInstances;
    for (const warning of discovered.registrationWarnings) {
      writeLine(
        io.stderr,
        `test-gates: registration warning ${warning.file}:${String(warning.location.line)}: ` +
          `${warning.titlePath.join(' > ')} is conditional on ${warning.environmentVariable}; ` +
          'keep test registration independent of Gateforge run variables',
      );
    }
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
    config.enforcement?.strictE2E === true || docsExclusions.length > 0 || cacheExclusions.length > 0,
  );
  if (policyGate.status === 'blocked') {
    if (!options.resultOnly) clearGateReceipt(stateDir);
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
  // Scope planning (Goal 2): typed blockers for affected obligations no
  // testable claim covers, and the covered-fingerprint set the sealed
  // `changed`-scope receipt binds. Empty in `full` mode.
  let scopeBlockers: BlockingEntry[] = [];
  let coveredFingerprints: string[] = [];
  // Coverage facts for the closed-world policy (E27 wiring: check feeds
  // these; test-gates omitted them, so every required table/operation
  // blocked as uncovered even when mapped — phantom findings over an
  // honest gate).
  let mappedCoverage: ReturnType<typeof mappedCoverageFrom> = [];
  let claimInventory: Claim[] = [];
  // Server-e2e obligations (server-witnessed persistence channel): the
  // trusted mapping resolution decides which obligations may stamp
  // `channel: 'server'` evidence — the drain registers exactly this set
  // with the witness before any test runs.
  let serverE2eObligations: string[] = [];
  // Observe obligations (Observe channel, Phase 2): the trusted mapping
  // resolution decides which obligations may stamp `channel: 'observe'`
  // evidence — the drain registers exactly this set pre-run and
  // finalizes passed sessions against it.
  let observeObligations: string[] = [];
  let fullPlannedCount = 0;
  let affectedTestCount = 0;
  // The claimed files' slice (changed scope) a non-Playwright runner
  // plans from — empty in full scope and for `playwright`.
  let affectedRequiredFiles: readonly string[] = [];
  // The verified parent a re-seal carries from — a gate receipt or a
  // run record — with the exact documents a consumer needs to
  // recompute the re-seal (the parent document, its execution result,
  // and this run's catalog). Retained next to the new receipt as
  // MAC-bound run state.
  let reSealParent: ResealParent | null = null;
  let reSealPlan: ResealPlan | null = null;
  // Framework ids whose claims and records must never grade (owner
  // quarantine); empty when nothing is quarantined.
  let excludedTestIds: readonly string[] = [];
  // Hoisted: a named run grades the obligations its selection declares,
  // which the mapping resolution below is the only trusted source for.
  let gradedResolution: ResolvedMappings | null = null;
  if (catalog !== null) {
    const mapped = await resolveRepositoryMappings({
      cwd: io.cwd,
      config,
      obligations: pipeline.policy.obligations,
      catalog,
      nativeClaims,
      behaviorCatalog: pipeline.behaviorCatalog,
      nativeErrors,
      nativeInstances,
    });
    mappingBlockers = mappingBlocking(mapped.resolution.problems);
    // Quarantined tests prove nothing: their declarations and their
    // coverage bindings leave the mapping surface BEFORE planning, so an
    // obligation only they covered becomes uncovered and stays `missing`.
    gradedResolution = withoutQuarantinedBindings(mapped.resolution, quarantinedKeys);
    excludedTestIds = [...quarantinedFrameworkIds(catalog, quarantinedKeys)].sort();
    claimInventory = mapped.claimInventory.filter(
      (claim) => !excludedTestIds.includes(claim.testId),
    );
    const fullPlannedRows = planExpectedSet(catalog).filter(
      (row) => !quarantinedKeys.has(row.planned.logicalKey),
    );
    fullPlannedCount = fullPlannedRows.length;
    plannedRows = fullPlannedRows;
    injections = claimInjectionsFor(gradedResolution, catalog);
    mappedCoverage = mappedCoverageFrom(gradedResolution, pipeline.policy.obligations, pipeline.graph);
    serverE2eObligations = serverE2eObligationIds(mapped.resolution);
    observeObligations = observeObligationIds(mapped.resolution);
    // Adopted baseline debt (E62): the changed-scope planner must agree
    // with this run's own grading, which waives exactly the obligations
    // the ADOPTED baseline forgives (`applyBaseline`). Strict E2E
    // re-grades every waiver back to blocking, so there the planner
    // forgives nothing and an unmapped affected obligation still blocks.
    const scopeBaseline =
      config.enforcement?.strictE2E === true ? null : resolveAdoptedBaseline(io.cwd, config.baselines);
    const affectedPlan = planScopedExpectedSet({
      catalog,
      resolution: gradedResolution,
      obligations: pipeline.policy.obligations,
      graph: pipeline.graph,
      changedFiles: providerChangedFiles,
      behaviorCatalog: pipeline.behaviorCatalog,
      ...(scopeBaseline !== null ? { forgivenFingerprints: scopeBaseline.fingerprints } : {}),
    });
    affectedTestCount = affectedPlan.plannedRows.length;
    affectedRequiredFiles = affectedPlan.requiredFiles;
    if (options.scope === 'changed') {
      // Test-only re-seal (plan phase 2). A verified parent and a
      // frozen tree are the only inputs; everything else — the change
      // set, the classification, the carried outcomes — Gateforge
      // recomputes itself. A refused re-seal prints ONE plain reason
      // line and the run continues through the unchanged path below.
      const reSealBaseSha = resolveCarryForwardBaseSha(io, providerIdentity);
      // The first binding this run itself cannot offer a parent for, in
      // the same plain words a rejected parent document gets. null means
      // every precondition holds and the parent must be looked up.
      const reSealPrecondition: string | null =
        options.testSelectors !== undefined || options.resultOnly
          ? 'a named/result-only run never re-seals'
          : freezeGitDir === null || frozenTreeId === null
            ? 'this run froze no candidate tree'
            : expectedDigest === null
              ? 'this run pinned no input digest'
              : approvedPolicyDigest === null
                ? 'this run pinned no owner-approved policy'
                : reSealBaseSha === null
                  ? 'no merge-base commit is known (set CI_MERGE_REQUEST_DIFF_BASE_SHA or GITHUB_BASE_REF)'
                  : catalog.inventoryComplete
                    ? null
                    : 'the test inventory is incomplete';
      const reSealParentLookup: ParentVerification<ResealParent> =
        reSealPrecondition === null
          ? resolveResealParent({
              io,
              config,
              stateDir,
              verifierKeyring,
              baseSha: reSealBaseSha as string,
              gitDir: freezeGitDir as string,
              docsExclusions,
              cacheExclusions,
              trustedPolicyDigest: trustedPolicy,
              approvedPolicyDigest: approvedPolicyDigest as string,
              executionBoundaryDigest,
            })
          : { parent: null, reason: reSealPrecondition };
      const reSealParentCandidate = reSealParentLookup.parent;
      // A chain of consecutive re-seals is bounded: past the bound the
      // carried evidence has drifted too far to recompute honestly, so
      // this run takes the full path instead (one plain reason line).
      const reSeal =
        reSealParentCandidate !== null &&
        resealChainHopCount(stateDir) >= RESEAL_CHAIN_MAX_HOPS
          ? {
              plan: null,
              reason:
                `the run state already retains ${String(RESEAL_CHAIN_MAX_HOPS)} consecutive re-seals, the ` +
                'bound this path may chain to → full run',
            }
          : decideTestOnlyReseal({
              io,
              gitDir: freezeGitDir as string,
              parent: reSealParentCandidate,
              currentTreeId: frozenTreeId as string,
              catalog,
              obligations: pipeline.policy.obligations,
              enabled: config.enforcement?.reseal === true,
            });
      if (reSeal.reason !== null) writeLine(io.stderr, `test-gates: ${reSeal.reason}`);
      // A parent document the run state holds but cannot be re-sealed
      // from is a refusal the consumer must SEE: the run continues on
      // the ordinary changed-scope path, which looks identical to a run
      // that never had a parent. With the path off, or with no parent
      // document at all, nothing is printed and the run is byte-identical
      // to before.
      else if (
        config.enforcement?.reseal === true &&
        reSealParentLookup.reason !== null &&
        (hasStateDocument(stateDir, 'receipt.json') || hasStateDocument(stateDir, 'run-record.json'))
      ) {
        writeLine(
          io.stderr,
          `test-gates: the previous run cannot be re-sealed from: ${reSealParentLookup.reason} → changed-scope run`,
        );
      }
      reSealPlan = reSeal.plan;
      if (reSeal.plan !== null) reSealParent = reSealParentCandidate;
      if (reSeal.plan !== null) {
        const affected = new Set(reSeal.plan.affectedFiles);
        plannedRows = fullPlannedRows.filter(
          (row) => affected.has(row.planned.file) && !quarantinedKeys.has(row.planned.logicalKey),
        );
        // The sealed parent proved every obligation in the repository;
        // this run re-proves the ones its re-run tests declare. The
        // covered set is that union, so a consumer's own diff-scoped
        // check still decides what the receipt covers.
        coveredFingerprints = [
          ...new Set(pipeline.policy.obligations.map((obligation) => obligationFingerprint(obligation))),
        ].sort();
        affectedRequiredFiles = reSeal.plan.affectedFiles;
        // A test-only change cannot open an obligation through app
        // sources, so the changed-scope "no testable slice" blockers
        // (the mapping gap this path exists to route around) do not
        // apply: the parent receipt already covered them.
        scopeBlockers = [];
      } else {
        plannedRows = affectedPlan.plannedRows.filter(
          (row) => !quarantinedKeys.has(row.planned.logicalKey),
        );
        coveredFingerprints = affectedPlan.coveredFingerprints;
        scopeBlockers = affectedPlan.unclaimed.map((entry): BlockingEntry => ({
          kind: 'finding',
          resourceId: null,
          name: entry.obligationId,
          detail: entry.detail,
          location: null,
          cause: 'EVIDENCE_SCOPE_INCOMPLETE',
          nextAction: CAUSE_NEXT_ACTIONS.EVIDENCE_SCOPE_INCOMPLETE,
        }));
        if (affectedPlan.adopted.length > 0) {
          writeLine(
            io.stderr,
            `test-gates: ${String(affectedPlan.adopted.length)} affected obligation(s) have no declared ` +
              'mapping and are forgiven by the adopted baseline; they stay uncovered by this slice',
          );
        }
      }
    }
  }
  // Runner-agnostic expected set (plan 2026-09-25): a NON-Playwright
  // runner enumerates through the RunnerAdapter contract — the expected
  // set is fixed BEFORE the run from the runner's own collection, and
  // the plan is the enumeration (whole set in full scope, the claimed
  // files' slice in changed scope). `playwright` never runs this: its
  // planning above is byte-identical to before. An unavailable
  // enumeration plans nothing and blocks the inventory below — never a
  // guessed half-set, never a silent whole-suite widening.
  let runnerEnumeration: RunnerEnumeration | null = null;
  if (runnerName !== 'playwright' && catalog !== null && discoveryError === null) {
    runnerEnumeration = await runnerAdapterFor(runnerName).enumerate(io.cwd);
    if (runnerEnumeration.status === 'discovered') {
      const enumeratedRows = runnerEnumeration.tests.map(plannedRowOfIdentity);
      fullPlannedCount = enumeratedRows.length;
      plannedRows =
        options.scope === 'changed'
          ? enumeratedRows.filter((row) => affectedRequiredFiles.includes(row.planned.file))
          : enumeratedRows;
    }
  }
  // Named selection (`--test`): the plan is built from the FULL planned
  // rows above and only then narrowed to the named logical keys, so the
  // expected set is still fixed before the run. An unresolvable selector
  // throws a UsageError (exit 2) before any witness or runner spawns.
  const namedSelections =
    options.testSelectors === undefined
      ? null
      : resolveTestSelectors(
          options.testSelectors,
          plannedRows.map((row) => ({ logicalKey: row.planned.logicalKey })),
        );
  // The selected logical keys, hoisted for the grading step below: a
  // named run grades exactly the claims of the tests it ran.
  const namedTestIds: string[] | null =
    namedSelections === null
      ? null
      : [...new Set(namedSelections.flatMap((entry) => [...entry.logicalKeys]))].sort();
  // What the SELECTION declares, through EITHER surface: the trusted
  // mapping resolution's bindings (the sidecar) or the current claim
  // declarations of the selected tests (native Playwright annotations
  // and sidecar-derived claims). Both are the same current inventory
  // the verdict engine grades against; the union is the graded set of a
  // named run. A test that declares nothing contributes nothing.
  // A test-only re-seal grades exactly what its re-run tests declare:
  // every other obligation keeps the parent receipt's attested outcome,
  // which is digest-bound through `resealedFrom`.
  const gradedTestIds: string[] | null =
    namedTestIds ?? (reSealPlan === null ? null : plannedRows.map((row) => row.planned.logicalKey));
  const namedObligationIds: string[] | null = (() => {
    if (gradedTestIds === null) return null;
    const selected = new Set(gradedTestIds);
    // A claim names the declaring test the way its runner does: a
    // sidecar row carries the logical key, a native Playwright
    // annotation the framework id. The selected entries' own framework
    // identities are the second half of that join.
    const selectedFrameworks = new Set<string>();
    for (const entry of catalog?.entries ?? []) {
      if (!selected.has(entry.logicalKey)) continue;
      if (entry.parameterIdentity !== null && entry.parameterIdentity.length > 0) {
        selectedFrameworks.add(entry.parameterIdentity);
      }
    }
    const declared = new Set<string>();
    for (const group of gradedResolution?.obligations ?? []) {
      if (group.bindings.some((binding) => selected.has(binding.logicalKey))) {
        declared.add(group.obligationId);
      }
    }
    for (const claim of claimInventory) {
      if (selected.has(claim.testId) || selectedFrameworks.has(claim.testId)) {
        declared.add(claim.obligationId);
      }
    }
    return [...declared].sort();
  })();
  if (namedSelections !== null) {
    const named = new Set(namedTestIds ?? []);
    plannedRows = plannedRows.filter((row) => named.has(row.planned.logicalKey));
    // A test this run did not execute can never have produced
    // evidence, so a claim row alone proves nothing: the graded SET is
    // `namedObligationIds` below, and the declaration inventory stays
    // whole. (A per-test filter here would silently drop a
    // declaration whose source location a sibling declaration in the
    // same file already occupies — the inventory is deduplicated per
    // source location, not per test.)
  }

  // Per-test narrowing (additive): a named run hands the runner the exact
  // `file:line` of every selected test the catalog located, so a runner
  // that can filter below file granularity executes exactly those tests
  // and never their file neighbours. A row the catalog never located
  // contributes nothing (the run then stays at file granularity). Empty
  // outside a named run, which keeps every other run byte-identical.
  const namedTestLocations: string[] =
    namedSelections === null
      ? []
      : plannedRows
          .map((row) => {
            const entry = catalog?.entries.find(
              (candidate) => candidate.logicalKey === row.planned.logicalKey,
            );
            return entry === undefined ? null : `${entry.file}:${String(entry.sourceLocation.line)}`;
          })
          .filter((location): location is string => location !== null)
          .sort();
  if (format === 'text') {
    writeLine(
      io.stdout,
      namedSelections !== null
        ? `scope: named (${plannedRows.length} tests) — ${humanMessage({ detail: 'a hand-picked test list never seals a receipt; a run of the whole suite does', type: 'partial-selection', nextAction: 'gateforge test-gates' })}`
        : options.scope === 'changed'
          ? `scope: changed (${plannedRows.length} tests) — ${providerChangedFiles.length} changed files (provider: ${providerIdentity})`
          : `scope: full (${fullPlannedCount} mapped tests) — add --scope changed for the ${affectedTestCount} tests affected by ${providerChangedFiles.length} changed files (provider: ${providerIdentity})`,
    );
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
      : nativeErrors.length > 0
        ? nativeInventoryBlocking(nativeInventoryProblem(nativeErrors))
        : runnerEnumeration !== null && runnerEnumeration.status !== 'discovered'
          ? [
              {
                kind: 'finding',
                resourceId: null,
                name: null,
                detail: `the configured runner '${runnerName}' could not enumerate its expected set: ${runnerEnumeration.detail} — nothing executed proves nothing`,
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
    runner: runnerName,
    // The selection mode names the slice honestly: a scoped run seals
    // `mapped-selection` and a hand-picked run reports `named-selection`,
    // so neither can ever be mistaken for a whole-suite seal. The digest
    // covers the mode, so full, scoped, and named runs never collide.
    mode: namedSelections !== null
      ? ('named-selection' as const)
      : options.scope === 'changed'
        ? ('mapped-selection' as const)
        : ('full-relevant-suite' as const),
    logicalKeys: plannedRows.map((row) => row.planned.logicalKey),
  };
  const selectionDigest = selectionDigestOf(selection);
  const catalogDigest = catalog === null ? NO_CATALOG_DIGEST : sha256Canonical(catalog as unknown as Record<string, never>);

  // 3. Cache reuse: identical evidence inputs, exact candidate tree, and
  // complete result only. No changed path is presumed inert.
  // The scope axis is part of the identity: a full run demands a
  // full-scope (or legacy unscoped) receipt, a scoped run demands a
  // changed-scope receipt sealing the IDENTICAL covered set — a slice
  // never reuses as a whole-suite seal or vice versa.
  const reuseCandidate = options.resultOnly
    ? { reuse: false as const }
    : tryReuseReceipt(stateDir, verifierKeyring, {
        inputDigest: expectedDigest ?? NO_DIGEST,
        trustedPolicyDigest: trustedPolicy,
        selectionDigest,
        executionBoundaryDigest,
        ...behaviorReceiptBindings(pipeline.behaviorCatalog),
        scope: options.scope === 'changed' ? 'changed' : 'full',
        ...(options.scope === 'changed' ? { coveredObligationFingerprints: coveredFingerprints } : {}),
      });
  const reuse =
    reuseCandidate.reuse && frozenTreeId !== null && reuseCandidate.receipt.candidateTreeId === frozenTreeId
      ? reuseCandidate
      : { reuse: false as const };
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
    // Witnessed suites are part of the SEALED supervised run: a reused
    // receipt means nothing re-executed (the identical-input contract
    // already pins the pytest bytes), so they are never re-run here —
    // said loudly, never silently skipped.
    if ((config.diagnostics?.suites ?? []).some((suite) => suite.witnessed === true)) {
      writeLine(
        io.stderr,
        'witnessed pytest suite(s) sealed in the reused run — identical authenticated inputs, not re-executed',
      );
    }
    await runDiagnosticsStep(io, config, io.cwd, stateDir, expectedDigest, pipeline.now);
    const evaluated = evaluateRun({
      cwd: io.cwd,
      config,
      graph: pipeline.graph,
      behaviorCatalog: pipeline.behaviorCatalog,
      obligations: pipeline.policy.obligations,
      blocking: [...pipeline.policy.blocking, ...mappingBlockers, ...inventoryBlocking, ...scopeBlockers],
      stateDir,
      now: pipeline.now,
      engineAlembicRecords: pipeline.engineAlembicRecords,
      // Scoped reuse re-grades exactly the sealed slice (the reuse
      // contract above already pinned scope + covered set); full reuse
      // stays unscoped. A scoped run without the flag never happens.
      changedFiles: scopeChangedFiles,
      claimInventory,
      witnessVerifierKey,
      witnessVerifierKeys: verifierKeyring?.keys.map((entry) => entry.key),
      // Goal 1: the reused gate grades through the SAME adopted-baseline
      // seam as check — baselined obligations waive (loudly) instead of
      // blocking the reused evaluation.
      baseline: resolveAdoptedBaseline(io.cwd, config.baselines),
      mappedCoverage,
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
      engine: engineIdentity(),
      lifecycleDerivation: pipeline.lifecycleDerivation,
      diagnosticContext: {
        scope: namedTestIds !== null ? ('named' as const) : (options.scope ?? 'full'),
        candidateTreeId: frozenTreeId,
        inputDigest: expectedDigest,
        evidenceState: 'receipt-reused',
        authority: 'authoritative',
        ...(docsExclusions.length === 0
          ? {}
          : {
              docsExclusions: {
                folders: docsExclusions,
                approvalDigest: approvedPolicyDigest ?? trustedPolicy,
                approvalStatus: 'matched' as const,
                guarantee: DOCS_EXCLUSIONS_GUARANTEE,
              },
            }),
            ...(cacheExclusions.length === 0
              ? {}
              : {
                  cacheExclusions: {
                    files: cacheExclusions,
                    approvalDigest: approvedPolicyDigest ?? trustedPolicy,
                    approvalStatus: 'matched' as const,
                    guarantee: CACHE_EXCLUSIONS_GUARANTEE,
                  },
                }),
      },
    });
    writeLine(io.stdout, report);
    const gateCode = runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
    writeLine(io.stderr, `reused receipt ${reuse.receipt.receiptId} (identical authenticated inputs; complete result)`);
    return gateCode;
  }

  // 3.5 Scoped empty-slice fast-fail (Goal 2): when the changed set maps
  // to no testable slice there is nothing to run and nothing to seal —
  // and launching the runner with an empty planned set would execute the
  // WHOLE suite (the trusted config's file filter is omitted for empty
  // selections). Fail closed here, before any witness/runner spawn: no
  // slice receipt over nothing is ever minted, and the previous receipt
  // is invalidated (E07 discipline).
  if (options.scope === 'changed' && plannedRows.length === 0) {
    const baseSha = resolveCarryForwardBaseSha(io, providerIdentity);
    const carryParent =
      !options.resultOnly &&
      expectedDigest !== null &&
      frozenTreeId !== null &&
      approvedPolicyDigest !== null &&
      baseSha !== null
        ? verifiedCarryForwardParent({
            io,
            config,
            stateDir,
            verifierKeyring,
            baseSha,
            gitDir: freezeGitDir,
            docsExclusions,
            cacheExclusions,
            trustedPolicyDigest: trustedPolicy,
            approvedPolicyDigest,
            executionBoundaryDigest,
          })
        : null;
    const playwrightConfig = findRunnerConfigPath(io.cwd, runnerName);
    const scopeDecision =
      catalog === null
        ? null
        : computeEvaluationScope({
            config,
            changedFiles: providerChangedFiles,
            testFiles: catalog.entries.map((entry) => entry.file),
            runnerConfigs: playwrightConfig === null ? [] : [playwrightConfig],
            mappingSidecar: existsSync(join(io.cwd, ...TEST_MAP_RELATIVE.split('/'))),
            knownSourceFiles: pipeline.graph.resources.map((resource) => resource.source),
            strictE2E: false,
          });
    const behaviorBindings = behaviorReceiptBindings(pipeline.behaviorCatalog);
    const scannedEveryChangedFile =
      providerChangedFiles.length > 0 &&
      config.plugins.length > 0 &&
      pipeline.contributions.length === config.plugins.length &&
      providerChangedFiles.every((path) =>
        pipeline.contributions.every((contribution) => contribution.scannedPaths?.includes(path) === true),
      );
    // A sealed candidate tree carries gitignored and untracked bytes,
    // so a verified parent proves the outcomes for ITS bytes. The
    // plain carry-forward evaluates only the provider's changed files,
    // so it may reuse the parent's outcomes exclusively when the two
    // sealed trees differ in nothing else — a gitignored dependency or
    // an untracked file would be a proof nobody produced. (The re-seal
    // path needs no such test: it classifies the whole difference.)
    const carryDiffWithinScope =
      carryParent !== null &&
      frozenTreeId !== null &&
      freezeGitDir !== null &&
      scopeDecision !== null &&
      carryDiffIsWithinScope({
        gitDir: freezeGitDir,
        env: io.env,
        parentTreeId: carryParent.treeId,
        currentTreeId: frozenTreeId,
        evaluatedPaths: scopeDecision.changedFiles,
      });
    // A planned re-seal is never a carry-forward: it re-runs the
    // affected tests and seals its own receipt. `affectedTestCount`
    // is the CHANGED-SCOPE plan's count, which a test-only change
    // leaves at zero — exactly the case this path would swallow.
    const carryIsSafe =
      reSealPlan === null &&
      carryParent !== null &&
      expectedDigest !== null &&
      frozenTreeId !== null &&
      pipeline.manifest.gitSha !== null &&
      catalog?.inventoryComplete === true &&
      discoveryError === null &&
      scopeDecision?.mode === 'changed' &&
      scopeDecision.expandedBecause.length === 0 &&
      scopeDecision.unmappedFiles.length === 0 &&
      carryDiffWithinScope &&
      coveredFingerprints.length === 0 &&
      affectedTestCount === 0 &&
      scopeBlockers.length === 0 &&
      mappingBlockers.length === 0 &&
      inventoryBlocking.length === 0 &&
      pipeline.policy.blocking.length === 0 &&
      (config.diagnostics?.suites.length ?? 0) === 0 &&
      pipeline.policy.obligations.length === carryParent.receipt.verdictSummary.total &&
      carryParent.receipt.behaviorCatalogDigest === behaviorBindings.behaviorCatalogDigest &&
      carryParent.receipt.requiredCaseSetDigest === behaviorBindings.requiredCaseSetDigest &&
      scannedEveryChangedFile;
    const activeVerifierKeyring = verifierKeyring;
    if (
      carryIsSafe &&
      activeVerifierKeyring !== null &&
      baseSha !== null &&
      pipeline.manifest.gitSha !== null &&
      freezeGitDir !== null &&
      carryParent !== null &&
      expectedDigest !== null &&
      frozenTreeId !== null
    ) {
      const candidateSnapshot = computeCandidateTreeSnapshot(
        freezeGitDir,
        io.cwd,
        io.env,
        stateDir,
        'record',
        runtimeReuseMounts,
        docsExclusions,
        cacheExclusions,
      );
      if (candidateSnapshot.treeId === frozenTreeId) {
        const carried = issueGateReceipt({
          verifierKey: activeVerifierKeyring.active.key,
          verifierKeyId: activeVerifierKeyring.active.keyId,
          runId: carryParent.receipt.runId,
          invocationId: carryParent.receipt.invocationId,
          inputDigest: expectedDigest,
          gitSha: pipeline.manifest.gitSha,
          parentSha: baseSha,
          trustedPolicyDigest: trustedPolicy,
          approvedPolicyDigest,
          receiptStage: config.enforcement?.receiptStage,
          engine: engineIdentity(),
          carriedFrom: baseSha,
          parentReceiptDigest: carryParent.receiptDigest,
          invocation: carryParent.receipt.invocation,
          selectionDigest: carryParent.receipt.selectionDigest,
          catalogDigest: carryParent.receipt.catalogDigest,
          executionResultDigest: carryParent.receipt.executionResultDigest,
          evidenceAttestationDigest: carryParent.receipt.evidenceAttestationDigest,
          candidateTreeId: frozenTreeId,
          behaviorCatalogDigest: behaviorBindings.behaviorCatalogDigest,
          requiredCaseSetDigest: behaviorBindings.requiredCaseSetDigest,
          caseExecutionDigest: carryParent.receipt.caseExecutionDigest,
          engineBundleDigest: engineBundleDigestOf(VERSION, trustedPolicy),
          executionBoundaryDigest,
          targetArtifactDigest: targetArtifactDigestOf(frozenTreeId),
          verdictSummary: carryParent.receipt.verdictSummary,
          issuedAt: pipeline.now,
        });
        const carryReport = canonicalJson({
          schemaVersion: 1,
          carriedForward: true,
          carriedFrom: baseSha,
          parentReceiptDigest: carryParent.receiptDigest,
          receiptId: carried.receiptId,
          candidateTreeId: frozenTreeId,
          inputDigest: expectedDigest,
          scope: 'changed',
          changedFiles: [...providerChangedFiles],
          testsPerformedThisInvocation: 0,
          summary: carryParent.receipt.verdictSummary,
          evidenceState: 'receipt-carried-forward',
          engine: { ...engineIdentity() },
        });
        writeGateReceipt(stateDir, carried);
        writeCandidateTreeEntries(stateDir, candidateSnapshot.entries);
        writeReport(stateDir, carryReport);
        writeLine(
          io.stdout,
          format === 'json'
            ? carryReport
            : `receipt ${carried.receiptId} carried forward from ${baseSha}; 0 tests run; full parent receipt and complete changed-file scan verified`,
        );
        writeLine(io.stderr, `receipt ${carried.receiptId} carried forward; 0 tests performed this invocation`);
        return 0;
      }
    }
    if (!options.resultOnly) clearGateReceipt(stateDir);
    const emptySliceBlocking: BlockingEntry[] =
      inventoryBlocking.length > 0
        ? // A failed/incomplete discovery already explains the block.
          []
        : [
            {
              kind: 'finding',
              resourceId: null,
              name: null,
              detail:
                scopeBlockers.length > 0
                  ? `no runnable slice: ${String(scopeBlockers.length)} affected obligation(s) have no declared mapping; changed files: ` +
                    `${providerChangedFiles.length > 0 ? providerChangedFiles.join(', ') : '<none>'}. ` +
                    'Run `gateforge test-gates --changed` for the full relevant suite.'
                  : `0 obligations affected by: ${providerChangedFiles.length > 0 ? providerChangedFiles.join(', ') : '<no changed files>'}; ` +
                    'run full scope, or approve documentation folders with `gateforge init --docs-exclude <folders>`',
              location: null,
              cause: 'EVIDENCE_SCOPE_INCOMPLETE',
              nextAction: CAUSE_NEXT_ACTIONS.EVIDENCE_SCOPE_INCOMPLETE,
            },
          ];
    const evaluated = evaluateRun({
      cwd: io.cwd,
      config,
      graph: pipeline.graph,
      behaviorCatalog: pipeline.behaviorCatalog,
      obligations: pipeline.policy.obligations,
      blocking: [
        ...pipeline.policy.blocking,
        ...mappingBlockers,
        ...inventoryBlocking,
        ...scopeBlockers,
        ...emptySliceBlocking,
      ],
      stateDir,
      now: pipeline.now,
      engineAlembicRecords: pipeline.engineAlembicRecords,
      changedFiles: scopeChangedFiles,
      claimInventory,
      witnessVerifierKey,
      witnessVerifierKeys: verifierKeyring?.keys.map((entry) => entry.key),
      baseline: resolveAdoptedBaseline(io.cwd, config.baselines),
      mappedCoverage,
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
      engine: engineIdentity(),
      lifecycleDerivation: pipeline.lifecycleDerivation,
      diagnosticContext: {
        scope: namedTestIds !== null ? ('named' as const) : (options.scope ?? 'full'),
        candidateTreeId: frozenTreeId,
        inputDigest: expectedDigest,
        evidenceState: snapshotUnavailable ? 'snapshot-unavailable' : 'not-executed',
        authority: options.resultOnly ? 'non-authoritative' : 'authoritative',
        ...(cacheExclusions.length === 0
          ? {}
          : {
              cacheExclusions: {
                files: cacheExclusions,
                approvalDigest: approvedPolicyDigest ?? trustedPolicy,
                approvalStatus: 'matched' as const,
                guarantee: CACHE_EXCLUSIONS_GUARANTEE,
              },
            }),
      },
    });
    writeLine(io.stdout, report);
    writeLine(
      io.stderr,
      'test-gates: --scope changed produced no runnable slice — nothing was executed and no receipt was sealed',
    );
    return 1;
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
  if (inputSnapshot !== null) writeInputSnapshot(stateDir, inputSnapshot);
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
        // Adapter-configuration passthrough (non-secret): server-witnessed
        // probes may target a disposable database container when the wired
        // suite runs against one. Never carries gate authority.
        ...(io.env['GATEFORGE_PROBE_DB_CONTAINER'] !== undefined && io.env['GATEFORGE_PROBE_DB_CONTAINER'] !== ''
          ? { GATEFORGE_PROBE_DB_CONTAINER: io.env['GATEFORGE_PROBE_DB_CONTAINER'] }
          : {}),
        // Session-proxy tag channel: the pytest, vitest and cypress
        // adapters publish a per-test session proxy origin, so the
        // witness must front the app with an observation proxy or every
        // proxied request is unattributable. The Playwright path is
        // untouched (its sessions are engine-browser scoped), so an
        // existing repository's witness wiring stays byte-identical.
        ...(runnerName === 'pytest' || runnerName === 'vitest' || runnerName === 'cypress'
          ? appBase !== ''
            ? { [ENV_PROXY_TARGET]: appBase }
            : {}
          : {}),
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
  const envRecord = writeEnv(stateDir, manifest, effectiveWitnessUrl ?? null, runToken, io.env);
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
      `test-gates --changed requires ${VERIFIER_KEY_ENV} or ${VERIFIER_KEY_FILE_ENV} in the orchestrating environment: ` +
        'the witness supervisor surface (expected set, session lifecycle, execution trace) is ' +
        'verifier-key authenticated and the key never reaches the suite or the runner child',
    );
  }
  const supervisor = new SupervisorClient(effectiveWitnessUrl, runToken, witnessVerifierKey);

  // 4.6 Expected-set registration BEFORE the run (review fix 2a): the
  // expected tests come from an INDEPENDENT enumeration — Playwright
  // through a separate `playwright --list` child with a scrubbed
  // (GATEFORGE-free) env and a finite timeout; pytest/vitest/cypress
  // through the contract adapter's enumerate() — never from
  // suite-writable state. The witness binds the set to this run; from
  // now on /sessions/open accepts only tests in it, and the execution
  // trace groups sessions by these identities.
  const plannedIdentities = new Set(
    plannedRows.map(
      (row) => `${row.planned.project ?? ''}\u0000${row.planned.file}\u0000${row.planned.titlePath.join('>')}`,
    ),
  );
  const registered = await (async (): Promise<ExpectedSetResponse> => {
    if (runnerName !== 'playwright') {
      // The contract enumeration (fixed above, before the policy gate
      // boundaries) IS the independent expected set. The runner's own
      // spool identity is registered so the trace names what the child
      // will report.
      const tests = (runnerEnumeration?.tests ?? [])
        .filter((test) =>
          options.scope === 'changed' || selection.mode === 'named-selection'
            ? plannedIdentities.has(`${test.project ?? ''}\u0000${test.file}\u0000${test.titlePath.join('>')}`)
            : true,
        )
        .map((test: RunnerTestIdentity) => ({
          testId: test.frameworkId ?? test.logicalKey,
          project: test.project,
          file: test.file,
          titlePath: [...test.titlePath],
        }));
      return supervisor.registerExpectedSet({ tests });
    }
    const enumeration = await listNativePlaywrightTests({ cwd: io.cwd });
    // A named run registers the NAMED tests, for the same reason it
    // executes them: the witness binds and the trace groups exactly the
    // tests the report will speak about.
    // Scoped registration (Goal 2): in a `changed`-scope run the expected
    // set IS the planned slice — the witness binds and the trace groups
    // exactly the tests the seal will vouch for. Full mode registers the
    // whole enumeration, byte-identical to before. (A planned instance the
    // enumeration never lists stays out of the set and can never open a
    // session — the same completeness machinery blocks it downstream.)
    const registeredInstances =
      options.scope === 'changed' || selection.mode === 'named-selection'
        ? enumeration.instances.filter((instance) =>
            plannedIdentities.has(
              `${instance.project ?? ''}\u0000${instance.file}\u0000${instance.titlePath.join('>')}`,
            ),
          )
        : enumeration.instances;
    return supervisor.registerExpectedSet({
      tests: registeredInstances.map((instance) => ({
        testId: instance.frameworkId,
        project: instance.project.length > 0 ? instance.project : null,
        file: instance.file,
        titlePath: instance.titlePath,
      })),
    });
  })();
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
  // `@gate-forge/pack-playwright` trusted-config.ts): the consumer config
  // file is never loaded; the engine reporter is forced with parent-side
  // paths as constructor options. The child env therefore carries ONLY
  // the witness URL + run token + app base — never run-state paths
  // (execution-authority fix; `buildRunnerChildEnv` refuses them).
  // Non-Playwright runners skip this entire Playwright-specific block:
  // their trusted wiring crosses to the child through the adapter
  // constructor (runnerAdapterFor below), and their registration comes
  // from the contract enumeration (4.6), so there is no Playwright
  // --list to re-diff.
  const adapter = runnerName === 'playwright'
    ? new PlaywrightAdapter({
        config,
        run: {
          testFiles: plannedRows.map((row) => row.planned.file),
          // A named run executes exactly the named tests, not their
          // whole spec files.
          ...(namedTestLocations.length > 0 ? { testLocations: namedTestLocations } : {}),
          ...(io.env['GATEFORGE_APP_BASE_URL'] ? { appBaseUrl: io.env['GATEFORGE_APP_BASE_URL'] } : {}),
          ...(io.env['GATEFORGE_SESSION_STATE'] ? { storageState: io.env['GATEFORGE_SESSION_STATE'] } : {}),
          projects: [
            ...new Set(
              plannedRows.map((row) => row.planned.project).filter((project): project is string => project !== null),
            ),
          ],
          // Operator-provided whole-run bound for multi-hour suites (default
          // 30 minutes stands when absent — same expected set and
          // completeness rules either way).
          ...(runTimeoutMs !== undefined ? { timeoutMs: runTimeoutMs } : {}),
        },
      })
    : null;
  const suiteEnv: Record<string, string> = {
    GATEFORGE_RUN_TOKEN: envRecord.GATEFORGE_RUN_TOKEN,
    GATEFORGE_CLI_VERSION: VERSION,
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

  if (adapter !== null) {
    // Registration must be identical under planning's scrubbed env and
    // the exact safe run variables before any Playwright test can execute.
    let wiredNative: NativeListResult;
    try {
      wiredNative = await listNativePlaywrightTests({ cwd: io.cwd, wiredEnv: suiteEnv });
    } catch (error) {
      if (spawnedWitness !== null) await stopWitnessProcess(spawnedWitness);
      throw error;
    }
    const registrationDiff = diffNativePlaywrightTests(nativeInstances, wiredNative.instances);
    if (registrationDiff.scrubbedOnly.length > 0 || registrationDiff.wiredOnly.length > 0) {
      if (spawnedWitness !== null) await stopWitnessProcess(spawnedWitness);
      const details = [
        ...registrationDiff.scrubbedOnly.map(
          (instance) => `only with scrubbed env: ${instance.file} [${instance.project}] ${instance.titlePath.join(' > ')}`,
        ),
        ...registrationDiff.wiredOnly.map(
          (instance) => `only with wired env: ${instance.file} [${instance.project}] ${instance.titlePath.join(' > ')}`,
        ),
      ];
      throw new UsageError(
        'test-gates: Playwright registration differs between scrubbed and wired --list; no tests were executed\n' +
          details.join('\n'),
      );
    }
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
  // begins, lone ends) that fail the run closed downstream. The drain
  // also serves the SERVER-WITNESSED persistence channel: it registers
  // the server-e2e obligations with the witness and forwards the suite's
  // persistence intents (an untrusted spool) so the witness — never the
  // suite — probes the adapter and stamps the evidence.
  const drain = startSupervisorSpoolDrain({
    stateDir,
    runId: manifest.runId,
    witnessUrl: effectiveWitnessUrl,
    runToken,
    verifierKey: witnessVerifierKey,
    serverE2eObligations,
    observeObligations,
  });
  let envelope: RunnerExecutionEnvelope;
  // The witness-side execution trace (review fix 2b) — THE execution
  // authority supervision grades completeness from. Fetched while the
  // witness is still up; `null` (unfetchable) blocks the run downstream.
  let sessionTrace: readonly TracedTestInput[] | null = null;
  let lifecycleConflicts: string[] = [];
  let intentFailures: string[] = [];
  // Witnessed pytest participants (server-witnessed persistence channel):
  // typed blocking details for any witnessed suite that did not complete
  // cleanly — collected inside the supervised window below.
  let witnessedBlocking: BlockingEntry[] = [];
  const executionStartedAt = performance.now();
  let executionDurationMs: number | null = null;
  const hostLoadCollector: HostLoadCollector | null =
    config.diagnostics?.hostLoad === true
      ? startHostLoadSampler(stateDir, (message) => writeLine(io.stderr, `warning: ${message}`))
      : null;
  try {
    // 6.5 WITNESSED pytest participants run INSIDE the supervised window
    // (server-witnessed persistence channel, GAP 2 fix): the drain is
    // live, so a pre intent is forwarded to the witness at its next poll
    // — before the suite's mutation — and every intent reaches the
    // verifier-key drain. The participant env is run-scoped by
    // construction (STATE_DIR/RUN_ID locate ONLY the intents spool;
    // WITNESS_URL/RUN_TOKEN are the already-non-secret run wiring; the
    // verifier key and every other parent-side name are refused by
    // `buildWitnessedPytestChildEnv`). The intents stay untrusted — the
    // witness probes the adapter itself — and a witnessed suite that runs
    // red or unfinished BLOCKS the gate: the mapped server-e2e test's red
    // is never graded green.
    // Playwright-only participant: with `runner: pytest` the configured
    // suite IS the supervised run the adapter executes below, so a
    // separate witnessed pass would execute it twice.
    if (runnerName === 'playwright' && (config.diagnostics?.suites ?? []).some((suite) => suite.witnessed === true)) {
      const witnessed = await runWitnessedPytestSuites({
        config,
        cwd: io.cwd,
        stateDir,
        childEnv: buildWitnessedPytestChildEnv({
          GATEFORGE_STATE_DIR: stateDir,
          GATEFORGE_RUN_ID: manifest.runId,
          GATEFORGE_WITNESS_URL: effectiveWitnessUrl,
          GATEFORGE_RUN_TOKEN: runToken,
        }),
      });
      for (const result of witnessed.results) {
        writeLine(
          io.stderr,
          `witnessed pytest ${result.suite}: ${result.status} (passed=${String(result.counts.passed)}` +
            ` failed=${String(result.counts.failed)} errors=${String(result.counts.errors)}` +
            ` skipped=${String(result.counts.skipped)} xfail=${String(result.counts.xfailed)}) — ` +
            'supervised participant: its persistence intents were drained to the witness',
        );
      }
      witnessedBlocking = witnessed.blocking.map((detail): BlockingEntry => ({
        kind: 'finding',
        resourceId: null,
        name: null,
        detail,
        location: null,
        cause: 'RUN_INCOMPLETE',
        nextAction: CAUSE_NEXT_ACTIONS['RUN_INCOMPLETE'],
      }));
    }
    if (adapter !== null) {
      envelope = await adapter.execute({ logicalKeys: selection.logicalKeys }, {
        stateDir,
        runId: manifest.runId,
        vars: suiteEnv,
      });
    } else if (runnerEnumeration?.status === 'discovered') {
      // The RunnerAdapter contract (plan 2026-09-25): the exact
      // selection, run identity, and wall-clock bound cross as data; the
      // adapter spawns the runner and reads its structured report. The
      // verdict still comes from supervision + the witness trace. The
      // selection MODE travels with it: a `named-selection` run narrows
      // to the named tests wherever the runner can, and a run without
      // `--test` executes exactly what it always did.
      const request: RunnerExecuteRequest = {
        logicalKeys: selection.logicalKeys,
        stateDir,
        runId: manifest.runId,
        timeoutMs: runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        cwd: io.cwd,
        mode: selection.mode,
        ...(selection.mode === 'named-selection' ? { testLocations: namedTestLocations } : {}),
      };
      envelope = await runnerAdapterFor(runnerName, {
        witnessUrl: effectiveWitnessUrl,
        runToken,
        appBaseUrl: io.env['GATEFORGE_APP_BASE_URL'] ?? '',
      }).execute(request);
    } else {
      // The runner could not enumerate its expected set: nothing is
      // selected, so launching would widen to the whole suite. Fail
      // closed here — the inventory blocking entry above names the cause.
      envelope = {
        processExit: null,
        complete: false,
        incompleteDetail:
          runnerEnumeration === null
            ? 'test inventory could not be enumerated — the configured runner never produced an expected set'
            : runnerEnumeration.detail,
        outcomes: [],
        fixtureOutcome: 'unknown' as const,
      };
    }
  } finally {
    // Final spool sweep + force-close of runner-left-open sessions,
    // BEFORE the witness stops (the close calls need it alive).
    const drained = await drain.stop();
    lifecycleConflicts = drained.conflicts;
    intentFailures = drained.intentFailures;
    // Observe finalize notes are diagnostics (missing traffic,
    // ambiguity, adapter trouble) — the obligations stay blocking
    // through verdicts, which is the honest outcome. Surfaced on
    // stderr so the operator sees exactly why an observed claim did
    // not resolve; never run-fatal here.
    for (const note of drained.observeNotes) {
      writeLine(io.stderr, `test-gates: ${note}`);
    }
    try {
      const trace = await supervisor.executionTrace();
      sessionTrace = trace === null ? null : trace.tests;
    } catch {
      sessionTrace = null; // fail closed: a missing authority never grades success
    }
    if (runnerName !== 'playwright' && effectiveWitnessUrl !== undefined) {
      await writeWitnessLedgerDocument(io, stateDir, effectiveWitnessUrl, runToken);
    }
    if (spawnedWitness !== null) {
      // Graceful stop (the same contract as the consumer teardown): the
      // witness appends its attested manifest envelope at shutdown, so
      // the durable evidence channel is sealed before evaluation.
      await stopWitnessProcess(spawnedWitness);
    }
    try {
      hostLoadCollector?.stop();
    } catch (error) {
      writeLine(io.stderr, `warning: host-load diagnostics could not be written: ${(error as Error).message}`);
    }
    executionDurationMs = Math.max(0, Math.round(performance.now() - executionStartedAt));
  }

  // Cypress cannot filter below the spec without a plugin the gate
  // refuses to trust, so a named Cypress run executes the whole spec and
  // grades ONLY the selected tests: their outcomes and sessions are
  // dropped (an unselected test never becomes evidence) and the operator
  // is told exactly how many ran ungraded. Every other runner executes
  // exactly the selection, so any extra outcome there stays unplanned and
  // fails the run closed.
  // Cypress identities of the tests that ran ungraded; the seal drops
  // them from the executed document too, so an honest ungraded run is
  // never reported as an unexpected extra execution.
  let namedUngradedKeys: ReadonlySet<string> | null = null;
  if (selection.mode === 'named-selection' && runnerName === 'cypress') {
    const selected = new Set(selection.logicalKeys);
    const ungraded = envelope.outcomes.filter((outcome) => !selected.has(outcome.logicalKey));
    if (ungraded.length > 0) {
      writeLine(
        io.stderr,
        `also ran ${String(ungraded.length)} other test(s) in the same file — not graded`,
      );
      envelope = {
        ...envelope,
        outcomes: envelope.outcomes.filter((outcome) => selected.has(outcome.logicalKey)),
        // The process status is the SPEC's, not the selection's: an
        // ungraded test that fails (its session was never opened,
        // because the selection registered only the named ones) would
        // otherwise fail the whole run closed for a test the run
        // explicitly said it does not grade. The selection's own
        // outcomes still decide completeness — a selected test that
        // never ran, or crashed, leaves the run incomplete.
        processExit: 0,
      };
      // The witness trace rows carry file + title path, which is exactly
      // how a `<file>#<title path>` logical key spells them.
      const ungradedKeys = new Set(ungraded.map((outcome) => outcome.logicalKey));
      namedUngradedKeys = ungradedKeys;
      sessionTrace =
        sessionTrace === null
          ? null
          : sessionTrace.filter(
              (traced) => !ungradedKeys.has(`${traced.file}#${traced.titlePath.join('>')}`),
            );
    }
  }
  if (options.runtimeReuseCheck !== undefined) {
    let currentReuseDigest: string | null;
    try {
      currentReuseDigest = options.runtimeReuseCheck();
    } catch {
      currentReuseDigest = null;
    }
    if (currentReuseDigest !== runtimeReuseDigest) {
      if (!options.resultOnly) clearGateReceipt(stateDir);
      writeLine(
        io.stderr,
        'test-gates: reused dependency bytes changed during the run; no receipt is sealed over mixed runtime inputs',
      );
      return 1;
    }
  }
  // Quarantined instances still RUN (the suite is executed whole) but
  // they are no longer REQUIRED, so their outcome and their session
  // trace are recorded as INFORMATION ONLY: leaving them in would make
  // supervision report them as unexpected extra executions.
  const quarantinedInstances = quarantinedInstanceKeys(catalog, quarantinedKeys);
  // Executed rows the seal must not treat as planned executions: the
  // quarantined instances, plus the tests a named Cypress run had to
  // execute but never grades. Both are information only.
  const unrequiredInstances = new Set<string>(quarantinedInstances);
  for (const key of namedUngradedKeys ?? []) unrequiredInstances.add(key);
  const rawOutcomesDoc = readRunnerOutcomes(join(stateDir, 'runner-outcomes.json'));
  const outcomesDoc =
    unrequiredInstances.size === 0 || rawOutcomesDoc === null
      ? rawOutcomesDoc
      : {
          ...rawOutcomesDoc,
          outcomes: rawOutcomesDoc.outcomes.filter(
            (row) => !unrequiredInstances.has(`${row.file}#${row.titlePath.join('>')}`),
          ),
        };
  if (sessionTrace !== null && unrequiredInstances.size > 0) {
    sessionTrace = sessionTrace.filter(
      (test) => !unrequiredInstances.has(`${test.file}#${test.titlePath.join('>')}`),
    );
  }
  const sealed = sealExecutionResult({
    runId: manifest.runId,
    invocationId,
    inputDigest: expectedDigest ?? NO_DIGEST,
    trustedPolicyDigest: trustedPolicy,
    // The REAL configured runner (additive values on the frozen schema:
    // `playwright` stays byte-identical; pytest/vitest/cypress name
    // themselves honestly in the execution result and every receipt
    // binding it).
    runner: runnerName,
    // A scoped or named run names its selection mode honestly (Goal 2):
    // the execution result — and the receipt digest that binds it —
    // record that a slice ran, never a whole relevant suite.
    ...(selection.mode === 'full-relevant-suite' ? {} : { mode: selection.mode }),
    logicalKeys: selection.logicalKeys,
    catalog: catalog ?? EMPTY_CATALOG,
    claimInventory: nativeClaims,
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
      const postSuite = collectInputFiles(io.cwd, config, stateDir, runtimeReuseMounts, docsExclusions, cacheExclusions);
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
  // Server-persistence intent failures (server-witnessed channel): an
  // intent the witness could not verify — missing probe, replay, auth —
  // never silently vanishes. Projected as run-blocking findings here, not
  // in the verdict engine: the claim simply stays unproven, and the
  // operator sees exactly why.
  const intentBlocking: BlockingEntry[] = intentFailures.map((detail) => ({
    kind: 'finding' as const,
    resourceId: null,
    name: null,
    detail,
    location: null,
    cause: 'RUN_INCOMPLETE' as const,
    nextAction: CAUSE_NEXT_ACTIONS['RUN_INCOMPLETE'],
  }));
  // An expired quarantine is ignored AND blocking: the owner let this
  // flake run long enough that nobody renewed it, so the required test
  // is back in the run and the stale escape hatch must be visible.
  const repositoryBlocking: BlockingEntry[] = [
    ...pipeline.policy.blocking,
    ...mappingBlockers,
    ...inventoryBlocking,
    ...expiredQuarantineBlocking(quarantines.expired),
  ];
  const evaluationInput: EvaluateInput = {
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    behaviorCatalog: pipeline.behaviorCatalog,
    behaviorAuthorityProfileDigest:
      pipeline.behaviorCatalog === null ? null : engineBundleDigestOf(VERSION, trustedPolicy),
    obligations: pipeline.policy.obligations,
    // Named grading: a hand-picked selection never
    // observed the rest of the repository, so repository-wide findings
    // (policy, mapping, inventory, expired quarantine) and the scoped
    // planning gaps stay in the report but block nothing here. What
    // still blocks is everything about THIS run: supervision, lifecycle,
    // intent and the witnessed channel, plus (inside the evaluator) any
    // entry naming a graded obligation and every evidence-context
    // finding. A named run never forgives a broken run.
    blocking: [
      ...(namedTestIds === null ? repositoryBlocking : []),
      // Scoped planning gaps (Goal 2): affected obligations no declared,
      // catalog-live claim covers. Fail closed — never diff-scoped away,
      // never waived, and they alone prevent the receipt.
      ...(namedTestIds === null ? scopeBlockers : []),
      ...supervisionBlocking(supervisionFindings),
      ...lifecycleBlocking,
      ...intentBlocking,
      // Witnessed pytest participants (server-witnessed channel): a red
      // or unfinished witnessed run blocks the gate — its mapping
      // declares this test as the create's witness, and a red test is
      // never evidence.
      ...witnessedBlocking,
    ],
    stateDir,
    now: pipeline.now,
    engineAlembicRecords: pipeline.engineAlembicRecords,
    // Scoped evaluation (Goal 2): the gate grades the affected slice —
    // the same join `planScopedExpectedSet` planned from, so the graded
    // obligations are exactly the covered set the receipt seals. Full
    // mode stays unscoped (changedFiles: null), byte-identical.
    // A re-seal grades the obligations its re-run tests declare (the
    // `namedObligationIds` above); diff scoping is the empty-slice
    // planner's axis and means nothing over a test-only change.
    changedFiles: reSealPlan === null ? scopeChangedFiles : null,
    // Named grading: the graded set is what the selected tests
    // declare. Absent for every other run, which then grades the whole
    // repository exactly as before.
    ...(namedObligationIds === null ? {} : { namedObligationIds }),
    claimInventory,
    ...(excludedTestIds.length === 0 ? {} : { excludedTestIds }),
    witnessVerifierKey,
    witnessVerifierKeys: verifierKeyring?.keys.map((entry) => entry.key),
    witnessAttestation: liveAttestation,
    // Goal 1: the supervised gate honors the adopted baseline through the
    // SAME fail-closed seam as `check` (no adoption record → nothing is
    // forgiven). Under strictE2E the evaluator still re-grades every
    // waived verdict to blocking — a waiver is not proof.
    baseline: resolveAdoptedBaseline(io.cwd, config.baselines),
    mappedCoverage,
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      expectedInvocationId: expectedDigest === null ? null : invocationId,
      requireInvocationId: true,
      changedInputs,
    },
  };
  const evaluated = evaluateRun(evaluationInput);
  // Owner-chosen strictness: the mapping from the strict decision to the
  // effective exit code. `changed` reuses the run's own provider diff and
  // the evaluator's own attribution rule — an unknown change fails closed.
  const strictExit = runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
  const blockingTotal =
    evaluated.verdicts.filter((verdict) => BLOCKING_VERDICTS.includes(verdict.verdict)).length +
    evaluated.blocking.length;
  const changedFileSet = new Set(providerChangedFiles);
  const strictness = decideStrictness({
    mode: gateMode,
    strictExitCode: strictExit,
    blockingTotal,
    ...(gateMode === 'changed'
      ? {
          changed: {
            active: true,
            blockingInScope:
              evaluated.verdicts.filter(
                (verdict) =>
                  BLOCKING_VERDICTS.includes(verdict.verdict) &&
                  (sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog).get(
                    verdict.obligation.resourceId,
                  ) ?? []).some((file) => changedFileSet.has(file)),
              ).length +
              scopeBlocking(
                evaluated.blocking,
                changedFileSet,
                sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog),
              ).length,
          },
        }
      : {}),
  });
  // The repository evaluation deliberately drops the named scope: it is
  // the whole-repository debt a named run reports but does not grade
  // (and never blocks on). Every other run already grades both halves
  // identically, so this is a no-op outside a named run.
  const repositoryEvaluation = evaluateRun({
    ...evaluationInput,
    namedObligationIds: null,
    blocking: repositoryBlocking,
    changedFiles: null,
  });
  const executionSummary = runExecutionSummaryOf({
    executionResult: sealed.result,
    mode: 'executed',
    scope: namedTestIds !== null ? 'named' : options.scope === 'changed' ? 'changed' : 'full',
    selectedVerdicts: evaluated.verdicts,
    selectedBlocking: evaluated.blocking,
    repositoryVerdicts: repositoryEvaluation.verdicts,
    repositoryBlocking: repositoryEvaluation.blocking,
    unclaimed: countUnclaimedObligations(stateDir, pipeline.policy.obligations),
  });
  if (
    options.scope !== 'changed' &&
    sealed.result.complete &&
    !options.resultOnly &&
    executionDurationMs !== null
  ) {
    writeLastFullRunSummary(stateDir, {
      testCount: executionSummary.selectedTests.selected,
      durationMs: executionDurationMs,
    });
  }
  const diagnosticContext = {
    scope: namedTestIds !== null ? ('named' as const) : options.scope,
    candidateTreeId: frozenTreeId,
    inputDigest: expectedDigest,
    evidenceState: snapshotUnavailable
      ? 'snapshot-unavailable'
      : changedInputs
        ? 'inputs-changed-during-run'
        : !sealed.result.complete
          ? 'execution-incomplete'
          : liveAttestation === null
            ? 'witness-attestation-unavailable'
            : 'attested',
    authority: options.resultOnly ? ('non-authoritative' as const) : ('authoritative' as const),
    ...(docsExclusions.length === 0
      ? {}
      : {
          docsExclusions: {
            folders: docsExclusions,
            approvalDigest: approvedPolicyDigest ?? trustedPolicy,
            approvalStatus: 'matched' as const,
            guarantee: DOCS_EXCLUSIONS_GUARANTEE,
          },
        }),
    ...(cacheExclusions.length === 0
      ? {}
      : {
          cacheExclusions: {
            files: cacheExclusions,
            approvalDigest: approvedPolicyDigest ?? trustedPolicy,
            approvalStatus: 'matched' as const,
            guarantee: CACHE_EXCLUSIONS_GUARANTEE,
          },
        }),
  };
  // Report-side strictness + quarantine (plan 20260925_2013 Phase 3):
  // ADDITIVE only. A repository that never softened its gate and never
  // quarantined a test gets exactly the document it got before.
  const renderedReport = renderRun(evaluated.verdicts, {
    format,
    blocking: evaluated.blocking,
    waiverCounts: evaluated.waiverCounts,
    run: manifest,
    toolVersion: VERSION,
    engine: engineIdentity(),
    lifecycleDerivation: pipeline.lifecycleDerivation,
    execution: executionSummary,
    diagnosticContext,
    ...(options.resultOnly ? { outcome: 'partial-selection' as const } : {}),
    ...(namedSelections !== null ? { selectors: namedSelections } : {}),
  });
  /**
   * The persisted json document: the same report shape stdout shows for a
   * json run, plus this run's strictness/quarantine blocks. Rendered
   * independently of `format` because the text run's rendered report is
   * text, not json.
   */
  const jsonReportDocument = (): string =>
    canonicalJson({
      ...(JSON.parse(
        renderRun(evaluated.verdicts, {
          format: 'json',
          blocking: evaluated.blocking,
          waiverCounts: evaluated.waiverCounts,
          run: manifest,
          toolVersion: VERSION,
          engine: engineIdentity(),
          lifecycleDerivation: pipeline.lifecycleDerivation,
          execution: executionSummary,
          diagnosticContext,
          ...(options.resultOnly ? { outcome: 'partial-selection' as const } : {}),
          ...(namedSelections !== null ? { selectors: namedSelections } : {}),
        }),
      ) as Record<string, unknown>),
      ...(gateMode === 'strict'
        ? {}
        : {
            strictness: {
              mode: strictness.mode,
              wouldBlock: strictness.wouldBlock,
              blockingInScope: strictness.blockingInScope,
              blockingTotal: strictness.blockingTotal,
            },
          }),
      ...(quarantines.active.length === 0
        ? {}
        : {
            quarantine: {
              count: quarantines.active.length,
              tests: quarantines.active.map((entry) => ({
                testKey: entry.quarantine.testKey,
                expiresAt: entry.quarantine.expiresAt,
                owner: entry.quarantine.owner,
              })),
            },
          }),
    } as unknown as JsonValue);
  const report =
    format === 'text'
      ? `${renderedReport}\n${strictnessSummaryLine(strictness)}${
          quarantines.active.length === 0
            ? ''
            : `\nquarantined: ${String(quarantines.active.length)} (expires ${quarantines.active
                .map((entry) => `${entry.quarantine.testKey} @ ${entry.quarantine.expiresAt}`)
                .join(', ')})`
        }`
      : format === 'json'
        ? jsonReportDocument()
        : renderedReport;
  writeLine(io.stdout, report);
  // The persisted report carries the SAME document stdout got: a later
  // consumer must see the strictness the run used and the quarantined
  // population, never a quieter one.
  writeReport(stateDir, jsonReportDocument());

  // 10. Only authoritative gate mode invalidates a previous receipt on
  // failure. Result-only reporting never creates, replaces, or clears one.
  // Owner-chosen strictness decides the exit code, never the evaluation:
  // a softened run still reports everything and, when it hides a block,
  // says so out loud. Setup/integrity failures above (drift, an
  // unresolvable input digest) are NOT softened — a run that could not
  // be evaluated honestly has nothing to report.
  const gateCode = strictness.exitCode;
  const softened = strictness.exitCode !== strictness.strictExitCode;
  // The post-run candidate tree, computed ONCE and used by both the
  // run record below and the drift check after the gate branch.
  const resultGitDir = resolveGitDir(io.cwd, io.env);
  const resultTreeSnapshot =
    resultGitDir === null
      ? null
      : computeCandidateTreeSnapshot(
          resultGitDir,
          io.cwd,
          io.env,
          stateDir,
          'record',
          runtimeReuseMounts,
          docsExclusions,
          cacheExclusions,
        );
  const resultTreeId = resultTreeSnapshot?.treeId ?? null;
  /**
   * Writes the run record of a whole-suite run that sealed no gate
   * receipt.
   *
   * A failing test is exactly the case a test-only re-seal exists for,
   * and a failing run issues no receipt (it clears the old one), so
   * without this record the path would be unusable where it matters
   * most. The record binds the same evidence a receipt binds and NO
   * verdict: `check`, pre-commit and the broker never read it, so a run
   * record alone leaves every gate exactly as blocked as it was. It is
   * written only for an authoritative whole-suite run whose evidence
   * is honestly bound — never for a slice, a named selection, a
   * result-only report, a drifting workspace or changed inputs.
   */
  const wholeSuiteRunRecord = (): void => {
    if (
      options.resultOnly ||
      namedTestIds !== null ||
      options.scope !== 'full' ||
      witnessVerifierKey === undefined ||
      approvedPolicyDigest === null ||
      expectedDigest === null ||
      snapshotUnavailable ||
      changedInputs ||
      resultTreeId === null ||
      resultTreeId !== frozenTreeId ||
      catalog === null
    ) {
      return;
    }
    writeRunRecord(
      stateDir,
      issueRunRecord({
        verifierKey: witnessVerifierKey,
        ...(verifierKeyring === null ? {} : { verifierKeyId: verifierKeyring.active.keyId }),
        runId: manifest.runId,
        invocationId,
        inputDigest: expectedDigest,
        gitSha: manifest.gitSha,
        parentSha: frozenParentSha,
        trustedPolicyDigest: trustedPolicy,
        approvedPolicyDigest,
        invocation: SUPERVISED_INVOCATION,
        selectionDigest,
        catalogDigest,
        executionResultDigest: sealed.digest,
        testOutcomesDigest: testOutcomesDigestOf(sealed.result.outcomes),
        plannedTests: sealed.result.planned.length,
        passedTests: sealed.result.outcomes.filter((outcome) => outcome.status === 'passed').length,
        evidenceAttestationDigest:
          liveAttestation === null ? null : sha256Canonical(liveAttestation as unknown as Record<string, never>),
        candidateTreeId: resultTreeId,
        engineBundleDigest: engineBundleDigestOf(VERSION, trustedPolicy),
        executionBoundaryDigest,
        issuedAt: pipeline.now,
      }),
    );
  };
  if (namedTestIds !== null) {
    // A named run is a REPORT, never a gate. It exits 0 only when the
    // selection itself is honest and complete: every selected test
    // passed and every obligation its claims declare is satisfied (or
    // waived by the owner), with no run-execution finding, no
    // incomplete execution, no changed inputs and a usable snapshot.
    // Anything else is exit 1. It never exits 2 here: an unresolvable
    // selector already threw a UsageError before anything ran, and it
    // never clears a receipt, because result-only never seals one.
    const selection =
      executionSummary.selectedTests.passed === executionSummary.selectedTests.selected &&
      executionSummary.selectedTests.selected > 0;
    const claimsProven =
      evaluated.blocking.length === 0 &&
      evaluated.verdicts.every((verdict) => verdict.verdict === 'satisfied' || verdict.verdict === 'waived');
    const runHonest = sealed.result.complete && !changedInputs && !snapshotUnavailable && expectedDigest !== null;
    if (!selection || !claimsProven || !runHonest) return 1;
  } else if (gateCode !== 0 || !sealed.result.complete || changedInputs || snapshotUnavailable || expectedDigest === null) {
    if (strictness.strictExitCode !== 0 && !options.resultOnly && !softened) clearGateReceipt(stateDir);
    // The run sealed no receipt; the evidence it DID produce is
    // retained as a run record, which only the test-only re-seal path
    // may read. It grants nothing on its own.
    wholeSuiteRunRecord();
    if (softened) {
      writeLine(
        io.stderr,
        `test-gates: ${strictnessSummaryLine(strictness)} — the gate exits 0 in mode '${strictness.mode}', ` +
          `strict mode would exit ${String(strictness.strictExitCode)}`,
      );
    }
    return gateCode === 0 ? 1 : gateCode;
  }
  // The result-only selection uses either a private temporary state dir or
  // the external witness's separate caller-provided state dir. It never
  // reads, writes, or clears the configured authoritative receipt.
  // Confirm the same candidate-tree drift check before returning a
  // descriptive pass.
  if (resultTreeId !== frozenTreeId) {
    writeLine(
      io.stderr,
      'test-gates: the workspace changed during the run ' +
        `(${frozenTreeId ?? 'unborn'} → ${resultTreeId ?? 'unborn'}); ` +
        'no result is reported for mixed bytes (fail closed)',
    );
    return 1;
  }
  if (options.resultOnly) {
    // A named run always lands here: it reported its selection and
    // sealed nothing.
    return 0;
  }
  if (expectedDigest === null) {
    // Unreachable: the gate path above already returned 1 for an
    // unusable snapshot. Kept so the seal below never sees a null
    // input digest.
    return 1;
  }
  if (witnessVerifierKey === undefined) {
    // No verifier key: the receipt cannot be signed by the same
    // authority as witness records — never mint an unverifiable one.
    if (!options.resultOnly) clearGateReceipt(stateDir);
    writeLine(io.stderr, 'test-gates: no witness verifier key — no gate receipt can be sealed (require-e2e consumers will block)');
    return gateCode;
  }
  const satisfied = evaluated.verdicts.filter((entry) => entry.verdict === 'satisfied').length;
  const waived = evaluated.verdicts.filter((entry) => entry.verdict === 'waived').length;
  // Phase 3 drift gate: the tree at seal time must equal the frozen
  // evaluation tree — a live-workspace edit mid-run blocks explicitly
  // instead of sealing mixed bytes.
  const sealTreeId = resultTreeId;
  // Phase 3 v2 bindings: the immutable candidate tree actually tested
  // (the drift-checked seal-time value, equal to the frozen evaluation tree),
  // the behavior catalog + required case set, authenticated executed
  // behavior cases that contributed to satisfied verdicts, the engine
  // bundle, the execution boundary, and target artifact.
  const candidateTreeId = sealTreeId;
  const behaviorBindings = behaviorReceiptBindings(pipeline.behaviorCatalog);
  const receipt = issueGateReceipt({
    verifierKey: witnessVerifierKey,
    verifierKeyId: verifierKeyring?.active.keyId,
    runId: manifest.runId,
    invocationId,
    inputDigest: expectedDigest,
    gitSha: manifest.gitSha,
    parentSha: frozenParentSha,
    trustedPolicyDigest: trustedPolicy,
    approvedPolicyDigest,
    receiptStage: config.enforcement?.receiptStage,
    engine: engineIdentity(),
    invocation: SUPERVISED_INVOCATION,
    selectionDigest,
    catalogDigest,
    // Scoped seal (Goal 2): the receipt names its slice and binds the
    // covered obligation fingerprints — MAC-covered like every other
    // field, so the covered set cannot be widened after the fact.
    ...(options.scope === 'changed'
      ? { scope: 'changed' as const, coveredObligationFingerprints: coveredFingerprints }
      : {}),
    // Test-only re-seal bindings (additive): the parent this run
    // re-sealed from — a gate receipt or a run record, named by
    // `resealedFromKind` — how many outcomes it carried, how many
    // tests it re-ran, and the change set Gateforge itself computed.
    // CI recomputes every one of them from the two sealed trees.
    ...(reSealPlan === null
      ? {}
      : {
          ...(reSealPlan.parentKind === 'receipt'
            ? { carriedFrom: reSealPlan.parentSha, parentReceiptDigest: reSealPlan.parentDigest }
            : {}),
          resealedFrom: reSealPlan.parentDigest,
          resealedFromKind: reSealPlan.parentKind,
          changeClass: 'test-only' as const,
          carriedTests: reSealPlan.carriedTests,
          rerunTests: plannedRows.length,
          changedPaths: reSealPlan.classification.changedPaths,
        }),
    executionResultDigest: sealed.digest,
    evidenceAttestationDigest: liveAttestation === null ? null : sha256Canonical(liveAttestation as unknown as Record<string, never>),
    candidateTreeId,
    behaviorCatalogDigest: behaviorBindings.behaviorCatalogDigest,
    requiredCaseSetDigest: behaviorBindings.requiredCaseSetDigest,
    caseExecutionDigest: executedBehaviorCaseDigest(
      stateDir,
      manifest.runId,
      pipeline.behaviorCatalog,
      evaluated.verdicts,
    ),
    engineBundleDigest: engineBundleDigestOf(VERSION, trustedPolicy),
    executionBoundaryDigest,
    targetArtifactDigest: targetArtifactDigestOf(candidateTreeId),
    verdictSummary: {
      total: evaluated.verdicts.length,
      satisfied,
      waived,
      blocking: 0,
    },
    issuedAt: pipeline.now,
  });
  writeGateReceipt(stateDir, receipt);
  // A receipt supersedes the run record of the same run: it carries the
  // same evidence PLUS a verdict, so the record is dropped rather than
  // left behind as a stale parent (the re-seal's own copy of the parent
  // it consumed lives in the retained chain below).
  clearRunRecord(stateDir);
  // The re-seal chain is additive run state: a re-sealed receipt keeps
  // its parent (receipt or run record, plus its execution result) and
  // the catalog its classification used, so a consumer can recompute
  // the re-seal with its own engine and key. Any other seal leaves no
  // chain behind.
  if (reSealPlan !== null && reSealParent !== null && catalog !== null) {
    writeResealChainHop(stateDir, {
      ...(reSealParent.receipt === null
        ? { runRecord: reSealParent.record, receipt: null }
        : { receipt: reSealParent.receipt, runRecord: null }),
      execution: reSealParent.execution,
      catalog,
    });
  } else {
    clearResealChain(stateDir);
  }
  writeCandidateTreeEntries(stateDir, resultTreeSnapshot?.entries ?? []);
  writeLine(io.stderr, `receipt ${receipt.receiptId} sealed (complete run, evidence graded, inputs bound)`);
  if (reSealPlan !== null) {
    writeLine(
      io.stderr,
      `only test files changed: re-ran ${String(plannedRows.length)} test(s), kept ${String(reSealPlan.carriedTests)} ` +
        `from the previous ${reSealPlan.parentKind === 'run-record' ? 'run' : 'receipt'}`,
    );
  }
  return 0;
}

/** Runs the configured ADVISORY diagnostic suites as a separate step. */
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
  // Witnessed suites never run in the advisory window (their GATEFORGE_*
  // env is stripped here, and their result must grade, not advise) — the
  // exclusion is always printed, never silent.
  for (const name of run.witnessedExcluded) {
    writeLine(io.stderr, `diagnostic ${name}: witnessed — excluded from the advisory window (runs inside the supervised window)`);
  }
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

/**
 * The behavior bindings a v2 receipt seals or must match on reuse: the
 * compiled catalog digest plus the digest over the sorted full required
 * case specifications. Both derive from the compiled catalog fixed
 * pre-run, so reuse and seal compute identical values.
 */
function behaviorReceiptBindings(behaviorCatalog: BehaviorCatalog | null): {
  behaviorCatalogDigest: string;
  requiredCaseSetDigest: string;
} {
  if (behaviorCatalog === null) {
    return {
      behaviorCatalogDigest: EMPTY_BEHAVIOR_CATALOG_DIGEST,
      requiredCaseSetDigest: requiredCaseSetDigestOf([]),
    };
  }
  const specs = behaviorCatalog.cases
    .map((item) => ({ caseId: item.caseId, specDigest: item.specDigest }))
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  return {
    behaviorCatalogDigest: behaviorCatalog.catalogDigest,
    requiredCaseSetDigest: requiredCaseSetDigestOf(specs as unknown as JsonValue[]),
  };
}

/**
 * Computes the receipt's executed-case digest from only authenticated,
 * schema-valid behavior.case records that the evaluator used for a
 * satisfied obligation verdict. Unreferenced, malformed, claimed, or
 * mismatched records are ignored.
 *
 * Args:
 *   stateDir: run-state directory containing records.json.
 *   runId: authenticated run identity.
 *   behaviorCatalog: trusted compiled behavior catalog, or null.
 *   verdicts: final evaluated obligation verdicts.
 *
 * Returns:
 *   string: canonical executed-case digest, empty when no catalog cases
 *   contributed.
 */
export function executedBehaviorCaseDigest(
  stateDir: string,
  runId: string,
  behaviorCatalog: BehaviorCatalog | null,
  verdicts: readonly ObligationVerdict[],
): string {
  if (behaviorCatalog === null || behaviorCatalog.cases.length === 0) return caseExecutionDigestOf([]);
  const requiredBySatisfiedObligation = new Map<string, Set<string>>();
  for (const verdict of verdicts) {
    if (verdict.verdict !== 'satisfied') continue;
    const obligationId = verdict.obligation.id;
    requiredBySatisfiedObligation.set(
      obligationId,
      new Set(behaviorCatalog.requirements[obligationId] ?? []),
    );
  }
  if (requiredBySatisfiedObligation.size === 0) return caseExecutionDigestOf([]);
  const satisfiedRecordIds = new Set(
    verdicts
      .filter((verdict) => verdict.verdict === 'satisfied')
      .flatMap((verdict) => verdict.recordIds),
  );
  const executedCaseIds: string[] = [];
  for (const raw of readJsonArray(stateDir, 'records.json')) {
    if (!isWitnessedRecord(raw)) continue;
    const record = EvidenceRecordSchema.safeParse(raw);
    if (!record.success) continue;
    const evidence = record.data;
    if (
      evidence.recordId === undefined ||
      !satisfiedRecordIds.has(evidence.recordId) ||
      evidence.runId !== runId ||
      evidence.kind !== BEHAVIOR_CASE_KIND ||
      evidence.trust !== 'witnessed' ||
      evidence.origin !== 'engine-observed'
    ) {
      continue;
    }
    const payload = BehaviorCasePayloadSchema.safeParse(evidence.payload);
    if (!payload.success || payload.data.state !== 'sealed' || !payload.data.completion.complete) continue;
    const requiredCaseIds = requiredBySatisfiedObligation.get(evidence.obligationId);
    if (
      requiredCaseIds === undefined ||
      !requiredCaseIds.has(payload.data.caseId) ||
      !payload.data.obligationIds.includes(evidence.obligationId)
    ) {
      continue;
    }
    const compiled = behaviorCatalog.cases.find((candidate) => candidate.caseId === payload.data.caseId);
    if (compiled === undefined || compiled.specDigest !== payload.data.caseSpecDigest) continue;
    executedCaseIds.push(payload.data.caseId);
  }
  return caseExecutionDigestOf(executedCaseIds);
}

/** Counts obligations with no claim row in the selected run state.
 *
 * Args:
 *   stateDir: run-state directory containing the claim registry.
 *   obligations: complete policy obligation set.
 *
 * Returns:
 *   number: unique obligations with no claim row.
 */
function countUnclaimedObligations(stateDir: string, obligations: readonly { id: string }[]): number {
  const claimed = new Set<string>();
  for (const raw of readJsonArray(stateDir, 'claims.json')) {
    if (typeof raw !== 'object' || raw === null || !('obligationId' in raw)) continue;
    const obligationId = (raw as { obligationId?: unknown }).obligationId;
    if (typeof obligationId === 'string') claimed.add(obligationId);
  }
  return obligations.filter((obligation) => !claimed.has(obligation.id)).length;
}

/** Builds the report counts from trusted execution and full-scope evaluation.
 *
 * Args:
 *   input: execution result, selected result, full repository result, and scope.
 *
 * Returns:
 *   RunExecutionSummary: descriptive counts that never authorize a gate.
 */
function runExecutionSummaryOf(input: {
  executionResult: ExecutionResult;
  mode: 'executed' | 'reused';
  scope: 'full' | 'changed' | 'named';
  selectedVerdicts: readonly ObligationVerdict[];
  selectedBlocking: readonly BlockingEntry[];
  repositoryVerdicts: readonly ObligationVerdict[];
  repositoryBlocking: readonly BlockingEntry[];
  unclaimed: number;
}): RunExecutionSummary {
  const latestOutcomes = new Map<string, ExecutionResult['outcomes'][number]>();
  for (const outcome of input.executionResult.outcomes) {
    const previous = latestOutcomes.get(outcome.logicalKey);
    if (previous === undefined || outcome.attempt >= previous.attempt) latestOutcomes.set(outcome.logicalKey, outcome);
  }
  const finalOutcomes = [...latestOutcomes.values()];
  const performed = finalOutcomes.filter((outcome) => outcome.status !== 'skipped' && outcome.status !== 'fixme').length;
  const passed = finalOutcomes.filter((outcome) => outcome.status === 'passed' && !outcome.expectedFailure).length;
  const skipped = finalOutcomes.filter((outcome) => outcome.status === 'skipped' || outcome.status === 'fixme').length;
  const expectedFailures = finalOutcomes.filter((outcome) => outcome.status === 'failed' && outcome.expectedFailure).length;
  const selected = input.executionResult.planned.length;
  const blockingSelected = input.selectedVerdicts.filter(
    (verdict) => verdict.verdict !== 'satisfied' && verdict.verdict !== 'waived',
  ).length;
  const blockingRepository = input.repositoryVerdicts.filter(
    (verdict) => verdict.verdict !== 'satisfied' && verdict.verdict !== 'waived',
  ).length;
  return {
    scope: input.scope,
    mode: input.mode,
    testsPerformedThisInvocation: input.mode === 'executed' ? performed : 0,
    selectedTests: {
      selected,
      passed,
      failed: Math.max(0, selected - passed - skipped - expectedFailures),
      skipped,
      expectedFailures,
    },
    selectedClaims: {
      selected: input.selectedVerdicts.length,
      satisfied: input.selectedVerdicts.filter((verdict) => verdict.verdict === 'satisfied').length,
      blocking: blockingSelected,
      blockingEntries: input.selectedBlocking.length,
      waived: input.selectedVerdicts.filter((verdict) => verdict.verdict === 'waived').length,
    },
    repositoryDebt: {
      obligations: input.repositoryVerdicts.length,
      blocking: blockingRepository + input.repositoryBlocking.length,
      blockingEntries: input.repositoryBlocking.length,
      unclaimed: input.unclaimed,
    },
  };
}

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
