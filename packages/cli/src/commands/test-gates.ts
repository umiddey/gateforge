/**
 * `gateforge test-gates`: orchestrate a full evidence run — plugin
 * discovery → obligations → run-state materialization → suite execution
 * → verdict evaluation → report.
 *
 * Two modes:
 *
 * **Legacy `--suite` mode** — the orchestration surface G6's Playwright
 * pack consumes (see packages/cli/guides/REFERENCE.md "test-gates protocol"). The
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
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AttestationSchema,
  BEHAVIOR_CASE_KIND,
  BehaviorCasePayloadSchema,
  BehaviorCatalogRegistrationSchema,
  CAUSE_NEXT_ACTIONS,
  canonicalJson,
  compareStrings,
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
  repositoryDebtOf,
  runExitCode,
  sha256Canonical,
  selectionDigestOf,
  targetArtifactDigestOf,
  verifyAttestationMac,
  type Attestation,
  type BehaviorCatalog,
  type BehaviorCatalogRegistration,
  type BlockingEntry,
  type ExecutionResult,
  type GateforgeConfig,
  type HttpRouteCandidate,
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
  twinDivergenceDetail,
  twinLinksFor,
  twinPathDivergence,
  withoutQuarantinedBindings,
  type LoadedQuarantine,
  type Obligation,
  type TestCatalog,
  type TestMap,
  type TestMapEntry,
  type TracedTestInput,
  type TwinDivergence,
  type TwinLink,
  type TwinShape,
} from '@gate-forge/core';
import {
  appendFreezeReleaseEvent,
  armFreezeControl,
  buildWitnessedPytestChildEnv,
  canonicalFreezeJson,
  defaultPlaywrightCommand,
  diffNativePlaywrightTests,
  discoverTestCatalog,
  findPlaywrightConfig,
  isPlaywrightRunnerInstall,
  listNativePlaywrightTests,
  mintFreezeSigningKeyPair,
  nativeConfigDirOf,
  playwrightTestModulePath,
  removeFreezeSpecDir,
  signFreezeRelease,
  spoolPathFor,
  supervisedRunnerChildEnv,
  writeFreezeRefusal,
  resolveProjectStorageState,
  CypressRunnerAdapter,
  PlaywrightAdapter,
  PytestRunnerAdapter,
  readRunnerOutcomes,
  startSupervisorSpoolDrain,
  startWitnessProcess,
  SupervisorClient,
  TestDiscoveryError,
  VitestRunnerAdapter,
  RUN_HEADER,
  VERIFIER_HEADER,
  DEFAULT_RUN_TIMEOUT_MS,
  ENV_CHAOS_MAX_DELAY_MS,
  ENV_CHAOS_REORDER,
  ENV_CHAOS_SEED,
  ENV_PROXY_TARGET,
  ENV_TWIN_INVENTORY,
  ENV_TWIN_QUERY_KEYS,
  ENV_TWIN_SHAPES,
  type FreezeSigningKeyPair,
  type SpoolDrainHandle,
  type ExpectedSetResponse,
  type NativeInstance,
  type NativeListResult,
  type RunnerEnumeration,
  type RunnerExecuteRequest,
  type RunnerTestIdentity,
  type RunActivity,
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
  plannedProjectScopes,
  plannedRowsWithProjectDependencies,
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
import {
  carryDiffIsWithinScope,
  classifyResealChange,
  parentCommitAcceptance,
  resealDisregardNotice,
  RESEAL_REFUSAL_SUFFIX,
  resealRefusal,
  type ResealChangeClassification,
} from '../reseal.js';
import {
  authenticateContributingEvidence,
  carriedEvidenceDigestOf,
  carriedEvidenceDocuments,
  carriedTestIdentities,
  clearRetainedParentEvidence,
  readRetainedParentEvidence,
  readRunAttestation,
  stringField,
  writeRetainedParentEvidence,
  type CarriedEvidenceContribution,
} from '../reseal-evidence.js';
import {
  clearResealChain,
  RESEAL_CHAIN_MAX_HOPS,
  resealChainHopCount,
  retainedChainCarriedTests,
  retainedEvidenceContributors,
  writeResealChainHop,
  writeResealChainParentEvidence,
} from '../reseal-chain.js';
import { obligationFingerprint } from '../evaluate.js';
import { computeEvaluationScope } from '../scope.js';
import { candidateTreeCoversCommit, computeCandidateTreeSnapshot, listTrackedPaths, resolveGitDir, sanitizedAuthorityEnv, type CandidateTreeSnapshot } from '../candidate-tree.js';
import {
  acceptedFreezeRequest,
  classifyGeneratedTargets,
  planNativeFreeze,
  preparedCandidateViolations,
  unfrozenPrerequisiteState,
  type GeneratedTargetClass,
  type NativeFreezePlan,
  type PreparedCandidateIdentity,
  type PrerequisiteIdentity,
} from '../native-freeze.js';
import type { RuntimeReuseMount } from '../runtime-reuse.js';
import { loadRuntimeConfigAt, resolveRuntimeReuseDigest } from '../runtime.js';
import { mergeRequestScopePreflight, resolveProvider } from '../providers.js';
import { engineIdentity, reportEngineLine } from '../engine-identity.js';
import { assertReceiptApprovedPolicy, evaluateApprovedPolicy, resolveApprovedPolicyDigest } from '../trusted-policy.js';
import { unstagedPolicyInputs } from './enforcement.js';
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
  writeTwinInventory,
  writeTwinShapes,
} from '../state.js';
import { engineGeneratedStateFileFilter } from '../state-artifacts.js';
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
import { ProgressStream, resolveProgressTarget, type ProgressOutcome, type ProgressTarget } from '../progress.js';
import { writeRunScopeView, writeTestFailures } from '../state.js';

export const TEST_GATES_USAGE =
  'usage: gateforge test-gates [--changed] [--scope full|changed] [--suite <command>] [--out <dir>] ' +
  '[--result-only] [--test <selector>] [--format text|json|sarif] [--witness-url <url>] [--run-token <token>] ' +
  '[--run-timeout-min <minutes>] [--progress stderr|file:<path>|off|auto] ' +
  `(verifier key via ${VERIFIER_KEY_ENV} or ${VERIFIER_KEY_FILE_ENV})\n` +
  '       --scope changed (supervised --changed only): plan, execute, and seal only the slice of tests\n' +
  '       claiming obligations affected by the resolved changed-file set; an affected obligation with no\n' +
  '       testable declared mapping blocks (EVIDENCE_SCOPE_INCOMPLETE) — narrower selection is never guessed\n' +
  '       --result-only (requires --changed --scope changed, or --test): report selected results without gate\n' +
  '       authority or receipt changes; external witnesses require a separate --out directory and --run-token\n' +
  '       --chaos <seed> (requires --result-only): make the witness proxy delay and reorder app responses\n' +
  '       from a seeded schedule, so rare response-order races fail on purpose. The seed IS the schedule:\n' +
  '       the same seed replays it exactly. Bounds come from run.chaos (maxDelayMs, reorder). A chaos run is a\n' +
  '       finding tool: it never seals a receipt and never writes the run record. With --witness-url the plan\n' +
  '       travels with the run context, so the witness needs nothing configured on its side, and a run against a\n' +
  '       witness that was itself started with GATEFORGE_CHAOS_SEED is refused before any test runs\n' +
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
    ['suite', 'out', 'format', 'witness-url', 'run-token', 'run-timeout-min', 'progress', 'changed', 'scope', 'result-only', 'test', 'chaos', 'help'],
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
  // --chaos <seed>: the timing-chaos switch. Same authority contract as
  // --test - a chaos run FINDS races, it never seals - and the seed is
  // the whole configuration: one non-negative integer replays one
  // schedule exactly.
  const chaosSeed = stringFlag(options, 'chaos');
  const chaos =
    chaosSeed === undefined ? null : parseChaosSeed(chaosSeed, resultOnly);
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
  // A usage error must cost seconds, not a spawned witness and a test
  // suite: an unusable --progress target is rejected before anything
  // runs. (The target itself is resolved again once the trusted config
  // is loaded, so the `run.progress` key gets the same treatment.)
  const progressFlag = stringFlag(options, 'progress');
  if (progressFlag !== undefined) resolveProgressTarget(progressFlag, undefined, io.env);
  const verifierKeyring = resolveVerifierKeyring(io.cwd, io.env, [resolveStateDir(io.cwd, out)]);
  if (changed || namedSelection) {
    const isolatedStateDir = resultOnly && witnessUrl === undefined ? mkdtempSync(join(tmpdir(), 'gateforge-selected-result-')) : undefined;
    try {
      return await runSupervisedTestGates(io, {
        out: isolatedStateDir ?? out,
        format,
        witnessUrl,
        runToken: stringFlag(options, 'run-token'),
        runTimeoutMs:
          parseRunTimeoutMin(stringFlag(options, 'run-timeout-min')) ?? runtimeRunTimeoutMs(io.cwd),
        stallTimeoutMs: runtimeStallTimeoutMs(io.cwd),
        progress: progressFlag,
        scope,
        resultOnly,
        testSelectors,
        chaos,
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

/**
 * The whole-run budget the OWNER declared in the staged runtime document,
 * in milliseconds, or undefined when the document declares none.
 *
 * `runtime.yml`'s `executionTimeoutSeconds` is the owner's budget for a
 * supervised run and the commit hook has always honoured it. Run
 * directly, the same document was ignored and every run died at the
 * 30-minute default — the owner's own runtime document did not apply to
 * the owner's own command. An explicit `--run-timeout-min` still wins, and
 * a document that cannot be read declares nothing: no whole-run cap applies,
 * and the stall bound (see {@link runtimeStallTimeoutMs}) is the only backstop.
 *
 * Args:
 *   cwd: absolute repository root.
 *
 * Returns:
 *   number | undefined: milliseconds, or undefined when no cap is declared.
 */
function runtimeRunTimeoutMs(cwd: string): number | undefined {
  try {
    const seconds = loadRuntimeConfigAt(cwd, loadConfigAt(cwd).runtime)?.executionTimeoutSeconds;
    return seconds === undefined ? undefined : seconds * 1_000;
  } catch {
    return undefined;
  }
}

/**
 * The stall bound the OWNER declared in the staged runtime document, in
 * milliseconds, or undefined when the document declares none.
 *
 * `runtime.yml`'s `stallTimeoutSeconds` is the owner's own answer to
 * "how long may my suite go without finishing a test". The engine
 * default stands when the document says nothing, and a document that
 * cannot be read declares nothing.
 *
 * Args:
 *   cwd: absolute repository root.
 *
 * Returns:
 *   number | undefined: milliseconds, or undefined for the engine default.
 */
function runtimeStallTimeoutMs(cwd: string): number | undefined {
  try {
    const seconds = loadRuntimeConfigAt(cwd, loadConfigAt(cwd).runtime)?.stallTimeoutSeconds;
    return seconds === undefined ? undefined : seconds * 1_000;
  } catch {
    return undefined;
  }
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
    engineLine: reportEngineLine(),
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
      engineLine: reportEngineLine(),
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
  /**
   * Whole-run wall-clock bound ms. Undefined = NO whole-run cap: the
   * bound is the operator's to declare (`--run-timeout-min` or
   * `runtime.yml executionTimeoutSeconds`), never a default that kills
   * the long suites it was meant to protect.
   */
  runTimeoutMs: number | undefined;
  /**
   * Stall bound ms: the run is killed when no test has FINISHED for this
   * long. Undefined resolves from `runtime.yml stallTimeoutSeconds` and
   * then the engine default (15 min) inside the supervised path.
   */
  stallTimeoutMs?: number;
  /**
   * `--progress` target (additive): `stderr`, `file:<path>`, `off`, or
   * undefined for the `run.progress` config key and then the CI-aware
   * `auto` default (stderr under CI, off locally).
   */
  progress?: string;
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
  /**
   * The resolved timing-chaos plan (`--chaos <seed>` with the
   * `run.chaos` bounds). Present only for an explicit chaos run, and
   * only ever together with `resultOnly`: a chaos run reports, it
   * never seals.
   */
  chaos?: { seed: number } | null;
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
  /**
   * Receives the PREPARED candidate identity the moment the global native
   * preparation freeze accepts it.
   *
   * It exists because that identity must never leave this process as a
   * state document: the staged pre-commit orchestrator needs the exact
   * tree the supervised run actually tested in order to hand the same
   * identity to the strict check that follows inside the isolated
   * checkout. A callback keeps it a typed in-memory value instead of a
   * file a later run could have rewritten. A run that never freezes
   * anything simply never calls it.
   */
  onPreparedCandidate?: (identity: PreparedCandidateIdentity) => void;
}

/** One recorded chaos release decision, exactly as the witness reports it. */
export interface ChaosScheduleResponse {
  /** Supervisor-issued test id the plan released under (never a secret). */
  session: string;
  /** `METHOD /pathname` (query stripped) — never a secret. */
  routeKey: string;
  /** 1-based index of the request under its route key. */
  k: number;
  /** The planned release offset: a pure function of seed/session/route/k. */
  plannedDelayMs: number;
  /** Milliseconds the response was actually held back. */
  delayMs: number;
  /** True when the plan released this response before the previous one. */
  releasedBefore: boolean;
}

/** The timing-chaos plan one `--chaos <seed>` run executes under (E63). */
export interface ChaosRun {
  /** The seed the owner typed; the whole schedule is a function of it. */
  seed: number;
  /** Upper bound of every applied delay, in whole milliseconds. */
  maxDelayMs: number;
  /** Whether a later response may be released before an earlier one. */
  reorder: boolean;
}

/** The documented default bound when `run.chaos.maxDelayMs` is unset. */
const CHAOS_DEFAULT_MAX_DELAY_MS = 400;

/** The hard ceiling on a configured bound (a chaos run is a finding tool). */
const CHAOS_MAX_DELAY_CEILING_MS = 5_000;

/**
 * How long the generated freeze controller waits for a valid release
 * when the run declared no whole-run budget. A wait, not a run bound:
 * the controller's own handshake must stay finite whatever the suite's
 * budget is, and the ceiling below already caps it at this value.
 */
const FREEZE_RELEASE_WAIT_MS = 900_000;

/**
 * Validates `--chaos <seed>` against the same authority contract as
 * `--test`: a chaos run reports, it never seals, and a seed that is not
 * a non-negative integer is refused in seconds — before a witness, a
 * browser or a suite is spawned.
 *
 * An EXTERNAL witness (`--witness-url`) is accepted here: the plan
 * travels with the run-context binding (see {@link WitnessRunOptions}),
 * so the repository's own witness needs nothing configured on its side.
 *
 * Args:
 *   raw: the value the operator typed.
 *   resultOnly: whether `--result-only` was given.
 *
 * Returns:
 *   { seed: number }: the accepted seed (the bounds are resolved later,
 *   from the trusted config).
 *
 * @throws UsageError: without `--result-only`, or on a seed that is not
 *   a non-negative integer.
 */
function parseChaosSeed(raw: string, resultOnly: boolean): { seed: number } {
  if (!resultOnly) {
    throw new UsageError(
      'test-gates: --chaos requires --result-only — a run whose timing was perturbed on purpose finds races, ' +
        'it never proves a commit; run the normal gate to issue a receipt',
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(
      `test-gates: --chaos takes a non-negative integer seed (0, 1, 2, ...), got '${raw}'`,
    );
  }
  return { seed: Number(raw) };
}

/** The run options this CLI hands a witness with the run context. */
export interface WitnessRunOptions {
  chaos?: ChaosRun;
  twinShapes?: { queryKeys: readonly string[]; inventory: readonly string[] };
}

/** The run options a witness confirmed it is applying. */
export interface AppliedWitnessOptions {
  chaos: ChaosRun | null;
  twinShapes: { queryKeys: readonly string[]; inventory?: readonly string[] } | null;
}

/** True when a binding echo is the additive `applied` block we sent. */
function isAppliedWitnessOptions(value: unknown): value is AppliedWitnessOptions {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return 'chaos' in record && 'twinShapes' in record;
}

/** The run options as the plain json the binding body carries. */
function runOptionsJson(options: WitnessRunOptions): JsonValue {
  return {
    ...(options.chaos === undefined ? {} : { chaos: { ...options.chaos } }),
    ...(options.twinShapes === undefined
      ? {}
      : {
          twinShapes: {
            queryKeys: [...options.twinShapes.queryKeys],
            inventory: [...options.twinShapes.inventory],
          },
        }),
  };
}

/**
 * Refuses a NORMAL run whose external witness perturbs timing on its
 * own, before a single test executes.
 *
 * The run owns the plan now: a witness only perturbs when THIS run
 * asked for it through the binding, and this run only asks with
 * `--chaos --result-only`. So a plan the witness reports for a run
 * that asked for none can only have come from the witness's own
 * ENVIRONMENT — and a perturbed run must never seal.
 *
 * A witness too old to have the route answers 404: it cannot perturb
 * timing it was never told to, so the run is exactly what it always
 * was.
 *
 * Args:
 *   witnessUrl: the external witness origin.
 *   runToken: the run token the supervisor surface authenticates with.
 *   verifierKey: the supervisor verifier key.
 *
 * @throws UsageError: when the witness reports a plan this run did not
 *   ask for, or cannot be asked at all.
 */
async function refuseChaosWitnessOnSealingRun(
  witnessUrl: string,
  runToken: string,
  verifierKey: string,
): Promise<void> {
  let body: { chaos?: ChaosRun | null } | null;
  let status: number;
  try {
    const response = await fetch(`${witnessUrl}/runs/chaos-schedule`, {
      headers: { [RUN_HEADER]: runToken, [VERIFIER_HEADER]: verifierKey },
    });
    status = response.status;
    body = response.ok ? ((await response.json()) as { chaos?: ChaosRun | null }) : null;
  } catch (error) {
    throw new UsageError(
      `test-gates: the external witness at '${witnessUrl}' could not be asked whether it perturbs timing on its ` +
        `own (${(error as Error).message}) — a sealing run never assumes its witness is not perturbing timing`,
    );
  }
  if (status === 404 || body === null) return;
  const reported = body.chaos ?? null;
  if (reported === null) return;
  throw new UsageError(
    `test-gates: the external witness at '${witnessUrl}' was started with a timing-chaos plan (seed ` +
      `${String(reported.seed)}), and a witness that perturbs timing can never serve a run that seals — unset ` +
      `${ENV_CHAOS_SEED} when starting it (this run never asked for chaos), or re-run with --chaos ` +
      `${String(reported.seed)} --result-only to report under the same plan`,
  );
}

/**
 * Resolves the tuned bounds of a chaos run from the trusted config. The
 * config only TUNES: `run.chaos` present without `--chaos` leaves every
 * byte of a normal run exactly as it was.
 *
 * Args:
 *   config: the trusted configuration.
 *   seed: the accepted `--chaos` seed.
 *
 * Returns:
 *   ChaosRun: the plan the witness proxy will execute.
 *
 * @throws UsageError: when `run.chaos.maxDelayMs` exceeds the ceiling.
 */
function chaosRunOf(config: ReturnType<typeof loadConfigAt>, seed: number): ChaosRun {
  const maxDelayMs = config.run?.chaos?.maxDelayMs ?? CHAOS_DEFAULT_MAX_DELAY_MS;
  if (maxDelayMs > CHAOS_MAX_DELAY_CEILING_MS) {
    throw new UsageError(
      `test-gates: run.chaos.maxDelayMs must be at most ${String(CHAOS_MAX_DELAY_CEILING_MS)} (got ${String(maxDelayMs)})`,
    );
  }
  return { seed, maxDelayMs, reorder: config.run?.chaos?.reorder ?? true };
}

/**
 * The plain line for a linked twin pair that ran but could not be
 * compared, because a side sent no request through the witness.
 *
 * Args:
 *   link: the linked pair.
 *   witnessedObserved: whether the witnessed test's requests were seen.
 *   rawObserved: whether the raw test's requests were seen.
 *
 * Returns:
 *   string: the stderr line naming the unobserved side and the fix.
 */
export function twinPairNotComparedLine(link: TwinLink, witnessedObserved: boolean, rawObserved: boolean): string {
  const unobserved = [
    ...(witnessedObserved ? [] : [`the witnessed test '${link.witnessed}'`]),
    ...(rawObserved ? [] : [`the raw test '${link.raw}'`]),
  ].join(' and ');
  const fix = rawObserved
    ? ''
    : ' — a raw twin is observed only when it runs with the Gateforge test fixture, which opens an observation-only session for it (it issues no evidence)';
  return `test-gates: twin pair not compared: ${unobserved} sent no request through the witness${fix}`;
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
  /**
   * `own-ancestor-commit` binds the parent to the commit the parent
   * DOCUMENT names (the re-seal path, which must work in a merge
   * request where no CI variable names the previous pipeline's
   * commit). Absent keeps the plain carry-forward path on its exact
   * merge base, unchanged.
   */
  parentCommitBinding?: 'own-ancestor-commit';
  /**
   * Every obligation fingerprint this repository declares. A re-seal
   * parent must have covered exactly this set, which is what lets one
   * re-seal become the parent of the next.
   */
  repositoryFingerprints?: readonly string[];
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
 * The commit a parent document is held to, or the plain refusal that
 * says why it is bound to none.
 *
 * A re-seal binds the parent to the commit the parent itself names:
 * the previous pipeline tested that commit's bytes, and this run
 * froze a descendant of it, so the two sealed trees differ only by
 * this run's change set. No CI variable is involved — a merge
 * request's diff base is a different commit from the one the previous
 * pipeline tested, and nothing sets such a variable to the parent.
 * The plain carry-forward path keeps its exact merge-base rule.
 *
 * Args:
 *   input: the repository coordinates, including the binding.
 *   ownSha: the commit the parent document names, or null when it
 *     names none.
 *
 * Returns:
 *   the bound commit, or the first binding that failed in plain words.
 */
function boundParentCommit(
  input: Pick<CarryForwardParentInput, 'io' | 'gitDir' | 'baseSha' | 'parentCommitBinding'>,
  ownSha: string | null | undefined,
): { sha: string; reason: null } | { sha: null; reason: string } {
  if (input.parentCommitBinding !== 'own-ancestor-commit') {
    if (input.baseSha.length === 0) return { sha: null, reason: 'no merge-base commit is known' };
    return { sha: input.baseSha, reason: null };
  }
  const commit = (ownSha ?? '').trim();
  const acceptance = parentCommitAcceptance(input.gitDir, input.io.env, commit);
  if (acceptance === 'ancestor') return { sha: commit, reason: null };
  if (acceptance === 'missing') {
    return {
      sha: null,
      reason: /^[0-9a-f]{40}$/.test(commit)
        ? `it was sealed at commit ${shortSha(commit)}, which this repository cannot read`
        : 'it names no commit, so there is nothing to bind it to',
    };
  }
  return { sha: null, reason: `it was sealed at commit ${shortSha(commit)}, which is not an ancestor of HEAD` };
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
    const bound = boundParentCommit(input, receipt.gitSha);
    if (bound.reason !== null) return refuse(bound.reason);
    // The sealed candidate is a WORKSPACE tree (it carries the repo's
    // untracked and gitignored bytes too), so it is never equal to the
    // commit's tree. What must hold is that it COVERS the bound
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
        `${bound.sha}^{tree}`,
        input.docsExclusions,
        input.cacheExclusions,
      )
    ) {
      return refuse(
        `its sealed tree is not the tree of commit ${shortSha(bound.sha)} (uncommitted changes were tested)`,
      );
    }
    if (input.parentCommitBinding !== 'own-ancestor-commit' && receipt.gitSha !== input.baseSha) {
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
    // A plain carried or sliced run proves a slice, so it never
    // re-seals. A RE-SEAL is different: it names the parent it carried
    // from in `resealedFrom` and the whole repository in
    // `coveredObligationFingerprints`, which is exactly what a
    // further re-seal needs to carry from.
    const isReseal = receipt.changeClass === 'test-only' && receipt.resealedFrom !== undefined;
    if (
      (receipt.carriedFrom !== undefined ||
        receipt.parentReceiptDigest !== undefined ||
        (receipt.scope !== undefined && receipt.scope !== 'full')) &&
      !isReseal
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
    // The parent is loaded against the coverage it sealed: a
    // whole-suite run, or — for a re-seal parent — the exact set of
    // obligation fingerprints this repository declares, which the
    // loader compares against the receipt's own list.
    const loaded = loadReceiptFor(input.stateDir, input.verifierKeyring, {
      inputDigest: receipt.inputDigest,
      trustedPolicyDigest: input.trustedPolicyDigest,
      candidateTreeId: treeId,
      executionBoundaryDigest: input.executionBoundaryDigest,
      ...(isReseal
        ? { scope: 'changed' as const, coveredObligationFingerprints: input.repositoryFingerprints ?? [] }
        : { scope: 'full' as const }),
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
  /**
   * `own-ancestor-commit` binds the parent to the commit the parent
   * DOCUMENT names; absent keeps the exact merge-base rule.
   */
  parentCommitBinding?: 'own-ancestor-commit';
  /**
   * Every obligation fingerprint this repository declares; a re-seal
   * parent must have covered exactly this set.
   */
  repositoryFingerprints?: readonly string[];
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
    const bound = boundParentCommit(input, record.gitSha);
    if (bound.reason !== null) return refuse(bound.reason);
    const treeId = record.candidateTreeId;
    if (
      input.gitDir === null ||
      treeId === null ||
      !candidateTreeCoversCommit(
        input.gitDir,
        input.io.env,
        treeId,
        `${bound.sha}^{tree}`,
        input.docsExclusions,
        input.cacheExclusions,
      )
    ) {
      return refuse(
        `its sealed tree is not the tree of commit ${shortSha(bound.sha)} (uncommitted changes were tested)`,
      );
    }
    if (input.parentCommitBinding !== 'own-ancestor-commit' && record.gitSha !== input.baseSha) {
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
        sha: bound.sha,
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
  /**
   * The owner-declared runtime files (`enforcement.resealRuntimeFiles`).
   * Absent or empty changes nothing: the classifier disregards nothing
   * and the decision is the one it always was.
   */
  runtimeFileGlobs?: readonly string[];
  /**
   * The tree of the commit this run froze (`<baseSha>^{tree}`). Both
   * commit trees — this one and the parent's — say which paths are
   * tracked source, which is what an owner declaration may never hide
   * and what a declared browser state must be to count as generated
   * output; without them the classifier disregards nothing and treats
   * no state as generated (fail closed).
   */
  currentCommitTreeId?: string;
  /**
   * Repo-relative paths this run's input snapshot binds. A declared
   * browser state inside it is authority, not output, so it is never
   * carried as a generated-state change. Absent when the caller holds no
   * inventory: input membership is not inferable from the sealed trees;
   * without an inventory this classifier applies only the other
   * generated-state eligibility rules.
   */
  inputFiles?: ReadonlySet<string>;
  /**
   * How many parent outcomes the WHOLE retained chain carries, read
   * from the run state. A parent that is itself a re-seal planned
   * only the tests it re-ran, so its own plan cannot count the rest;
   * absent, the parent's plan is counted exactly as before.
   */
  chainCarriedTests?: number;
}): { plan: ResealPlan | null; reason: string | null } {
  const parent = input.parent;
  if (parent === null) return { plan: null, reason: null };
  if (!input.enabled) {
    return {
      plan: null,
      reason: resealRefusal('the re-seal path is off (`enforcement.reseal` is not true)'),
    };
  }
  if (parent.kind === 'receipt' && parent.receipt !== null) {
    // A re-seal parent is a whole-suite proof in its own way: it names
    // the parent it carried from and seals a `coveredObligation-
    // Fingerprints` list covering the whole repository, so the next
    // re-seal carries from exactly the same coverage. A plain slice
    // covers less, and a plain full run is graded in full.
    const isReseal = parent.receipt.changeClass === 'test-only' && parent.receipt.resealedFrom !== undefined;
    if (isReseal) {
      const covered = new Set(parent.receipt.coveredObligationFingerprints ?? []);
      const uncovered = input.obligations
        .map((obligation) => obligationFingerprint(obligation))
        .filter((fingerprint) => !covered.has(fingerprint));
      if (uncovered.length > 0) {
        return {
          plan: null,
          reason: resealRefusal(
            `the previous re-seal covered ${String(input.obligations.length - uncovered.length)} of ` +
            `${String(input.obligations.length)} obligation(s), so it proves no whole-suite run`,
          ),
        };
      }
    } else if (receiptScope(parent.receipt) !== 'full') {
      return { plan: null, reason: resealRefusal('the previous receipt sealed a slice, not a whole-suite run') };
    } else if (parent.receipt.verdictSummary.total !== input.obligations.length) {
      return {
        plan: null,
        reason: resealRefusal(
          `the previous receipt graded ${String(parent.receipt.verdictSummary.total)} obligation(s) ` +
          `while this candidate declares ${String(input.obligations.length)}`,
        ),
      };
    }
  } else if (parent.execution.planned.length === 0) {
    // A run record is only a whole-suite parent when the run it
    // describes actually planned the suite. Obligations cannot have
    // drifted under it either: the record binds the trusted policy and
    // the owner-approved policy digest this run is pinned to.
    return { plan: null, reason: resealRefusal("the previous run's record planned no test, so it proves no whole-suite run") };
  }
  const classification = classifyResealChange({
    gitDir: input.gitDir,
    env: input.io.env,
    cwd: input.io.cwd,
    parentTreeId: parent.treeId,
    currentTreeId: input.currentTreeId,
    testFiles: [...new Set(input.catalog.entries.map((entry) => entry.file))],
    // The two sealed COMMIT trees say which paths are tracked SOURCE, and
    // the classifier needs them for a decision that has nothing to do with
    // an owner declaration: a declared browser state counts as generated
    // output only when neither commit tracks it. So they travel on their
    // own terms, whenever both exist — an owner declaration merely adds
    // the second use of the same reading.
    ...(input.currentCommitTreeId !== undefined && parent.sha.length > 0
      ? { parentCommitTreeId: `${parent.sha}^{tree}`, currentCommitTreeId: input.currentCommitTreeId }
      : {}),
    ...(input.runtimeFileGlobs !== undefined ? { runtimeFileGlobs: input.runtimeFileGlobs } : {}),
    ...(input.inputFiles !== undefined ? { inputFiles: input.inputFiles } : {}),
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
      reason: resealRefusal(
        `the previous ${previousRun ? 'run' : 'receipt'}'s test ${planned.logicalKey} no longer exists and ` +
        'no changed file explains it',
      ),
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
          ? resealRefusal(`the previous run's test ${planned.logicalKey} failed outside the affected set`)
          : resealRefusal(`the previous receipt's test ${planned.logicalKey} did not pass outside the affected set`),
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
      // A parent that is itself a re-seal planned only the tests IT
      // re-ran, so the chain's own count is authoritative; a
      // whole-suite parent counts the same way from its own plan.
      carriedTests:
        input.chainCarriedTests ??
        parent.execution.planned.filter(
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

  // The existing owner-pinned runtime declaration names test inputs too.
  // Values come only from the operator, never from candidate configuration.
  // Checked HERE, before a harness command, the pipeline, or the
  // candidate's own runner configuration runs: a reserved control this
  // run refuses must never reach candidate code first.
  const declaredRunnerEnvNames = loadRuntimeConfigAt(io.cwd, config.runtime)?.envAllowlist;
  if (declaredRunnerEnvNames !== undefined) {
    for (const name of declaredRunnerEnvNames) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
          /^(?:GATEFORGE_|NODE_OPTIONS$|NODE_PATH$|LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|BASH_ENV$|ENV$)/i.test(name)) {
        throw new UsageError(
          `test-gates: runtime envAllowlist cannot grant '${name}' to test code; ` +
          'engine wiring and process-loader controls stay outside the runner',
        );
      }
    }
  }

  // A merge-request pipeline with no base commit resolves the `auto`
  // provider to the local staged diff: zero changed files, and a gate
  // that fails an hour later on debt nobody changed. Refuse in seconds,
  // before a harness starts or a witness is spawned.
  if (options.scope === 'changed') {
    const refusal = mergeRequestScopePreflight(config, io.env);
    if (refusal !== null) throw new UsageError(refusal);
  }
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
    runCode = await runSupervisedTestGatesInner(io, options, declaredRunnerEnvNames);
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
 * names the test and its expiry. An expired
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
 * Writes the WITNESS-ISSUED ledger into the run's `records.json` after
 * the supervisor drain has finalized every session.
 *
 * The Playwright reporter may copy the ledger for its advisory output
 * before the final drain sweep issues Observe or server-persistence
 * records. Every runner therefore uses this final trusted fetch while
 * the witness is alive. A transport failure writes nothing and names
 * itself on stderr; unissued evidence can never receive credit.
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

/**
 * The directory the native playwright child runs from: the directory
 * holding the config enumeration selected (the repo root for a
 * root-level config, the project directory for a nested one). It is the
 * base every relative path the suite itself writes or reads resolves
 * from, so the gate's own checks must use it rather than the repo root.
 */
function nativePlaywrightConfigDir(cwd: string): string {
  const config = findPlaywrightConfig(cwd);
  return config === null ? cwd : dirname(resolve(cwd, config));
}

async function runSupervisedTestGatesInner(
  io: Io,
  options: SupervisedOptions,
  declaredRunnerEnvNames: readonly string[] | undefined,
): Promise<number> {
  const { out, format, witnessUrl, runTimeoutMs } = options;
  // The stall bound: the caller's value wins (the CLI entry resolved it
  // from `runtime.yml`), the document is re-read for an in-process
  // caller that has no value of its own (the commit hook), and the
  // engine default stands when neither declares one.
  const stallTimeoutMs = options.stallTimeoutMs ?? runtimeStallTimeoutMs(io.cwd);
  // The reuse digest is the IDENTITY of the dependency bytes this run
  // executes against, and it must be the same value whoever computes it.
  // ONE resolver owns that value: the commit hook hands over the digest
  // `prepareRuntime` bound AFTER the staged links were made, and every
  // other surface reads the declared `prepare.reuse` roots of the same
  // runtime document through `resolveRuntimeReuseDigest` — which
  // `computeInputSnapshot` itself calls for `check`, `next` and `tests`
  // when they hand it no digest, so no surface can seal one identity and
  // verify another. A document that cannot be read, or that declares no
  // reuse root, binds nothing — the staged candidate is where a declared
  // root is prepared, and an unbound run fails closed there.
  const config = loadConfigAt(io.cwd);
  // The `??` here is not a second identity rule: it only lets the
  // declared roots below stand in when a mounted caller bound nothing at
  // all, which is also the value the reuse-drift guards compare against.
  const runtimeReuseDigest = options.runtimeReuseDigest ?? resolveRuntimeReuseDigest(io.cwd, config.runtime);
  const runtimeReuseMounts = options.runtimeReuseMounts ?? [];
  // The configured runner (plan 2026-09-25, runner-agnostic evidence):
  // `playwright` (the default) keeps the byte-identical supervised path;
  // pytest/vitest/cypress enumerate, execute, and report through the
  // RunnerAdapter contract behind the SAME witness session, run token,
  // supervision, receipts, and strictness machinery.
  const runnerName = config.runner;
  // The timing-chaos plan for THIS run (E63). Null without the flag:
  // then the witness is spawned with no plan and every byte of the run
  // is exactly what it was before chaos existed. The bounds come from
  // `run.chaos` either way: a SPAWNED witness is configured with them
  // in its environment, an EXTERNAL one through the run-context
  // binding. The run owns the plan in both cases.
  const chaosRun: ChaosRun | null =
    options.chaos === undefined || options.chaos === null ? null : chaosRunOf(config, options.chaos.seed);
  // The schedule the witness actually used (filled in before it stops);
  // null until then, and for every run without `--chaos`.
  let chaosSchedule: ChaosScheduleResponse[] | null = null;
  // Twin path coverage (E64): the divergences this run found, filled in
  // from the witness's recorded shapes before it stops. Empty for every
  // run without `enforcement.twinPaths`, and empty again when a linked
  // pair did not both run — a divergence needs two sides observed in
  // the SAME run, never shapes carried over from another.
  let twinDivergences: TwinDivergence[] = [];
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
  // Owner-chosen strictness. Absent key =
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
  // The graded scope, published to the in-runner reporter BEFORE the
  // suite starts: a reporter that graded a selection must not print a
  // repository verdict. Debt itself is the gate's alone — the reporter
  // has no waivers, no scope and no baseline, so it never grades it.
  const runScope: 'full' | 'changed' | 'named' =
    options.testSelectors !== undefined ? 'named' : options.scope === 'changed' ? 'changed' : 'full';
  writeRunScopeView(stateDir, runScope);
  const adoptedBaseline = resolveAdoptedBaseline(io.cwd, config.baselines);
  // Owner quarantine: loaded against the
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
  //
  // The walk is taken ONCE with its ENTRIES, not just its id: the global
  // preparation freeze below compares those exact baseline bytes against
  // the prepared candidate, so the baseline assertion and the index
  // guard keep reading the same raw inventory the freeze reads.
  const freezeGitDir = resolveGitDir(io.cwd, io.env);
  const baselineSnapshot: CandidateTreeSnapshot | null =
    freezeGitDir === null
      ? null
      : computeCandidateTreeSnapshot(
          freezeGitDir,
          io.cwd,
          io.env,
          stateDir,
          'record',
          runtimeReuseMounts,
          docsExclusions,
          cacheExclusions,
        );
  const frozenTreeId = options.fixedCandidateTreeId ?? baselineSnapshot?.treeId ?? null;
  const frozenParentSha = options.fixedParentSha !== undefined ? options.fixedParentSha : parentSha(io.cwd);

  // 2. Catalog + mappings (Phase 3 resolver) → expected set + claim
  // injections + typed mapping blockers. A failed discovery blocks the
  // gate (E16) — never an empty-success fallback.
  let discoveryError: string | null = null;
  let catalog: TestCatalog | null = null;
  let nativeClaims: Claim[] = [];
  let nativeErrors: string[] = [];
  let nativeInstances: NativeInstance[] = [];
  // The project dependency graph the enumeration captured from the
  // RUNNER's resolved config (`setup` depends on nothing, the projects
  // that read its artifact depend on `setup`). Empty when the
  // enumeration could not read it — absence, never a guessed empty one.
  let projectDependencies: Record<string, string[]> = {};
  // Whether the enumeration actually READ the runner's resolved project
  // graph. The map itself is defaulted to `{}` so every existing caller
  // keeps working, but `{}` and "unreadable" are different facts: the
  // global preparation freeze may only derive an ordering from a graph it
  // really captured, so absence is carried separately and never guessed.
  let projectGraphCaptured = false;
  // The `use.storageState` path each project declared, as the RUNNER
  // resolved it: the standard auth pattern's dependent project reads the
  // state its setup project saved. Empty when the enumeration captured
  // none — absence, never a guessed empty one.
  let projectStorageStates: Record<string, string> = {};
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
    const discovered = await discoverTestCatalog({
      cwd: io.cwd,
      config,
      collectPytest: true,
      // The state directory this run ACTUALLY resolved (`--out` aware):
      // the supervised run's own generated config — and, for a
      // repository carrying one, an earlier build's freeze control files
      // — must not be harvested back as declared tests on a repeat run.
      excludeFile: engineGeneratedStateFileFilter(io.cwd, stateDir),
    });
    catalog = discovered.catalog;
    nativeClaims = discovered.nativeClaims;
    nativeErrors = discovered.nativeErrors;
    nativeInstances = discovered.nativeInstances;
    projectDependencies = discovered.projectDependencies ?? {};
    projectStorageStates = discovered.projectStorageStates ?? {};
    projectGraphCaptured = discovered.projectDependencies !== undefined;
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
  // A declared state is honored as DATA, and only when it names a file
  // inside the candidate. A relative declaration is resolved from the
  // native config directory — the cwd the suite's own setup test wrote
  // the file from — while the candidate root stays the containment
  // boundary. Refused here, loudly and before anything is spawned,
  // because dropping it instead would run the project logged out and
  // report a green gate over a suite that never really exercised the
  // authenticated UI. With an operator's whole-run
  // GATEFORGE_SESSION_STATE set, no declaration is used at all, so none
  // is read or checked either — precedence means the losing value never
  // reaches the filesystem.
  if (io.env['GATEFORGE_SESSION_STATE'] === undefined) {
    const nativeConfigDir = nativePlaywrightConfigDir(io.cwd);
    for (const [project, declared] of Object.entries(projectStorageStates)) {
      try {
        resolveProjectStorageState(declared, io.cwd, project, nativeConfigDir);
      } catch (error) {
        throw new UsageError(`test-gates: ${(error as Error).message}`);
      }
    }
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
    // The two commands of one pipeline digest DIFFERENT trees: this one
    // digests the working tree, `check --staged` digests the staged
    // index. While a policy input is modified-but-unstaged they compute
    // different digests, so the single owner-approved pin that satisfies
    // the commit gate refuses HERE, and the remedy the commit gate prints
    // (`test-gates --changed`) is the command this refusal blocks. Name
    // the offending files and the remedy that actually clears it.
    if (policyGate.cause === 'ENFORCEMENT_UNTRUSTED') {
      const unstaged = unstagedPolicyInputs(io, config);
      if (unstaged !== null && unstaged.length > 0) {
        writeLine(
          io.stderr,
          'this run digests the WORKING TREE while `check --staged` digests the STAGED INDEX: ' +
            'while a policy input is modified-but-unstaged the two compute different digests, so one ' +
            `approved pin cannot satisfy both. Policy inputs differing between them: ${unstaged.join(', ')}`,
        );
        writeLine(
          io.stderr,
          'next action: stage them (`git add` the files above) and re-run, or commit or restore them — ' +
            'then re-pin outside the repository if the approved revision changed',
        );
      }
    }
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
  // The FULL planned set every narrowing selected from. The dependency
  // closure below reads it to pull in the tests of a `setup` project a
  // narrowed plan's dependent tests need (see
  // `plannedRowsWithProjectDependencies`).
  let allPlannedRows: PlannedRow[] = [];
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
  // The parent run's authenticated witness EVIDENCE, reduced to what
  // the carried tests proved: the union this run grades and seals is
  // this plus its own fresh records. Resolved at the re-seal decision,
  // BEFORE this run overwrites the state documents that hold it. In a
  // chain, several runs contributed to that union, so it keeps every
  // contributing run's envelope and the channel each one authorizes.
  let reSealParentEvidence: {
    records: unknown[];
    claims: unknown[];
    attestations: unknown[];
    contributions: readonly CarriedEvidenceContribution[];
    contributingRunIds: string[];
  } | null = null;
  // Hoisted: the validated sidecar, the only declaration source the
  // witness-side case assignments are built from.
  let behaviorSidecar: TestMap | null = null;
  if (catalog !== null) {
    const mapped = await resolveRepositoryMappings({
      cwd: io.cwd,
      config,
      obligations: pipeline.policy.obligations,
      stateDir,
      catalog,
      nativeClaims,
      behaviorCatalog: pipeline.behaviorCatalog,
      nativeErrors,
      nativeInstances,
    });
    behaviorSidecar = mapped.sidecar;
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
    allPlannedRows = fullPlannedRows;
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
      // The parent is bound to the commit the parent document itself
      // names, which must be an ancestor of HEAD: a merge request's
      // diff base is a different commit, and no CI variable names the
      // one the previous pipeline tested.
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
              baseSha: '',
              parentCommitBinding: 'own-ancestor-commit',
              repositoryFingerprints: [
                ...new Set(pipeline.policy.obligations.map((obligation) => obligationFingerprint(obligation))),
              ].sort(),
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
              reason: resealRefusal(
                `the run state already retains ${String(RESEAL_CHAIN_MAX_HOPS)} consecutive re-seals, the ` +
                'bound this path may chain to',
              ),
            }
          : decideTestOnlyReseal({
              io,
              gitDir: freezeGitDir as string,
              parent: reSealParentCandidate,
              currentTreeId: frozenTreeId as string,
              catalog,
              obligations: pipeline.policy.obligations,
              enabled: config.enforcement?.reseal === true,
              ...(config.enforcement?.resealRuntimeFiles !== undefined
                ? { runtimeFileGlobs: config.enforcement.resealRuntimeFiles }
                : {}),
              // The commit this run froze is the receipt's own `gitSha`:
              // it, and the parent's, are the two commit trees that say
              // which paths are TRACKED. Absent (outside a checkout) the
              // declaration can hide nothing, so the classifier refuses
              // exactly as it does without it.
              ...(pipeline.manifest.gitSha !== null
                ? { currentCommitTreeId: `${pipeline.manifest.gitSha}^{tree}` }
                : {}),
              // The input inventory is what separates generated output from
              // authority: a declared browser state the digest binds is
              // never carried as a generated-state change. Absent (no
              // usable snapshot) the classifier simply holds no inventory.
              ...(preFiles !== null ? { inputFiles: new Set(preFiles.map((entry) => entry.path)) } : {}),
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
          `test-gates: the previous run cannot be re-sealed from: ${reSealParentLookup.reason} ${RESEAL_REFUSAL_SUFFIX}`,
        );
      }
      reSealPlan = reSeal.plan;
      reSealParent = reSeal.plan === null ? null : reSealParentCandidate;
      // What the WHOLE chain carries: a parent that is itself a
      // re-seal planned only the tests it re-ran, so its own plan
      // cannot count the rest. Absent a retained chain, the plan's own
      // count stands (a whole-suite parent, exactly as before).
      const reSealCarried =
        reSealPlan === null
          ? null
          : retainedChainCarriedTests({ stateDir, childFiles: reSealPlan.affectedFiles });
      if (reSealPlan !== null && reSealCarried !== null) {
        reSealPlan = { ...reSealPlan, carriedTests: reSealCarried.count };
      }
      // The parent's witness EVIDENCE is the copy the run RETAINED when
      // it sealed its own receipt or run record — never the live state
      // documents, which any run in between (a materialization
      // pre-step that rewrites `manifest.json`, a hand-picked
      // selection) has already overwritten. A re-seal carries a carried
      // test's outcomes AND the records those outcomes were witnessed
      // with — and in a chain, the records EVERY contributing run
      // witnessed, each under its own envelope.
      if (reSeal.plan !== null && reSealParent !== null) {
        const retained = readRetainedParentEvidence(stateDir);
        const contributors =
          retained === null
            ? null
            : retainedEvidenceContributors({
                stateDir,
                parent: { kind: reSealParent.kind, receipt: reSealParent.receipt, record: reSealParent.record },
                parentAttestation: retained.attestation,
                verifierKeyring,
              });
        const authenticated =
          retained === null || contributors === null
            ? { ok: false as const, reason: 'it retains no copy of the evidence its own document sealed' }
            : contributors.reason === null
              ? authenticateContributingEvidence(
                  retained,
                  contributors.contributors,
                  verifierKeyring === null ? [] : verifierKeyring.keys.map((entry) => entry.key),
                )
              : { ok: false as const, reason: contributors.reason };
        // The envelopes of every contributing run, kept for the chain
        // hop this re-seal writes: each run's records are authorized by
        // its own envelope and by nobody else's.
        const contributorAttestations =
          contributors?.contributors.map((contributor) => contributor.attestation) ?? [];
        if (!authenticated.ok) {
          writeLine(
            io.stderr,
            `test-gates: the previous run cannot be re-sealed from: ${authenticated.reason} ${RESEAL_REFUSAL_SUFFIX}`,
          );
          reSealPlan = null;
          reSealParent = null;
        } else {
          const identities =
            reSealCarried?.identities ?? carriedTestIdentities(reSealParent.execution, reSeal.plan.affectedFiles);
          const carriedFiles = reSealCarried?.files ?? new Set(
            reSealParent.execution.outcomes
              .filter((outcome) => !reSeal.plan?.affectedFiles.includes(outcome.file))
              .map((outcome) => outcome.file),
          );
          // A witness-issued record is stamped with the CLAIMING test's
          // identity, which for a mapped test is the mapping key: the
          // trusted resolution of this very run, never the record's word.
          for (const group of gradedResolution?.obligations ?? []) {
            for (const binding of group.bindings) {
              if (binding.instances.some((instance) => carriedFiles.has(instance.file))) {
                identities.add(binding.logicalKey);
              }
            }
          }
          const carriedDocuments = carriedEvidenceDocuments(authenticated.evidence, identities);
          reSealParentEvidence = {
            ...carriedDocuments,
            attestations: contributorAttestations,
            contributions: authenticated.evidence.contributions,
            contributingRunIds: [...new Set(authenticated.evidence.contributions.map((entry) => entry.runId))],
          };
          writeResealChainParentEvidence(stateDir, reSealParentEvidence);
        }
      }
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
  // Twin path coverage (E64): the linked raw/witnessed pairs this run
  // should compare, resolved BEFORE the suite runs so the witness can
  // wire the proxy and mark the raw twins' sessions observation-only.
  // Absent `enforcement.twinPaths` this is empty and the run is
  // byte-identical to a repository that never heard of twins.
  const twinPathsMode = config.enforcement?.twinPaths ?? null;
  const twinLinks: TwinLink[] =
    twinPathsMode === null || catalog === null
      ? []
      : twinLinksFor(
          catalog.entries.map((entry) => ({ logicalKey: entry.logicalKey, title: entry.title })),
          Object.fromEntries(
            (behaviorSidecar?.tests ?? [])
              .filter((entry): entry is TestMapEntry & { twinOf: string } => entry.twinOf !== undefined)
              .map((entry) => [entry.key, entry.twinOf]),
          ),
        );
  // Twin coverage is only WORTH wiring when there is a pair to compare:
  // with the option on and no link, the run records no shape, writes no
  // inventory and adds no report key — byte-identical to a run that
  // never heard of twins.
  const twinComparisonOn = twinPathsMode !== null && twinLinks.length > 0;
  // The raw twins' REGISTERED identities (project, file, titlePath) —
  // not their runner test ids. The id the catalog enumerated is not the
  // id the test runs under: Playwright hashes the test's file path
  // relative to the config it loaded, so a supervised run driving a
  // trusted config from another directory mints different ids from the
  // same tests. The identity is the join key both sides speak.
  const twinRawIdentities = new Set<string>();
  for (const link of twinLinks) {
    const raw = plannedRows.find((row) => row.planned.logicalKey === link.raw);
    if (raw !== undefined) {
      twinRawIdentities.add(
        `${raw.planned.project ?? ''}\u0000${raw.planned.file}\u0000${raw.planned.titlePath.join('>')}`,
      );
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
    // Bound to a `const` first: the plan below narrows on the ENUMERATION,
    // and a `let` that later feeds a closure reads as its own initializer
    // again. Nothing about the enumeration is assumed — an adapter that
    // cannot list its tests returns `status: 'unavailable'`, and that
    // plans nothing rather than planning a guessed half-set.
    const enumeration = await runnerAdapterFor(runnerName).enumerate(io.cwd);
    runnerEnumeration = enumeration;
    if (enumeration.status === 'discovered') {
      const enumeratedRows = enumeration.tests.map(plannedRowOfIdentity);
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
  // Dependency closure for a NARROWED plan (`--scope changed` or
  // `--test`): Playwright runs a dependency project's tests before the
  // dependent project, so a plan that selected only a `chromium` test
  // must also carry the `setup` project's tests. Without them the run
  // executes the dependent test with no auth artifact (it fails), and
  // the `dependencies` edge the synthesized config would emit names a
  // project that config does not define — which Playwright refuses to
  // load at all. The closure reads the FULL planned set, and a FULL run
  // (or a config with no dependencies) already contains those rows, so
  // this adds nothing and the plan is byte-identical. The added rows
  // are part of the plan from here on: they are registered in the
  // expected set, scoped per project, and counted in the scope line.
  plannedRows = plannedRowsWithProjectDependencies(plannedRows, allPlannedRows, projectDependencies);

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
          : `scope: full (${fullPlannedCount} planned tests) — add --scope changed for the ${affectedTestCount} tests affected by ${providerChangedFiles.length} changed files (provider: ${providerIdentity})`,
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
      baseline: adoptedBaseline,
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
      engineLine: reportEngineLine(),
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
      baseline: adoptedBaseline,
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
      engineLine: reportEngineLine(),
      lifecycleDerivation: pipeline.lifecycleDerivation,
      diagnosticContext: {
        scope: namedTestIds !== null ? ('named' as const) : (options.scope ?? 'full'),
        candidateTreeId: frozenTreeId,
        inputDigest: expectedDigest,
        evidenceState: snapshotUnavailable ? 'snapshot-unavailable' : 'not-executed',
      // Nothing ran, so nothing was delayed: the seed is still named,
      // with an empty schedule, rather than a run that quietly forgets
      // it was asked to perturb timing.
      ...(chaosRun === null ? {} : { chaos: { ...chaosRun, schedule: [] } }),
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
  // The route inventory a recorded twin shape resolves against, so a
  // shape names a route template (`/accounts/{}`) and never a concrete
  // id. Written ONLY when a pair can actually be compared: a run with
  // the option on and no link adds no state file at all.
  const twinQueryKeys = config.enforcement?.twinQueryKeys ?? [];
  const twinInventoryPath = join(stateDir, 'twin-inventory.json');
  if (twinComparisonOn) {
    writeTwinInventory(
      twinInventoryPath,
      httpRoutes.map((route) => route.canonicalPath).filter((template) => template.length > 0),
    );
  }
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
        // Browser cache the ENGINE's own Chromium comes from. The
        // doctor and the run preflight read this same variable through
        // `io.env`, so it is forwarded explicitly rather than inherited
        // from `process.env`: an injected Io environment would
        // otherwise let the readiness checks inspect one cache while the
        // witness child launched from another, and the engine browser
        // would fail with "Executable doesn't exist" for a directory the
        // operator was just told was ready. An operator-chosen directory,
        // never a secret (same class as HOME).
        ...(io.env['PLAYWRIGHT_BROWSERS_PATH'] !== undefined && io.env['PLAYWRIGHT_BROWSERS_PATH'] !== ''
          ? { PLAYWRIGHT_BROWSERS_PATH: io.env['PLAYWRIGHT_BROWSERS_PATH'] }
          : {}),
        // Trusted fixture/actor provider (non-secret path): strong
        // behavior cases mint their fixtures and actor credentials from
        // the operator's approved module, engine-side. The suite never
        // sees it, and without it the cases block fail-closed.
        ...(io.env['GATEFORGE_FIXTURE_PROVIDER'] !== undefined &&
        io.env['GATEFORGE_FIXTURE_PROVIDER'] !== ''
          ? { GATEFORGE_FIXTURE_PROVIDER: io.env['GATEFORGE_FIXTURE_PROVIDER'] }
          : {}),
        // Engine-owned queue observer: the
        // witness reads the delivery queue itself, so a repository with a
        // `queueObserver` block hands it the approved declaration (the
        // connection material stays in the witness process). Without the
        // block nothing is passed and every `engine-task` case blocks
        // fail-closed — the spawn environment stays byte-identical.
        ...(config.queueObserver === undefined
          ? {}
          : {
              GATEFORGE_QUEUE_OBSERVER: config.queueObserver.kind,
              GATEFORGE_QUEUE_OBSERVER_CONFIG: JSON.stringify(config.queueObserver),
            }),
        // Suite-driven Observe claims need session-attributed traffic too.
        // Engine-driven Playwright repositories without these declarations
        // keep their existing proxy-free wiring.
        ...(runnerName === 'pytest' || runnerName === 'vitest' || runnerName === 'cypress' ||
        (runnerName === 'playwright' && observeObligations.length > 0)
          ? appBase !== ''
            ? { [ENV_PROXY_TARGET]: appBase }
            : {}
          : {}),
        // Timing chaos (E63): the seeded release plan, plus — for the
        // Playwright path, whose sessions are engine-browser scoped and
        // therefore proxy-free by default — the observation proxy the
        // plan delays. Both are strictly opt-in: without `--chaos` this
        // spawn is byte-identical to the one it always was.
        ...(chaosRun === null
          ? {}
          : {
              [ENV_CHAOS_SEED]: String(chaosRun.seed),
              [ENV_CHAOS_MAX_DELAY_MS]: String(chaosRun.maxDelayMs),
              [ENV_CHAOS_REORDER]: chaosRun.reorder ? 'on' : 'off',
              ...(appBase !== '' ? { [ENV_PROXY_TARGET]: appBase } : {}),
            }),
        // Twin path coverage (E64): the observation-only shape
        // recording, the owner's query-key allowlist and the route
        // inventory the shapes resolve against. Like chaos, the
        // Playwright path needs the observation proxy wired explicitly
        // (its sessions are engine-browser scoped and therefore
        // proxy-free by default), because a shape can only come from a
        // request the proxy saw. The raw twins themselves are NOT
        // listed here: their mark travels with the expected-set
        // registration, keyed by identity. With no link to compare this
        // spawn is byte-identical to the one it always was.
        ...(twinComparisonOn
          ? {
              [ENV_TWIN_SHAPES]: 'on',
              ...(twinQueryKeys.length > 0 ? { [ENV_TWIN_QUERY_KEYS]: twinQueryKeys.join(',') } : {}),
              [ENV_TWIN_INVENTORY]: twinInventoryPath,
              ...(appBase !== '' ? { [ENV_PROXY_TARGET]: appBase } : {}),
            }
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
  // The run OPTIONS (chaos, twin shapes) travel with the context, so a
  // repository that starts its OWN witness gets both features with
  // nothing configured on the witness side. A run that asks for
  // nothing sends no `options` key at all: the body is byte-identical
  // to what it always was.
  const runOptions: WitnessRunOptions = {
    ...(chaosRun === null ? {} : { chaos: chaosRun }),
    ...(twinComparisonOn
      ? {
          twinShapes: {
            queryKeys: twinQueryKeys,
            inventory: httpRoutes.map((route) => route.canonicalPath).filter((template) => template.length > 0),
          },
        }
      : {}),
  };
  let appliedOptions: AppliedWitnessOptions | null = null;
  if (
    effectiveWitnessUrl !== undefined &&
    witnessVerifierKey !== undefined &&
    expectedDigest !== null
  ) {
    appliedOptions = await bindWitnessContext(effectiveWitnessUrl, runToken, witnessVerifierKey, {
      runId: manifest.runId,
      invocationId,
      inputDigest: expectedDigest,
      ...(Object.keys(runOptions).length === 0 ? {} : { options: runOptionsJson(runOptions) }),
    });
  }
  // A witness that does not echo its options is older than them, and
  // this run would then perturb or compare nothing while reporting as
  // if it had. Say which, rather than reporting the fiction.
  if (chaosRun !== null && appliedOptions?.chaos == null) {
    if (spawnedWitness !== null) await stopWitnessProcess(spawnedWitness);
    throw new UsageError(
      `test-gates: --chaos ${String(chaosRun.seed)} needs a witness that accepts run options; the witness at ` +
        `'${effectiveWitnessUrl ?? ''}' confirmed no chaos plan, so no schedule was applied and this run would ` +
        'report a finding it never made — upgrade the witness',
    );
  }
  if (twinComparisonOn && appliedOptions?.twinShapes == null) {
    writeLine(
      io.stderr,
      'test-gates: twin path coverage needs a witness that accepts run options — this witness does not; ' +
        'pairs were not compared',
    );
  }
  // A witness that perturbs timing on its OWN (its environment, never
  // this run's binding) can never serve a run that seals.
  if (
    chaosRun === null &&
    witnessUrl !== undefined &&
    effectiveWitnessUrl !== undefined &&
    witnessVerifierKey !== undefined
  ) {
    await refuseChaosWitnessOnSealingRun(effectiveWitnessUrl, runToken, witnessVerifierKey);
  }
  // The compiled behavior catalog is a PRE-run fact, so the witness binds
  // it now — before any session opens — exactly like the run context. A
  // repository with no behavior document makes no call and runs
  // byte-identical; a refused bind fails the run instead of leaving every
  // behavior obligation silently unprovable.
  if (
    effectiveWitnessUrl !== undefined &&
    witnessVerifierKey !== undefined &&
    pipeline.behaviorCatalog !== null &&
    pipeline.behaviorCatalog.cases.length > 0
  ) {
    await registerWitnessBehaviorCatalog({
      witnessUrl: effectiveWitnessUrl,
      runToken,
      verifierKey: witnessVerifierKey,
      catalog: pipeline.behaviorCatalog,
      assignments: behaviorCaseAssignments(catalog ?? EMPTY_CATALOG, behaviorSidecar),
      routes: httpRoutes,
      authorityProfileDigest: engineBundleDigestOf(VERSION, trustedPolicy),
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
          ...(twinRawIdentities.has(`${test.project ?? ''}\u0000${test.file}\u0000${test.titlePath.join('>')}`)
            ? { observationOnly: true }
            : {}),
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
        // Twin path coverage (E64): a raw twin is marked by its
        // REGISTERED IDENTITY, which is the one part of a registration
        // that is the same in enumeration and execution. Its runner test
        // id is not: Playwright derives it from the test's file path
        // relative to the config it loaded, so an id enumerated from the
        // repository's own config is not the id the supervised run
        // opens the session with.
        ...(twinRawIdentities.has(
          `${instance.project ?? ''}\u0000${instance.file}\u0000${instance.titlePath.join('>')}`,
        )
          ? { observationOnly: true }
          : {}),
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
  // A record with NO prototype, not an object literal: the declared
  // runtime allowlist below carries arbitrary operator-chosen NAMES, and
  // `__proto__` is both a legal one and a property every plain object
  // inherits — assigning it to a literal stores no own key at all (the
  // inherited accessor swallows it), so the name would silently vanish
  // from the child's own baseline and the freeze controller could never
  // project a body worker back to it.
  const suiteEnv = Object.create(null) as Record<string, string>;
  suiteEnv['GATEFORGE_RUN_TOKEN'] = envRecord.GATEFORGE_RUN_TOKEN;
  suiteEnv['GATEFORGE_CLI_VERSION'] = VERSION;
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
  if (declaredRunnerEnvNames !== undefined) {
    for (const name of declaredRunnerEnvNames) {
      // OWN membership on the ambient environment, for the same reason the
      // record above has no prototype: a declared name is an arbitrary
      // name, and `__proto__`, `constructor` and `toString` are properties
      // every plain object inherits, so a plain lookup would put `Object`
      // or `Object.prototype` itself into the baseline for a variable the
      // operator never set.
      if (!Object.hasOwn(io.env, name)) continue;
      const value = io.env[name];
      if (value !== undefined && value !== '') suiteEnv[name] = value;
    }
  }

  // 6.1 The GLOBAL native preparation freeze: ONE native process, ONE
  // prepared candidate. A native prerequisite stage produces its
  // artifacts — the standard auth pattern's saved session above all —
  // WHILE the behavioral projects are already scheduled, so a candidate
  // frozen only before the spawn can never equal the workspace the bodies
  // actually run against. The engine therefore adds ONE controller
  // project, gives it the full upstream prerequisite closure of the
  // planned captured graph, gives every other planned project that
  // controller as a dependency, and freezes the candidate exactly once in
  // between. Nothing else moves: an operator's whole-run state still
  // outranks every declaration and bypasses this path exactly as before, a
  // run that planned no project has nothing to freeze, and a non-native
  // runner never enters it.
  const plannedScopes = plannedProjectScopes(plannedRows, projectDependencies, projectStorageStates);
  let freezePlan: NativeFreezePlan | null = null;
  let freezeTargets: GeneratedTargetClass | null = null;
  let freezePrerequisites: PrerequisiteIdentity[] = [];
  let freezeKeys: FreezeSigningKeyPair | null = null;
  let freezeNonce: string | null = null;
  // The barrier needs a REAL Playwright child: its own phase scheduler,
  // worker host and `playwright/test` module are what order the
  // controller between the prerequisites and the bodies. The predicate
  // is the same one the pack applies before it emits the controller
  // project, so both sides agree on whether a barrier is possible.
  const nativeRunnerCommand =
    runnerName === 'playwright' ? defaultPlaywrightCommand(io.cwd) : null;
  if (
    nativeRunnerCommand !== null &&
    plannedScopes.length > 0 &&
    isPlaywrightRunnerInstall(nativeRunnerCommand) &&
    io.env['GATEFORGE_SESSION_STATE'] === undefined
  ) {
    try {
      const plan = planNativeFreeze({
        projectScopes: plannedScopes,
        projectDependencies: projectGraphCaptured ? projectDependencies : undefined,
      });
      // An unavailable or ambiguous captured graph is refused BEFORE the
      // spawn: a half-known graph would order this run wrongly while
      // looking complete.
      if ('problem' in plan) throw new Error(plan.problem);
      freezePlan = plan.plan;
      const trackedPaths = freezeGitDir === null ? null : listTrackedPaths(freezeGitDir, io.env);
      if (trackedPaths === null) {
        throw new Error(
          'the tracked-path inventory could not be read, so no generated target can be told apart from source',
        );
      }
      freezeTargets = classifyGeneratedTargets({
        root: io.cwd,
        nativeConfigDir: nativeConfigDirOf(io.cwd),
        storageStates: projectStorageStates,
        tracked: trackedPaths,
        inputFiles: new Set((preFiles ?? []).map((entry) => entry.path)),
        docsExclusions,
        cacheExclusions,
      });
      freezeKeys = mintFreezeSigningKeyPair();
      freezeNonce = randomUUID();
      freezePrerequisites = plannedRows
        .filter(
          (row) =>
            row.planned.project !== null &&
            (freezePlan?.prerequisiteProjects.includes(row.planned.project) ?? false),
        )
        .map((row) => ({ file: row.planned.file, titlePath: [...row.planned.titlePath] }));
    } catch (error) {
      if (spawnedWitness !== null) await stopWitnessProcess(spawnedWitness);
      throw new UsageError(
        `test-gates: the global native preparation freeze refuses this run — ${(error as Error).message}`,
      );
    }
  }
  const armedFreeze =
    freezePlan === null || freezeTargets === null || freezeKeys === null || freezeNonce === null
      ? null
      : armFreezeControl({
          runId: manifest.runId,
          invocationId,
          nonce: freezeNonce,
          stateDir,
          // The SAME install this run spawns, so the generated controller
          // imports one consistent runner module (`@playwright/test`'s
          // package root, or `playwright/test`).
          testModulePath: playwrightTestModulePath(defaultPlaywrightCommand(io.cwd)),
          releasePublicKey: freezeKeys.publicKeyBase64,
          // The runner child's OWN environment, captured before any project
          // worker exists — the only honest baseline a body worker's
          // inherited preparation environment can be projected back to.
          baseEnv: supervisedRunnerChildEnv(suiteEnv, io.cwd),
          // The freeze controller's own wait for a release. Independent of
          // the run's own bounds: it must stay finite, and its ceiling is
          // the release wait, not the whole-run budget.
          timeoutMs: Math.min(Math.max(runTimeoutMs ?? FREEZE_RELEASE_WAIT_MS, 120_000), 900_000),
        });
  // The identity the freeze accepted, written by the handler below and
  // read once when this run seals. It is read through a NAMED accessor
  // on purpose: the handler runs from the drain's own callback, so the
  // assignment is not this function's straight line, and a compiler that
  // sees only the initializer would narrow the variable to `null` and
  // quietly seal the pre-run tree for a run that really froze a prepared
  // one. The accessor carries the union type explicitly, so the read is
  // the truth and not an inference about it.
  let preparedIdentity: PreparedCandidateIdentity | null = null;
  const acceptedPreparedIdentity = (): PreparedCandidateIdentity | null => preparedIdentity;

  // Per-project file selection (setup-dependency fix): the plan already
  // knows which files belong to which project, and project identity is
  // the join key the registered expected set speaks — so a
  // `{ name: 'setup', testMatch: … }` config cannot collect every selected
  // file under every project. Each scope also carries the dependency EDGES
  // the enumeration captured and the `use.storageState` PATH each project
  // declared, so the project that reads the saved session is handed it
  // while the setup project keeps running unauthenticated. An operator's
  // GATEFORGE_SESSION_STATE still outranks both (above).
  // The per-test completion sink the supervised run fills in before it
  // spawns. The drain below feeds it from the SAME event the `--progress`
  // stream consumes, so the stall watchdog and the progress stream share
  // one signal instead of two.
  const runActivity: RunActivity = {};
  const adapter = runnerName === 'playwright'
    ? new PlaywrightAdapter({
        config,
        discover: { excludeFile: engineGeneratedStateFileFilter(io.cwd, stateDir) },
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
          projectScopes: plannedScopes,
          ...(armedFreeze === null || freezePlan === null
            ? {}
            : {
                freeze: {
                  control: armedFreeze.control,
                  prerequisiteProjects: freezePlan.prerequisiteProjects,
                },
              }),
          // Operator-declared whole-run bound: absent, NO cap applies
          // (same expected set and completeness rules either way — only
          // the kill timer moves). The stall bound is the default backstop.
          ...(runTimeoutMs !== undefined ? { timeoutMs: runTimeoutMs } : {}),
          ...(stallTimeoutMs !== undefined ? { stallTimeoutMs } : {}),
          activity: runActivity,
        },
      })
    : null;

  if (adapter !== null) {
    // Registration must be identical under planning's scrubbed env and
    // the exact safe run variables before any Playwright test can execute.
    //
    // Either refusal ends this run BEFORE the supervised window, so it
    // never reaches the cleanup that follows the final control-spec pin.
    // The generated controller spec is removed here for the same reason
    // the witness is stopped here: a run that is over must leave nothing
    // of itself behind, whatever it refused on.
    try {
      const wiredNative: NativeListResult = await listNativePlaywrightTests({
        cwd: io.cwd,
        wiredEnv: suiteEnv,
      });
      const registrationDiff = diffNativePlaywrightTests(nativeInstances, wiredNative.instances);
      if (registrationDiff.scrubbedOnly.length > 0 || registrationDiff.wiredOnly.length > 0) {
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
    } catch (error) {
      if (spawnedWitness !== null) await stopWitnessProcess(spawnedWitness);
      if (armedFreeze !== null) removeFreezeSpecDir(armedFreeze.control);
      throw error;
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
  // The CI progress stream (additive): every line below is a fact the
  // supervisor already holds — the registered expected-set size, the
  // test identity the drain sees, the catalog title, the outcome, and
  // (for a failure) the runner's own first error line behind the
  // credential guard. Nothing here reads, filters, or tails runner
  // output, so the stream cannot carry a secret by construction. It is
  // off locally, and it decides nothing: no gate reads it.
  const progressTarget: ProgressTarget | null = resolveProgressTarget(
    options.progress,
    config.run?.progress,
    io.env,
  );
  const progress = new ProgressStream({
    writer: progressTarget,
    runner: runnerName,
    scope: runScope,
    expected: selection.logicalKeys.length,
    writeLine: (line: string) => writeLine(io.stderr, line),
    warn: (line: string) => writeLine(io.stderr, line),
  });
  // The trusted freeze handler. It runs OFF the drain's own serialization
  // (see `supervisor/drain.ts`): it waits for the supervisor to seal the
  // prerequisite sessions, and those seals are produced by that same
  // drain, so chaining this wait in front of them would deadlock.
  let drainHandle: SpoolDrainHandle | null = null;
  const handleFreezeRequest = async (request: unknown): Promise<void> => {
    if (
      freezePlan === null ||
      freezeTargets === null ||
      freezeKeys === null ||
      freezeNonce === null ||
      armedFreeze === null
    ) {
      throw new Error('this run armed no preparation freeze to serve');
    }
    // Every refusal this handler raises is ALSO written to the control
    // directory's refusal document. That document is failure-only by
    // construction — no controller path treats it as permission to
    // continue — so publishing it can only end the controller's wait
    // sooner, never satisfy it. Without it a permanent refusal (a
    // prerequisite that sealed failed, skipped, retried or duplicated)
    // would burn the controller's whole bound before failing anyway.
    try {
      await serveFreezeRequest(request);
    } catch (error) {
      writeFreezeRefusal(armedFreeze.control, (error as Error).message);
      throw error;
    }
  };
  const serveFreezeRequest = async (request: unknown): Promise<void> => {
    if (
      freezePlan === null ||
      freezeTargets === null ||
      freezeKeys === null ||
      freezeNonce === null ||
      armedFreeze === null
    ) {
      throw new Error('this run armed no preparation freeze to serve');
    }
    const accepted = acceptedFreezeRequest(request, {
      runId: manifest.runId,
      invocationId,
      nonce: freezeNonce,
      project: freezePlan.controllerProject,
    });
    if (typeof accepted === 'string') throw new Error(accepted);
    // (1) Every prerequisite must already be PROVEN passed under the
    // AUTHENTICATED supervisor trace. A genuine sealed pass with zero
    // witness activity counts: a setup project's honest job is to produce
    // an artifact, and admitting that artifact is exactly what the diff
    // below is for. No activity threshold is invented here.
    //
    // Only genuinely PENDING prerequisites are waited for (no session
    // yet). A prerequisite that already sealed as failed/skipped, that
    // opened more than one session, or whose trace cannot be read is
    // TERMINAL and refuses at once — waiting cannot change it, so the
    // bound is only there for a prerequisite the runner has not reached.
    const bound = Date.now() + Math.max(600_000, 120_000);
    let pending = ['the witness has not reported the prerequisite stage yet'];
    while (pending.length > 0) {
      if (Date.now() >= bound) {
        throw new Error(
          `the prerequisite stage did not report within the freeze's own bound (${pending.join('; ')})`,
        );
      }
      const trace = await supervisor.executionTrace();
      const state = unfrozenPrerequisiteState({
        trace: trace?.tests ?? null,
        prerequisites: freezePrerequisites,
      });
      if (state.refused.length > 0) throw new Error(state.refused.join('; '));
      pending = state.pending;
      if (pending.length > 0) await delay(100);
    }
    // (2) The input inventory must not have moved while the prerequisites
    // ran: this run will seal against the digest it pinned at discovery.
    if (!snapshotUnavailable && preFiles !== null) {
      const nowFiles = collectInputFiles(io.cwd, config, stateDir, runtimeReuseMounts, docsExclusions, cacheExclusions);
      const drift = diffInputFiles(preFiles, nowFiles);
      if (drift.length > 0) {
        throw new Error(
          `the input inventory moved during native preparation (${drift.slice(0, 3).join('; ')})`,
        );
      }
    }
    // (3) The control spec the CLI pinned BEFORE the run must still be
    // the bytes on disk, and the release document must not exist yet.
    // Both are checked BEFORE anything is snapshotted or signed: they
    // are inputs to the release decision, not consequences of it.
    //
    // The spec is GENERATED engine code and the controller can rewrite
    // its own file (it runs as a worker on this same host, from its own
    // private per-run directory), so a release signed over a digest
    // nothing re-checks would bind a control file nobody verified. The
    // CLI therefore compares the file itself, never the file's own
    // report of itself.
    const specBytesNow = readFileSync(armedFreeze.control.specPath);
    const specDigestNow = createHash('sha256').update(specBytesNow).digest('hex');
    if (specDigestNow !== armedFreeze.specDigest) {
      throw new Error(
        `the generated freeze controller spec no longer matches the bytes this run pinned (expected ` +
          `${armedFreeze.specDigest.slice(0, 12)}…, found ${specDigestNow.slice(0, 12)}…)`,
      );
    }
    // The publisher is ONE-SHOT per invocation and has not run yet: this
    // handler is the only writer of the release document, and it writes
    // it at the END of this function. A release file that already exists
    // when the request is accepted was therefore NOT written by this run
    // — it is a leftover, a replay of an earlier invocation's document,
    // or a forgery.
    //
    // Signing anyway would let the publisher OVERWRITE a planted
    // document, so a controller that read the planted bytes and a
    // controller that read the genuine ones would reach opposite
    // conclusions about one and the same run. Refusing here makes the
    // handshake deterministic instead: an unexpected release document
    // ends the barrier through the FAILURE-ONLY channel, naming its
    // path, and is never mistaken for the one positive signal that
    // unblocks a body. It grants no authority — the ephemeral signature
    // is still the only thing that can unblock a controller, and the
    // worker still verifies the release cryptographically.
    if (existsSync(armedFreeze.control.releasePath)) {
      throw new Error(
        `a freeze release document already existed at '${armedFreeze.control.releasePath}' when the controller ` +
          'asked to be frozen, so this run did not write it — an unexpected (planted, stale or replayed) release ' +
          'is never overwritten into a genuine one (fail closed)',
      );
    }
    // (4) ONE prepared snapshot, admitted against the frozen baseline:
    // only admissible generated-target additions and modifications pass.
    if (freezeGitDir === null || baselineSnapshot === null) {
      throw new Error('this run pinned no candidate baseline, so no prepared candidate can be frozen');
    }
    const preparedSnapshot = computeCandidateTreeSnapshot(
      freezeGitDir,
      io.cwd,
      io.env,
      stateDir,
      'record',
      runtimeReuseMounts,
      docsExclusions,
      cacheExclusions,
    );
    const violations = preparedCandidateViolations({
      root: io.cwd,
      baseline: baselineSnapshot.entries,
      prepared: preparedSnapshot.entries,
      targets: freezeTargets,
    });
    if (violations.length > 0) throw new Error(violations.join('; '));
    // (5) Publish. The ordering marker is appended FIRST so that every
    // body project's begin is provably later than the accepted freeze, then
    // the SIGNED release the controller verifies before it proceeds. The
    // private key never leaves this function's closure.
    appendFreezeReleaseEvent(spoolPathFor(stateDir, manifest.runId), {
      project: freezePlan.controllerProject,
      preparedTreeId: preparedSnapshot.treeId,
      specDigest: armedFreeze.specDigest,
    });
    drainHandle?.markFreezeRelease({
      preparedTreeId: preparedSnapshot.treeId,
      specDigest: armedFreeze.specDigest,
    });
    const sealedAt = new Date().toISOString();
    writeFileSync(
      armedFreeze.control.releasePath,
      `${canonicalFreezeJson(
        signFreezeRelease(freezeKeys.privateKey, {
          schemaVersion: 1,
          project: freezePlan.controllerProject,
          runId: manifest.runId,
          invocationId,
          nonce: freezeNonce,
          preparedTreeId: preparedSnapshot.treeId,
          specDigest: armedFreeze.specDigest,
          sealedAt,
        }),
      )}\n`,
      'utf8',
    );
    preparedIdentity = {
      preparedTreeId: preparedSnapshot.treeId,
      runId: manifest.runId,
      invocationId,
      nonce: freezeNonce,
      sealedAt,
    };
    options.onPreparedCandidate?.(preparedIdentity);
    writeLine(
      io.stderr,
      `prepared candidate frozen at ${preparedSnapshot.treeId.slice(0, 12)}… ` +
        `(${String(freezeTargets.eligible.size)} generated target(s) admitted)`,
    );
  };
  progress.start();
  const drain = startSupervisorSpoolDrain({
    // The GLOBAL preparation freeze rides the same pump: the controller's
    // request is noticed here, and the handler above owns every authority
    // decision the release depends on.
    ...(freezePlan === null || armedFreeze === null
      ? {}
      : {
          freeze: {
            controllerProject: freezePlan.controllerProject,
            bodyProjects: freezePlan.bodyProjects,
            requestPath: armedFreeze.control.requestPath,
            onRequest: handleFreezeRequest,
          },
        }),
    stateDir,
    runId: manifest.runId,
    witnessUrl: effectiveWitnessUrl,
    runToken,
    verifierKey: witnessVerifierKey,
    serverE2eObligations,
    observeObligations,
    onTestEvent: (event) => {
      const title = event.titlePath.join(' > ');
      if (event.kind === 'testBegin') {
        progress.beginTest(title);
        return;
      }
      // A worker-side end carries no outcome (the runner's reporter
      // still owes it): counting it would report a test twice.
      if (event.outcome === undefined) return;
      // The stall watchdog rides THIS event — the run's own per-test
      // completion signal — exactly as the progress stream below does.
      runActivity.onTestFinished?.(title);
      progress.endTest({
        logicalKey: `${event.file ?? ''}#${event.titlePath.join('>')}`,
        title,
        outcome: progressOutcomeOf(event.outcome),
        ...(event.errorMessage === undefined ? {} : { message: event.errorMessage }),
        ...(event.stackFrames === undefined ? {} : { stackFrames: event.stackFrames }),
      });
    },
  });
  // The handler closes over the handle so an accepted freeze can record
  // its own ordering marker identity; the assignment happens before the
  // first poll, and the handler only ever runs later.
  drainHandle = drain;
  let envelope: RunnerExecutionEnvelope;
  // The witness-side execution trace (review fix 2b) — THE execution
  // authority supervision grades completeness from. Fetched while the
  // witness is still up; `null` (unfetchable) blocks the run downstream.
  let sessionTrace: readonly TracedTestInput[] | null = null;
  let lifecycleConflicts: string[] = [];
  let intentFailures: string[] = [];
  // The FINAL control-spec verdict, decided in the `finally` below — at
  // the close of the supervised window, which is the last moment the
  // generated spec is read — and consumed below, after the run sealed.
  let controlSpecDrift: string | null = null;
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
        // These adapters publish NO per-test completion signal, so no
        // stall bound can be honoured for them; the whole-run bound stays
        // (operator's value, else the documented default). The Playwright
        // path above is the one with the stall watchdog.
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
    if (effectiveWitnessUrl !== undefined) {
      await writeWitnessLedgerDocument(io, stateDir, effectiveWitnessUrl, runToken);
    }
    if (chaosRun !== null && effectiveWitnessUrl !== undefined && witnessVerifierKey !== undefined) {
      // The replay record, read while the witness is still alive. A
      // chaos run that cannot explain its own schedule is a finding
      // nobody can reproduce, so a failed read says so out loud.
      try {
        const response = await fetch(`${effectiveWitnessUrl}/runs/chaos-schedule`, {
          headers: { [RUN_HEADER]: runToken, [VERIFIER_HEADER]: witnessVerifierKey },
        });
        if (response.ok) {
          const body = (await response.json()) as { chaos?: { schedule?: ChaosScheduleResponse[] } | null };
          chaosSchedule = body.chaos?.schedule ?? null;
        } else {
          writeLine(
            io.stderr,
            `test-gates: the chaos schedule could not be read (HTTP ${String(response.status)}) — this run still reports, without a replay record`,
          );
        }
      } catch (error) {
        writeLine(
          io.stderr,
          `test-gates: the chaos schedule could not be read (${(error as Error).message}) — this run still reports, without a replay record`,
        );
      }
    }
    if (twinComparisonOn && effectiveWitnessUrl !== undefined && witnessVerifierKey !== undefined) {
      // Twin path coverage (E64): the honest comparison. The shapes
      // come from the witness's own per-session proxies and are joined
      // to the catalog by the session's REGISTERED IDENTITY (project,
      // file, titlePath) — never by the runner test id, which is not
      // stable from enumeration to execution (Playwright derives it from
      // the test's file path relative to the config it loaded). A pair
      // is compared only when BOTH twins were observed in this run, and
      // a run that could not read them says so rather than reporting
      // twins that agree because nobody looked.
      const shapes = await supervisor.twinShapes();
      if (shapes === null) {
        writeLine(
          io.stderr,
          'test-gates: the recorded twin shapes could not be read — this run still reports, without the ' +
            'TWIN_PATH_DIVERGENT check (an unread comparison is never a passing one)',
        );
      } else {
        const logicalKeyByIdentity = new Map<string, string>();
        for (const row of plannedRows) {
          logicalKeyByIdentity.set(
            `${row.planned.project ?? ''}\u0000${row.planned.file}\u0000${row.planned.titlePath.join('>')}`,
            row.planned.logicalKey,
          );
        }
        const observed = new Map<string, { observationOnly: boolean; shapes: TwinShape[] }>();
        for (const twin of shapes.twins) {
          const logicalKey =
            twin.identity === null
              ? undefined
              : logicalKeyByIdentity.get(
                  `${twin.identity.project ?? ''}\u0000${twin.identity.file}\u0000${twin.identity.titlePath.join('>')}`,
                );
          if (logicalKey !== undefined) {
            observed.set(logicalKey, { observationOnly: twin.observationOnly, shapes: [...twin.shapes] });
          }
        }
        writeTwinShapes(
          stateDir,
          [...observed.entries()]
            .sort((left, right) => compareStrings(left[0], right[0]))
            .map(([logicalKey, entry]) => ({
              logicalKey,
              observationOnly: entry.observationOnly,
              shapes: entry.shapes,
            })),
        );
        // A pair both of whose tests are in this run but one side sent no
        // request through the witness was NOT compared; saying nothing
        // would read as "the twins agree".
        const inRun = new Set(namedTestIds ?? plannedRows.map((row) => row.planned.logicalKey));
        for (const link of twinLinks) {
          const witnessedShapes = observed.get(link.witnessed);
          const rawShapes = observed.get(link.raw);
          if (witnessedShapes === undefined || rawShapes === undefined) {
            if (inRun.has(link.witnessed) && inRun.has(link.raw)) {
              writeLine(io.stderr, twinPairNotComparedLine(link, witnessedShapes !== undefined, rawShapes !== undefined));
            }
            continue;
          }
          twinDivergences = [
            ...twinDivergences,
            ...twinPathDivergence(
              { logicalKey: link.witnessed, shapes: witnessedShapes.shapes },
              { logicalKey: link.raw, shapes: rawShapes.shapes },
            ),
          ];
        }
      }
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
    // The FINAL control-spec pin, and the LAST read of the spec.
    //
    // It runs here, at the close of the supervised window: after the
    // runner child exited and the drain stopped, so nothing can still be
    // executing the controller, and still before ANY receipt, result or
    // carried re-seal is accepted below — because everything downstream
    // of this point claims the prepared candidate was frozen under
    // control nobody replaced. The request-time check proved the pinned
    // bytes were intact before the release was signed; the bodies then
    // ran against that control. This is the same guard the synthesized
    // runner config gets in the pack (`supervised-run.ts`, pinned before
    // the spawn and compared again after the child exits) and it is
    // deliberately SEPARATE from it: the trusted config is the whole
    // authority the runner executes, while the control SPEC is the
    // handshake document, and one check does not cover the other.
    //
    // A control file that moved during the run is an integrity failure,
    // not a recoverable outcome: fail closed, name the path, write
    // nothing. As everywhere else here, this is a same-UID
    // replace-and-restore LIMIT, not a physical sandbox — an attacker
    // who restores the file between the two reads stays outside this
    // boundary.
    if (armedFreeze !== null) {
      let finalSpecDigest: string | null;
      try {
        finalSpecDigest = createHash('sha256').update(readFileSync(armedFreeze.control.specPath)).digest('hex');
      } catch {
        finalSpecDigest = null;
      }
      if (finalSpecDigest !== armedFreeze.specDigest) {
        controlSpecDrift =
          `the generated freeze controller spec at '${armedFreeze.control.specPath}' no longer matches the bytes ` +
          `this run pinned (expected ${armedFreeze.specDigest.slice(0, 12)}…, found ` +
          `${finalSpecDigest === null ? 'no readable file' : `${finalSpecDigest.slice(0, 12)}…`}), so the ` +
          'prepared candidate this run would seal cannot be shown to come from the control it froze under (fail closed)';
      }
      // The spec has served its run and nothing above this line reads it
      // again, so the private directory that held it goes now: no
      // generated engine file outlives the run inside the candidate's
      // own bytes. This `finally` covers every outcome of the supervised
      // window — a completed run, a refusal, an incomplete execution, a
      // throw — so none of them keeps it.
      removeFreezeSpecDir(armedFreeze.control);
    }
  }
  // The suite has finished: close the stream (grading follows) and keep
  // the screened failing-test diagnosis as a Gateforge-owned artifact,
  // so a CI job never has to publish the runner log to explain a red
  // test. Both happen only when the stream is on — a local run with the
  // stream off writes nothing new into the state directory.
  progress.finish();
  if (progressTarget !== null) {
    writeTestFailures(stateDir, manifest.runId, progress.failures);
  }
  // A local run has no stream, so the report is the only place its
  // operator will ever read WHY. The records are the same guarded ones
  // the stream prints (never runner output), and they are offered to
  // the report ONLY with the stream off — a stream that already named
  // the failures must not have them named twice.
  const localFailures: { title: string; message: string }[] =
    progressTarget === null
      ? progress.failures.map((failure) => ({ title: failure.title, message: failure.message }))
      : [];

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
    // Timing chaos (E63): the seed, its bounds and the schedule the
    // proxy used, so a red chaos run can be explained and replayed from
    // the sealed result alone. Absent without `--chaos`.
    ...(chaosRun === null
      ? {}
      : { chaos: { ...chaosRun, schedule: chaosSchedule ?? [] } }),
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
  // Twin path coverage (E64): the owner-chosen strictness of the
  // TWIN_PATH_DIVERGENT finding. `advisory` reports it and leaves the
  // exit code exactly what the run already decided; `block` makes it a
  // blocking entry. Absent configuration, or twins that agree, this is
  // empty and the report keeps exactly the keys it always had.
  const twinEntries: BlockingEntry[] = twinDivergences.map((divergence) => ({
    kind: 'finding' as const,
    resourceId: null,
    name: null,
    detail: twinDivergenceDetail(divergence),
    location: null,
    cause: 'TWIN_PATH_DIVERGENT' as const,
    nextAction: CAUSE_NEXT_ACTIONS['TWIN_PATH_DIVERGENT'],
  }));
  const twinAdvisories = twinPathsMode === 'block' ? [] : twinEntries;
  const twinBlocking = twinPathsMode === 'block' ? twinEntries : [];
  // An expired quarantine is ignored AND blocking: the owner let this
  // flake run long enough that nobody renewed it, so the required test
  // is back in the run and the stale escape hatch must be visible.
  const repositoryBlocking: BlockingEntry[] = [
    ...pipeline.policy.blocking,
    ...mappingBlockers,
    ...inventoryBlocking,
    ...expiredQuarantineBlocking(quarantines.expired),
  ];
  // The graded evidence of a re-seal is the UNION: the carried parent
  // records and claims plus this run's own. It is written to the run
  // state BEFORE grading, so the verdict summary the receipt seals and
  // every later `check` grade the exact same documents, and the
  // carriedEvidenceDigest below binds them.
  let carriedEvidenceDocumentsUnion: { records: unknown[]; claims: unknown[] } | null = null;
  if (reSealParentEvidence !== null) {
    const carriedClaims = new Set(
      reSealParentEvidence.claims.map((claim) => stringField(claim, 'testId')).filter((id): id is string => id !== null),
    );
    carriedEvidenceDocumentsUnion = {
      records: [
        ...reSealParentEvidence.records,
        ...readJsonArray(stateDir, 'records.json').filter(
          (record) => !reSealParentEvidence.contributingRunIds.includes(stringField(record, 'runId') ?? ''),
        ),
      ],
      claims: [
        ...reSealParentEvidence.claims,
        ...readJsonArray(stateDir, 'claims.json').filter((claim) => {
          const testId = stringField(claim, 'testId');
          return testId !== null && !carriedClaims.has(testId);
        }),
      ],
    };
    writeFileSync(join(stateDir, 'records.json'), `${JSON.stringify(carriedEvidenceDocumentsUnion.records, null, 2)}\n`, 'utf8');
    writeFileSync(join(stateDir, 'claims.json'), `${JSON.stringify(carriedEvidenceDocumentsUnion.claims, null, 2)}\n`, 'utf8');
  }
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
    // Every contributing run's own envelope, authenticated against the
    // identity and input digest the re-seal's own recomputation bound
    // it to.
    ...(reSealParentEvidence === null
      ? {}
      : { carriedEvidence: reSealParentEvidence.contributions }),
    // Goal 1: the supervised gate honors the adopted baseline through the
    // SAME fail-closed seam as `check` (no adoption record → nothing is
    // forgiven). Under strictE2E the evaluator still re-grades every
    // waived verdict to blocking — a waiver is not proof.
    baseline: adoptedBaseline,
    mappedCoverage,
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      expectedInvocationId: expectedDigest === null ? null : invocationId,
      requireInvocationId: true,
      changedInputs,
    },
  };
  const evaluatedBase = evaluateRun(evaluationInput);
  // Twin path coverage in `block` mode joins the run's OWN blocking set:
  // it appears in `blocking` (not only in `advisories`) and it fails the
  // run the way any other blocking finding does. In `advisory` mode this
  // is the base evaluation, byte-identical.
  const evaluated: typeof evaluatedBase =
    twinBlocking.length === 0
      ? evaluatedBase
      : { ...evaluatedBase, blocking: [...evaluatedBase.blocking, ...twinBlocking] };
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
  // The tree this run actually TESTED. Without the global native
  // preparation freeze that is the frozen pre-run tree, exactly as before;
  // with it, it is the ONE prepared candidate the freeze accepted after
  // the prerequisite stage — never a rebound baseline, and never a second
  // snapshot. Both the final drift check and the receipt bind this value.
  const testedTreeId = acceptedPreparedIdentity()?.preparedTreeId ?? frozenTreeId;

  // The test-only re-seal must hold against the tree this run actually
  // TESTED, and the fresh outcomes it issues must be EXACTLY the tests
  // that classification names — in BOTH directions. Before the global
  // preparation freeze the tested tree is the pre-run baseline the plan
  // was decided from; with the freeze it is the PREPARED candidate, and a
  // native preparation stage that restores a parent state target shrinks
  // the affected set after the plan was made. An affected file with no
  // fresh outcome leaves a claim nobody proved; a fresh outcome the
  // affected set does not name is proof the sealed classification does
  // not cover, and the independent chain check refuses exactly that as
  // EVIDENCE_STALE.
  //
  // So the classification is recomputed here from the SAME two sealed
  // trees a consumer recomputes from ONLY when the tested tree moved, the
  // seal binds THAT result, and an unchanged tested tree reuses the
  // plan's own classification rather than recomputing nothing new. Either
  // way the two-sided membership check runs on EVERY re-seal issuance, and
  // a mismatch is a targeted refusal naming every offending file and the
  // explicit full-fresh command — never a silent carry of proof that no
  // longer applies, and never a hop this run's own consumer will reject.
  let preparedReseal: ResealPlan | null = reSealPlan;
  let preparedResealRefusal: string | null = null;
  let preparedClassification: ResealChangeClassification | null = null;
  if (reSealPlan !== null && testedTreeId !== null && testedTreeId !== frozenTreeId && freezeGitDir !== null) {
    preparedClassification = classifyResealChange({
      gitDir: freezeGitDir,
      env: io.env,
      cwd: io.cwd,
      parentTreeId: reSealPlan.parentTreeId,
      currentTreeId: testedTreeId,
      testFiles: catalog === null ? [] : [...new Set(catalog.entries.map((entry) => entry.file))],
      // The two commit trees travel whenever both exist: they say which
      // paths are tracked SOURCE, which is what decides whether a
      // declared browser state the preparation stage rewrote counts as
      // generated output at all. An owner declaration only adds the
      // second use of the same reading, so it no longer gates them.
      ...(reSealPlan.parentSha.length > 0 && pipeline.manifest.gitSha !== null
        ? {
            parentCommitTreeId: `${reSealPlan.parentSha}^{tree}`,
            currentCommitTreeId: `${pipeline.manifest.gitSha}^{tree}`,
          }
        : {}),
      ...(config.enforcement?.resealRuntimeFiles !== undefined
        ? { runtimeFileGlobs: config.enforcement.resealRuntimeFiles }
        : {}),
      ...(preFiles !== null ? { inputFiles: new Set(preFiles.map((entry) => entry.path)) } : {}),
    });
  }
  if (reSealPlan !== null && testedTreeId !== null) {
    const recomputed = preparedClassification ?? reSealPlan.classification;
    if (!recomputed.eligible) {
      // A change set that no longer classifies against the PREPARED tree
      // is refused the same actionable way an uncovered carry is: the
      // offending path the classifier named, and the explicit full-fresh
      // command that re-runs everything against the prepared candidate.
      // The feature is never disabled and nothing is silently carried.
      preparedResealRefusal =
        `${recomputed.reason ?? 'the change set no longer classifies'} — the prepared candidate tree ` +
        `${testedTreeId.slice(0, 12)}… differs from the pre-run tree this re-seal was planned from; ` +
        're-run the full relevant suite (`gateforge test-gates --changed --scope full`) so every ' +
          'affected test executes against the prepared candidate';
      preparedReseal = null;
    } else {
      const freshFiles = new Set(plannedRows.map((row) => row.planned.file));
      const uncovered = recomputed.affectedTestFiles.filter((file) => !freshFiles.has(file)).sort();
      // BOTH directions, because the independent chain check requires
      // both. The second is what a preparation restore produces: the
      // state returns to its parent revision, the readers that change
      // dragged into the affected set drop back out of it, and the plan
      // made before that restore still executes them. Sealing anyway
      // issues a hop the very next `check` refuses, so it is refused
      // here, where every extra path and the fix can still be named.
      const affectedSet = new Set(recomputed.affectedTestFiles);
      const outside = [...freshFiles].filter((file) => !affectedSet.has(file)).sort();
      if (uncovered.length > 0 || outside.length > 0) {
        const freshen =
          're-run the full relevant suite (`gateforge test-gates --changed --scope full`) so the re-sealed ' +
          'receipt carries outcomes only for the tests its own classification names';
        if (uncovered.length > 0 && outside.length > 0) {
          preparedResealRefusal =
            'the executed set and the sealed affected set disagree in BOTH directions: this re-seal carried ' +
            `instead of re-running (${uncovered.join(', ')}) and re-ran test file(s) the affected set does ` +
            `not name (${outside.join(', ')}) — ${freshen}`;
        } else if (uncovered.length > 0) {
          // The prepared-drift wording is true only when the tested tree
          // actually moved. An unchanged tree has no preparation drift
          // to blame, so the reason names the membership mismatch itself
          // rather than inventing a cause for it.
          if (preparedClassification !== null) {
            preparedResealRefusal =
              `native preparation changed the tested bytes in a way that affects test file(s) this re-seal ` +
              `carried instead of re-running (${uncovered.join(', ')}) — re-run the full relevant suite ` +
              '(`gateforge test-gates --changed --scope full`) so every affected test executes against the ' +
              'prepared candidate';
          } else {
            preparedResealRefusal =
              `this re-seal carried test file(s) its own classification requires it to re-run ` +
              `(${uncovered.join(', ')}) — ${freshen}`;
          }
        } else {
          preparedResealRefusal =
            `this re-seal executed test file(s) the sealed affected set does not name (${outside.join(', ')}) — ` +
            freshen;
        }
        preparedReseal = null;
      } else {
        // Reuse the plan itself when the tested tree did not move: its
        // classification is already the one that applies, so rebuilding
        // an identical object would be a copy with no new information.
        preparedReseal =
          preparedClassification === null
            ? reSealPlan
            : { ...reSealPlan, classification: preparedClassification };
      }
    }
  }
  if (preparedResealRefusal !== null) {
    writeLine(io.stderr, `test-gates: ${resealRefusal(preparedResealRefusal)}`);
    // No receipt: a test-only seal over this prepared tree would claim
    // evidence for bytes the change set no longer supports.
    clearGateReceipt(stateDir);
    clearResealChain(stateDir);
    return 1;
  }
  if (controlSpecDrift !== null) {
    writeLine(io.stderr, `test-gates: ${controlSpecDrift}`);
    // Nothing downstream of this point may be accepted: the graded
    // report, the receipt, and the carried re-seal all claim this run
    // froze its candidate under a control nobody replaced. An
    // authoritative run therefore invalidates the receipt and the chain
    // it was about to extend; a result-only run owns neither, so its
    // precedence is untouched.
    if (!options.resultOnly) {
      clearGateReceipt(stateDir);
      clearResealChain(stateDir);
    }
    return 1;
  }
  const diagnosticContext = {
    scope: namedTestIds !== null ? ('named' as const) : options.scope,
    candidateTreeId: testedTreeId,
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
  // Report-side strictness + quarantine:
  // ADDITIVE only. A repository that never softened its gate and never
  // quarantined a test gets exactly the document it got before.
  const renderedReport = renderRun(evaluated.verdicts, {
    format,
    blocking: evaluated.blocking,
    // Twin path coverage (E64): reported, never blocking, in advisory
    // mode. An empty list adds no report key, so a run without twin
    // findings keeps exactly the document it always had.
    ...(twinAdvisories.length === 0 ? {} : { advisories: twinAdvisories }),
    waiverCounts: evaluated.waiverCounts,
    run: manifest,
    toolVersion: VERSION,
    engine: engineIdentity(),
    engineLine: reportEngineLine(),
    lifecycleDerivation: pipeline.lifecycleDerivation,
    execution: executionSummary,
    diagnosticContext,
    ...(options.resultOnly ? { outcome: 'partial-selection' as const } : {}),
    ...(namedSelections !== null ? { selectors: namedSelections } : {}),
    ...(chaosRun === null
      ? {}
      : { chaos: { ...chaosRun, ...(chaosSchedule === null ? {} : { schedule: chaosSchedule }) } }),
    ...(localFailures.length === 0 ? {} : { failedTests: localFailures }),
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
          ...(twinAdvisories.length === 0 ? {} : { advisories: twinAdvisories }),
          waiverCounts: evaluated.waiverCounts,
          run: manifest,
          toolVersion: VERSION,
          engine: engineIdentity(),
          lifecycleDerivation: pipeline.lifecycleDerivation,
          execution: executionSummary,
          diagnosticContext,
          ...(options.resultOnly ? { outcome: 'partial-selection' as const } : {}),
          ...(namedSelections !== null ? { selectors: namedSelections } : {}),
          ...(chaosRun === null
            ? {}
            : { chaos: { ...chaosRun, ...(chaosSchedule === null ? {} : { schedule: chaosSchedule }) } }),
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
   * Retains this run's own witness evidence for the re-seal that may
   * come for it: the records and claims it just produced, plus the
   * exact envelope the document it is about to seal binds by digest.
   *
   * The copy exists because the LIVE state cannot be trusted to still
   * hold them: a materialization pre-step rewrites `manifest.json`
   * (and the witness envelope with it) between this run and the re-seal,
   * and a run that writes records of its own replaces the documents.
   * It is retained only when the owner opted into the re-seal, so a
   * state directory without that opt-in is byte-identical to before.
   * It is replaced by the next run that seals a document here, and
   * removed with the one it belongs to.
   */
  const retainParentEvidence = (): void => {
    if (config.enforcement?.reseal !== true) return;
    writeRetainedParentEvidence(stateDir, {
      records: readJsonArray(stateDir, 'records.json'),
      claims: readJsonArray(stateDir, 'claims.json'),
      // The witness appends its envelope to the run manifest as it
      // shuts down, so the manifest is the honest source for a run
      // whose own live fetch was too late to see it: prefer the
      // fetched one, fall back to what the run state holds.
      attestation: liveAttestation ?? readRunAttestation(stateDir),
    });
  };
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
      resultTreeId !== testedTreeId ||
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
    // The record and the evidence copy a re-seal reads from it are
    // written together, or neither is: a record whose own evidence is
    // not beside it would be refused for a reason the owner cannot fix.
    retainParentEvidence();
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
    if (strictness.strictExitCode !== 0 && !options.resultOnly && !softened) {
      clearGateReceipt(stateDir);
      // A run that seals no receipt invalidates the re-seal chain with
      // it: the chain describes the parents of the receipt that is no
      // longer there, and its evidence was already overwritten by this
      // run's own. Leaving it behind would be read as a chain.
      clearResealChain(stateDir);
      // The retained parent evidence belongs to the receipt this run
      // just invalidated, exactly as the chain does: it is cleared here
      // and written again below, together with the run record that
      // replaces it.
      clearRetainedParentEvidence(stateDir);
    }
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
  if (resultTreeId !== testedTreeId) {
    writeLine(
      io.stderr,
      'test-gates: the workspace changed during the run ' +
        `(${testedTreeId ?? 'unborn'} → ${resultTreeId ?? 'unborn'}); ` +
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
    ...(preparedReseal === null
      ? {}
      : {
          ...(preparedReseal.parentKind === 'receipt'
            ? { carriedFrom: preparedReseal.parentSha, parentReceiptDigest: preparedReseal.parentDigest }
            : {}),
          resealedFrom: preparedReseal.parentDigest,
          resealedFromKind: preparedReseal.parentKind,
          changeClass: 'test-only' as const,
          carriedTests: preparedReseal.carriedTests,
          rerunTests: plannedRows.length,
          changedPaths: preparedReseal.classification.changedPaths,
          // Which of those paths the owner's runtime-file declaration
          // hid, and the consumer recomputes the list from the same
          // declaration — a difference is EVIDENCE_STALE.
          ...((preparedReseal.classification.disregardedPaths ?? []).length > 0
            ? { resealDisregarded: preparedReseal.classification.disregardedPaths }
            : {}),
          // The graded evidence union — the carried parent records and
          // claims plus this run's own — bound by the receipt MAC, so a
          // consumer recomputes it and demands the state evidence equal
          // it.
          ...(carriedEvidenceDocumentsUnion === null
            ? {}
            : { carriedEvidenceDigest: carriedEvidenceDigestOf(carriedEvidenceDocumentsUnion) }),
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
  // This receipt is now the parent, so the evidence copy a re-seal reads
  // is this run's own: written from the same envelope the receipt binds
  // by digest, and replacing whatever the previous parent left behind.
  retainParentEvidence();
  // The re-seal chain is additive run state: a re-sealed receipt keeps
  // its parent (receipt or run record, plus its execution result) and
  // the catalog its classification used, so a consumer can recompute
  // the re-seal with its own engine and key. Any other seal leaves no
  // chain behind.
  if (preparedReseal !== null && reSealParent !== null && catalog !== null) {
    writeResealChainHop(stateDir, {
      ...(reSealParent.receipt === null
        ? { runRecord: reSealParent.record, receipt: null }
        : { receipt: reSealParent.receipt, runRecord: null }),
      execution: reSealParent.execution,
      catalog,
      records: reSealParentEvidence?.records ?? [],
      claims: reSealParentEvidence?.claims ?? [],
      attestations: reSealParentEvidence?.attestations ?? [],
    });
  } else {
    clearResealChain(stateDir);
  }
  writeCandidateTreeEntries(stateDir, resultTreeSnapshot?.entries ?? []);
  writeLine(io.stderr, `receipt ${receipt.receiptId} sealed (complete run, evidence graded, inputs bound)`);
  if (preparedReseal !== null) {
    const disregarded = preparedReseal.classification.disregardedPaths ?? [];
    if (disregarded.length > 0) writeLine(io.stderr, `test-gates: ${resealDisregardNotice(disregarded)}`);
    writeLine(
      io.stderr,
      `only test files changed: re-ran ${String(plannedRows.length)} test(s), kept ${String(preparedReseal.carriedTests)} ` +
        `from the previous ${preparedReseal.parentKind === 'run-record' ? 'run' : 'receipt'}`,
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

/**
 * Normalizes one runner-reported outcome onto the stream's vocabulary.
 *
 * A skipped test is a skip in every runner (`skipped`, `pending`); an
 * expected failure is still a non-passing test, and anything the
 * vocabulary does not know is reported as a failure — never as a pass.
 *
 * Args:
 *   outcome: the status the runner adapter reported.
 *
 * Returns:
 *   ProgressOutcome: the outcome the progress stream counts.
 */
function progressOutcomeOf(outcome: string): ProgressOutcome {
  if (outcome === 'passed') return 'passed';
  if (outcome === 'skipped' || outcome === 'pending' || outcome === 'fixme') return 'skipped';
  return 'failed';
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
  // The one definition, over both halves this run evaluated: the
  // graded surface (what the exit code blocks on) and the whole
  // repository (what the report describes).
  const debt = repositoryDebtOf({
    verdicts: input.repositoryVerdicts,
    findings: input.repositoryBlocking,
    gradedVerdicts: input.selectedVerdicts,
    gradedFindings: input.selectedBlocking,
    unclaimed: input.unclaimed,
  });
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
    // The one definition: the split is read back from what the
    // evaluator actually graded, never recomputed beside it.
    repositoryDebt: debt,
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
 *     inputDigest from trusted caller memory, plus the additive run
 *     `options` (chaos / twin shapes) when this run asked for any.
 *
 * Returns:
 *   AppliedWitnessOptions | null: the options the witness confirmed it
 *   is applying, or null for a witness that does not echo them (an
 *   older build) — never a guess.
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
  body: { runId: string; invocationId: string; inputDigest: string; options?: JsonValue },
): Promise<AppliedWitnessOptions | null> {
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
    if (response.ok) {
      // The `applied` echo is how the run learns whether this witness
      // UNDERSTOOD the options. A witness older than them answers
      // without it, and the caller must say so rather than report a
      // comparison — or a schedule — that never happened.
      const confirmed = (await response.json().catch(() => null)) as { applied?: unknown } | null;
      return isAppliedWitnessOptions(confirmed?.applied) ? confirmed.applied : null;
    }
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
 * Builds the witness-side case assignments for this run: which compiled
 * behavior cases a given test may execute, keyed by the identity the
 * runner opens its session with (its own framework id, falling back to
 * the derived logical key exactly like the expected set does).
 *
 * The witness resolves `/behavior/execute` through this binding alone,
 * so it is supervisor-authenticated run input, never a suite-supplied
 * claim. A declaration whose test is absent from the current catalog
 * contributes no assignment (its test cannot open a session anyway);
 * a declaration without `caseIds` declares nothing.
 *
 * Args:
 *   catalog: the current discovered test catalog.
 *   sidecar: the validated `.gateforge/test-map.yml`, or null.
 *
 * Returns:
 *   Record<string, string[]>: session test id → sorted case ids.
 */
function behaviorCaseAssignments(
  catalog: TestCatalog,
  sidecar: TestMap | null,
): Record<string, string[]> {
  if (sidecar === null) return {};
  const identityByKey = new Map<string, string>();
  for (const row of catalog.entries) {
    // A catalog row without a runner-native identity is keyed by the
    // derived logical key, exactly like the registered expected set.
    const identity = row.parameterIdentity === null || row.parameterIdentity.length === 0
      ? row.logicalKey
      : row.parameterIdentity;
    identityByKey.set(row.logicalKey, identity);
  }
  const assignments: Record<string, string[]> = {};
  for (const entry of sidecar.tests) {
    if (entry.caseIds === undefined || entry.caseIds.length === 0) continue;
    const identity = identityByKey.get(entry.key);
    if (identity === undefined) continue;
    const merged = new Set(assignments[identity] ?? []);
    for (const caseId of entry.caseIds) merged.add(caseId);
    assignments[identity] = [...merged].sort(compareStrings);
  }
  return assignments;
}

/**
 * Binds the compiled behavior catalog to a wired witness (plan
 * 2026-09-19 §4.7): supervisor-authenticated
 * `POST /runs/behavior-catalog`, carrying the catalog, the case
 * assignments, the COMPLETE route inventory principal attribution needs,
 * and the engine-bundle authority-profile digest — all compiled by this
 * run, never read from the suite.
 *
 * Called only when a `behaviorPolicy` compiled at least one case: a
 * repository without one makes no call and its run is byte-identical.
 *
 * Args:
 *   witnessUrl: the wired witness base URL.
 *   runToken: the witness run token (outer auth gate).
 *   verifierKey: the witness verifier key (supervisor capability).
 *   catalog: this run's compiled behavior catalog.
 *   assignments: session test id → allowed case ids.
 *   routes: the complete derived `http.endpoint` inventory.
 *   authorityProfileDigest: the engine bundle + trusted policy digest.
 *
 * Throws:
 *   Error: fail closed when the witness refuses the registration or is
 *   unreachable. Without a bound catalog every behavior obligation stays
 *   `missing`, so a silent skip would be a lie; diagnostics name only
 *   the failure class, never verifier material.
 */
async function registerWitnessBehaviorCatalog(input: {
  witnessUrl: string;
  runToken: string;
  verifierKey: string;
  catalog: BehaviorCatalog;
  assignments: Record<string, string[]>;
  routes: readonly HttpRouteCandidate[];
  authorityProfileDigest: string;
}): Promise<void> {
  if (input.routes.length === 0) {
    throw new Error(
      'test-gates: the compiled behavior catalog cannot be bound — no http.endpoint route was ' +
        'discovered and principal attribution has no any-endpoint fallback; no behavior case can execute without it',
    );
  }
  let body: BehaviorCatalogRegistration;
  try {
    body = BehaviorCatalogRegistrationSchema.parse({
      catalog: input.catalog,
      assignments: input.assignments,
      routes: input.routes.map((route) => ({
        resourceId: route.resourceId,
        method: route.method,
        // Route shapes use `{}` wildcards (core pathMatchesShape), so a
        // graph path written with a named parameter (`:id`, `{id}`) is
        // registered in that grammar.
        canonicalPath: route.canonicalPath
          .split('/')
          .map((segment) => (/^:[^/]+$/.test(segment) || /^\{[^/{}]+\}$/.test(segment) ? '{}' : segment))
          .join('/'),
      })),
      authorityProfileDigest: input.authorityProfileDigest,
    });
  } catch (error) {
    const first = (error as Error).message.split('\n')[0] ?? 'unknown schema error';
    throw new Error(
      `test-gates: the compiled behavior catalog is not registrable (${first}); no behavior case can execute without it`,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${input.witnessUrl}/runs/behavior-catalog`, {
      method: 'POST',
      headers: {
        'x-gateforge-run': input.runToken,
        'x-gateforge-verifier': input.verifierKey,
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
      `test-gates: witness ${input.witnessUrl} refused the behavior-catalog bind (HTTP ${String(status)})${detail}; ` +
        'no behavior case can execute without it',
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('test-gates: witness')) throw error;
    throw new Error(
      `test-gates: witness ${input.witnessUrl} behavior-catalog bind failed (transport): ${(error as Error).message}`,
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
