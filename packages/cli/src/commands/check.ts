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
import { renderRun, runExitCode, type BlockingEntry } from '@gateforge/core';
import { parseArgs, stringFlag } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { evaluateRun } from '../evaluate.js';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  type SnapshotFileEntry,
} from '../input-snapshot.js';
import { runPipeline } from '../pipeline.js';
import { resolveProvider } from '../providers.js';
import {
  computeEvaluationScope,
  detectStagedWorkingTreeMismatches,
  type ScopeDecision,
} from '../scope.js';
import { httpRoutesView, resolveStateDir } from '../state.js';
import { loadConfigAt, parseRunFormat, rejectUnknownFlags, VERIFIER_KEY_ENV, VERSION } from './common.js';
import { renderEndpointInventory } from '../endpoint-report.js';

export const CHECK_USAGE = 'usage: gateforge check [--changed] [--format text|json|sarif]';

/**
 * Runs the check subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved, 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function checkCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, CHECK_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['changed', 'format', 'help'], CHECK_USAGE);
  const format = parseRunFormat(stringFlag(options, 'format') ?? 'text');
  const diffScoped = options['changed'] === true;
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
  const providerIdentity = diffScoped ? resolveProvider(config.changed.provider, io.cwd, io.env).provider : 'all-files';
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

  // One effective evaluation scope (plan §12.2, D4), computed BEFORE
  // grading and applied to obligations AND blockers: without `--changed`
  // the run stays all-files; with `--changed` a diff touching any
  // gate-defining input (policy/classification/pack configs, adapters,
  // waivers, plugin impl, manifests, ignore controls) expands to all.
  // The provider identity is preserved throughout — an expanded run
  // never stamps `all-files` as the diff provider.
  let scopeDecision: ScopeDecision = { mode: 'all', changedFiles: [], expandedBecause: [] };
  let mismatchBlocking: BlockingEntry[] = [];
  if (diffScoped) {
    scopeDecision = computeEvaluationScope({ config, changedFiles: pipeline.changedFiles });
    // The local-staged provider lists index changes, but discovery reads
    // working-tree bytes. Files differing in both must not be silently
    // certified: force the full scope and add an explicit blocking
    // diagnostic naming the staged verification gap (§12.3). No isolated
    // index snapshot is evaluated in this repair.
    if (providerIdentity === 'local-staged') {
      const mismatched = detectStagedWorkingTreeMismatches(io.cwd, io.env);
      if (mismatched.length > 0) {
        scopeDecision = {
          mode: 'all',
          changedFiles: scopeDecision.changedFiles,
          expandedBecause: scopeDecision.expandedBecause,
        };
        mismatchBlocking = mismatched.map(
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
        );
      }
    }
  }

  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    obligations: pipeline.policy.obligations,
    blocking: [...pipeline.policy.blocking, ...mismatchBlocking],
    stateDir,
    now: pipeline.now,
    // One effective scope (§12.2), decided before grading: an expanded
    // (gate-defining) diff evaluates everything — obligations AND
    // blockers — exactly like the unrestricted run.
    changedFiles: scopeDecision.mode === 'all' ? null : scopeDecision.changedFiles,
    witnessVerifierKey,
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      requireInvocationId: false,
      changedInputs,
    },
  });

  const report = renderRun(evaluated.verdicts, {
    format,
    blocking: evaluated.blocking,
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
  return runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
}