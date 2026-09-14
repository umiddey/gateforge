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
 * Claims and records come from the run-state directory
 * (`.gateforge/test-gates/` by default) — the same surface the
 * `test-gates` suite contract writes.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import {
  CAUSE_NEXT_ACTIONS,
  renderRun,
  runExitCode,
  type BlockingEntry,
  type CauseCode,
  type ChangedProvider,
  type Claim,
} from '@gateforge/core';
import { discoverTestCatalog, findPlaywrightConfig } from '@gateforge/pack-playwright';
import { parseArgs, stringFlag } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { trustedPolicyDigestForConfig } from '../execution.js';
import { evaluateRun } from '../evaluate.js';
import { gradingClaimsFor, loadOptionalTestMap, mappedCoverageFrom, mappingBlocking, resolveRepositoryMappings, TEST_MAP_RELATIVE } from '../mapping.js';
import type { MappedCoverage } from '@gateforge/core';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  type SnapshotFileEntry,
} from '../input-snapshot.js';
import { runPipeline, resolveRepoPath, sourcesByResourceId } from '../pipeline.js';
import { loadReceiptFor, receiptGateBlocking } from '../receipts.js';
import { resolveProvider } from '../providers.js';
import {
  computeEvaluationScope,
  detectStagedWorkingTreeMismatches,
  type ScopeDecision,
} from '../scope.js';
import {
  freezeStagedCandidate,
  materializeStagedCandidate,
  recheckStagedCandidate,
  releaseStagedCandidate,
  StagedCandidateBlockError,
  type StagedCandidate,
} from '../staged-candidate.js';
import { httpRoutesView, resolveStateDir } from '../state.js';
import {
  assertReceiptApprovedPolicy,
  evaluateApprovedPolicy,
  resolveApprovedPolicyDigest,
} from '../trusted-policy.js';
import { loadConfigAt, parseRunFormat, rejectUnknownFlags, VERIFIER_KEY_ENV, VERSION } from './common.js';
import { renderEndpointInventory } from '../endpoint-report.js';

export const CHECK_USAGE =
  'usage: gateforge check [--changed] [--staged] [--require-e2e] [--format text|json|sarif]\n' +
  '       [--approved-policy-digest <hex64>]\n' +
  '       approved policy digest: the OWNER-APPROVED policy revision pin. Never sourced from\n' +
  '       candidate-controlled files in strict mode — provision it via the protected\n' +
  '       GATEFORGE_APPROVED_POLICY_DIGEST variable, this flag, or GATEFORGE_TRUSTED_CONFIG outside the candidate.';

/** Options of one gate run (the check body, shared by --changed/--staged). */
interface CheckGateOptions {
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
  /**
   * Phase 5 staged-candidate runs: the fixed changed set computed from
   * the FROZEN index vs base. When present no diff provider runs (the
   * candidate checkout has no diff basis of its own), the manifest stamps
   * the `local-staged` basis identity, and the staged-vs-worktree
   * mismatch diagnostic is skipped (the checkout IS the staged bytes).
   */
  fixedChangedFiles?: readonly string[];
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
  rejectUnknownFlags(options, ['changed', 'staged', 'require-e2e', 'format', 'approved-policy-digest', 'help'], CHECK_USAGE);
  if (options['staged'] === true && options['changed'] === true) {
    throw new UsageError('check: --staged already scopes the run to the staged candidate; --changed cannot be combined');
  }
  const format = parseRunFormat(stringFlag(options, 'format') ?? 'text');
  const requireE2E = options['require-e2e'] === true;
  const approvedPolicyDigest = stringFlag(options, 'approved-policy-digest');
  if (options['staged'] === true) {
    return stagedCheckCommand(io, { requireE2E, format, approvedPolicyDigest });
  }
  return runCheckGate(io, {
    diffScoped: options['changed'] === true,
    requireE2E,
    format,
    approvedPolicyDigest,
  });
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
  options: { requireE2E: boolean; format: 'text' | 'json' | 'sarif'; approvedPolicyDigest?: string },
): Promise<number> {
  let frozen: StagedCandidate;
  try {
    frozen = freezeStagedCandidate(io.cwd, io.env);
  } catch (error) {
    if (error instanceof StagedCandidateBlockError) {
      return renderStagedBlock(io, error.causeCode, error.message, error.nextAction);
    }
    throw error;
  }
  let checkoutDir: string;
  try {
    checkoutDir = materializeStagedCandidate(io.cwd, io.env, frozen);
    // Empty directories are invisible to Git trees — checkout-index cannot
    // create them — yet the input snapshot distinguishes an EMPTY optional
    // config directory (adapters/waivers) from a MISSING one through
    // explicit absence markers. Mirror the user repo's directory presence
    // so a receipt sealed in the worktree verifies against the candidate
    // checkout of the SAME bytes (the bytes themselves stay exactly the
    // staged tree; only the marker-relevant empty dirs are mirrored).
    const checkoutConfig = loadConfigAt(checkoutDir);
    for (const dir of [checkoutConfig.adapters, checkoutConfig.waivers]) {
      const userDir = resolveRepoPath(io.cwd, dir);
      const checkoutPath = resolveRepoPath(checkoutDir, dir);
      if (existsSync(userDir) && !existsSync(checkoutPath)) {
        mkdirSync(checkoutPath, { recursive: true });
      }
    }
  } catch (error) {
    releaseStagedCandidate(frozen);
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
      diffScoped: true,
      requireE2E: options.requireE2E,
      format: options.format,
      approvedPolicyDigest: options.approvedPolicyDigest,
      fixedChangedFiles: frozen.changedPaths,
    });
    // Re-check BEFORE authorizing: different bytes never pass.
    const recheck = recheckStagedCandidate(io.cwd, io.env, frozen);
    if (!recheck.ok) {
      return renderStagedBlock(
        io,
        'ENFORCEMENT_UNTRUSTED',
        recheck.detail,
        'Re-run the gate for the current staged candidate.',
      );
    }
    return code;
  } catch (error) {
    if (error instanceof StagedCandidateBlockError) {
      return renderStagedBlock(io, error.causeCode, error.message, error.nextAction);
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
async function runCheckGate(io: Io, options: CheckGateOptions): Promise<number> {
  const { diffScoped, requireE2E, format } = options;
  const fixedChangedFiles = options.fixedChangedFiles;
  // Witness verifier key (GF-23, plan §11): read from the
  // environment — never argv, whose cmdline is world-readable. With the
  // key, the manifest's v2 `attestation` envelope can be authenticated
  // against the recomputed current input digest (D3: a completed signed
  // run is reusable for byte-identical inputs); without it, no
  // suite-writable artifact can prove issuance and the provenance gate
  // fails closed. Legacy v1 `recordIdsMac` never authorizes, even when
  // it verifies.
  const witnessVerifierKey = io.env[VERIFIER_KEY_ENV];

  const config = loadConfigAt(io.cwd);
  const providerIdentity: ChangedProvider =
    fixedChangedFiles !== undefined
      ? 'local-staged'
      : diffScoped
        ? resolveProvider(config.changed.provider, io.cwd, io.env).provider
        : 'all-files';
  const stateDir = resolveStateDir(io.cwd);

  // Pre-discovery file inventory (plan §11.5): the gate context does not
  // exist yet, so only file bytes are captured. A repository without
  // usable Git inventory keeps discovery working but fails evidence
  // authorization (snapshot-unavailable); an uncapturable input or an
  // unsafe --out overlap fails closed before any evaluation.
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

  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: providerIdentity,
    stateDir,
    ...(fixedChangedFiles !== undefined ? { changedFilesOverride: fixedChangedFiles } : {}),
  });

  // Post-discovery stability + full digest (plan §11.5): the input tree
  // must not have moved under discovery, and the current digest is what
  // the stored envelope must equal (D3). A changing tree cannot
  // establish a reliable digest — the run blocks without certifying.
  const httpRoutes = httpRoutesView(pipeline.graph);
  let expectedDigest: string | null = null;
  let changedInputs = false;
  if (!snapshotUnavailable) {
    try {
      const postFiles = collectInputFiles(io.cwd, config, stateDir);
      if (preFiles !== null && diffInputFiles(preFiles, postFiles).length > 0) {
        changedInputs = true;
      } else {
        expectedDigest = computeInputSnapshot({
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
  let scopeDecision: ScopeDecision = { mode: 'all', changedFiles: [], expandedBecause: [], unmappedFiles: [] };
  let mismatchBlocking: BlockingEntry[] = [];
  if (diffScoped) {
    // Phase 4 expansion inputs (E15): test inventory is loaded only when
    // test infrastructure exists (playwright config or mapping sidecar);
    // repositories without either keep the exact historical behavior.
    const sidecar = loadOptionalTestMap(io.cwd);
    const runnerConfig = findPlaywrightConfig(io.cwd);
    let testFiles: string[] = [];
    if (runnerConfig !== null) {
      try {
        testFiles = (await discoverTestCatalog({ cwd: io.cwd, config })).catalog.entries
          .filter((entry) => entry.runner === 'playwright')
          .map((entry) => entry.file);
      } catch {
        // Discovery problems surface on their own gates; scope expansion
        // proceeds with the infra signals it does have (fail visible).
        testFiles = [];
      }
    }
    const knownSourceFiles = [
      ...new Set(
        pipeline.graph.resources.flatMap((resource) =>
          resource.id === null ? [] : sourcesByResourceId(pipeline.graph).get(resource.id) ?? [],
        ),
      ),
    ];
    scopeDecision = computeEvaluationScope({
      config,
      changedFiles: pipeline.changedFiles,
      testFiles,
      runnerConfigs: runnerConfig === null ? [] : [runnerConfig],
      mappingSidecar: sidecar !== null,
      knownSourceFiles,
      strictE2E: config.enforcement?.strictE2E === true,
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
        nextAction: CAUSE_NEXT_ACTIONS.CHANGE_UNMAPPED,
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

  // Test-mapping seam (plan 2026-09-13 §5.3, Phase 3): when the
  // repository declares a `.gateforge/test-map.yml` sidecar, the ONE core
  // resolver normalizes sidecar declarations + native claims against a
  // freshly discovered catalog. Resolved bindings join grading as
  // DECLARED claims (mapping declares intent; with no witnessed evidence
  // the obligation grades EVIDENCE_NOT_COLLECTED — blocking, never
  // satisfied), and unsafe/out-of-date declarations become typed blocking
  // entries. Without a sidecar nothing changes for the run. Mapping
  // claims cannot waive or weaken anything, so strict mode is unaffected.
  let mappingClaims: Claim[] = [];
  let mappingBlockers: BlockingEntry[] = [];
  let mappedCoverage: MappedCoverage[] = [];
  if (loadOptionalTestMap(io.cwd) !== null) {
    const mapped = await resolveRepositoryMappings({
      cwd: io.cwd,
      config,
      stateDir,
      obligations: pipeline.policy.obligations,
    });
    mappingClaims = gradingClaimsFor(mapped.resolution, mapped.nativeClaims);
    mappingBlockers = mappingBlocking(mapped.resolution.problems);
    mappedCoverage = mappedCoverageFrom(mapped.resolution, pipeline.policy.obligations, pipeline.graph);
  }

  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    obligations: pipeline.policy.obligations,
    blocking: [...pipeline.policy.blocking, ...mismatchBlocking, ...mappingBlockers],
    stateDir,
    now: pipeline.now,
    // One effective scope (§12.2), decided before grading: an expanded
    // (gate-defining) diff evaluates everything — obligations AND
    // blockers — exactly like the unrestricted run.
    changedFiles: scopeDecision.mode === 'all' ? null : scopeDecision.changedFiles,
    mappingClaims,
    mappedCoverage,
    witnessVerifierKey,
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      requireInvocationId: false,
      changedInputs,
    },
  });

  // `--require-e2e` (plan Phase 4 item 5, ADR 0005 D3): the strict
  // saved-state gate. Without a valid, non-stale receipt for the CURRENT
  // input digest the run blocks — missing receipt (RUN_INCOMPLETE),
  // stale inputs (EVIDENCE_STALE, E13), forged/tampered (typed
  // ENFORCEMENT_UNTRUSTED). Old record bundles without receipts are
  // rejected, never silently accepted.
  //
  // Approved-policy ownership gate (review 2026-09-13 P1 #5): before any
  // receipt is consulted, the candidate's recomputed trusted policy
  // digest is compared against the OWNER-APPROVED digest provisioned
  // OUTSIDE the candidate (protected env / flag / trusted config). A
  // weakened candidate policy is a typed ENFORCEMENT_UNTRUSTED block; a
  // missing pin under enforcement.strictE2E fails closed with the exact
  // provisioning step; a receipt sealed under a different approved
  // revision is rejected (policy revision changed after sealing).
  let receiptBlocking: BlockingEntry[] = [];
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
      const candidatePolicyDigest = trustedPolicyDigestForConfig(io.cwd, config);
      const resolution = resolveApprovedPolicyDigest({
        flag: options.approvedPolicyDigest,
        env: io.env,
        candidateCwd: io.cwd,
        candidateConfig: config,
      });
      const gate = evaluateApprovedPolicy(resolution, candidatePolicyDigest, config.enforcement?.strictE2E === true);
      if (gate.status === 'blocked') {
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
        const load = loadReceiptFor(
          stateDir,
          witnessVerifierKey ?? null,
          {
            inputDigest: expectedDigest,
            trustedPolicyDigest: candidatePolicyDigest,
            // check cannot know the run's selection/catalog identity —
            // those expectations are skipped here and enforced on the
            // test-gates reuse path; the input-digest binding is the
            // staleness contract (E13).
            selectionDigest: undefined,
            catalogDigest: undefined,
          },
        );
        if (load.status === 'ok' && gate.status === 'enforced') {
          // A provisioned pin binds the receipt too: a receipt sealed
          // under a since-revoked/different approved revision is a typed
          // reject, and under a pin the binding must be present.
          const binding = assertReceiptApprovedPolicy(load.receipt, gate.approved);
          receiptBlocking = binding.ok
            ? []
            : [
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
        } else {
          receiptBlocking = receiptGateBlocking(load);
        }
      }
    }
  }

  const evaluatedBlocking = [...evaluated.blocking, ...receiptBlocking];
  const report = renderRun(evaluated.verdicts, {
    format,
    blocking: evaluatedBlocking,
    waiverCounts: evaluated.waiverCounts,
    run: pipeline.manifest,
    toolVersion: VERSION,
    scope: { mode: scopeDecision.mode, expandedBecause: scopeDecision.expandedBecause },
  });
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
  return runExitCode({ verdicts: evaluated.verdicts, blocking: evaluatedBlocking });
}