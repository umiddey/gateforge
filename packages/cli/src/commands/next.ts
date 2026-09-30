/**
 * `gateforge next`: the only agent-facing navigation command — exactly
 * ONE blocking next action, never a dump.
 *
 * Runs the same discover → classify → obligations → evaluate path as
 * `check` (without `--require-e2e`: next is navigation, not the gate),
 * collects blocking entries plus verdicts whose status is blocking, and
 * prints the single highest-ranked item. Exit 0 when clean, 1 when a
 * next action exists, 2 on config/usage errors.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOCKING_VERDICTS,
  CAUSE_NEXT_ACTIONS,
  type BlockingEntry,
  type CauseCode,
  type ChangedProvider,
  type Claim,
  type ObligationVerdict,
} from '@gate-forge/core';
import {
  discoverTestCatalog,
  TestDiscoveryError,
  type DiscoverResult,
} from '@gate-forge/pack-playwright';
import { parseArgs } from '../args.js';
import { resolveAdoptedBaseline } from '../adopted-baseline.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { evaluateRun } from '../evaluate.js';
import {
  findRunnerConfigPath,
  loadOptionalTestMap,
  mappedCoverageFrom,
  mappingBlocking,
  nativeInventoryBlocking,
  resolveRepositoryMappings,
} from '../mapping.js';
import type { MappedCoverage } from '@gate-forge/core';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  symlinkNotices,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  type SnapshotFileEntry,
} from '../input-snapshot.js';
import { runPipeline, sourcesByResourceId } from '../pipeline.js';
import { resolveProvider } from '../providers.js';
import { computeEvaluationScope, detectStagedWorkingTreeMismatches } from '../scope.js';
import { httpRoutesView, resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags, VERIFIER_KEY_ENV } from './common.js';
import { loadCacheExclusions } from '../cache-exclusions.js';

export const NEXT_USAGE = 'usage: gateforge next [--changed] [--json]';

const ENVIRONMENT_GUIDES: Partial<Record<CauseCode, string>> = {
  EVIDENCE_STALE: 'packages/cli/guides/TEST-ENVIRONMENT.md#keep-the-repository-unchanged-during-a-run',
  ENFORCEMENT_UNTRUSTED: 'packages/cli/guides/TEST-ENVIRONMENT.md#run-containers-as-your-user',
  RUN_INCOMPLETE: 'packages/cli/guides/TEST-ENVIRONMENT.md#register-the-same-tests-in-every-mode',
};

/**
 * One ranked navigation candidate: a blocking entry or a blocking
 * verdict, normalized to the `next/cause/why/do` surface.
 */
interface NextCandidate {
  /** Obligation id or resource id (human identity of the item). */
  id: string;
  /** Stable cause code (never null — unmapped causes get a fallback). */
  cause: string;
  /** Single-cause human explanation. */
  why: string;
  /** The single imperative action. */
  do: string;
  /** Rank per the plan §2 table (lower wins). */
  rank: number;
}

/**
 * Ranks a cause per the plan §2 table: capability gaps first, mapping
 * intent last, everything else blocking after that.
 */
function rankCause(cause: CauseCode | null | undefined, kind: string): number {
  switch (cause) {
    case 'VERIFIER_UNSUPPORTED':
      return 1;
    // Complete-behavior setup/declaration problems block before any
    // test-generation advice: an owner document gap is not something a
    // test can fix.
    case 'ENDPOINT_BEHAVIOR_MISSING':
    case 'BEHAVIOR_REFERENCE_STALE':
    case 'BEHAVIOR_CASE_UNMAPPED':
    case 'BEHAVIOR_CASE_MISSING':
    case 'BEHAVIOR_BINDING_MISMATCH':
    case 'BEHAVIOR_EFFECT_MISMATCH':
    case 'OBSERVATION_SCOPE_INCOMPLETE':
    case 'BEHAVIOR_UNEXPECTED_EFFECT':
    case 'ENFORCEMENT_BOUNDARY_UNVERIFIED':
      return 2;
    case 'MIGRATION_MISSING':
    case 'MIGRATION_LINEAGE_BROKEN':
    case 'MIGRATION_DOWNGRADE_NOOP':
    case 'MIGRATION_DRIFT':
    case 'MIGRATION_ROUNDTRIP_FAILED':
    case 'MIGRATION_DATA_LOST':
    case 'MIGRATION_CONFLICT':
    case 'MIGRATION_SCRATCH_UNSAFE':
      return 2;
    case 'CRUD_COVERAGE_MISSING':
      return 3;
    case 'CHANGE_UNMAPPED':
      return 4;
    case 'ENFORCEMENT_UNTRUSTED':
      return 5;
    case 'EVIDENCE_NOT_COLLECTED':
      return 6;
    case 'EVIDENCE_STALE':
    case 'RUN_INCOMPLETE':
    case 'TEST_NOT_EXECUTED':
    case 'TEST_FAILED':
      return 7;
    case 'TEST_INVENTORY_INCOMPLETE':
      return 0;
    case 'TEST_MAPPING_MISSING':
    case 'TEST_MAPPING_AMBIGUOUS':
    case 'TEST_MAPPING_STALE':
    case 'TEST_KIND_UNKNOWN':
      return 8;
    default:
      break;
  }
  if (cause === null || cause === undefined) {
    // Unclassified / unresolved / parse findings sort right after
    // capability gaps; a blocking verdict without a cause is still an
    // unsatisfied obligation (missing-evidence rank).
    if (kind === 'unclassified' || kind === 'unresolved' || kind === 'finding') return 2;
    if (kind === 'verdict') return 6;
    return 9;
  }
  return 9;
}

/**
 * Normalizes blocking entries + blocking verdicts into ranked
 * candidates (stable sort by id inside a rank).
 */
function rankBlockers(blocking: readonly BlockingEntry[], verdicts: readonly ObligationVerdict[]): NextCandidate[] {
  const candidates: NextCandidate[] = [];
  for (const entry of blocking) {
    const cause = entry.cause ?? null;
    candidates.push({
      id: entry.resourceId ?? entry.name ?? 'repo',
      cause: cause ?? 'BLOCKING_FINDING',
      why: entry.detail,
      do:
        entry.nextAction ??
        (cause !== null
          ? CAUSE_NEXT_ACTIONS[cause]
          : entry.resourceId !== null && entry.resourceId !== undefined
            ? `gateforge explain ${entry.resourceId}`
            : 'gateforge discover --json'),
      rank: rankCause(cause, entry.kind),
    });
  }
  for (const verdict of verdicts) {
    if (!BLOCKING_VERDICTS.includes(verdict.verdict)) continue;
    const cause = verdict.cause ?? null;
    candidates.push({
      id: verdict.obligation.id,
      cause: cause ?? 'EVIDENCE_NOT_COLLECTED',
      why: verdict.reason ?? `obligation '${verdict.obligation.id}' is ${verdict.verdict}`,
      do:
        verdict.nextAction ??
        (cause !== null ? CAUSE_NEXT_ACTIONS[cause] : CAUSE_NEXT_ACTIONS['EVIDENCE_NOT_COLLECTED']),
      rank: rankCause(cause, 'verdict'),
    });
  }
  candidates.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates;
}

/**
 * Quotes one shell argument so generated commands can be copied safely.
 *
 * Args:
 *   value: the argument text.
 *
 * Returns:
 *   string: a POSIX single-quoted argument.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Builds owner-directed advice for an endpoint with no resolved plane.
 *
 * Every printed command runs exactly as printed: the prerequisite that
 * creates the owner-reviewed planes file is printed FIRST, because the
 * plane command below it exits 2 without that file — the omission this
 * guidance used to have.
 *
 * Args:
 *   routeName: canonical method and path shown to the user.
 *   resourceName: detector identity used by the owner-only policy edit.
 *   source: router source file used by the plane writer.
 *
 * Returns:
 *   string[]: ordered question, runnable commands, and exact policy edit.
 */
function unresolvedRouteGuidance(
  routeName: string,
  resourceName: string,
  source: string,
): string[] {
  const choices = ['tenant', 'master', 'global'] as const;
  const commands = choices.map((plane) => {
    const reason = `Owner review confirms the ${plane} plane for ${routeName}.`;
    return `gateforge classify plane ${shellQuote(source)} ${plane} --reason ${shellQuote(reason)} --confirm`;
  });
  return [
    // One plain line BEFORE the question: a new repo meets this
    // question first, and no shipped document prepares anyone for it.
    // It says what is being asked, why only the owner can answer it,
    // and what each answer does next — so the question is answerable
    // from the output alone.
    'about this question: this route has no data plane, so Gateforge cannot tell whether its records are ' +
      'per-tenant, shared master data, or global — that is an owner decision no detector can read from the ' +
      'code. Answer once, then run only the `classify plane` command for that answer (tenant / master / ' +
      'global), or, if the route is not used by real users, the internal rule printed at the end.',
    `question: ${routeName} — is this route used by real users, and which data plane owns its records?`,
    'This edits a classification input; re-approve any approved policy pin before strict gates run.',
    "The plane command below needs the owner-reviewed '.gateforge/planes.json' first — run this once to create it:",
    'gateforge init --planes',
    '[CODE]',
    'Then choose only the command for the boundary confirmed by the owner:',
    ...commands.flatMap((command) => [command, '[CODE]']),
    'Owner-only alternative: only if this route is genuinely internal, edit `.gateforge/classification-policy.yml` under `internalRules`:',
    '  - match:',
    '      resourceKind: http.endpoint',
    `      resourceName: ${JSON.stringify(resourceName)}`,
    '    reason: "<owner-written reason and evidence for treating this route as internal>"',
    '[CODE]',
    'An internal rule is certificate-checked; it is not an override.',
  ];
}
/**
 * Runs the `gateforge next` subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean, 1 a next action exists, 2
 *   config/usage.
 */
export async function nextCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, NEXT_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['changed', 'json', 'help'], NEXT_USAGE);
  if (!existsSync(join(io.cwd, '.gateforge.yml'))) {
    throw new UsageError('no .gateforge.yml found — run gateforge init first');
  }
  const diffScoped = options['changed'] === true;
  const asJson = options['json'] === true;

  const witnessVerifierKey = io.env[VERIFIER_KEY_ENV];
  const config = loadConfigAt(io.cwd);
  const cacheExclusions = loadCacheExclusions(io.cwd, config);
  const providerIdentity: ChangedProvider = diffScoped
    ? resolveProvider(config.changed.provider, io.cwd, io.env).provider
    : 'all-files';
  const stateDir = resolveStateDir(io.cwd);

  // Trusted digest: the same pre/post inventory check `check` performs
  // so witnessed records authorize for the current bytes (next never
  // demands a gate receipt — navigation, not the gate).
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
  // A dangling symlink, or one pointing at a directory, is captured by
  // its link text, so the run continues; one plain notice line names what
  // does not resolve and whether an action is needed. In --json mode
  // stdout stays a single JSON document, so the notice goes to stderr
  // there.
  for (const notice of symlinkNotices(preFiles ?? [])) {
    writeLine(asJson ? io.stderr : io.stdout, notice);
  }

  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: providerIdentity,
    stateDir,
  });

  const httpRoutes = httpRoutesView(pipeline.graph);
  let expectedDigest: string | null = null;
  let changedInputs = false;
  if (!snapshotUnavailable) {
    try {
      const postFiles = collectInputFiles(io.cwd, config, stateDir, [], [], cacheExclusions);
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
          cacheExclusions,
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

  // One effective evaluation scope (same contract as check --changed):
  // gate-defining inputs expand to all; strict-mode unmapped files add
  // CHANGE_UNMAPPED blockers; staged/worktree divergence blocks loudly.
  let changedFiles: readonly string[] | null = null;
  let mismatchBlocking: BlockingEntry[] = [];
  let discoveryResult: DiscoverResult | undefined;
  if (diffScoped) {
    const sidecar = loadOptionalTestMap(io.cwd);
    const runnerConfig = findRunnerConfigPath(io.cwd, config.runner);
    let testFiles: string[] = [];
    if (runnerConfig !== null) {
      try {
        const discovered = await discoverTestCatalog({ cwd: io.cwd, config, collectPytest: true });
        discoveryResult = discovered;
        testFiles = discovered.catalog.entries
          .filter((entry) => entry.runner === config.runner)
          .map((entry) => entry.file);
      } catch (error) {
        if (error instanceof TestDiscoveryError) throw new UsageError(error.message);
        throw error;
      }
    }
    const knownSourceFiles = [
      ...new Set(
        pipeline.graph.resources.flatMap((resource) =>
          resource.id === null ? [] : sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog).get(resource.id) ?? [],
        ),
      ),
    ];
    const scopeDecision = computeEvaluationScope({
      config,
      changedFiles: pipeline.changedFiles,
      testFiles,
      runnerConfigs: runnerConfig === null ? [] : [runnerConfig],
      mappingSidecar: sidecar !== null,
      knownSourceFiles,
      strictE2E: config.enforcement?.strictE2E === true,
    });
    changedFiles = scopeDecision.mode === 'all' ? null : scopeDecision.changedFiles;
    const sidecarCoveredFiles = new Set((sidecar?.tests ?? []).map((entry) => entry.selector.file));
    mismatchBlocking = [
      ...mismatchBlocking,
      ...scopeDecision.unmappedFiles
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
        })),
    ];
    if (providerIdentity === 'local-staged') {
      const mismatched = detectStagedWorkingTreeMismatches(io.cwd, io.env);
      if (mismatched.length > 0) {
        changedFiles = null;
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

  const mapped = await resolveRepositoryMappings({
    cwd: io.cwd,
    config,
    obligations: pipeline.policy.obligations,
    ...(discoveryResult !== undefined
      ? {
          catalog: discoveryResult.catalog,
          nativeClaims: discoveryResult.nativeClaims,
          nativeErrors: discoveryResult.nativeErrors,
          nativeInstances: discoveryResult.nativeInstances,
        }
      : {}),
    behaviorCatalog: pipeline.behaviorCatalog,
  });
  const claimInventory: Claim[] = mapped.claimInventory;
  const mappingBlockers = [
    ...mappingBlocking(mapped.resolution.problems),
    ...nativeInventoryBlocking(mapped.nativeLoadProblem),
  ];
  const mappedCoverage = mappedCoverageFrom(mapped.resolution, pipeline.policy.obligations, pipeline.graph);

  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    behaviorCatalog: pipeline.behaviorCatalog,
    obligations: pipeline.policy.obligations,
    blocking: [...pipeline.policy.blocking, ...mismatchBlocking, ...mappingBlockers],
    stateDir,
    now: pipeline.now,
    engineAlembicRecords: pipeline.engineAlembicRecords,
    changedFiles,
    claimInventory,
    mappedCoverage,
    witnessVerifierKey,
    baseline: resolveAdoptedBaseline(io.cwd, config.baselines),
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      requireInvocationId: false,
      changedInputs,
    },
  });

  const candidates = rankBlockers(evaluated.blocking, evaluated.verdicts);
  if (candidates.length === 0) {
    if (asJson) {
      writeLine(
        io.stdout,
        JSON.stringify({ next: null, cause: null, why: 'clean', do: null, remainingBlocking: 0 }),
      );
    } else {
      writeLine(io.stdout, 'next: none — clean');
    }
    return 0;
  }
  const first = candidates[0] as NextCandidate;
  const unresolvedRoute = pipeline.classification.decisions.find(
    (decision) =>
      decision.name === first.id &&
      decision.kind === 'http.endpoint' &&
      decision.classification === null &&
      decision.blocks.some((block) => block.code === 'PLANE_UNRESOLVED'),
  );
  const routeResource =
    unresolvedRoute === undefined
      ? undefined
      : pipeline.graph.resources.find((resource) => resource.name === unresolvedRoute.name);
  const method = routeResource?.attributes['method'];
  const path = routeResource?.attributes['canonicalPath'];
  const routeName =
    typeof method === 'string' && typeof path === 'string'
      ? `${method} ${path}`
      : unresolvedRoute?.name;
  const routeGuidance =
    unresolvedRoute === undefined || routeName === undefined
      ? null
      : unresolvedRouteGuidance(routeName, unresolvedRoute.name, unresolvedRoute.source);
  const guide = ENVIRONMENT_GUIDES[first.cause as CauseCode] ?? null;
  if (asJson) {
    writeLine(
      io.stdout,
      JSON.stringify({
        next: first.id,
        cause: first.cause,
        why: first.why,
        do: first.do,
        remainingBlocking: candidates.length - 1,
        guide,
        ...(routeGuidance === null ? {} : { guidance: routeGuidance }),
      }),
    );
  } else {
    writeLine(io.stdout, `next: ${first.id}`);
    writeLine(io.stdout, `cause: ${first.cause}`);
    writeLine(io.stdout, `why: ${first.why}`);
    if (guide !== null) writeLine(io.stdout, `guide: ${guide}`);
    if (routeGuidance === null) {
      writeLine(io.stdout, `do: ${first.do}`);
    } else {
      writeLine(io.stdout, 'do: confirm the route owner and run only the matching plane command below');
      for (const line of routeGuidance) writeLine(io.stdout, line);
    }
  }
  return 1;
}
