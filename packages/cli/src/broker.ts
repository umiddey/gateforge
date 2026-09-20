/**
 * Managed-mode commit broker (plan 2026-09-13 Phase 5 item 6, ADR 0005
 * D1): `gateforge broker commit` — the broker MECHANISM, not the
 * deployment.
 *
 * MANAGED-MODE BOUNDARY (honest, per ADR 0005 D1): the guarantee of
 * managed mode exists ONLY when the broker runs OUTSIDE the agent's
 * write/process boundary — the authoritative Git directory, the gate
 * executable, the policy authority, and this CLI process (including the
 * witness verifier key in its environment) must live where the agent
 * cannot write or execute. This subcommand implements the mechanism: it
 * is the entry point a hardened deployment calls. Running it inside the
 * agent's own boundary provides NO managed guarantee — `enforcement
 * doctor` reports that honestly.
 *
 * Flow (fail closed at every step):
 * 1. the workspace candidate's bytes are ingested RAW into the
 *    authoritative object store (`hash-object -w` per regular file +
 *    `mktree` — never `git add`, so candidate clean filters, hooks, and
 *    ambient `GIT_*` redirectors cannot execute or rewrite bytes),
 *    yielding the immutable tree id;
 * 2. the trusted policy digest is recomputed from RAW workspace file
 *    bytes only (no plugin/adapter import, no pipeline execution in the
 *    authority process);
 * 3. the recomputed policy revision is compared against the OWNER-APPROVED
 *    policy digest provisioned in the BROKER environment
 *    (`GATEFORGE_APPROVED_POLICY_DIGEST` / `GATEFORGE_TRUSTED_CONFIG`
 *    outside the candidate — never the workspace): a mismatch is a typed
 *    ENFORCEMENT_UNTRUSTED rejection; a workspace declaring
 *    `enforcement.strictE2E` demands the pin outright;
 * 4. a valid v2 gate receipt must verify (MAC with the broker's
 *    verifier key, candidate tree id, trusted policy digest, execution
 *    boundary, clean verdict summary, supervised invocation) for EXACTLY
 *    that tree — missing receipts, stale/different-bytes receipts, v1
 *    receipts, and forged receipts are typed rejections; under a provisioned pin the receipt must ALSO
 *    bind the currently approved revision (a receipt sealed under a
 *    since-revoked policy is rejected: policy revision changed after
 *    sealing);
 * 5. the commit is created with compare-and-swap ref protection: the
 *    expected parent is read, the receipt's bound parent must match it,
 *    and `git update-ref <ref> <new> <old>` performs an atomic
 *    lockfile-guarded old-value check — a concurrent update fails the
 *    CAS and no commit is accepted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { loadConfig, verifyGateReceipt, executionBoundaryDigestOf, type GateReceipt, type GateforgeConfig } from '@gate-forge/core';
import { isolationProfileForEnvironment } from './isolation.js';
import { parseArgs } from './args.js';
import { trustedPolicyDigestForConfig, SUPERVISED_INVOCATION } from './execution.js';
import { UsageError } from './errors.js';
import type { Io } from './io.js';
import { writeLine } from './io.js';
import { computeCandidateTreeId, resolveGitDir } from './candidate-tree.js';
import { resolveStateDir } from './state.js';
import { assertReceiptApprovedPolicy, evaluateApprovedPolicy, resolveApprovedPolicyDigest } from './trusted-policy.js';
import { rejectUnknownFlags } from './commands/common.js';

export const BROKER_USAGE =
  'usage: gateforge broker commit --workspace <dir> --message <msg> [--receipt <path>] [--ref <ref>]\n' +
  '       (verifier key via GATEFORGE_WITNESS_VERIFIER_KEY env; runs with cwd = the AUTHORITATIVE repository)\n' +
  '       approved policy pin: GATEFORGE_APPROVED_POLICY_DIGEST (protected broker env) — when provisioned,\n' +
  '       the workspace policy revision and the receipt must bind exactly that approved revision.\n' +
  '       Managed-mode boundary: this command implements the broker MECHANISM, not the deployment.\n' +
  '       The guarantee exists only while the broker (Git dir, engine, verifier key) is outside the\n' +
  '       agent\'s write/process boundary — ADR 0005 D1.';

/** One typed broker rejection (plan Phase 5 item 6). */
export class BrokerRejection extends UsageError {
  /** The §5.4 cause code (or a broker-specific CAS/message marker). */
  readonly causeCode: string;

  /**
   * Args:
   *   causeCode: stable cause code (ENFORCEMENT_UNTRUSTED /
   *     EVIDENCE_STALE / RUN_INCOMPLETE / BROKER_CAS_MISMATCH /
   *     BROKER_UNSAFE_MESSAGE).
   *   detail: precise rejection reason.
   */
  constructor(causeCode: string, detail: string) {
    super(detail);
    this.name = 'BrokerRejection';
    this.causeCode = causeCode;
  }
}

/**
 * Runs one git command against the AUTHORITATIVE repository (never the
 * workspace; `GIT_WORK_TREE`/`GIT_INDEX_FILE` from the ambient env are
 * stripped so caller processes cannot redirect the writes).
 */
function authorityGit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): { status: number; stdout: string; stderr: string } {
  // Strip AMBIENT GIT_WORK_TREE/GIT_INDEX_FILE first, THEN apply the
  // caller's explicit extras — the order matters: deleting after the
  // merge would strip exactly the temp-index plumbing the broker relies
  // on (and redirect writes at the authoritative repo's real index).
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv['GIT_WORK_TREE'];
  delete childEnv['GIT_INDEX_FILE'];
  Object.assign(childEnv, extraEnv);
  const result = spawnSync('git', [...args], { cwd, env: childEnv, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw new UsageError(`broker: cannot run git: ${result.error.message}`);
  }
  return {
    status: result.status ?? -1,
    stdout: (result.stdout ?? Buffer.alloc(0)).toString('utf8'),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8'),
  };
}
/**
 * Raw owner-controlled boundary label, retained for operator-facing
 * diagnostics. Receipt digests use the normalized isolation profile below.
 */
function authorityBoundaryLabel(env: NodeJS.ProcessEnv): string {
  const raw = env['GATEFORGE_AUTHORITY_BOUNDARY'];
  return typeof raw === 'string' && raw.length > 0 ? raw : 'local-unisolated';
}

/**
 * Normalized execution-boundary profile accepted by this authority.
 * Managed-authoritative is an authority label, not a receipt profile.
 */
function authorityBoundaryProfile(env: NodeJS.ProcessEnv): string {
  return isolationProfileForEnvironment(env);
}

/**
 * Recomputes the workspace candidate's trusted digests from RAW file
 * bytes only: the resolved config (pure YAML parse — no plugin import,
 * no detector execution) plus the trusted policy/config revision digest
 * (file bytes hashed, never imported). No pipeline runs in the authority
 * process, so candidate-selected executable input can never execute here.
 *
 * Args:
 *   workspace: absolute workspace path.
 *
 * Returns:
 *   {trustedPolicyDigest, config}: the recomputed policy revision plus
 *   the workspace-loaded config (the approved-policy gate reads
 *   enforcement.strictE2E from it).
 *
 * Throws:
 *   UsageError: when the workspace has no valid gateforge config.
 */
function recomputeWorkspaceDigests(
  workspace: string,
): { trustedPolicyDigest: string; config: GateforgeConfig } {
  const config = loadConfig(join(workspace, '.gateforge.yml'));
  const trustedPolicyDigest = trustedPolicyDigestForConfig(workspace, config);
  return { trustedPolicyDigest, config };
}

/**
 * Runs `gateforge broker commit` (plan Phase 5 item 6): verifies the
 * workspace candidate's gate receipt for EXACTLY those bytes, then
 * creates the authoritative commit with compare-and-swap ref protection.
 *
 * Args:
 *   io: process context (cwd = the AUTHORITATIVE repository).
 *   argv: flags after `broker commit`.
 *
 * Returns:
 *   number: 0 committed; rejections are typed errors (exit 2).
 *
 * Throws:
 *   BrokerRejection: no/stale/wrong-bytes/forged receipt, unsafe
 *     message, or CAS mismatch (no commit is created).
 *   UsageError: usage problems or git/plumbing failures.
 */
export async function brokerCommitCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, BROKER_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['workspace', 'message', 'receipt', 'ref', 'help'], BROKER_USAGE);
  const workspaceFlag = options['workspace'];
  const messageFlag = options['message'];
  if (typeof workspaceFlag !== 'string' || workspaceFlag.length === 0) {
    throw new UsageError('broker commit: --workspace <dir> is required');
  }
  if (typeof messageFlag !== 'string') {
    throw new UsageError('broker commit: --message <msg> is required');
  }
  const message = messageFlag;
  const workspace = resolve(io.cwd, workspaceFlag);
  const ref = typeof options['ref'] === 'string' && options['ref'].length > 0 ? options['ref'] : 'HEAD';
  const receiptPath =
    typeof options['receipt'] === 'string' && options['receipt'].length > 0
      ? resolve(io.cwd, options['receipt'])
      : join(resolveStateDir(workspace), 'receipt.json');

  // Unsafe messages (plan item 6): NUL bytes can smuggle extra "fields"
  // into commit objects — reject before any git call.
  if (message.includes('\0')) {
    throw new BrokerRejection('BROKER_UNSAFE_MESSAGE', 'the commit message contains NUL bytes; refusing (fail closed)');
  }
  if (message.trim().length === 0) {
    throw new BrokerRejection('BROKER_UNSAFE_MESSAGE', 'the commit message is empty; refusing (fail closed)');
  }

  // 1. Freeze the candidate bytes (immutable tree id) + recompute the
  //    trusted policy digest from RAW workspace bytes. No `process.chdir`
  //    into the candidate, no pipeline execution, no plugin/adapter
  //    import in the authority process: candidate-selected executable
  //    input can never execute here. The workspace itself is never
  //    modified.
  if (!existsSync(workspace)) {
    throw new UsageError(`broker: workspace '${workspace}' does not exist`);
  }
  const authorityGitDir = resolveGitDir(io.cwd, io.env);
  if (authorityGitDir === null) {
    throw new UsageError('broker: the authoritative directory is not a Git checkout (fail closed)');
  }
  const treeId = computeCandidateTreeId(authorityGitDir, workspace, io.env, resolveStateDir(workspace));
  const digests = recomputeWorkspaceDigests(workspace);

  // 1b. Approved-policy ownership gate (review 2026-09-13 P1 #5): the
  //     workspace's recomputed policy revision must match the
  //     OWNER-APPROVED digest provisioned in the BROKER environment
  //     (GATEFORGE_APPROVED_POLICY_DIGEST / GATEFORGE_TRUSTED_CONFIG —
  //     never the workspace, whose `.gateforge.yml` is candidate bytes).
  //     A provisioned pin binds EVERY commit; a workspace declaring
  //     enforcement.strictE2E demands the pin outright (fail closed).
  const policyResolution = resolveApprovedPolicyDigest({
    env: io.env,
    candidateCwd: workspace,
    candidateConfig: digests.config,
  });
  const policyGate = evaluateApprovedPolicy(
    policyResolution,
    digests.trustedPolicyDigest,
    digests.config.enforcement?.strictE2E === true,
  );
  if (policyGate.status === 'blocked') {
    throw new BrokerRejection(
      policyGate.cause,
      `broker: ${policyGate.detail} (${policyGate.nextAction})`,
    );
  }
  if (policyGate.status === 'unenforced') {
    writeLine(
      io.stderr,
      'broker: no approved policy digest provisioned (GATEFORGE_APPROVED_POLICY_DIGEST); ' +
        'policy-revision ownership NOT enforced for this commit',
    );
  }

  // 2. Require a valid v2 receipt for EXACTLY this tree (Phase 3
  //    authority cutover). The MAC authenticates the sealed binding set;
  //    the broker additionally demands: the sealed candidate tree equals
  //    the freshly ingested tree, the sealed policy revision equals the
  //    raw recomputed revision, and the sealed execution boundary equals
  //    THIS authority's expectation. The sealed input digest rides inside
  //    the authenticated envelope (the trusted controller bound it at
  //    seal time); the broker never re-runs a candidate-configured
  //    pipeline to second-guess it.
  if (!existsSync(receiptPath)) {
    throw new BrokerRejection(
      'RUN_INCOMPLETE',
      `no gate receipt at '${receiptPath}' — run \`gateforge test-gates --changed\` in the workspace; ` +
        'the broker never commits an unverified candidate (fail closed)',
    );
  }
  let receiptRaw: unknown;
  try {
    receiptRaw = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new BrokerRejection(
      'ENFORCEMENT_UNTRUSTED',
      `the gate receipt at '${receiptPath}' is unreadable/malformed: ${(error as Error).message}`,
    );
  }
  const verifierKey = io.env['GATEFORGE_WITNESS_VERIFIER_KEY'];
  if (verifierKey === undefined || verifierKey.length === 0) {
    throw new BrokerRejection(
      'ENFORCEMENT_UNTRUSTED',
      'no witness verifier key in the broker environment; the receipt cannot be authenticated (fail closed)',
    );
  }
  const expectedBoundary = executionBoundaryDigestOf(authorityBoundaryProfile(io.env));
  const verified = verifyGateReceipt(verifierKey, receiptRaw, {
    candidateTreeId: treeId,
    trustedPolicyDigest: digests.trustedPolicyDigest,
    executionBoundaryDigest: expectedBoundary,
  });
  if (!verified.ok) {
    if (
      verified.rejection === 'input-digest-mismatch' ||
      verified.rejection === 'policy-digest-mismatch' ||
      verified.rejection === 'tree-mismatch'
    ) {
      // Binding mismatches are STALENESS: the receipt is for other bytes
      // or a different trusted policy revision (E13).
      throw new BrokerRejection('EVIDENCE_STALE', `broker: ${verified.detail} (rerun the gate for the exact candidate)`);
    }
    if (verified.rejection === 'boundary-mismatch') {
      throw new BrokerRejection(
        'ENFORCEMENT_UNTRUSTED',
        `broker: ${verified.detail} — this authority requires execution-boundary ` +
          `'${authorityBoundaryProfile(io.env)}' (authority label '${authorityBoundaryLabel(io.env)}'); a '${'local-unisolated'}' receipt cannot authorize ` +
          'managed acceptance (fail closed)',
      );
    }
    throw new BrokerRejection('ENFORCEMENT_UNTRUSTED', `broker: ${verified.detail}`);
  }
  const receipt: GateReceipt = verified.receipt;
  if (receipt.invocation !== SUPERVISED_INVOCATION) {
    throw new BrokerRejection(
      'ENFORCEMENT_UNTRUSTED',
      `the receipt records invocation '${receipt.invocation}', not '${SUPERVISED_INVOCATION}'; ` +
        'only the supervised strict gate can authorize a managed commit (fail closed)',
    );
  }
  // Approved-policy receipt binding (review item 3): under a provisioned
  // pin the receipt must bind the CURRENTLY approved revision — a receipt
  // sealed under a since-revoked/different approved policy (or before any
  // pin existed) is a typed reject, never a commit.
  if (policyGate.status === 'enforced') {
    const binding = assertReceiptApprovedPolicy(receipt, policyGate.approved);
    if (!binding.ok) {
      throw new BrokerRejection(binding.cause, `broker: ${binding.detail} (${binding.nextAction})`);
    }
  }

  // 3. Compare-and-swap commit: expected parent read first, the
  //    receipt's bound parent must agree, then an atomic old-value
  //    checked update (update-ref takes a ref lockfile).
  const expected = authorityGit(io.cwd, io.env, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  const parentSha =
    expected.status === 0 && /^[0-9a-f]{40}$/.test(expected.stdout.trim()) ? expected.stdout.trim() : null;
  if (receipt.parentSha !== null && receipt.parentSha !== parentSha) {
    throw new BrokerRejection(
      'BROKER_CAS_MISMATCH',
      `the receipt was sealed against parent '${receipt.parentSha}' but the authoritative ref '${ref}' is at ` +
        `'${parentSha ?? 'unborn'}'; stale base — rerun the gate against the current base (compare-and-swap protection)`,
    );
  }
  const commitArgs = ['commit-tree', treeId, '--no-gpg-sign', '-m', message];
  if (parentSha !== null) commitArgs.push('-p', parentSha);
  const commitEnv: NodeJS.ProcessEnv = { ...io.env };
  commitEnv['GIT_AUTHOR_NAME'] = commitEnv['GIT_AUTHOR_NAME'] ?? 'gateforge broker';
  commitEnv['GIT_AUTHOR_EMAIL'] = commitEnv['GIT_AUTHOR_EMAIL'] ?? 'broker@gateforge.invalid';
  commitEnv['GIT_COMMITTER_NAME'] = commitEnv['GIT_COMMITTER_NAME'] ?? 'gateforge broker';
  commitEnv['GIT_COMMITTER_EMAIL'] = commitEnv['GIT_COMMITTER_EMAIL'] ?? 'broker@gateforge.invalid';
  const committed = authorityGit(io.cwd, commitEnv, commitArgs);
  if (committed.status !== 0) {
    throw new UsageError(`broker: git commit-tree failed: ${committed.stderr.trim()}`);
  }
  const newSha = committed.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(newSha)) {
    throw new UsageError('broker: git commit-tree returned an unusable commit id');
  }
  // Atomic CAS: `update-ref <ref> <new> <old>` takes a lockfile and
  // verifies the old value — a concurrent update fails the whole call
  // (40 zeros = the ref must not exist; initial-commit support).
  const updated = authorityGit(io.cwd, io.env, ['update-ref', ref, newSha, parentSha ?? '0'.repeat(40)]);
  if (updated.status !== 0) {
    throw new BrokerRejection(
      'BROKER_CAS_MISMATCH',
      `the authoritative ref '${ref}' moved during the commit (compare-and-swap rejected; expected parent ` +
        `'${parentSha ?? 'unborn'}'); no commit was accepted`,
    );
  }
  writeLine(
    io.stdout,
    `broker: committed ${newSha} on ${ref} (tree ${treeId}, receipt ${receipt.receiptId}, boundary ${authorityBoundaryLabel(io.env)} / profile ${authorityBoundaryProfile(io.env)})`,
  );
  writeLine(
    io.stdout,
    'managed-mode note: this guarantee holds only while the broker (Git dir, engine, verifier key) stays outside the agent boundary (ADR 0005 D1)',
  );
  return 0;
}

/**
 * Runs the `broker` command family (plan Phase 5 item 6). Only `commit`
 * exists: a deliberately narrow surface — there is no unchecked
 * ref-update path.
 *
 * Args:
 *   io: process context.
 *   argv: flags + positionals after `broker`.
 *
 * Returns:
 *   Promise<number>: exit code.
 */
export async function brokerCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { positionals } = parseArgs(argv);
  const sub = positionals[0];
  if (sub === undefined || argv.includes('--help')) {
    writeLine(io.stdout, BROKER_USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub !== 'commit') {
    throw new UsageError(`unknown broker subcommand '${sub}' (only 'commit' exists)`);
  }
  return brokerCommitCommand(io, argv.slice(1));
}
