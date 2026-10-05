
/** No `ui.action` anchor to pair with: the observe channel's record is its own anchor. */
const OBSERVE_ANCHORS: readonly unknown[] = [null];

/**
 * The two adapter advisories a run reports, neither of which blocks:
 *
 * - ADAPTER_CANNOT_WITNESS: a create obligation whose adapter can
 *   neither list the collection nor bind a natural key. The engine
 *   cannot prove such a create — a row that is absent from a partial
 *   or missing list proves nothing (E4). A finding, not a new blocking
 *   default: the obligation still fails on its own evidence.
 * - ADAPTER_VOLATILE_FIELD_SKIPPED: the exact-value echo skipped a
 *   field the adapter DECLARES server-computed (E18a). Either evidence
 *   channel qualifies: the browser channel's `ui.action` entered input,
 *   or the observe channel's witness-observed request fields (a
 *   `persistence.observed` record has no `ui.action` anchor). Only keys
 *   the journey actually sent are reported. The owner must see every
 *   skip, so it is reported rather than silently honoured.
 *
 * Args:
 *   cwd: repo root (the adapters directory lives under it).
 *   pipeline: the completed pipeline run.
 *   verdicts: the evaluated verdicts (for the volatile skips).
 *   stateDir: run-state directory holding the sealed records.
 *
 * Returns:
 *   Promise<BlockingEntry[]>: non-blocking report entries, sorted.
 */
async function adapterAdvisories(
  cwd: string,
  pipeline: PipelineResult,
  verdicts: readonly ObligationVerdict[],
  stateDir: string,
): Promise<BlockingEntry[]> {
  const entries: BlockingEntry[] = [];
  const adaptersDir = join(cwd, '.gateforge/adapters');
  const reports = await auditAdapters(adaptersDir);
  const byName = new Map(reports.map((report) => [report.name, report]));

  for (const verdict of verdicts) {
    if (verdict.verdict === 'satisfied') continue;
    if (verdict.obligation.contract !== 'persistence:create') continue;
    const resourceId = verdict.obligation.resourceId;
    const report = byName.get(resourceId);
    if (report === undefined || !report.ok) continue;
    if (report.declares.list || report.declares.naturalKey) continue;
    if (verdict.reason !== null && !verdict.reason.includes('no witnessed')) continue;
    entries.push({
      kind: 'finding',
      resourceId,
      name: null,
      detail:
        `create for '${resourceId}' cannot be witnessed by adapter '${report.name}': it can neither ` +
        'list the collection nor bind a natural key, so a created row could never be shown to have ' +
        'been absent before and present after (a partial list proves nothing)',
      location: null,
      cause: 'ADAPTER_CANNOT_WITNESS',
      nextAction: CAUSE_NEXT_ACTIONS.ADAPTER_CANNOT_WITNESS,
    });
  }

  // The run's own witnessed records, as sealed: a declared skip is read
  // from the evidence itself, never from a suite-declared expectation.
  const byId = new Map<string, Record<string, unknown>>();
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, 'records.json'), 'utf8'));
    if (Array.isArray(raw)) {
      for (const record of raw) {
        if (typeof record !== 'object' || record === null) continue;
        const id = (record as { recordId?: unknown }).recordId;
        if (typeof id === 'string') byId.set(id, record as Record<string, unknown>);
      }
    }
  } catch {
    // No sealed records (a static run): nothing to report a skip about.
  }
  for (const verdict of verdicts) {
    if (verdict.verdict !== 'satisfied') continue;
    const used = verdict.recordIds.map((id) => byId.get(id) ?? null);
    const actions = used.filter((record) => record !== null && record['kind'] === 'ui.action');
    const skipped: string[] = [];
    for (const record of used) {
      if (record === null) continue;
      // The browser channel declares the entered values on its ui.action
      // anchor; an observe persistence record has no anchor and carries
      // the witness-observed request fields itself.
      const anchors = actions.length > 0 ? actions : OBSERVE_ANCHORS;
      for (const anchor of anchors) {
        for (const skip of volatileEchoSkips(anchor, record)) {
          if (!skipped.includes(skip.field)) skipped.push(skip.field);
        }
      }
    }
    if (skipped.length === 0) continue;
    entries.push({
      kind: 'finding',
      resourceId: verdict.obligation.resourceId,
      name: null,
      detail:
        `the exact-value echo skipped ${skipped.length} field(s) the adapter declares ` +
        `server-computed: ${skipped.sort().join(', ')} — the entered values were not compared with the ` +
        'persisted state, and the engine-observed values are what the app stored',
      location: null,
      cause: 'ADAPTER_VOLATILE_FIELD_SKIPPED',
      nextAction: CAUSE_NEXT_ACTIONS.ADAPTER_VOLATILE_FIELD_SKIPPED,
    });
  }
  return entries;
}

/**
 * `gateforge check`: the full gate — discover → obligations → claims →
 * verdicts → report, with exit codes per architecture contract 4
 * (0 clean/waived, 1 unresolved, 2 config/usage).
 *
 * `--changed` restricts the gate to changed files: the resolved diff
 * provider (pin #5) picks the changed set, and one effective scope
 * decision (plan §12.2) narrows obligations and blockers together —
 * unless the diff touches a gate-defining input (policy, classification,
 * pack configs, adapters, waivers, plugin impl, manifests, ignore
 * controls), which expands the run to all obligations. The provider
 * identity lands in the run manifest, so a run's report states exactly
 * which diff basis it used (GF-09: local-staged, github-pr, and gitlab-mr
 * produce identical resource-change sets for identical repos).
 *
 * Current claim declarations come from `.gateforge/test-map.yml` and,
 * when available, a verified receipt for the current input digest. Static
 * annotations are compared with generated sidecar entries but are not direct
 * check bindings; raw `claims.json` is never a declaration source.
 */
import { cpSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BLOCKING_VERDICTS,
  decideStrictness,
  loadQuarantines,
  QUARANTINE_DIR,
  resolveStrictnessMode,
  strictnessSummaryLine,
  CAUSE_NEXT_ACTIONS,
  canonicalJson,
  ENGINE_UPGRADE_REFUSAL_PREFIX,
  volatileEchoSkips,
  engineBundleDigestOf,
  executionBoundaryDigestOf,
  GateforgeConfigError,
  GateReceiptSchema,
  humanMessage,
  LOCAL_UNISOLATED_BOUNDARY,
  renderRun,
  runExitCode,
  type BlockingEntry,
  type CauseCode,
  type ChangedProvider,
  type Claim,
  type GateReceipt,
  type JsonValue,
  type ObligationVerdict,
  type RuntimeConfig,
} from '@gate-forge/core';
import {
  discoverTestCatalog,
  findPlaywrightConfig,
  scanTestFiles,
  TestDiscoveryError,
  untrustedEnv,
  type DiscoverOptions,
  type DiscoveryTimings,
  type PytestCollectionResult,
} from '@gate-forge/pack-playwright';
import { parseArgs, stringFlag } from '../args.js';
import { resolveAdoptedBaseline } from '../adopted-baseline.js';
import { printFailure, UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { trustedPolicyDigestForConfig } from '../execution.js';
import { gateforgeOwnedInputs } from '../gateforge-owned.js';
import { obligationFingerprint, evaluateRun, scopeBlocking } from '../evaluate.js';
import { auditAdapters } from '../adapter-audit.js';
import { singletonPerTenantAdvisories } from '../singleton-guidance.js';
import { responseFieldAdvisories } from '../response-field-guidance.js';
import { unmatchedRouteBannerLines } from '../unmatched-routes.js';
import { annotationMapSyncAdvisories, loadOptionalTestMap, mappedCoverageFrom, mappingBlocking, nativeInventoryBlocking, resolveRepositoryMappings, TEST_MAP_RELATIVE } from '../mapping.js';
import {
  businessRuleInventory,
  businessRuleReportEntries,
  businessRuleRunFacts,
  gradeBusinessRules,
  partitionBusinessRuleEntries,
  witnessedRunnersOf,
} from '../business-rules.js';
import { runnerConfigPaths, runtimeDeclaredInputs } from '../test-infrastructure.js';
import type {
  BusinessRuleCaseResult,
  MappedCoverage,
  RuleClaimBindings,
  TestCatalog,
} from '@gate-forge/core';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  type InputSnapshot,
  type SnapshotFileEntry,
} from '../input-snapshot.js';
import { runPipeline, sourcesByResourceId, type PipelineResult } from '../pipeline.js';
import {
  digestPytestInputs,
  interpreterIdentity,
  pytestCacheKey,
  readPytestCache,
  resolveCacheControl,
  type CacheCounts,
  writePytestCache,
} from '../run-cache.js';
import { RuntimeBlockError, loadRuntimeConfigAt, prepareRuntime } from '../runtime.js';
import { digestRuntimeReuseMounts, type RuntimeReuseMount } from '../runtime-reuse.js';
import {
  authenticatedChangedInputs,
  loadReceiptFor,
  receiptGateBlocking,
  receiptScope,
  scopedReceiptCoverageBlocking,
  type ReceiptLoad,
  type ScopedObligationRef,
} from '../receipts.js';
import { resealChainBlocking, retainedCarriedEvidence } from '../reseal-chain.js';
import { evaluateAdoptionCommit } from '../adoption-mode.js';
import { changeBaseTextReader, mergeRequestScopePreflight, resolveProvider, textReaderAtRevision } from '../providers.js';
import {
  computeEvaluationScope,
  detectStagedWorkingTreeMismatches,
  testToolingSourceConflicts,
  type ScopeDecision,
} from '../scope.js';
import {
  assertRuntimeReuseOwnerApproval,
  freezeCommitCandidate,
  freezeStagedCandidate,
  materializeStagedCandidate,
  recheckStagedCandidate,
  releaseStagedCandidate,
  StagedCandidateBlockError,
  type StagedCandidate,
} from '../staged-candidate.js';
import { httpRoutesView, readCandidateTreeEntries, readStateDocument, resolveStateDir } from '../state.js';
import { engineGeneratedStateFileFilter } from '../state-artifacts.js';
import {
  assertReceiptApprovedPolicy,
  evaluateApprovedPolicy,
  resolveApprovedPolicyDigest,
} from '../trusted-policy.js';
import { loadConfigAt, parseRunFormat, rejectUnknownFlags, VERSION } from './common.js';
import { resolveVerifierKeyring, type VerifierKeyring } from '../verifier-keys.js';
import { renderEndpointInventory } from '../endpoint-report.js';
import { candidateTreeCoversCommit, computeCandidateTreeSnapshot, resolveGitDir, sanitizedAuthorityEnv } from '../candidate-tree.js';
import { DOCS_EXCLUSIONS_GUARANTEE, loadDocsExclusions } from '../docs-exclusions.js';
import { CACHE_EXCLUSIONS_GUARANTEE, loadCacheExclusions } from '../cache-exclusions.js';
import { engineIdentity, reportEngineLine } from '../engine-identity.js';

/**
 * Compares sealed candidate entries with the current tree and explains the files behind a mismatch.
 *
 * Args:
 *   sealed: entries persisted with the receipt.
 *   current: entries from the current candidate-tree walk.
 *   workspace: absolute repository root.
 *   stateDir: absolute run-state directory containing the receipt.
 *   env: sanitized process environment for Git ignore checks.
 *
 * Returns:
 *   string: actionable file-level mismatch details, or an empty string when unavailable or unchanged.
 */
function candidateTreeMismatchSummary(
  sealed: readonly { mode: string; sha: string; path: string }[],
  current: readonly { mode: string; sha: string; path: string }[],
  workspace: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
): string {
  const sealedByPath = new Map(sealed.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
  const changes: Array<{ kind: 'added' | 'removed' | 'changed'; path: string }> = [];
  for (const [path, entry] of currentByPath) {
    const before = sealedByPath.get(path);
    if (before === undefined) changes.push({ kind: 'added', path });
    else if (before.mode !== entry.mode || before.sha !== entry.sha) changes.push({ kind: 'changed', path });
  }
  for (const path of sealedByPath.keys()) {
    if (!currentByPath.has(path)) changes.push({ kind: 'removed', path });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (changes.length === 0) return '';

  const lines = changes.slice(0, 20).map(({ kind, path }) => {
    const ignored = spawnSync('git', ['--no-replace-objects', 'check-ignore', '--quiet', '--', path], {
      cwd: workspace,
      env: sanitizedAuthorityEnv(env),
      stdio: 'ignore',
    }).status === 0;
    return `  ${kind} ${JSON.stringify(path)}${ignored ? ' (ignored by git but part of the tested tree)' : ''}`;
  });
  if (changes.length > lines.length) lines.push(`  ... ${changes.length - lines.length} additional path changes`);

  let postSealHint = '';
  try {
    // Filesystem mtimes advance in coarse clock ticks (milliseconds), so a
    // quick edit right after sealing can carry the receipt's exact mtime;
    // a tie therefore counts as "after the seal".
    const receiptTime = lstatSync(join(stateDir, 'receipt.json')).mtimeMs;
    const allChangedAfterSeal = changes.every(({ path }) => lstatSync(join(workspace, path)).mtimeMs >= receiptTime);
    if (allChangedAfterSeal) {
      postSealHint =
        ' these paths changed after the run was sealed — often another pre-commit hook or a build step; ' +
        'run those before the suite or make them non-mutating.';
    }
  } catch {
    // Missing paths or receipt timestamps cannot support a post-seal claim.
  }

  const docsOnly = changes.every(({ path }) =>
    /^(?:docs?|guides?)\//i.test(path) || /\.(?:md|mdx|rst)$/i.test(path),
  );
  const docsHint = docsOnly
    ? ' Only documentation paths changed; if these are approved documentation folders, run `gateforge init --docs-exclude <folders>`.'
    : '';
  return ` candidate tree files:\n${lines.join('\n')}${postSealHint}${docsHint}`;
}

type VerifiedCandidateFastPath = {
  receipt: GateReceipt;
  treeMatches: boolean;
  /** The tree identity the receipt was compared against (filtered when exclusions exist). */
  expectedTreeId: string | null;
};

/**
 * Returns an authenticated receipt for a candidate base, distinguishing a
 * matching tree from an authenticated stale-tree binding. With owner-approved
 * docs/cache exclusions the comparison uses the FILTERED snapshot identity
 * (the same one the full gate seals): the raw candidate tree carries excluded
 * bytes the receipt deliberately ignores, so an exact raw-tree match is
 * impossible and the filtered tree id decides instead.
 *
 * Args:
 *   io: process context.
 *   checkoutDir: isolated checkout of the immutable candidate.
 *   candidate: frozen commit identity and tree.
 *   options: receipt key and optional policy pin.
 *
 * Returns:
 *   VerifiedCandidateFastPath | null: authenticated clean receipt, or null
 *   to use the full path.
 */
function verifiedCandidateFastPathReceipt(
  io: Io,
  checkoutDir: string,
  candidate: StagedCandidate,
  options: {
    approvedPolicyDigest?: string;
    verifierKeyring: VerifierKeyring | null;
  },
): VerifiedCandidateFastPath | null {
  try {
    const config = loadConfigAt(checkoutDir);
    const receiptDocument = readStateDocument(resolveStateDir(io.cwd), 'receipt.json');
    const parsed = GateReceiptSchema.safeParse(receiptDocument);
    if (!parsed.success || config.enforcement?.receiptStage === undefined) return null;
    const docsExclusions = loadDocsExclusions(checkoutDir, config);
    const cacheExclusions = loadCacheExclusions(checkoutDir, config);
    const hasOwnerExclusions = docsExclusions.length > 0 || cacheExclusions.length > 0;
    const receipt = parsed.data;
    const currentEngine = engineIdentity();
    const currentPolicyDigest = trustedPolicyDigestForConfig(checkoutDir, config);
    const resolution = resolveApprovedPolicyDigest({
      flag: options.approvedPolicyDigest,
      env: io.env,
      candidateCwd: checkoutDir,
      candidateConfig: config,
    });
    // Owner exclusions raise the ownership bar exactly like the full gate:
    // without the external pin the exclusions (and this fast path) fail closed.
    const policyGate = evaluateApprovedPolicy(
      resolution,
      currentPolicyDigest,
      config.enforcement.strictE2E === true || hasOwnerExclusions,
    );
    if (
      policyGate.status !== 'enforced' ||
      receipt.trustedPolicyDigest !== currentPolicyDigest ||
      receipt.engine === undefined ||
      receipt.engine.version !== currentEngine.version ||
      receipt.engine.source !== currentEngine.source ||
      receipt.engine.unpublished !== currentEngine.unpublished ||
      receipt.engineBundleDigest !== engineBundleDigestOf(currentEngine.version, currentPolicyDigest) ||
      receipt.receiptStage !== config.enforcement.receiptStage ||
      receipt.verdictSummary.blocking !== 0 ||
      (receipt.scope !== undefined && receipt.scope !== 'full')
    ) {
      return null;
    }
    const firstParent = candidate.parentShas[0] ?? null;
    let priorParent: string | null = null;
    if (firstParent !== null) {
      const parentResult = spawnSync('git', ['rev-parse', '--verify', `${firstParent}^`], {
        cwd: io.cwd,
        env: sanitizedAuthorityEnv(io.env),
        encoding: 'utf8',
      });
      const value = (parentResult.stdout ?? '').trim();
      if (parentResult.error === undefined && parentResult.status === 0 && /^[0-9a-f]{40}$/.test(value)) {
        priorParent = value;
      }
    }
    const baseMatches =
      (receipt.gitSha === candidate.headSha && receipt.parentSha === firstParent) ||
      (receipt.gitSha === firstParent && receipt.parentSha === priorParent);
    if (!baseMatches) return null;

    const currentBoundary = executionBoundaryDigestOf(
      io.env['GATEFORGE_AUTHORITY_BOUNDARY']?.trim() || LOCAL_UNISOLATED_BOUNDARY,
    );
    const verified = loadReceiptFor(resolveStateDir(io.cwd), options.verifierKeyring, {
      inputDigest: receipt.inputDigest,
      trustedPolicyDigest: currentPolicyDigest,
      executionBoundaryDigest: currentBoundary,
      scope: 'full',
    });
    if (verified.status !== 'ok') return null;
    const approvedBinding = assertReceiptApprovedPolicy(verified.receipt, policyGate.approved);
    if (!approvedBinding.ok) return null;
    // Currency check: the receipt binds the tree identity the full gate would
    // have sealed. With exclusions that is the FILTERED tree of the checkout
    // (docs/cache bytes excluded), recomputed here from the candidate bytes.
    let expectedTreeId: string | null = candidate.treeId;
    if (hasOwnerExclusions) {
      const gitDir = resolveGitDir(checkoutDir, io.env);
      expectedTreeId =
        gitDir === null
          ? null
          : computeCandidateTreeSnapshot(
              gitDir,
              checkoutDir,
              io.env,
              resolveStateDir(checkoutDir),
              'record',
              [],
              docsExclusions,
              cacheExclusions,
            ).treeId;
    }
    if (expectedTreeId === null) return null;
    return { receipt: verified.receipt, treeMatches: verified.receipt.candidateTreeId === expectedTreeId, expectedTreeId };
  } catch {
    return null;
  }
}

/**
 * Renders the signed summary used when discovery is safely skipped.
 *
 * Args:
 *   format: text or JSON output requested by the caller.
 *   receipt: authenticated full-scope receipt.
 *   candidateTreeId: frozen candidate tree identity.
 *
 * Returns:
 *   string: auditable fast-path result.
 */
function renderFastPathReceipt(
  format: 'text' | 'json',
  receipt: GateReceipt,
  candidateTreeId: string,
): string {
  const diagnosticContext = {
    scope: 'full',
    candidateTreeId,
    inputDigest: receipt.inputDigest,
    evidenceState: 'receipt-verified-fast-path',
    authority: 'authoritative',
  };
  if (format === 'json') {
    return canonicalJson({
      fastPath: true,
      receiptStage: receipt.receiptStage ?? null,
      engine: receipt.engine ?? null,
      summary: receipt.verdictSummary,
      blocking: [],
      diagnosticContext,
    });
  }
  const summary = receipt.verdictSummary;
  return [
    `gateforge run: ${String(summary.total)} obligation(s) — ${String(summary.satisfied)} satisfied, ${String(summary.waived)} waived, 0 blocking`,
    'receipt: verified for the exact candidate tree; discovery and test execution were not started (fast path)',
    `diagnostic context: scope=full candidateTreeId=${candidateTreeId} inputDigest=${receipt.inputDigest} evidence=receipt-verified-fast-path authority=authoritative`,
  ].join('\n');
}

/**
 * Finds endpoints whose only statically matched tests intercept their route.
 *
 * Args:
 *   endpoints: compiled endpoint identities.
 *   tests: statically discovered tests and their route-interception facts.
 *
 * Returns:
 *   BlockingEntry[]: non-blocking report entries for mocked-only routes.
 */
function mockedOnlyEndpointAdvisories(
  endpoints: readonly { method: string; canonicalPath: string; identity: string }[],
  tests: readonly {
    file: string;
    title: string;
    facts: {
      pageRoute: { file: string; line: number; col: number } | null;
      pageRouteTargets?: readonly string[];
    };
  }[],
): BlockingEntry[] {
  /**
   * Compiles a Playwright-style route glob for a full-path comparison.
   *
   * Args:
   *   pattern: statically discovered route glob.
   *
   * Returns:
   *   RegExp: matcher for one candidate URL or canonical path.
   */
  const routeRegex = (pattern: string): RegExp => {
    /**
     * Escapes ordinary glob text for use in the route regular expression.
     *
     * Args:
     *   value: text between wildcard markers.
     *
     * Returns:
     *   string: escaped regular-expression source.
     */
    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `^${pattern
        .split('**')
        .map((part) => part.split('*').map(escape).join('[^/]*'))
        .join('.*')}$`,
    );
  };
  const entries: BlockingEntry[] = [];
  for (const endpoint of endpoints) {
    const targetPath = endpoint.canonicalPath;
    const matchingTests = tests.filter((test) =>
      (test.facts.pageRouteTargets ?? []).some((pattern) => {
        const matches = routeRegex(pattern);
        return matches.test(targetPath) || matches.test(`http://gateforge.invalid${targetPath}`);
      }),
    );
    if (matchingTests.length === 0 || matchingTests.some((test) => test.facts.pageRoute === null)) continue;
    const testNames = matchingTests.map((test) => `${test.file} (${test.title})`).sort();
    entries.push({
      kind: 'finding',
      resourceId: null,
      name: null,
      detail: `only mocked tests reach ${endpoint.method} ${targetPath}: ${testNames.join(', ')}`,
      location: null,
      cause: null,
      nextAction: 'Add a witnessed test that reaches the server instead of intercepting this route.',
    });
  }
  return entries;
}

export const CHECK_USAGE =
  'usage: gateforge check [--changed] [--staged] [--candidate-commit <sha>] [--require-e2e] [--format text|json|sarif]\n' +
  '       [--approved-policy-digest <hex64>] [--timing] [--no-cache]\n' +
  '       verifier key: GATEFORGE_WITNESS_VERIFIER_KEY or GATEFORGE_WITNESS_VERIFIER_KEY_FILE\n' +
  '       approved policy digest: the OWNER-APPROVED policy revision pin. Never sourced from\n' +
  '       candidate-controlled files in strict mode — provision it via the protected\n' +
  '       GATEFORGE_APPROVED_POLICY_DIGEST variable, this flag, or GATEFORGE_TRUSTED_CONFIG outside the candidate.';

/** Options of one gate run (the check body, shared by --changed/--staged). */
export interface CheckGateOptions {
  /** Restrict evaluation to the changed-file scope. */
  diffScoped: boolean;
  /** Require a valid, non-stale gate receipt (strict saved-state gate). */
  requireE2E: boolean;
  /** Report format. */
  format: 'text' | 'json' | 'sarif';
  /**
   * Owner-approved policy revision digest from `--approved-policy-digest`
   * (an operator channel). The protected `GATEFORGE_APPROVED_POLICY_DIGEST`
   * variable and a `GATEFORGE_TRUSTED_CONFIG` file outside the candidate
   * are resolved as well; see src/trusted-policy.ts. Never taken from
   * candidate-controlled files in strict mode.
   */
  approvedPolicyDigest?: string;
  /** Trusted key ring resolved before candidate materialization. */
  verifierKeyring?: VerifierKeyring | null;
  /** Frozen candidate tree from a staged-candidate orchestrator. */
  fixedCandidateTreeId?: string | null;
  /**
   * Phase 5 staged-candidate runs: the fixed changed set computed from
   * the FROZEN index vs base. When present no diff provider runs (the
   * candidate checkout has no diff basis of its own), the manifest stamps
   * the `local-staged` basis identity, and the staged-vs-worktree
   * mismatch diagnostic is skipped (the checkout IS the staged bytes).
   */
  fixedChangedFiles?: readonly string[];
  /** Digest of dependency bytes reused by the staged candidate runtime. */
  runtimeReuseDigest?: string | null;
  /** Exact owner-approved external dependency mounts in the staged checkout. */
  runtimeReuseMounts?: readonly RuntimeReuseMount[];
  /** Recomputes mounted dependency bytes after discovery. */
  runtimeReuseCheck?: () => string | null;
  /** Emit per-step wall-clock timings in the report (additive only). */
  timing?: boolean;
  /**
   * Phase 5 staged-candidate runs: the base-revision
   * text reader for policy-input classification,
   * resolved by the caller against the USER's
   * repository BEFORE the process moves to the
   * isolated checkout (the checkout has none of the
   * base revision's objects, so the staged diff's
   * base — HEAD, or the candidate commit's first
   * parent — can only be read where it lives).
   */
  fixedBaseText?: (path: string) => string | null;
  /**
   * Force a full scan: no detector or pytest
   * collection cache reads or writes. Also forced by
   * `GATEFORGE_NO_CACHE=1` and CI environments.
   */
  noCache?: boolean;
  /**
   * Persistent state directory for the run cache. Staged-candidate runs
   * pass the USER's run-state dir so cached results survive the thrown
   * away scratch checkout; the cache key covers every input, so sharing
   * across materializations of the same repo is sound.
   */
  cacheStateDir?: string;
}

/**
 * Runs the check subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved (or a blocked staged
 *   candidate), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function checkCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, CHECK_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['changed', 'staged', 'candidate-commit', 'require-e2e', 'format', 'approved-policy-digest', 'timing', 'no-cache', 'help'], CHECK_USAGE);
  if (options['staged'] === true && options['changed'] === true) {
    throw new UsageError('check: --staged already scopes the run to the staged candidate; --changed cannot be combined');
  }
  const format = parseRunFormat(stringFlag(options, 'format') ?? 'text');
  const requireE2E = options['require-e2e'] === true;
  const approvedPolicyDigest = stringFlag(options, 'approved-policy-digest');
  const timing = options['timing'] === true;
  const noCache = options['no-cache'] === true;
  const verifierKeyring = resolveVerifierKeyring(io.cwd, io.env, [resolveStateDir(io.cwd)]);
  const candidateCommitSha = stringFlag(options, 'candidate-commit');
  if (options['staged'] === true && candidateCommitSha !== undefined) {
    throw new UsageError('check: --candidate-commit cannot be combined with --staged');
  }
  if (candidateCommitSha !== undefined) {
    return stagedCheckCommand(io, {
      candidateCommitSha,
      diffScoped: options['changed'] === true,
      requireE2E,
      format,
      approvedPolicyDigest,
      verifierKeyring,
      timing,
      noCache,
    });
  }
  if (options['staged'] === true) {
    return stagedCheckCommand(io, { diffScoped: true, requireE2E, format, approvedPolicyDigest, verifierKeyring, timing, noCache });
  }
  return runCheckGate(io, {
    diffScoped: options['changed'] === true,
    requireE2E,
    format,
    approvedPolicyDigest,
    verifierKeyring,
    timing,
    noCache,
  });
}

/**
 * The candidate tree id `check --staged` binds a sealed receipt to.
 *
 * The frozen index tree is what the commit will contain, but a receipt is
 * sealed over the WORKSPACE its run tested, and a candidate tree carries
 * that workspace's untracked and gitignored bytes as well — that is what
 * makes it a candidate, and it is why `candidateTreeCoversCommit` treats
 * CONTAINMENT of the committed bytes, not equality with the commit tree,
 * as the property a gate relies on. String equality between a workspace
 * tree and the index tree can therefore never hold in a repository whose
 * run writes into its own worktree (`node_modules/`, a blob report, a
 * storage state), so a receipt sealed over a fully staged worktree could
 * not satisfy the gate at all.
 *
 * What the gate actually needs is that every staged byte was among the
 * tested bytes: when the sealed tree carries every staged path with the
 * SAME mode and blob, the sealed tree IS the candidate, and binding the
 * receipt to it says exactly what containment means. Nothing is relaxed
 * — the receipt's authenticated input digest must still equal the digest
 * this checkout computes, every staged path must be present in the sealed
 * tree, and an unreadable receipt, an unreadable tree listing or a single
 * differing byte falls back to the frozen index tree, which is the
 * previous (stricter) test.
 *
 * Args:
 *   gitDir: the USER repository's git dir — the sealed candidate tree
 *     objects were written there by the run that sealed the receipt.
 *   env: process environment.
 *   stateDir: the USER run-state directory holding the sealed receipt.
 *   frozen: the frozen candidate (staged index or candidate commit).
 *   docsExclusions: owner-approved documentation folders (never sealed).
 *   cacheExclusions: exact approved Python bytecode files (never sealed).
 *
 * Returns:
 *   string: the sealed tree id when it provably covers the candidate,
 *     otherwise the frozen candidate's own tree id.
 */
function boundCandidateTreeId(
  gitDir: string | null,
  env: NodeJS.ProcessEnv,
  stateDir: string,
  frozen: StagedCandidate,
  docsExclusions: readonly string[],
  cacheExclusions: readonly string[],
): string {
  if (gitDir === null) return frozen.treeId;
  const parsed = GateReceiptSchema.safeParse(readStateDocument(stateDir, 'receipt.json'));
  const sealed = parsed.success ? parsed.data.candidateTreeId : null;
  if (sealed === null || sealed === undefined || sealed === frozen.treeId) return frozen.treeId;
  return candidateTreeCoversCommit(gitDir, env, sealed, frozen.treeId, docsExclusions, cacheExclusions)
    ? sealed
    : frozen.treeId;
}

/**
 * The `--staged` gate (plan 2026-09-13 Phase 5 items 3–4): gate the EXACT
 * staged candidate. The candidate is frozen (tree id + parents + change
 * set), materialized into an isolated scratch checkout, and the regular
 * gate body runs against those bytes with the frozen change set as its
 * scope — never the working tree (the process cwd follows the checkout
 * so repo-relative readers, in-process plugins included, resolve the
 * staged bytes). The candidate is RE-CHECKED after the
 * gate: any index/HEAD drift during the run is a typed
 * ENFORCEMENT_UNTRUSTED block ('the staged candidate changed during
 * verification; re-run the gate'). Unsupported candidates (symlinks,
 * submodules, unmerged index) are explicit typed blocks, never fallbacks.
 * The user's run-state directory is copied into the checkout BEFORE the
 * gate so a valid receipt sealed for exactly these bytes is reusable
 * (the receipt's MAC still binds it to the recomputed candidate digest).
 *
 * Args:
 *   io: process context (cwd = the user's repository).
 *   options: strictness + report format.
 *
 * Returns:
 *   number: 0 the exact staged bytes passed, 1 blocked, 2 usage/config.
 */
async function stagedCheckCommand(
  io: Io,
  options: {
    candidateCommitSha?: string;
    diffScoped: boolean;
    requireE2E: boolean;
    format: 'text' | 'json' | 'sarif';
    approvedPolicyDigest?: string;
    verifierKeyring: VerifierKeyring | null;
    timing?: boolean;
    noCache?: boolean;
  },
): Promise<number> {
  let frozen: StagedCandidate;
  try {
    frozen =
      options.candidateCommitSha === undefined
        ? freezeStagedCandidate(io.cwd, io.env)
        : freezeCommitCandidate(io.cwd, io.env, options.candidateCommitSha);
  } catch (error) {
    if (error instanceof StagedCandidateBlockError) {
      return renderStagedBlock(io, error.causeCode, error.message, error.nextAction);
    }
    throw error;
  }

  // The base revision of the frozen change set lives in
  // the USER's repository: the staged index was diffed
  // against its HEAD (or the candidate commit against
  // its first parent), and the isolated checkout the
  // gate runs in has none of those objects. Resolve the
  // base-revision text reader HERE, before the process
  // moves to the checkout, so `.gitignore` policy-input
  // classification compares the staged bytes against
  // the exact base the frozen index was diffed against.
  const fixedBaseText =
    options.candidateCommitSha === undefined
      ? changeBaseTextReader('local-staged', io.cwd, io.env)
      : frozen.parentShas[0] === undefined
        ? null
        : textReaderAtRevision(frozen.parentShas[0], io.cwd, io.env);

  let checkoutDir: string;
  let runtimeReuseDigest: string | null = null;
  let runtimeReuseMounts: RuntimeReuseMount[] = [];
  let runtimeDoc: RuntimeConfig | null = null;
  let docsExclusions: readonly string[] = [];
  let cacheExclusions: readonly string[] = [];
  try {
    checkoutDir = materializeStagedCandidate(io.cwd, io.env, frozen);
    // An EMPTY optional config directory (`.gateforge/adapters/`,
    // `.gateforge/waivers/` — exactly what `gateforge init` leaves) is
    // digested and snapshotted exactly like an ABSENT one, on every
    // surface: the markers live in the digest entry list and the input
    // snapshot, so a materialized checkout needs no worktree shaping for
    // its digest to match — the bytes of the tree under test are the
    // whole story, for a staged index and a candidate commit alike.
    const checkoutConfig = loadConfigAt(checkoutDir);
    docsExclusions = loadDocsExclusions(checkoutDir, checkoutConfig);
    cacheExclusions = loadCacheExclusions(checkoutDir, checkoutConfig);
    // The candidate's own staged-runtime document prepares ITS checkout
    // (dependency reuse + tracked preparation command) — discovery reads
    // installed tooling from the candidate, never the worktree. The
    // document is trusted-revision input (hashed into the approved
    // digest), so a candidate cannot edit its runtime commands and
    // approve the edit in the same commit. Services do NOT start here:
    // check validates recorded evidence and runs no tests.
    // Evaluate the canonical owner-approved policy gate BEFORE any staged
    // prepare command can execute. `check --staged` is also a runtime
    // execution surface, so it must not rely on the later receipt check
    // to discover an unapproved runtime revision.
    const candidatePolicyDigest = trustedPolicyDigestForConfig(checkoutDir, checkoutConfig);
    const policyGate = evaluateApprovedPolicy(
      resolveApprovedPolicyDigest({
        flag: options.approvedPolicyDigest,
        env: io.env,
        candidateCwd: checkoutDir,
        candidateConfig: checkoutConfig,
      }),
      candidatePolicyDigest,
      checkoutConfig.enforcement?.strictE2E === true || docsExclusions.length > 0 || cacheExclusions.length > 0,
    );
    if (policyGate.status === 'blocked') {
      releaseStagedCandidate(frozen);
      return renderStagedBlock(io, policyGate.cause, policyGate.detail, policyGate.nextAction);
    }
    if (
      options.candidateCommitSha !== undefined &&
      options.requireE2E &&
      options.format !== 'sarif'
    ) {
      const fastPathReceipt = verifiedCandidateFastPathReceipt(io, checkoutDir, frozen, {
        approvedPolicyDigest: options.approvedPolicyDigest,
        verifierKeyring: options.verifierKeyring,
      });
      if (fastPathReceipt !== null) {
        if (!fastPathReceipt.treeMatches) {
          const stateDir = resolveStateDir(io.cwd);
          const sealedEntries = readCandidateTreeEntries(stateDir);
          const gitDir = resolveGitDir(checkoutDir, io.env);
          const snapshot =
            sealedEntries === null || gitDir === null
              ? null
              : computeCandidateTreeSnapshot(
                  gitDir,
                  checkoutDir,
                  io.env,
                  resolveStateDir(checkoutDir),
                  'record',
                  [],
                  docsExclusions,
                  cacheExclusions,
                );
          const treeDiff =
            sealedEntries === null || snapshot === null
              ? ''
              : candidateTreeMismatchSummary(sealedEntries, snapshot.entries, checkoutDir, stateDir, io.env);
          const nextAction = CAUSE_NEXT_ACTIONS.EVIDENCE_STALE;
          const detail = humanMessage({
            cause: 'EVIDENCE_STALE',
            detail:
              `require-e2e: authenticated receipt is bound to candidate tree ${fastPathReceipt.receipt.candidateTreeId ?? '<unavailable>'}, ` +
              `not ${fastPathReceipt.expectedTreeId ?? '<unavailable>'}.${treeDiff}`,
            // The detail names the command that re-seals this candidate;
            // the block's own `next action:` line keeps the cause prose.
            nextAction: 'gateforge test-gates --changed',
          });
          releaseStagedCandidate(frozen);
          return renderStagedBlock(io, 'EVIDENCE_STALE', detail, nextAction);
        }
        writeLine(
          io.stdout,
          renderFastPathReceipt(
            options.format === 'json' ? 'json' : 'text',
            fastPathReceipt.receipt,
            fastPathReceipt.expectedTreeId ?? frozen.treeId,
          ),
        );
        releaseStagedCandidate(frozen);
        return 0;
      }
    }
    runtimeDoc = loadRuntimeConfigAt(checkoutDir, checkoutConfig.runtime);
    if (runtimeDoc !== null) {
      // R1-17: runtime.yml is a trusted-policy input hashed into
      // the candidate digest, so an owner pin that matched the
      // candidate revision (policyGate enforced) approves the
      // requested reuse roots — the first commit introducing
      // runtime.yml no longer deadlocks. Without a matching pin
      // the committed base stays the only approver.
      if (policyGate.status !== 'enforced') {
        assertRuntimeReuseOwnerApproval(frozen.approvedReusePaths, runtimeDoc.prepare?.reuse ?? []);
      }
      const preparedRuntime = await prepareRuntime(io.cwd, checkoutDir, runtimeDoc, io, resolveStateDir(checkoutDir));
      runtimeReuseDigest = preparedRuntime.reuseDigest;
      runtimeReuseMounts = preparedRuntime.reuseMounts;
    }
  } catch (error) {
    releaseStagedCandidate(frozen);
    if (error instanceof RuntimeBlockError) {
      return renderStagedBlock(io, error.causeCode, error.message, CAUSE_NEXT_ACTIONS[error.causeCode]);
    }
    if (error instanceof StagedCandidateBlockError) {
      return renderStagedBlock(io, error.causeCode, error.message, error.nextAction);
    }
    throw error;
  }
  // The candidate checkout IS the gated repository for this run — the
  // whole process follows it (plan Phase 5 item 3: build/run from those
  // bytes). In-process plugin modules read repo-relative paths against
  // the process cwd (the production contract: cwd is the gated repo
  // root), so without this move discovery would read the user's
  // worktree bytes instead of the staged bytes. Restored on every path.
  const previousCwd = process.cwd();
  process.chdir(checkoutDir);
  try {
    // Receipt-reuse surface: the checkout's run state starts as a copy of
    // the user's (supervision artifacts only — the receipt gate still
    // re-verifies the MAC against the recomputed candidate digests).
    const userState = resolveStateDir(io.cwd);
    if (existsSync(userState)) {
      cpSync(userState, resolveStateDir(checkoutDir), { recursive: true });
    }
    const code = await runCheckGate({ ...io, cwd: checkoutDir }, {
      diffScoped: options.diffScoped,
      requireE2E: options.requireE2E,
      format: options.format,
      approvedPolicyDigest: options.approvedPolicyDigest,
      verifierKeyring: options.verifierKeyring,
      fixedCandidateTreeId: boundCandidateTreeId(
        resolveGitDir(io.cwd, io.env),
        io.env,
        userState,
        frozen,
        docsExclusions,
        cacheExclusions,
      ),
      ...(options.diffScoped
        ? {
            fixedChangedFiles: frozen.changedPaths,
            // Resolved against the USER's repository BEFORE the
            // chdir below: the base revision's objects live only
            // there (the isolated checkout's HEAD is the staged
            // tree), and the policy-input classifier needs the
            // base text to recognize init's `.gitignore` block.
            ...(fixedBaseText !== null ? { fixedBaseText } : {}),
          }
        : {}),
      runtimeReuseDigest,
      runtimeReuseMounts,
      runtimeReuseCheck: () => digestRuntimeReuseMounts(runtimeReuseMounts),
      ...(options.timing === true ? { timing: true } : {}),
      // The scratch checkout's state dir is thrown away — the cache lives
      // in the USER's persistent run-state dir (same repo, content keys).
      ...(options.noCache === true ? { noCache: true } : { cacheStateDir: resolveStateDir(io.cwd) }),
    });
    if (options.candidateCommitSha === undefined) {
      const recheck = recheckStagedCandidate(io.cwd, io.env, frozen);
      if (!recheck.ok) {
        return renderStagedBlock(
          io,
          'ENFORCEMENT_UNTRUSTED',
          recheck.detail,
          'Re-run the gate for the current staged candidate.',
        );
      }
    }
    return code;
  } catch (error) {
    if (error instanceof StagedCandidateBlockError) {
      return renderStagedBlock(io, error.causeCode, error.message, error.nextAction);
    }
    // Staged discovery hint (0.9.1): the candidate
    // checkout holds TRACKED bytes only, so a test-
    // discovery run that cannot find its dependencies
    // fails with the raw runner error and no pointer —
    // unless the runtime document already declares the
    // dependency directories to link.
    if (isStagedDiscoveryFailure(error) && !runtimeDeclaresReuse(runtimeDoc)) {
      printFailure(io, error);
      writeLine(io.stderr, STAGED_DISCOVERY_HINT);
      return 2;
    }
    throw error;
  } finally {
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
    releaseStagedCandidate(frozen);
  }
}

/**
 * Renders one typed staged-candidate block (plan §5.4) as deterministic
 * gate output and returns the blocking exit code.
 *
 * Args:
 *   io: process context.
 *   cause: the §5.4 cause code.
 *   detail: precise reason.
 *   nextAction: the actionable next step.
 *
 * Returns:
 *   number: 1 (blocking).
 */
function renderStagedBlock(io: Io, cause: CauseCode, detail: string, nextAction: string): number {
  writeLine(io.stdout, 'staged-candidate gate: BLOCKED');
  writeLine(io.stdout, `cause: ${cause}`);
  writeLine(io.stdout, `detail: ${detail}`);
  writeLine(io.stdout, `next action: ${nextAction}`);
  return 1;
}

/**
 * The staged-checkout dependency hint (0.9.1):
 * appended to a test-discovery failure inside the
 * staged candidate when the runtime document declares
 * no `prepare.reuse` roots.
 */
export const STAGED_DISCOVERY_HINT =
  'hint: the staged candidate checkout holds tracked files only — declare your dependency directories ' +
  'in .gateforge/runtime.yml (prepare: { reuse: [node_modules] }), see REFERENCE "Staged runtime"';

/**
 * Whether the error is a test-discovery failure inside
 * the staged candidate: the pack's typed discovery
 * error, or the usage error the CLI maps it to (its
 * message names the playwright invocation that could
 * not enumerate the candidate's tests).
 */
export function isStagedDiscoveryFailure(error: unknown): boolean {
  if (error instanceof TestDiscoveryError) return true;
  if (error instanceof UsageError) {
    return /playwright --list|playwright CLI not found/.test(error.message);
  }
  return false;
}

/**
 * Whether the candidate's runtime document declares at
 * least one `prepare.reuse` dependency directory — the
 * sanctioned bridge from the user repository into the
 * staged checkout.
 */
export function runtimeDeclaresReuse(runtimeDoc: RuntimeConfig | null): boolean {
  return (runtimeDoc?.prepare?.reuse ?? []).length > 0;
}

/**
 * Names the report's exit-code line for what it is when a non-blocking
 * mode softened the run's exit code.
 *
 * The text report always carries the STRICT result's exit code. In
 * `strict` mode that is the code the process exits with, so the line is
 * left byte-identical. When a mode softens it, the same bare
 * `exit code: 1` would contradict `EXIT=0` in a CI log and to an agent
 * reading the report, so it is relabelled as the value a blocking mode
 * would have produced. Nothing is invented: a report without that line
 * is returned untouched.
 *
 * Args:
 *   report: the rendered text report.
 *   strictExitCode: the exit code the strict result maps to.
 *   exitCode: the exit code this run actually exits with.
 *
 * Returns:
 *   string: the report with its exit-code line relabelled when softened.
 */
export function labelSoftenedExitCode(
  report: string,
  strictExitCode: number,
  exitCode: number,
): string {
  if (strictExitCode === exitCode) return report;
  const lines = report.split('\n');
  // The LAST such line is the report's own verdict; a fixture or a
  // quoted payload earlier in the text is never relabelled.
  let index = -1;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (/^exit code: \d+$/.test(lines[at] ?? '')) {
      index = at;
      break;
    }
  }
  if (index < 0) return report;
  lines[index] = `would exit ${String(strictExitCode)} in blocking mode`;
  return lines.join('\n');
}


/**
 * Validates persisted pytest collection data before it can bypass a child run.
 *
 * Args:
 *   value: parsed cache payload.
 *
 * Returns:
 *   boolean: true only for a complete collection result with valid fields.
 */
function isPytestCollectionResult(value: unknown): value is PytestCollectionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (
    (result['status'] !== 'discovered' && result['status'] !== 'unavailable') ||
    typeof result['detail'] !== 'string' ||
    !Array.isArray(result['cases']) ||
    !Array.isArray(result['collectionErrors']) ||
    (result['exitCode'] !== null && typeof result['exitCode'] !== 'number')
  ) {
    return false;
  }
  return (
    result['cases'].every((testCase: unknown) => {
      if (typeof testCase !== 'object' || testCase === null || Array.isArray(testCase)) return false;
      const row = testCase as Record<string, unknown>;
      return (
        typeof row['nodeId'] === 'string' &&
        typeof row['file'] === 'string' &&
        Array.isArray(row['titlePath']) &&
        row['titlePath'].every((title: unknown) => typeof title === 'string')
      );
    }) && result['collectionErrors'].every((error: unknown) => typeof error === 'string')
  );
}

/**
 * The gate body shared by `check`, `check --changed`, and the Phase 5
 * `check --staged` candidate run (via a scratch checkout cwd).
 *
 * Args:
 *   io: process context (cwd = the repository the gate evaluates).
 *   options: scope/strictness/format + the optional fixed changed set.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved, 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function runCheckGate(io: Io, options: CheckGateOptions): Promise<number> {
  const gateStartedAtMs = performance.now();
  const { diffScoped, requireE2E, format } = options;
  const fixedChangedFiles = options.fixedChangedFiles;
  const runtimeReuseDigest = options.runtimeReuseDigest;
  const runtimeReuseMounts = options.runtimeReuseMounts ?? [];
  // Witness verifier key (GF-23, plan §11): read from the
  // environment — never argv, whose cmdline is world-readable. With the
  // key, the manifest's v2 `attestation` envelope can be authenticated
  // against the recomputed current input digest (D3: a completed signed
  // run is reusable for byte-identical inputs); without it, no
  // suite-writable artifact can prove issuance and the provenance gate
  // fails closed. Legacy v1 `recordIdsMac` never authorizes, even when
  // it verifies.
  const config = loadConfigAt(io.cwd);
  // A merge-request pipeline with no base commit would resolve `auto` to
  // the local staged diff — zero changed files in a CI job, and a gate
  // that fails an hour later on debt nobody changed. Refuse in seconds.
  if (diffScoped) {
    const refusal = mergeRequestScopePreflight(config, io.env);
    if (refusal !== null) throw new UsageError(refusal);
  }
  // Owner-chosen strictness. A missing key
  // resolves to `strict`, which is byte-for-byte today's behavior: the
  // decision below is a pure mapping of an ALREADY-COMPUTED strict
  // result, so no mode can change what was evaluated, only what the
  // process returns. `changed` needs the diff machinery, so it reuses
  // the `--changed` path (provider + scope expansion) for its decision
  // while the full debt still reaches the report.
  const gateMode = resolveStrictnessMode(config);
  const gateModeChanged = gateMode === 'changed' && !diffScoped && fixedChangedFiles === undefined;
  const scopeAwareRun = diffScoped || gateModeChanged;
  const docsExclusions = loadDocsExclusions(io.cwd, config);
  const cacheExclusions = loadCacheExclusions(io.cwd, config);
  const hasOwnerExclusions = docsExclusions.length > 0 || cacheExclusions.length > 0;
  const docsApprovalDigest = hasOwnerExclusions ? trustedPolicyDigestForConfig(io.cwd, config) : null;
  const docsApprovalResolution =
    !hasOwnerExclusions
      ? null
      : resolveApprovedPolicyDigest({
          flag: options.approvedPolicyDigest,
          env: io.env,
          candidateCwd: io.cwd,
          candidateConfig: config,
        });
  const docsApprovalStatus =
    docsApprovalResolution === null
      ? null
      : docsApprovalResolution.status !== 'ok'
        ? 'invalid'
        : docsApprovalResolution.digest === null
          ? 'missing'
          : docsApprovalResolution.digest === docsApprovalDigest
            ? 'matched'
            : 'mismatch';
  const providerIdentity: ChangedProvider =
    fixedChangedFiles !== undefined
      ? 'local-staged'
      : scopeAwareRun
        ? resolveProvider(config.changed.provider, io.cwd, io.env).provider
        : 'all-files';
  const stateDir = resolveStateDir(io.cwd);
  const verifierKeyring = options.verifierKeyring ?? resolveVerifierKeyring(io.cwd, io.env, [stateDir]);
  const witnessVerifierKey = verifierKeyring?.active.key;

  // Pre-discovery file inventory (plan §11.5): the gate context does not
  // exist yet, so only file bytes are captured. A repository without
  // usable Git inventory keeps discovery working but fails evidence
  // authorization (snapshot-unavailable); an uncapturable input or an
  // unsafe --out overlap fails closed before any evaluation.
  let preFiles: SnapshotFileEntry[] | null = null;
  let snapshotUnavailable = false;
  // Content-addressed run cache: lives in
  // the EXCLUDED run-state dir (never in the input digest), forced off by
  // --no-cache / GATEFORGE_NO_CACHE / CI. A speed-up, never proof.
  const cacheControl = resolveCacheControl(io.env, options.cacheStateDir ?? stateDir, options.noCache === true);
  try {
    preFiles = collectInputFiles(io.cwd, config, stateDir, runtimeReuseMounts, docsExclusions, cacheExclusions);
  } catch (error) {
    if (error instanceof SnapshotUnavailableError) {
      snapshotUnavailable = true;
    } else if (error instanceof UnsupportedSnapshotError) {
      throw new UsageError(`unsupported input snapshot: ${error.message}`);
    } else {
      throw error;
    }
  }

  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: providerIdentity,
    stateDir,
    ...(fixedChangedFiles !== undefined ? { changedFilesOverride: fixedChangedFiles } : {}),
    pluginCache: cacheControl,
  });
  // 0.10.2: a declared test-tooling glob that reaches a discovered
  // resource's own source is a CONFIG error, not a silent pass — the
  // declaration exists so tooling can be attributed, never so product
  // code can hide behind it. Fail closed before anything is graded.
  const toolingConflicts = testToolingSourceConflicts(
    config,
    [
      ...new Set(
        pipeline.graph.resources.flatMap((resource) =>
          resource.id === null ? [] : sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog).get(resource.id) ?? [],
        ),
      ),
    ],
  );
  if (toolingConflicts.length > 0) {
    throw new GateforgeConfigError(
      toolingConflicts.map((conflict) => ({
        file: '.gateforge.yml',
        jsonPath: '$.project.paths.testTooling',
        message:
          `glob '${conflict.glob}' matches the source of a discovered resource: declared test tooling ` +
          'cannot be product code — narrow the glob',
        expected: 'a glob that matches no discovered resource source',
        got: conflict.file,
      })),
    );
  }
  // Owner quarantine population: check is
  // the debt view, so an owner-quarantined test is reported here too —
  // loaded against the INJECTED run clock, never the wall clock. It is
  // only reported when the population exists, so a repository that never
  // quarantined anything gets exactly the document it had before.
  const quarantines = loadQuarantines(join(io.cwd, ...QUARANTINE_DIR.split('/')), {
    now: pipeline.now,
  });
  for (const notice of pipeline.alembicNotices) {
    writeLine(io.stdout, `alembic: ${notice}`);
  }
  if (diffScoped && format === 'text') {
    const base =
      providerIdentity === 'github-pr'
        ? io.env['GITHUB_BASE_REF'] ?? '<missing GITHUB_BASE_REF>'
        : providerIdentity === 'gitlab-mr'
          ? io.env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] ?? '<missing merge-request base>'
          : 'staged index vs HEAD';
    writeLine(
      io.stdout,
      `changed files: ${pipeline.changedFiles.length} (${providerIdentity}, ${base})`,
    );
  }

  if (options.runtimeReuseCheck !== undefined) {
    let currentReuseDigest: string | null;
    try {
      currentReuseDigest = options.runtimeReuseCheck();
    } catch {
      currentReuseDigest = null;
    }
    if (currentReuseDigest !== runtimeReuseDigest) {
      writeLine(io.stderr, 'check: reused dependency bytes changed during discovery; refusing the staged check');
      return 1;
    }
  }

  // Post-discovery stability + full digest (plan §11.5): the input tree
  // must not have moved under discovery, and the current digest is what
  // the stored envelope must equal (D3). A changing tree cannot
  // establish a reliable digest — the run blocks without certifying.
  const httpRoutes = httpRoutesView(pipeline.graph);
  let expectedDigest: string | null = null;
  let changedInputs = false;
  let currentSnapshot: InputSnapshot | null = null;
  let diagnosticCandidateTreeId = options.fixedCandidateTreeId ?? null;
  let diagnosticEvidenceState = 'not-required';
  if (!snapshotUnavailable) {
    try {
      const postFiles = collectInputFiles(io.cwd, config, stateDir, runtimeReuseMounts, docsExclusions, cacheExclusions);
      if (preFiles !== null && diffInputFiles(preFiles, postFiles).length > 0) {
        changedInputs = true;
      } else {
        currentSnapshot = computeInputSnapshot({
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
          runtimeReuseDigest,
          runtimeReuseMounts,
          docsExclusions,
          cacheExclusions,
        });
      expectedDigest = currentSnapshot.inputDigest;
      }
    } catch (error) {
      if (error instanceof SnapshotUnavailableError) {
        snapshotUnavailable = true;
      } else if (error instanceof UnsupportedSnapshotError) {
        throw new UsageError(`unsupported input snapshot: ${error.message}`);
      } else {
        throw error;
      }
    }
  }
  let claimBindings: Claim[] = [];
  if (expectedDigest !== null && verifierKeyring !== null) {
    const claimPolicyDigest = docsApprovalDigest ?? trustedPolicyDigestForConfig(io.cwd, config);
    const claimReceipt = loadReceiptFor(stateDir, verifierKeyring, {
      inputDigest: expectedDigest,
      trustedPolicyDigest: claimPolicyDigest,
    });
    if (
      claimReceipt.status === 'ok' &&
      claimReceipt.executionResult.inputDigest === expectedDigest &&
      claimReceipt.executionResult.trustedPolicyDigest === claimPolicyDigest
    ) {
      claimBindings = [...(claimReceipt.executionResult.claimInventory ?? [])];
    }
  }
  diagnosticEvidenceState = snapshotUnavailable
    ? 'snapshot-unavailable'
    : changedInputs
      ? 'inputs-changed'
      : expectedDigest === null
        ? 'input-digest-unavailable'
        : requireE2E
          ? 'receipt-not-checked'
          : 'not-required';

  // One effective evaluation scope (plan §12.2, D4; Phase 4 item 2
  // conservative expansion), computed BEFORE grading and applied to
  // obligations AND blockers: without `--changed` the run stays
  // all-files; with `--changed` a diff touching any gate-defining input
  // (policy/classification/pack configs, adapters, waivers, plugin impl,
  // manifests, ignore controls), a test file, a test-directory
  // fixture/helper, the runner configuration, or the mapping sidecar
  // expands to all. Under strict E2E mode an UNCLASSIFIED changed file
  // also expands the scope and surfaces as a `CHANGE_UNMAPPED` blocking
  // entry (E15) unless a resolved mapping covers it. The provider
  // identity is preserved throughout — an expanded run never stamps
  // `all-files` as the diff provider.
  let scopeDecision: ScopeDecision = {
    mode: 'all',
    changedFiles: [],
    expandedBecause: [],
    unmappedFiles: [],
    policyInputs: [],
    policyInputsOnly: false,
    productBehaviorNeutral: false,
    docsOnly: false,
  };
  // F2 adoption mode: computed from the BASE revision (HEAD for the
  // staged diff), never declared — no flag, no config key. It only moves
  // WHICH obligations must be proven (the ones this commit newly claims);
  // it never relaxes `CHANGE_UNMAPPED` and never forgives an obligation.
  let adoptionCommit = false;
  let mismatchBlocking: BlockingEntry[] = [];
  let scopeDiscoveryTimings: DiscoveryTimings | undefined;
  if (scopeAwareRun) {
    // Phase 4 expansion inputs (E15): the test inventory is loaded only
    // when test infrastructure exists for the CONFIGURED runner (`runner:`
    // in `.gateforge.yml`; an absent key means playwright, so a repository
    // without it keeps the exact historical behavior) or a mapping
    // sidecar.
    const sidecar = loadOptionalTestMap(io.cwd);
    const runnerConfigs = runnerConfigPaths(io.cwd, config.runner);
    const runtimeInputs = runtimeDeclaredInputs(io.cwd, config);
    let testFiles: string[] = [];
    let testInfrastructureFiles: string[] = [];
    let fileVerdict: ((file: string) => 'claimed' | 'disclaimed' | 'unclaimed') | undefined;
    if (runnerConfigs.length > 0) {
      try {
        const scopeDiscovery = await discoverTestCatalog({
          cwd: io.cwd,
          config,
          excludeFile: engineGeneratedStateFileFilter(io.cwd, stateDir),
        });
        scopeDiscoveryTimings = scopeDiscovery.timings;
        testFiles = scopeDiscovery.catalog.entries
          .filter((entry) => entry.runner === config.runner)
          .map((entry) => entry.file);
        testInfrastructureFiles = scopeDiscovery.testInfrastructureFiles;
        fileVerdict = scopeDiscovery.fileVerdict;
      } catch {
        // Discovery problems surface on their own gates; scope expansion
        // proceeds with the infrastructure signals it does have.
        testFiles = [];
        testInfrastructureFiles = [];
        fileVerdict = undefined;
      }
    }
    const knownSourceFiles = [
      ...new Set(
        pipeline.graph.resources.flatMap((resource) =>
          resource.id === null ? [] : sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog).get(resource.id) ?? [],
        ),
      ),
    ];
    // 0.9.0 D2: the Gateforge-owned policy inputs of this change set are
    // classified here (check owns the candidate checkout; `scope.ts` stays
    // pure) so they never become unmapped product changes and their change
    // set can be recognized as product-behavior-neutral.
    // 0.9.1: the base-text reader reads a file at the base revision the
    // provider diffs against (HEAD for the staged diff, the merge/CI base
    // for the platform diffs), so the `.gitignore` engine-state block
    // `init` appends is recognized as wiring. Staged-candidate runs (a
    // frozen index) take the reader the orchestrator resolved against the
    // USER's repository BEFORE the process moved to the isolated checkout:
    // the checkout's HEAD is the staged tree, not the base, so the base
    // revision's objects are reachable only in the user's repository.
    const baseText =
      fixedChangedFiles === undefined
        ? changeBaseTextReader(providerIdentity, io.cwd, io.env) ?? undefined
        : options.fixedBaseText;
    // The adoption verdict rides the SAME base reader the policy-input
    // classifier uses: HEAD for the staged diff, the merge/CI base for the
    // platform diffs. Condition 3 (the owner-approved digest) is checked
    // by the receipt gate below, which reaches its coverage decision only
    // after that pin has passed.
    adoptionCommit = evaluateAdoptionCommit({
      baseText: baseText ?? null,
      configPath: '.gateforge.yml',
      candidateEnforcement: config.enforcement !== undefined && Object.keys(config.enforcement).length > 0,
      changedFiles: pipeline.changedFiles,
    }).adoptionCommit;
    const ownedInputs = gateforgeOwnedInputs(io.cwd, pipeline.changedFiles, config, baseText);
    // A path this change DELETED that no configured runner's own
    // test-file selection ever claimed. Nothing collected it, so removing
    // it removes no test and no behaviour: it neither expands the scope
    // nor blocks as unmapped. Without a readable runner selection
    // (`fileVerdict` absent) nothing is excused and every deletion keeps
    // today's treatment.
    const removedUnclaimedFiles =
      fileVerdict === undefined || baseText === undefined
        ? []
        : pipeline.changedFiles.filter(
            (file) =>
              !existsSync(join(io.cwd, ...file.split('/'))) &&
              baseText(file) !== null &&
              fileVerdict(file) === 'disclaimed',
          );
    scopeDecision = computeEvaluationScope({
      config,
      changedFiles: pipeline.changedFiles,
      testFiles,
      runnerConfigs,
      testInfrastructureFiles,
      runtimeInputs,
      removedUnclaimedFiles,
      mappingSidecar: sidecar !== null,
      knownSourceFiles,
      strictE2E: config.enforcement?.strictE2E === true,
      policyInputs: [...ownedInputs.keys()],
    });
    // CHANGE_UNMAPPED (plan §5.4, E15): strict mode blocks unclassified
    // changes unless a resolved mapping covers the file (journey
    // associations are not implemented yet — documented Phase 4 state).
    const sidecarCoveredFiles = new Set(
      (sidecar?.tests ?? []).map((entry) => entry.selector.file),
    );
    const unmappedBlocking: BlockingEntry[] = scopeDecision.unmappedFiles
      .filter((file) => !sidecarCoveredFiles.has(file))
      .map((file): BlockingEntry => ({
        kind: 'finding',
        resourceId: null,
        name: file,
        detail:
          `changed file '${file}' has no safe obligation/journey scope — unknown behavior changes ` +
          'stay visible and blocking until mapped (strict E2E mode)',
        location: { file, line: 1, col: 0 },
        cause: 'CHANGE_UNMAPPED',
        // 0.9.0 problem 26: the remediation names the step that actually
        // attributes the file. `gateforge explain <file>` prints what the file
        // is and what governs it (a discovered resource, a gate input, or an
        // unclassified change) so the owner can map, declare or detect it.
        nextAction:
          `Attributing '${file}' starts with \`gateforge explain ${file}\`, which prints what the file is ` +
          'and what governs it: map the detected resource, declare documentation folders with ' +
          '`gateforge init --docs-exclude <folders>`, or add the detection that owns the file. ' +
          'Never weaken the policy.' +
          // The docs-only exemption is engine-owned and applies only to a
          // WHOLE documentation commit, so name the route that works
          // rather than leaving the owner to guess at "mixed change".
          (file.startsWith('docs/') && file.endsWith('.md')
            ? ' A `docs/**.md` edit is exempt only when the WHOLE commit is documentation: commit it on its own, before or after this change.'
            : ''),
      }));
    mismatchBlocking = [...mismatchBlocking, ...unmappedBlocking];
    // The local-staged provider lists index changes, but discovery reads
    // working-tree bytes. Files differing in both must not be silently
    // certified: force the full scope and add an explicit blocking
    // diagnostic naming the staged verification gap (§12.3). Phase 5
    // staged-candidate runs skip this diagnostic entirely: the gate
    // executes in a materialized checkout of the staged bytes, so there
    // is no worktree/index divergence to detect — the exact staged bytes
    // ARE the evaluated input.
    if (providerIdentity === 'local-staged' && fixedChangedFiles === undefined) {
      const mismatched = detectStagedWorkingTreeMismatches(io.cwd, io.env);
      if (mismatched.length > 0) {
        scopeDecision = {
          mode: 'all',
          changedFiles: scopeDecision.changedFiles,
          expandedBecause: scopeDecision.expandedBecause,
          unmappedFiles: scopeDecision.unmappedFiles,
          policyInputs: scopeDecision.policyInputs,
          policyInputsOnly: scopeDecision.policyInputsOnly,
          productBehaviorNeutral: scopeDecision.productBehaviorNeutral,
          // A worktree that diverges from the index is not the candidate,
          // so it can never be certified as the docs-only slice either.
          docsOnly: false,
        };
        mismatchBlocking = [
          ...mismatchBlocking,
          ...mismatched.map(
            (file): BlockingEntry => ({
              kind: 'finding',
              resourceId: null,
              name: null,
              detail:
                `staged verification cannot certify '${file}': staged (index) bytes differ ` +
                'from working-tree bytes, but discovery reads the working tree — commit or ' +
                'stash the worktree change, or run without --changed to verify the worktree',
              location: { file, line: 1, col: 0 },
            }),
          ),
        ];
      }
    }
  }

  // 0.9.0 D2: the adopted baseline is a recorded, shrink-only statement of
  // pre-existing debt, not an owner risk acceptance, so it survives the
  // strict-E2E re-grade while a change set is provably product-behavior-
  // neutral: Gateforge-owned policy inputs only (the scope for those files is
  // unchanged — they keep expanding as gate-defining inputs exactly as
  // today). The forgiveness is granted only when the owner has pinned the
  // policy revision that governs those files: a mismatching pin still blocks
  // on its own, and with no pin today's reporting stays (adopted debt is
  // re-graded as blocking). An owner waiver is never forgiveness here.
  //
  // 0.10.2 (adoption mode, REFERENCE "Adoption mode"): the commit that WIRES the gate is
  // never policy-inputs-only — it brings the manifest, the runner
  // configuration, the mapping sidecar and the specs, every one of them
  // gate-defining or test infrastructure — so the 0.9.0 condition could
  // never hold for exactly the commit adoption mode exists to serve, and
  // adopted debt was re-graded blocking on the first commit of every
  // repository. The forgiveness therefore ALSO holds when the change set is
  // product-behaviour-NEUTRAL, read from the same attribution that produced
  // the scope decision (every changed file is a policy input, a
  // gate-defining input, a catalog test file, test infrastructure, a
  // runtime-declared input or docs, and NO discovered resource's source is
  // in the set), AND this candidate IS an adoption commit (computed from
  // the base revision, never declared), AND the owner pin is enforced on
  // exactly the same `evaluateApprovedPolicy(...).status === 'enforced'`
  // condition. One product source in the change set denies the neutrality,
  // so the strict re-grade returns. Nothing else moves.
  //
  // 0.10.4 (`enforcement.adoptedDebt`, the OWNER-PINNED setting for how
  // adopted debt is treated under strict E2E AFTER the adoption commit):
  // `lenient` — the ABSENT default — drops the `adoptionCommit` term from
  // the neutrality branch, so the forgiveness survives on ANY diff-scoped
  // change set with no product source: a later commit that only adds tests,
  // the mapping sidecar or runner configuration no longer has to re-prove
  // debt `gateforge adopt` already recorded, which is what 0.10.3 demanded
  // of the first test-adding commit of every repository. `strict` keeps
  // the 0.10.3 condition byte for byte (an adoption commit or
  // policy-inputs-only, plus the enforced pin). The pin requirement is
  // UNCHANGED in both values, a newly claimed obligation is still graded
  // on its own evidence (the forgiveness covers adopted-baseline entries
  // only), and one discovered resource's source in the change set denies
  // the neutrality in either value. `init --preset strict` writes no key,
  // so a preset install gets the lenient default like every other.
  const adoptedDebtLenient = config.enforcement?.adoptedDebt !== 'strict';
  const ownerPinEnforced =
    evaluateApprovedPolicy(
      docsApprovalResolution ??
        resolveApprovedPolicyDigest({
          flag: options.approvedPolicyDigest,
          env: io.env,
          candidateCwd: io.cwd,
          candidateConfig: config,
        }),
      docsApprovalDigest ?? trustedPolicyDigestForConfig(io.cwd, config),
      config.enforcement?.strictE2E === true || hasOwnerExclusions,
    ).status === 'enforced';
  const adoptedBaselineSurvivesStrictE2E =
    diffScoped &&
    (scopeDecision.policyInputsOnly ||
      ((adoptionCommit || adoptedDebtLenient) && scopeDecision.productBehaviorNeutral)) &&
    ownerPinEnforced;

  // 0.10.4: the same slice as a RECEIPT-COVERAGE fact. Forgiveness alone
  // would not unblock the commit it exists for: a tests/test-map/runner-
  // config change expands the evaluation to every obligation, so the
  // scoped receipt is refused with `EVIDENCE_SCOPE_INCOMPLETE` over the
  // adopted debt BEFORE any verdict is graded. Under strict E2E with the
  // lenient default such a change set therefore demands exactly what
  // adoption mode demands of the wiring commit — coverage of the
  // obligations it newly claims — while every untouched obligation stays
  // unproven, named debt. Narrowed to the lenient value, to strict E2E
  // (a non-strict run keeps today's requirement byte for byte) and to an
  // ENFORCED pin (same trust bar as the forgiveness above), so `strict`
  // and an unpinned candidate keep 0.10.3 exactly.
  const adoptedDebtCoverageSlice =
    config.enforcement?.strictE2E === true &&
    adoptedDebtLenient &&
    diffScoped &&
    scopeDecision.productBehaviorNeutral &&
    ownerPinEnforced;

  // Static annotations are compared with generated sidecar entries. The
  // advisory is deliberately separate from blockers for this warning-only
  // release period; only the tracked sidecar and a verified receipt bind
  // claims during check.
  // Environment-dependent registration warnings are stderr advisories;
  // they never declare claims or alter the gate result.
  const currentTestMap = loadOptionalTestMap(io.cwd);
  const annotationScanStartedAtMs = performance.now();
  const annotationScan = scanTestFiles({
    cwd: io.cwd,
    include: config.project.paths.include,
    exclude: config.project.paths.exclude,
    excludeFile: engineGeneratedStateFileFilter(io.cwd, stateDir),
  });
  const tsScanMs = performance.now() - annotationScanStartedAtMs;
  for (const warning of annotationScan.registrationWarnings) {
    writeLine(
      io.stderr,
      `check: registration warning ${warning.file}:${String(warning.location.line)}: ` +
        `${warning.titlePath.join(' > ')} is conditional on ${warning.environmentVariable}; ` +
        'keep test registration independent of Gateforge run variables',
    );
  }
  const annotationAdvisories = annotationMapSyncAdvisories(annotationScan, currentTestMap);
  const mockedOnlyAdvisories = mockedOnlyEndpointAdvisories(
    pipeline.endpointInventory.endpoints,
    annotationScan.entries,
  );
  let claimInventory: Claim[] = claimBindings;
  let mappingBlockers: BlockingEntry[] = [];
  let mappedCoverage: MappedCoverage[] = [];
  let mappingDiscoveryTimings: DiscoveryTimings | undefined;
  const pytestCacheCounts: CacheCounts = { hits: 0, misses: 0 };
  const pytestCollection: NonNullable<DiscoverOptions['pytestCollection']> = async (
    suite,
    suiteCwd,
    collectorArgv,
    collect,
  ) => {
      if (cacheControl.disabled) return collect();
      const inputDigest = digestPytestInputs(io.cwd, stateDir, cacheControl.stateDir);
      const collectorEnv = { ...untrustedEnv(io.env), PYTHONDONTWRITEBYTECODE: '1' };
      const collectorInterpreter = interpreterIdentity(collectorArgv[0] ?? '', collectorEnv);
      if (inputDigest === null || collectorInterpreter === null) {
        pytestCacheCounts.misses += 1;
        return collect();
      }
      const environmentDigest = createHash('sha256')
        .update(JSON.stringify(Object.entries(collectorEnv).sort(([a], [b]) => a.localeCompare(b))))
        .digest('hex');
      const key = pytestCacheKey(
        {
          name: suite.name,
          cwd: suiteCwd,
          argv: suite.argv,
          collectorArgv,
          testPaths: suite.testPaths,
          timeoutMs: suite.timeoutMs,
        },
        inputDigest,
        collectorInterpreter,
        environmentDigest,
      );
      let cached: unknown | null = null;
      try {
        cached = readPytestCache(cacheControl.stateDir, key);
      } catch {
        cached = null;
      }
      if (isPytestCollectionResult(cached)) {
        pytestCacheCounts.hits += 1;
        return cached;
      }
      pytestCacheCounts.misses += 1;
      const result = await collect();
      if (result.status === 'discovered' && result.exitCode === 0) {
        try {
          writePytestCache(cacheControl.stateDir, key, result);
        } catch {
          // Storage failure costs only a future miss; collection is authoritative.
        }
      }
      return result;
    };
  // A repository that declares business rules but ships no sidecar must
  // still be graded: every case reads `unmapped` (a blocking finding), so
  // skipping the resolution here would hide the feature's whole point.
  let ruleBindings: RuleClaimBindings[] = [];
  let ruleCatalog: TestCatalog | null = null;
  if (currentTestMap !== null || pipeline.businessRules.length > 0) {
    const mapped = await resolveRepositoryMappings({
      cwd: io.cwd,
      config,
      stateDir,
      obligations: pipeline.policy.obligations,
      businessRules: pipeline.businessRules,
      claimBindings,
      behaviorCatalog: pipeline.behaviorCatalog,
      pytestCollection,
    });
    mappingDiscoveryTimings = mapped.discoveryTimings;
    claimInventory = mapped.claimInventory;
    mappingBlockers = [
      ...mappingBlocking(mapped.resolution.problems),
      ...nativeInventoryBlocking(mapped.nativeLoadProblem),
    ];
    mappedCoverage = mappedCoverageFrom(mapped.resolution, pipeline.policy.obligations, pipeline.graph);
    ruleBindings = mapped.resolution.ruleBindings;
    ruleCatalog = mapped.catalog;
  }

  const adoptedBaseline = resolveAdoptedBaseline(io.cwd, config.baselines);
  // A re-sealed run grades the evidence UNION: this run's own records
  // plus the parent's carried ones, authenticated by the retained
  // parent envelope. `resealChainBlocking` below is what recomputes the
  // whole chain and fails closed on any difference.
  const carriedEvidence = retainedCarriedEvidence(stateDir);
  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    behaviorCatalog: pipeline.behaviorCatalog,
    behaviorAuthorityProfileDigest:
      pipeline.behaviorCatalog === null
        ? null
        : engineBundleDigestOf(VERSION, trustedPolicyDigestForConfig(io.cwd, config)),
    obligations: pipeline.policy.obligations,
    blocking: [...pipeline.policy.blocking, ...mismatchBlocking, ...mappingBlockers],
    stateDir,
    now: pipeline.now,
    engineAlembicRecords: pipeline.engineAlembicRecords,
    // One effective scope (§12.2), decided before grading: an expanded
    // (gate-defining) diff evaluates everything — obligations AND
    // blockers — exactly like the unrestricted run.
    // Only an EXPLICIT `--changed` narrows what gets graded. `mode:
    // changed` reuses the same scope computation for its DECISION while
    // the full debt stays in the report — that is the whole difference
    // between the two.
    changedFiles: diffScoped && scopeDecision.mode !== 'all' ? scopeDecision.changedFiles : null,
    claimInventory,
    mappedCoverage,
    witnessVerifierKey,
    witnessVerifierKeys: verifierKeyring?.keys.map((entry) => entry.key),
    ...(carriedEvidence === null ? {} : { carriedEvidence }),
    baseline: adoptedBaseline,
    // 0.9.0 D2: see `adoptedBaselineSurvivesStrictE2E` above.
    adoptedBaselineSurvivesStrictE2E,
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      requireInvocationId: false,
      changedInputs,
    },
  });
  const baselineReport =
    adoptedBaseline === null
      ? undefined
      : {
          obligations: evaluated.baselined?.obligations ?? 0,
          blockingEntries: evaluated.baselined?.blockingEntries ?? 0,
          ...(evaluated.baselined?.classificationBlocked !== undefined
            ? { classificationBlocked: evaluated.baselined.classificationBlocked }
            : {}),
          adoptedAt: adoptedBaseline.adoptedAt,
          ageDays: Math.max(
            0,
            Math.floor((Date.parse(pipeline.now) - Date.parse(adoptedBaseline.adoptedAt)) / 86_400_000),
          ),
          neverWitnessed: evaluated.baselined?.neverWitnessed ?? 0,
        };

  const baselineDriftAdvisories: BlockingEntry[] = [];
  if (
    scopeDecision.mode === 'changed' &&
    adoptedBaseline?.obligationFingerprintsById !== undefined &&
    adoptedBaseline.obligationSourcesById !== undefined
  ) {
    const currentSources = sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog);
    const currentFingerprints = new Map(
      pipeline.policy.obligations.map((obligation) => [
        obligation.id,
        obligationFingerprint(obligation),
      ]),
    );
    const lostByFile = new Map<string, Set<string>>();
    for (const [id, oldFingerprint] of adoptedBaseline.obligationFingerprintsById) {
      const currentFingerprint = currentFingerprints.get(id);
      if (
        currentFingerprint === undefined ||
        currentFingerprint === oldFingerprint ||
        !adoptedBaseline.fingerprints.has(oldFingerprint)
      ) {
        continue;
      }
      const sourcePaths = new Set([
        ...(adoptedBaseline.obligationSourcesById.get(id) ?? []),
        ...(currentSources.get(id) ?? []),
      ]);
      for (const file of scopeDecision.changedFiles) {
        if (!sourcePaths.has(file)) continue;
        const obligations = lostByFile.get(file) ?? new Set<string>();
        obligations.add(id);
        lostByFile.set(file, obligations);
      }
    }
    for (const [file, obligations] of [...lostByFile].sort(([a], [b]) => a.localeCompare(b))) {
      baselineDriftAdvisories.push({
        kind: 'finding',
        resourceId: null,
        name: null,
        detail:
          `${obligations.size} adopted baseline obligation(s) lost their baseline because ${file} changed`,
        location: null,
        cause: null,
        nextAction: 'Compare baseline files with `gateforge baseline diff <before> <after>`.',
      });
    }
  }

  // `--require-e2e` (plan Phase 4 item 5, ADR 0005 D3): the strict
  // saved-state gate. Without a valid, non-stale receipt for the CURRENT
  // input digest the run blocks — missing receipt (RUN_INCOMPLETE),
  // stale inputs (EVIDENCE_STALE, E13), forged/tampered (typed
  // ENFORCEMENT_UNTRUSTED). Old record bundles without receipts are
  // rejected, never silently accepted.
  //
  // Scope consumption (Goal 2): a FULL receipt (or a legacy one with no
  // scope field) covers everything, as before. A CHANGED-scope receipt
  // satisfies the gate only when EVERY obligation this evaluation demands
  // — the changed-slice join for a narrowed run, every obligation for an
  // unscoped/expanded one — is inside its sealed covered set; otherwise a
  // typed EVIDENCE_SCOPE_INCOMPLETE blocker names the uncovered
  // obligations (fail closed, never a silent partial pass).
  //
  // Approved-policy ownership gate (review 2026-09-13 P1 #5): before any
  // receipt is consulted, the candidate's recomputed trusted policy
  // digest is compared against the OWNER-APPROVED digest provisioned
  // OUTSIDE the candidate (protected env / flag / trusted config). A
  // weakened candidate policy is a typed ENFORCEMENT_UNTRUSTED block; a
  // missing pin under enforcement.strictE2E fails closed with the exact
  // provisioning step; a receipt sealed under a different approved
  // revision is rejected (policy revision changed after sealing).
  // The obligations this evaluation demands receipt coverage for (Goal 2
  // scope consumption): the changed-slice join for a narrowed run — the
  // SAME join-aware sources map the diff scoping grades by — and EVERY
  // obligation for an unscoped or expanded run (a slice receipt cannot
  // silently certify a whole-repo evaluation). Carried as id +
  // pin-#2 fingerprint, the exact identity a changed-scope receipt seals.
  // ADOPTION MODE (F2 §4): the commit that wires the gate always expands
  // the scope, yet the only affordable proof of a large repository is a
  // changed-slice receipt. An adoption commit therefore demands coverage
  // of the obligations this change set NEWLY CLAIMS — the same
  // join-aware slice a narrowed run demands — while every obligation it
  // does not touch stays unproven debt (`adopt` baselines it, and the
  // report still names it). Nothing else moves: a policy-input pin
  // mismatch, a receipt bound to another candidate tree, a
  // `CHANGE_UNMAPPED` file and an uncovered newly claimed obligation are
  // all refused exactly as before.
  // ADOPTED DEBT (0.10.4, `adoptedDebtCoverageSlice` above): the same
  // treatment a product-behaviour-neutral change set gets after the
  // adoption commit — coverage of what it newly claims, never of the
  // adopted debt the change cannot have affected.
  //
  const coverageChangedFiles =
    diffScoped &&
    (scopeDecision.mode === 'changed' || adoptionCommit || adoptedDebtCoverageSlice)
      ? scopeDecision.changedFiles
      : null;
  const requiredCoverage = (): ScopedObligationRef[] => {
    const sources = sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog);
    return pipeline.policy.obligations
      .filter((obligation) => {
        if (coverageChangedFiles === null) return true;
        const obligationSources = sources.get(obligation.resourceId);
        if (obligationSources === undefined) return false;
        return obligationSources.some((source) => coverageChangedFiles.includes(source));
      })
      .map((obligation) => ({ id: obligation.id, fingerprint: obligationFingerprint(obligation) }));
  };

  let receiptBlocking: BlockingEntry[] = [];
  // The digest-verified receipt load, hoisted out of the `--require-e2e`
  // block because the business-rule grader reads its SEALED execution
  // result. `check` never re-parses `execution-result.json` itself: that
  // document is suite-writable state, and only the receipt's own MAC and
  // execution digest make it trustworthy. Absent (no `--require-e2e`, or
  // no receipt) rules grade as `unproven` — a declaration is never proof.
  let verifiedRuleReceipt: ReceiptLoad | null = null;
  if (requireE2E) {
    if (snapshotUnavailable || expectedDigest === null) {
      receiptBlocking = [
        {
          kind: 'finding',
          resourceId: null,
          name: null,
          detail:
            'require-e2e: the input snapshot is unavailable, so no gate receipt can be validated for this candidate (fail closed)',
          location: null,
          cause: 'ENFORCEMENT_UNTRUSTED',
          nextAction: CAUSE_NEXT_ACTIONS.ENFORCEMENT_UNTRUSTED,
        },
      ];
    } else {
      const candidatePolicyDigest = docsApprovalDigest ?? trustedPolicyDigestForConfig(io.cwd, config);
      const resolution = docsApprovalResolution ?? resolveApprovedPolicyDigest({
        flag: options.approvedPolicyDigest,
        env: io.env,
        candidateCwd: io.cwd,
        candidateConfig: config,
      });
      const gate = evaluateApprovedPolicy(
        resolution,
        candidatePolicyDigest,
        config.enforcement?.strictE2E === true || hasOwnerExclusions,
      );
      if (gate.status === 'blocked') {
        diagnosticEvidenceState = 'owner-policy-blocked';
        receiptBlocking = [
          {
            kind: 'finding',
            resourceId: null,
            name: null,
            detail: `require-e2e: ${gate.detail}`,
            location: null,
            cause: gate.cause,
            nextAction: gate.nextAction,
          },
        ];
      } else {
        const gitDir = resolveGitDir(io.cwd, io.env);
        const candidateTreeSnapshot =
          gitDir === null
            ? null
            : computeCandidateTreeSnapshot(
                gitDir,
                io.cwd,
                io.env,
                stateDir,
                'record',
                runtimeReuseMounts,
                docsExclusions,
                cacheExclusions,
              );
        const candidateTreeId =
          docsExclusions.length > 0 || cacheExclusions.length > 0
            ? (candidateTreeSnapshot?.treeId ?? null)
            : (options.fixedCandidateTreeId ?? candidateTreeSnapshot?.treeId ?? null);
        diagnosticCandidateTreeId = candidateTreeId;
        const load = loadReceiptFor(
          stateDir,
          verifierKeyring,
          {
            inputDigest: expectedDigest,
            trustedPolicyDigest: candidatePolicyDigest,
            candidateTreeId,
            // check cannot know the run's selection/catalog identity —
            // those expectations are skipped here and enforced on the
            // test-gates reuse path; the input-digest binding is the
            // staleness contract (E13).
            selectionDigest: undefined,
            catalogDigest: undefined,
            executionBoundaryDigest: executionBoundaryDigestOf(
              io.env['GATEFORGE_AUTHORITY_BOUNDARY']?.trim() || LOCAL_UNISOLATED_BOUNDARY,
            ),
          },
        );
        diagnosticEvidenceState = load.status === 'ok' ? 'receipt-verified' : `receipt-${load.status}`;
        if (load.status === 'ok') {
          // Retained for the business-rule grader below; cleared again at
          // the end of this branch if any refusal landed, because a
          // receipt this check is refusing must not grade anything.
          verifiedRuleReceipt = load;
          if (
            load.receipt.engine !== undefined &&
            load.receipt.engine.version !== engineIdentity().version
          ) {
            const detail =
              `require-e2e: receipt engine version '${load.receipt.engine.version}' differs from ` +
              `installed version '${engineIdentity().version}'`;
            receiptBlocking = [
              {
                kind: 'finding',
                resourceId: null,
                name: null,
                detail: humanMessage({
                  cause: 'ENFORCEMENT_UNTRUSTED',
                  detail,
                  nextAction: 'gateforge test-gates --changed',
                }),
                location: null,
                cause: 'ENFORCEMENT_UNTRUSTED',
                nextAction: 'gateforge test-gates --changed',
              },
            ];
          }
          // A provisioned pin binds the receipt too: a receipt sealed
          // under a since-revoked/different approved revision is a typed
          // reject, and under a pin the binding must be present. When the
          // binding decides, the coverage check below is skipped.
          if (receiptBlocking.length === 0 && gate.status === 'enforced') {
            const binding = assertReceiptApprovedPolicy(load.receipt, gate.approved);
            if (!binding.ok) {
              receiptBlocking = [
                {
                  kind: 'finding',
                  resourceId: null,
                  name: null,
                  detail: `require-e2e: ${binding.detail}`,
                  location: null,
                  cause: binding.cause,
                  nextAction: binding.nextAction,
                },
              ];
            }
          }
          // 0.10.2: a `docsOnly` receipt is a CLAIM, exactly like the
          // re-seal's `changeClass`: it says this candidate's WHOLE changed
          // set was `docs/**.md`. The consumer recomputes that decision from
          // its OWN scope computation rather than believing it, so a marking
          // that does not match the staged change set is refused. A matching
          // one covers nothing — `scopedReceiptCoverageBlocking` below still
          // demands a fingerprint for every obligation this change produces.
          if (receiptBlocking.length === 0 && load.receipt.docsOnly === true && !scopeDecision.docsOnly) {
            receiptBlocking = [
              {
                kind: 'finding',
                resourceId: null,
                name: null,
                detail:
                  `require-e2e: the receipt claims the engine-owned docs-only slice, but this change set is not ` +
                  `docs-only (changed files: ${scopeDecision.changedFiles.length > 0 ? scopeDecision.changedFiles.join(', ') : '<none>'}) ` +
                  '— the claim is a stale slice, not this candidate (fail closed)',
                location: null,
                cause: 'EVIDENCE_STALE',
                nextAction: CAUSE_NEXT_ACTIONS.EVIDENCE_STALE,
              },
            ];
          }
          if (receiptBlocking.length === 0) {
            // Scope consumption (Goal 2): full receipts pass unchanged; a
            // changed-scope receipt must cover every obligation this
            // evaluation demands or the typed blocker names the gap.
            receiptBlocking = scopedReceiptCoverageBlocking(load.receipt, requiredCoverage());
            // Re-seal recomputation (plan phase 3): a `test-only`
            // receipt is a claim. The chain it names is authenticated
            // with THIS keyring, the two sealed trees are re-diffed
            // with THIS engine, the change set is re-classified and
            // the affected set recomputed — any difference is a typed
            // EVIDENCE_STALE naming the exact mismatch.
            if (receiptBlocking.length === 0 && load.receipt.resealedFrom !== undefined) {
              receiptBlocking = resealChainBlocking({
                stateDir,
                receipt: load.receipt,
                verifierKeyring,
                gitDir,
                cwd: io.cwd,
                env: io.env,
                ...(config.enforcement?.resealRuntimeFiles !== undefined
                  ? { runtimeFileGlobs: config.enforcement.resealRuntimeFiles }
                  : {}),
              }).map((entry) => ({ ...entry, detail: `require-e2e: ${entry.detail}` }));
            }
          }
          if (receiptBlocking.length > 0) diagnosticEvidenceState = 'receipt-verified-with-blocking-entry';
          if (receiptBlocking.length > 0) verifiedRuleReceipt = null;
        } else {
          receiptBlocking = receiptGateBlocking(load);
          if (load.status === 'stale') {
            const changedPaths = authenticatedChangedInputs(stateDir, verifierKeyring, currentSnapshot);
            const docsOnly = changedPaths.length > 0 && changedPaths.every((path) =>
              /^(?:docs?|guides?)\//i.test(path) || /\.(?:md|mdx|rst|txt)$/i.test(path),
            );
            const changedSummary =
              changedPaths.length > 0
                ? ` changed inputs: ${changedPaths.join(', ')}.` +
                  (docsOnly
                    ? ' Only documentation paths changed; if these are approved documentation folders, run `gateforge init --docs-exclude <folders>`.'
                    : '')
                : ' the saved input inventory is unavailable or the change is in gate context rather than file bytes.';
            const sealedTreeEntries = readCandidateTreeEntries(stateDir);
            const treeDiff =
              load.detail.toLowerCase().includes('candidate tree') &&
              candidateTreeSnapshot !== null &&
              sealedTreeEntries !== null
                ? candidateTreeMismatchSummary(
                    sealedTreeEntries,
                    candidateTreeSnapshot.entries,
                    io.cwd,
                    stateDir,
                    io.env,
                  )
                : '';
            // The engine-upgrade refusal is already one complete sentence
            // naming the cause and the fix; the changed-input summary
            // belongs to the digest line beside it. Both name the same one
            // command that re-seals.
            receiptBlocking = receiptBlocking.map((entry) =>
              entry.detail.startsWith(ENGINE_UPGRADE_REFUSAL_PREFIX)
                ? entry
                : {
                    ...entry,
                    detail: `${entry.detail}${changedSummary}${treeDiff}`,
                    nextAction: 'gateforge test-gates --changed',
                  },
            );
          }
        }
      }
    }
  }

  // Owner-declared business rules (plan 2026-10-05 D4/D5). Graded
  // RUN-WIDE and deliberately OUTSIDE `evaluateRun`: rule findings are
  // never diff-scoped away by `--changed`, and the evaluator's own
  // named-scope projection would drop them (they name no obligation).
  // A case whose test sits outside the sealed run's graded slice is
  // reported `unproven (outside this run's graded slice)` — visible, not
  // absent, and never satisfied by a receipt that never covered it.
  let rulePartition: { blocking: BlockingEntry[]; advisories: BlockingEntry[] } = {
    blocking: [],
    advisories: [],
  };
  // Every graded case (satisfied ones included) for the report's
  // `businessRules` section: a satisfied case names the channel that
  // proved it, and an advisory case is listed here beside its
  // advisory-channel entry (invariant 6: the output says what was
  // proven; invariant 7: a demoted rule never hides).
  let ruleCases: BusinessRuleCaseResult[] = [];
  // `ruleCatalog` is non-null here by construction: declaring rules is
  // exactly what makes the mapping resolution above run. The guard says
  // so to the type checker rather than asserting it.
  if (pipeline.businessRules.length > 0 && ruleCatalog !== null) {
    const runFacts =
      verifiedRuleReceipt === null
        ? null
        : businessRuleRunFacts({
            result: verifiedRuleReceipt.executionResult,
            // The AUTHORIZED records `evaluateRun` graded from, never a
            // raw `records.json` read: a rule case must not be attributed
            // to evidence the obligation grader rejected.
            records: evaluated.records,
            witnessedRunners: witnessedRunnersOf(config),
            scope: receiptScope(verifiedRuleReceipt.receipt),
            docsOnly: verifiedRuleReceipt.receipt.docsOnly === true,
            catalog: ruleCatalog,
          });
    ruleCases = gradeBusinessRules({
      rules: pipeline.businessRules,
      ruleBindings,
      inventory: businessRuleInventory(pipeline.graph),
      runFacts,
      catalog: ruleCatalog,
    }).cases;
    rulePartition = partitionBusinessRuleEntries(pipeline.businessRules, ruleCases);
  }

  const inScopeSourcePaths =
    diffScoped && scopeDecision.mode === 'changed'
      ? sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog)
      : null;
  const changedSourcePaths = new Set(scopeDecision.changedFiles);
  // Scope metadata stays exactly as a non-diff run reports it unless the
  // caller actually asked for `--changed`.
  const reportScope = {
    mode: diffScoped ? scopeDecision.mode : ('all' as const),
    expandedBecause: diffScoped ? scopeDecision.expandedBecause : [],
  };
  const reportVerdicts =
    inScopeSourcePaths === null
      ? evaluated.verdicts
      : evaluated.verdicts.map((verdict) => ({
          ...verdict,
          inScopeBecause: [
            ...new Set(inScopeSourcePaths.get(verdict.obligation.resourceId) ?? []),
          ]
            .filter((file) => changedSourcePaths.has(file))
            .sort(),
        }));
  // Rule findings join the run's OWN blocking set, unconditionally: a
  // `--changed` run never scopes a declared rule away (plan invariant 8).
  const evaluatedBlocking = [...evaluated.blocking, ...receiptBlocking, ...rulePartition.blocking];
  const newDebt =
    diffScoped
      ? reportVerdicts
          .filter((verdict) => BLOCKING_VERDICTS.includes(verdict.verdict))
          .map((verdict) => verdict.obligation.id)
          .sort()
      : null;
  const adapterFindings = await adapterAdvisories(
    io.cwd,
    pipeline,
    evaluated.verdicts,
    stateDir,
  );
  // Per-tenant singletons (plan Phase 4b item 3): one advisory per tagged
  // resource that owes a create. Absent the tag this is an empty list, so
  // a repo without one is byte-identical.
  const singletonFindings = singletonPerTenantAdvisories(
    pipeline.graph.resources,
    new Set(
      evaluated.verdicts
        .filter((verdict) => verdict.obligation.contract === 'persistence:create')
        .map((verdict) => verdict.obligation.resourceId),
    ),
  );
  let report = renderRun(reportVerdicts, {
    format,
    blocking: evaluatedBlocking,
    advisories: [
      ...annotationAdvisories,
      ...mockedOnlyAdvisories,
      ...baselineDriftAdvisories,
      ...adapterFindings,
      ...singletonFindings,
      // Frontend reads a response field the model does not declare (plan
      // Phase 4b item 5). One non-blocking advisory per gap; empty unless
      // a joined endpoint pairs a proven response model with a read, so
      // a repository without both packs renders byte-identically.
      ...responseFieldAdvisories(pipeline.endpointInventory.endpoints),
      // Unmatched by-id routes the owner graded as advisory (0.9.0,
      // owner decision D7). Same code, advisory channel, never blocking:
      // the entries are already out of `pipeline.policy.blocking`, so
      // the exit code and `check --changed` are untouched.
      ...pipeline.unmatchedRouteAdvisories,
      // Advisory business rules (plan D5): the same typed cause codes,
      // in the report's existing advisory channel, out of `blocking` and
      // out of the exit code — but printed and serialized every run, so a
      // demoted rule never hides.
      ...rulePartition.advisories,
    ],
    waiverCounts: evaluated.waiverCounts,
    baseline: baselineReport,
    run: pipeline.manifest,
    toolVersion: VERSION,
    engine: engineIdentity(),
    engineLine: reportEngineLine(),
    lifecycleDerivation: pipeline.lifecycleDerivation,
    scope: reportScope,
    diagnosticContext: {
      scope: reportScope.mode === 'changed' ? 'changed' : 'full',
      candidateTreeId: diagnosticCandidateTreeId,
      inputDigest: expectedDigest,
      evidenceState: diagnosticEvidenceState,
      authority: 'authoritative',
      ...(docsExclusions.length === 0
        ? {}
        : {
            docsExclusions: {
              folders: docsExclusions,
              approvalDigest: docsApprovalResolution?.status === 'ok' ? docsApprovalResolution.digest : null,
              approvalStatus: docsApprovalStatus ?? 'missing',
              guarantee: DOCS_EXCLUSIONS_GUARANTEE,
            },
          }),
      ...(cacheExclusions.length === 0
        ? {}
        : {
            cacheExclusions: {
              files: cacheExclusions,
              approvalDigest: docsApprovalResolution?.status === 'ok' ? docsApprovalResolution.digest : null,
              approvalStatus: docsApprovalStatus ?? 'missing',
              guarantee: CACHE_EXCLUSIONS_GUARANTEE,
            },
          }),
    },
  });
  // Unmatched by-id routes the owner graded as advisory (0.9.0, owner
  // decision D7): loud at the TOP of the text report, not buried in the
  // advisory tail, because a demoted finding must be impossible to miss.
  // The JSON document keeps them in `advisories` under the same code.
  if (format === 'text') {
    const banner = unmatchedRouteBannerLines(
      pipeline.unmatchedRouteAdvisories,
      pipeline.unmatchedRoutesMode,
    );
    if (banner.length > 0) report = `${banner.join('\n')}\n${report}`;
  }
  if (options.timing === true) {
    // Per-step wall-clock timings: additive
    // observability behind `--timing`, never an input to any verdict.
    const collectionMs =
      (scopeDiscoveryTimings?.totalMs ?? 0) + (mappingDiscoveryTimings?.totalMs ?? 0);
    const timing = {
      detectorsMs: Math.round(pipeline.timings.pluginsMs),
      collectionMs: Math.round(collectionMs),
      tsScanMs: Math.round(tsScanMs),
      planningMs: Math.round(pipeline.timings.totalMs - pipeline.timings.pluginsMs),
      totalMs: Math.round(performance.now() - gateStartedAtMs),
    };
    if (format === 'json') {
      const document = JSON.parse(report) as Record<string, JsonValue>;
      report = canonicalJson({ ...document, timing });
    } else if (format === 'text') {
      report =
        `${report}\ntiming: detectors=${String(timing.detectorsMs)}ms collection=${String(timing.collectionMs)}ms ` +
        `tsScan=${String(timing.tsScanMs)}ms planning=${String(timing.planningMs)}ms total=${String(timing.totalMs)}ms`;
    }
  }
  {
    // Cache accounting (additive `cache` key): how
    // many detector/pytest results were reused vs recomputed. Never an
    // input to any verdict.
    const cacheCounts: CacheCounts = {
      hits: pipeline.cache.hits + pytestCacheCounts.hits,
      misses: pipeline.cache.misses + pytestCacheCounts.misses,
    };
    if (format === 'json') {
      const document = JSON.parse(report) as Record<string, JsonValue>;
      report = canonicalJson({ ...document, cache: { hits: cacheCounts.hits, misses: cacheCounts.misses } });
    } else if (format === 'text' && cacheCounts.hits + cacheCounts.misses > 0) {
      report = `${report}\ncache: ${String(cacheCounts.hits)} hit(s), ${String(cacheCounts.misses)} miss(es)`;
    }
  }
  if (ruleCases.length > 0 && format === 'json') {
    // Owner-declared business rules (plan §7.5, invariant 6): every
    // graded case is serialized with its status and the channel that
    // proved it — a satisfied case must be VISIBLE naming its channel,
    // because "satisfied" read as "the rule holds" is exactly the
    // overclaim the naming exists to prevent. Additive: no declared
    // rules, no section, byte-identical report (invariant 1).
    const document = JSON.parse(report) as Record<string, JsonValue>;
    report = canonicalJson({
      ...document,
      businessRules: businessRuleReportEntries(pipeline.businessRules, ruleCases),
    } as unknown as JsonValue);
  }
  // Owner-chosen strictness: the decision
  // is a pure mapping of the strict result that was ALREADY computed, so
  // no mode can change what was evaluated. Exit 2 (config/usage) keeps
  // its meaning; only the debt exit 1 is ever softened.
  const strictExit = runExitCode({ verdicts: evaluated.verdicts, blocking: evaluatedBlocking });
  const blockingTotal =
    evaluated.verdicts.filter((verdict) => BLOCKING_VERDICTS.includes(verdict.verdict)).length +
    evaluatedBlocking.length;
  const sourcePaths = sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog);
  const decision = decideStrictness({
    mode: gateMode,
    strictExitCode: strictExit,
    blockingTotal,
    // An expanded scope (a gate-defining input changed) is full scope:
    // the change owns all of the debt, exactly like `--changed` says.
    ...(gateMode === 'changed'
      ? {
          changed: {
            active: true,
            blockingInScope:
              scopeDecision.mode === 'changed'
                ? evaluated.verdicts.filter(
                    (verdict) =>
                      BLOCKING_VERDICTS.includes(verdict.verdict) &&
                      (sourcePaths.get(verdict.obligation.resourceId) ?? []).some((file) =>
                        changedSourcePaths.has(file),
                      ),
                  ).length +
                  scopeBlocking(evaluatedBlocking, changedSourcePaths, sourcePaths).length
                : blockingTotal,
          },
        }
      : {}),
  });
  // The one footer that answers "what must THIS change still prove, and
  // which command settles it?". It sits after `decideStrictness` because
  // it must know whether the run blocks at all: with nothing newly
  // unproven, a blocking run is blocked for a reason that has nothing to
  // do with new debt, and the footer used to say so by reporting `0
  // unproven obligations: <none>` — a blocking entry whose whole text
  // claimed there was nothing to prove, next to a command that settles a
  // problem it never described (measured: a commit that upgrades one
  // dependency and changes nothing else, whose sealed receipt went stale
  // with the manifest bytes and was refused `evidence-context`). Nothing
  // about WHAT blocks changes here: only the sentence that names it.
  if (newDebt !== null) {
    if (format === 'json') {
      const document = JSON.parse(report) as Record<string, JsonValue>;
      report = canonicalJson({ ...document, newDebt: { count: newDebt.length, obligationIds: newDebt } });
    } else if (format === 'text') {
      // The evidence-context entries are the ones an owner acts on by
      // re-sealing, so they are named first and on their own; the rest
      // follow, in report order, never dropped.
      const causes = evaluatedBlocking.filter((entry) => entry.detail.startsWith('evidence-context:'));
      const named = (causes.length > 0 ? causes : evaluatedBlocking)
        .map((entry) => entry.detail)
        .join('; ');
      const debtLine =
        newDebt.length > 0
          ? humanMessage({
              detail: `this change adds ${String(newDebt.length)} unproven obligations: ${newDebt.join(', ')}`,
              type: 'new-debt',
              nextAction: 'gateforge test-gates --changed',
            })
          : decision.exitCode === 0 || named === ''
            ? // Nothing is owed and nothing is refused: there is no
              // remedy to print, and a command here would be advice to
              // fix a commit that is already committable.
              ''
            : humanMessage({
                detail: `this change adds no NEW unproven obligations; this commit is refused for another reason: ${named}`,
                type: 'new-debt',
                nextAction: 'gateforge test-gates --changed',
              });
      if (debtLine !== '') report = `${report}\n${debtLine}`;
    }
  }
  if (decision.wouldBlock && decision.exitCode !== decision.strictExitCode) {
    // The softened decision is announced on stderr too: a CI log that
    // only keeps stdout must not read as "nothing was wrong".
    writeLine(
      io.stderr,
      `check: ${strictnessSummaryLine(decision)} — the gate exits 0 in mode '${decision.mode}', ` +
        `strict mode would exit ${String(decision.strictExitCode)}`,
    );
  }
  const quarantineLine =
    quarantines.active.length === 0
      ? ''
      : `quarantined: ${String(quarantines.active.length)} (expires ${quarantines.active
          .map((entry) => `${entry.quarantine.testKey} @ ${entry.quarantine.expiresAt}`)
          .join(', ')})`;
  if (format === 'json') {
    if (gateMode !== 'strict' || quarantines.active.length > 0) {
      const document = JSON.parse(report) as Record<string, JsonValue>;
      report = canonicalJson({
        ...document,
        ...(gateMode === 'strict'
          ? {}
          : {
              strictness: {
                mode: decision.mode,
                wouldBlock: decision.wouldBlock,
                blockingInScope: decision.blockingInScope,
                blockingTotal: decision.blockingTotal,
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
      });
    }
  } else if (format === 'text') {
    // Text only: SARIF must stay machine-parseable JSON, and the json
    // document carries the structured blocks above. The report's own
    // `exit code:` line always carries the strict result; when this mode
    // softened it, the line is labelled as the value a blocking mode
    // would have produced, so it can never contradict the code the
    // process actually exits with.
    report = `${labelSoftenedExitCode(report, decision.strictExitCode, decision.exitCode)}\n${
      strictnessSummaryLine(decision)
    }${quarantineLine === '' ? '' : `\n${quarantineLine}`}`;
  }
  if (format === 'text') {
    // Plan phase 7: the endpoint inventory rides the text report —
    // totals, unmatched calls, unconsumed routes, and ambiguous joins
    // are visible on every check, never hidden behind a flag.
    writeLine(io.stdout, '');
    writeLine(io.stdout, renderEndpointInventory(pipeline.endpointInventory));
    writeLine(io.stdout, '');
    writeLine(
      io.stdout,
      'remediation: each blocking entry names its code, cause, and source location; ' +
        'for endpoint obligations the accepted evidence is a witnessed proxy observation ' +
        'plus a provenanced claimed ui anchor (see ADR 0004 D7/D8).',
    );
  }
  writeLine(io.stdout, report);
  return decision.exitCode;
}
