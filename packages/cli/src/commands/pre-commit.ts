/**
 * Witnessed pre-commit orchestration over the exact staged candidate.
 *
 * The command freezes and materializes the Git index, prepares the
 * candidate's staged runtime (owner-reviewed `.gateforge/runtime.yml`:
 * sanctioned dependency reuse, frozen preparation command, candidate-
 * owned application/database services started from the checkout bytes),
 * executes the supervised witness run inside that checkout, validates
 * its receipt, and rechecks the original index before it authorizes the
 * commit.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CAUSE_NEXT_ACTIONS } from '@gate-forge/core';
import { parseArgs, stringFlag } from '../args.js';
import { computeCandidateTreeId, resolveGitDir } from '../candidate-tree.js';
import { trustedPolicyDigestForConfig } from '../execution.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import {
  RuntimeBlockError,
  loadRuntimeConfigAt,
  prepareRuntime,
  startRuntimeServices,
  stopRuntimeChildren,
  type RunningRuntime,
} from '../runtime.js';
import { digestRuntimeReuseMounts, type RuntimeReuseMount } from '../runtime-reuse.js';
import {
  assertRuntimeReuseOwnerApproval,
  freezeStagedCandidate,
  materializeStagedCandidate,
  recheckStagedCandidate,
  releaseStagedCandidate,
  StagedCandidateBlockError,
  type StagedCandidate,
} from '../staged-candidate.js';
import { resolveStateDir } from '../state.js';
import { resolveVerifierKeyring } from '../verifier-keys.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { runCheckGate } from './check.js';
import { runSupervisedTestGates } from './test-gates.js';
import { evaluateApprovedPolicy, resolveApprovedPolicyDigest } from '../trusted-policy.js';
import { loadDocsExclusions } from '../docs-exclusions.js';
import { loadCacheExclusions } from '../cache-exclusions.js';

export const PRE_COMMIT_USAGE =
  'usage: gateforge pre-commit --scope staged|full\n' +
  '       staged: run tests mapped to obligations affected by staged files\n' +
  '       full: run the complete relevant mapped suite\n' +
  '       both modes execute against the exact frozen index and require the normal witness runtime';

/** Runs a complete witnessed pre-commit gate against the frozen index. */
export async function preCommitCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, PRE_COMMIT_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['scope', 'help'], PRE_COMMIT_USAGE);
  const scope = stringFlag(options, 'scope');
  if (scope !== 'staged' && scope !== 'full') {
    throw new UsageError("pre-commit: --scope must be 'staged' or 'full'");
  }
  const verifierKeyring = resolveVerifierKeyring(io.cwd, io.env, [resolveStateDir(io.cwd)]);

  let frozen: StagedCandidate;
  try {
    frozen = freezeStagedCandidate(io.cwd, io.env);
  } catch (error) {
    if (error instanceof StagedCandidateBlockError) return renderCandidateBlock(io, error.message, error.nextAction);
    throw error;
  }

  const previousCwd = process.cwd();
  let runtime: RunningRuntime | null = null;
  let runtimeReuseDigest: string | null = null;
  let runtimeReuseMounts: RuntimeReuseMount[] = [];
  // Interruption safety: while candidate services are alive, SIGINT/
  // SIGTERM tear the process groups down BEFORE the gate dies (the
  // handlers restore the default disposition and re-raise so the shell
  // observes the original signal).
  const interruptSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const interruptHandlers = new Map<NodeJS.Signals, () => void>();
  const armInterruptHandlers = (): void => {
    for (const signal of interruptSignals) {
      const handler = (): void => {
        const teardown = runtime === null ? stopRuntimeChildren() : runtime.stop();
        void teardown.finally(() => {
          process.kill(process.pid, signal);
        });
      };
      interruptHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  };
  const disarmInterruptHandlers = (): void => {
    for (const [signal, handler] of interruptHandlers) process.removeListener(signal, handler);
    interruptHandlers.clear();
  };
  try {
    const checkoutDir = materializeStagedCandidate(io.cwd, io.env, frozen);
    // Candidate run state starts as a copy of the user's (supervision
    // artifacts only); runtime logs land there and are copied BACK after
    // the run — the only bytes that ever leave the scratch checkout.
    copyStateIfPresent(io.cwd, checkoutDir);
    const candidateStateDir = resolveStateDir(checkoutDir);
    const checkoutConfig = loadConfigAt(checkoutDir);
    const docsExclusions = loadDocsExclusions(checkoutDir, checkoutConfig);
    const cacheExclusions = loadCacheExclusions(checkoutDir, checkoutConfig);
    // The runtime document contains executable commands. Evaluate the same
    // owner-approved policy gate used by supervised runs BEFORE any prepare
    // or service command can start in the staged checkout.
    const policyResolution = resolveApprovedPolicyDigest({
      env: io.env,
      candidateCwd: checkoutDir,
      candidateConfig: checkoutConfig,
    });
    const policyGate = evaluateApprovedPolicy(
      policyResolution,
      trustedPolicyDigestForConfig(checkoutDir, checkoutConfig),
      checkoutConfig.enforcement?.strictE2E === true || docsExclusions.length > 0 || cacheExclusions.length > 0,
    );
    if (policyGate.status === 'blocked') {
      return renderCandidateBlock(io, policyGate.detail, policyGate.nextAction);
    }
    const runtimeDoc = loadRuntimeConfigAt(checkoutDir, checkoutConfig.runtime);
    if (runtimeDoc !== null) {
      assertRuntimeReuseOwnerApproval(frozen.approvedReusePaths, runtimeDoc.prepare?.reuse ?? []);
      // Armed BEFORE preparation: a SIGINT during a long prepare (or a
      // readiness wait) still tears the detached process groups down.
      armInterruptHandlers();
      const prepared = await prepareRuntime(io.cwd, checkoutDir, runtimeDoc, io, candidateStateDir);
      runtimeReuseDigest = prepared.reuseDigest;
      runtimeReuseMounts = prepared.reuseMounts;
      runtime = await startRuntimeServices(checkoutDir, runtimeDoc, io, candidateStateDir);
    }
    process.chdir(checkoutDir);

    // When the candidate runtime owns the attested target, ITS binding
    // overrides any operator-provided target env: the witnessed subject
    // must be the process this gate started from the checkout, never a
    // URL the surrounding shell names.
    const candidateEnv: NodeJS.ProcessEnv = { ...io.env };
    if (runtime?.targetBaseUrl !== null && runtime?.targetBaseUrl !== undefined) {
      candidateEnv['GATEFORGE_APP_BASE_URL'] = runtime.targetBaseUrl;
      candidateEnv['GATEFORGE_TARGET_BASE_URL'] = runtime.targetBaseUrl;
      candidateEnv['GATEFORGE_TARGET_FINGERPRINT'] = runtime.targetFingerprint ?? '';
    }
    const candidateIo: Io = { ...io, cwd: checkoutDir, env: candidateEnv };
    // The seal-time drift check recomputes the candidate tree by raw
    // ingestion of the RUN WORKSPACE (the checkout, run state excluded).
    // The trusted override must be the SAME computation over the prepared
    // checkout — the frozen INDEX tree alone never matches it (prepared
    // runtime artifacts are part of the tested workspace). The authenticated
    // input digest also carries the deterministic bytes digest for any
    // sanctioned external reuse link. The user-index binding stays with
    // recheckStagedCandidate below.
    const checkoutGitDir = resolveGitDir(checkoutDir, io.env);
    const candidateTreeId =
      checkoutGitDir === null
        ? undefined
        : computeCandidateTreeId(
            checkoutGitDir,
            checkoutDir,
            io.env,
            candidateStateDir,
            'record',
            runtimeReuseMounts,
            docsExclusions,
            cacheExclusions,
          );
    const runCode = await runSupervisedTestGates(candidateIo, {
      out: undefined,
      format: 'text',
      witnessUrl: undefined,
      runToken: undefined,
      runTimeoutMs:
        runtimeDoc?.executionTimeoutSeconds !== undefined ? runtimeDoc.executionTimeoutSeconds * 1_000 : undefined,
      scope: scope === 'staged' ? 'changed' : 'full',
      fixedChangedFiles: frozen.changedPaths,
      fixedCandidateTreeId: candidateTreeId,
      fixedParentSha: frozen.headSha,
      runtimeReuseDigest,
      runtimeReuseMounts,
      runtimeReuseCheck: () => digestRuntimeReuseMounts(runtimeReuseMounts),
      verifierKeyring,
    });

    const checkCode =
      runCode === 0
        ? await runCheckGate(candidateIo, {
            diffScoped: scope === 'staged',
            requireE2E: true,
            format: 'text',
            fixedChangedFiles: frozen.changedPaths,
            fixedCandidateTreeId: candidateTreeId ?? null,
            runtimeReuseDigest,
      runtimeReuseMounts,
      runtimeReuseCheck: () => digestRuntimeReuseMounts(runtimeReuseMounts),
      verifierKeyring,
          })
        : runCode;

    copyStateIfPresent(checkoutDir, io.cwd);
    const recheck = recheckStagedCandidate(io.cwd, io.env, frozen);
    if (!recheck.ok) {
      return renderCandidateBlock(io, recheck.detail, 'Restage the intended bytes and run the pre-commit gate again.');
    }
    return checkCode;
  } catch (error) {
    if (error instanceof RuntimeBlockError) {
      return renderRuntimeBlock(io, error);
    }
    if (error instanceof StagedCandidateBlockError) return renderCandidateBlock(io, error.message, error.nextAction);
    throw error;
  } finally {
    disarmInterruptHandlers();
    if (runtime !== null) await runtime.stop();
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
    releaseStagedCandidate(frozen);
  }
}

/** Copies Gateforge run-state artifacts between the user and candidate trees. */
function copyStateIfPresent(sourceRoot: string, destinationRoot: string): void {
  const source = resolveStateDir(sourceRoot);
  if (!existsSync(source)) return;
  const destination = resolveStateDir(destinationRoot);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

/** Prints a deterministic staged-candidate failure. */
function renderCandidateBlock(io: Io, detail: string, nextAction: string): number {
  writeLine(io.stdout, 'witnessed pre-commit gate: BLOCKED');
  writeLine(io.stdout, 'cause: ENFORCEMENT_UNTRUSTED');
  writeLine(io.stdout, `detail: ${detail}`);
  writeLine(io.stdout, `next action: ${nextAction}`);
  return 1;
}

/**
 * Prints a deterministic typed runtime failure (preparation or
 * readiness) with the shared next action for its cause code.
 *
 * Args:
 *   io: process context.
 *   error: the typed runtime block.
 *
 * Returns:
 *   number: 1 (blocking).
 */
function renderRuntimeBlock(io: Io, error: RuntimeBlockError): number {
  writeLine(io.stdout, 'witnessed pre-commit gate: BLOCKED');
  writeLine(io.stdout, `cause: ${error.causeCode}`);
  writeLine(io.stdout, `detail: ${error.message}`);
  writeLine(io.stdout, `next action: ${CAUSE_NEXT_ACTIONS[error.causeCode]}`);
  return 1;
}
