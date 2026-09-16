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
 * 1. the workspace candidate's bytes are snapshotted into a throwaway
 *    index (`GIT_INDEX_FILE` + `GIT_WORK_TREE` plumbing — the workspace
 *    is never modified), yielding the immutable tree id;
 * 2. the current input digest + trusted policy digest are RECOMPUTED
 *    from the workspace bytes with the Phase 4 machinery;
 * 3. the recomputed policy revision is compared against the OWNER-APPROVED
 *    policy digest provisioned in the BROKER environment
 *    (`GATEFORGE_APPROVED_POLICY_DIGEST` / `GATEFORGE_TRUSTED_CONFIG`
 *    outside the candidate — never the workspace): a mismatch is a typed
 *    ENFORCEMENT_UNTRUSTED rejection; a workspace declaring
 *    `enforcement.strictE2E` demands the pin outright;
 * 4. a valid, non-stale gate receipt must verify (MAC with the broker's
 *    verifier key, input digest, trusted policy digest, clean verdict
 *    summary, supervised invocation) for EXACTLY those bytes — missing
 *    receipts, stale/different-bytes receipts, and forged receipts are
 *    typed rejections; under a provisioned pin the receipt must ALSO
 *    bind the currently approved revision (a receipt sealed under a
 *    since-revoked policy is rejected: policy revision changed after
 *    sealing);
 * 5. the commit is created with compare-and-swap ref protection: the
 *    expected parent is read, the receipt's bound parent must match it,
 *    and `git update-ref <ref> <new> <old>` performs an atomic
 *    lockfile-guarded old-value check — a concurrent update fails the
 *    CAS and no commit is accepted.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, verifyGateReceipt, type GateReceipt, type GateforgeConfig } from '@gate-forge/core';
import { parseArgs } from './args.js';
import { trustedPolicyDigestForConfig, SUPERVISED_INVOCATION } from './execution.js';
import { UsageError } from './errors.js';
import type { Io } from './io.js';
import { writeLine } from './io.js';
import { TEST_MAP_RELATIVE } from './mapping.js';
import { computeInputSnapshot } from './input-snapshot.js';
import { runPipeline } from './pipeline.js';
import { httpRoutesView, resolveStateDir } from './state.js';
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
 * Computes the immutable tree id of a workspace candidate: the bytes are
 * snapshotted into a throwaway index (the workspace itself is never
 * modified) and `git write-tree` pins the tree into the authoritative
 * object store. Symlink/submodule candidates are typed rejections.
 *
 * Args:
 *   authorityCwd: the authoritative repository cwd.
 *   env: process environment.
 *   workspace: absolute workspace path (the candidate bytes).
 *   scratchDir: scratch directory for the throwaway index.
 *
 * Returns:
 *   string: 40-char hex tree id.
 *
 * Throws:
 *   UsageError: when the workspace is missing or plumbing fails.
 *   BrokerRejection: unsupported symlink/submodule entries.
 */
function workspaceTreeId(
  authorityCwd: string,
  env: NodeJS.ProcessEnv,
  workspace: string,
  scratchDir: string,
): string {
  if (!existsSync(workspace)) {
    throw new UsageError(`broker: workspace '${workspace}' does not exist`);
  }
  const index = join(scratchDir, 'workspace-index');
  const emptied = authorityGit(authorityCwd, env, ['read-tree', '--empty'], { GIT_INDEX_FILE: index });
  if (emptied.status !== 0) {
    throw new UsageError(`broker: could not initialize the candidate index: ${emptied.stderr.trim()}`);
  }
  const added = spawnSync('git', ['add', '-A', '--'], {
    cwd: authorityCwd,
    env: { ...env, GIT_INDEX_FILE: index, GIT_WORK_TREE: workspace },
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (added.error !== undefined || added.status !== 0) {
    throw new UsageError(
      `broker: could not snapshot the workspace candidate (git add, exit ${added.status ?? -1}): ` +
        `${(added.stderr ?? Buffer.alloc(0)).toString('utf8').trim()}`,
    );
  }
  const staged = authorityGit(authorityCwd, env, ['ls-files', '-s', '-z'], { GIT_INDEX_FILE: index });
  for (const entry of staged.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const mode = entry.slice(0, tab).split(' ')[0] ?? '';
    const path = entry.slice(tab + 1);
    if (mode === '120000' || mode === '160000') {
      throw new BrokerRejection(
        'ENFORCEMENT_UNTRUSTED',
        `the workspace candidate contains an unsupported entry ('${path}', mode ${mode}); ` +
          'symlink/submodule candidates cannot be verified (fail closed)',
      );
    }
  }
  const written = authorityGit(authorityCwd, env, ['write-tree'], { GIT_INDEX_FILE: index });
  if (written.status !== 0) {
    throw new UsageError(`broker: git write-tree failed: ${written.stderr.trim()}`);
  }
  const treeId = written.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(treeId)) {
    throw new UsageError('broker: git write-tree returned an unusable tree id');
  }
  return treeId;
}

/**
 * Recomputes the workspace candidate's trusted digests with the Phase 4
 * machinery (the exact binding a supervised gate run seals): the
 * pipeline-derived input snapshot digest and the trusted policy/config
 * revision digest, both from the WORKSPACE bytes.
 *
 * Args:
 *   workspace: absolute workspace path.
 *   env: process environment.
 *
 * Returns:
 *   {inputDigest, trustedPolicyDigest, config}: the recomputed binding
 *   digests plus the workspace-loaded config (the approved-policy gate
 *   reads enforcement.strictE2E / candidate-declared pins from it).
 *
 * Throws:
 *   UsageError: when the workspace has no valid gateforge config.
 */
async function recomputeWorkspaceDigests(
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<{ inputDigest: string; trustedPolicyDigest: string; config: GateforgeConfig }> {
  const config = loadConfig(join(workspace, '.gateforge.yml'));
  const stateDir = resolveStateDir(workspace);
  const pipeline = await runPipeline({
    cwd: workspace,
    env,
    config,
    provider: 'all-files',
    stateDir,
  });
  const inputDigest = computeInputSnapshot({
    cwd: workspace,
    config,
    stateDir,
    classifications: pipeline.classificationsView.resources,
    obligations: pipeline.policy.obligations,
    httpRoutes: httpRoutesView(pipeline.graph),
    plugins: pipeline.manifest.plugins.map((plugin) => ({ id: plugin.id, version: plugin.version })),
  }).inputDigest;
  const trustedPolicyDigest = trustedPolicyDigestForConfig(workspace, config);
  return { inputDigest, trustedPolicyDigest, config };
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
  //    Phase 4 binding digests from those bytes. The workspace IS the
  //    evaluated repository for this step: the process cwd follows it so
  //    repo-relative readers (in-process plugin modules read repo-relative
  //    paths against the process cwd) resolve the workspace bytes — never
  //    the authoritative repo's. Restored on every path.
  const scratchDir = mkdtempSync(join(tmpdir(), 'gateforge-broker-'));
  let treeId: string;
  let digests: { inputDigest: string; trustedPolicyDigest: string; config: GateforgeConfig };
  const previousCwd = process.cwd();
  process.chdir(workspace);
  try {
    treeId = workspaceTreeId(io.cwd, io.env, workspace, scratchDir);
    digests = await recomputeWorkspaceDigests(workspace, io.env);
  } finally {
    if (process.cwd() !== previousCwd) process.chdir(previousCwd);
    rmSync(scratchDir, { recursive: true, force: true });
  }

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

  // 2. Require a valid receipt for EXACTLY these bytes (Phase 4
  //    verification incl. trustedPolicyDigest + staleness binding).
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
  const verified = verifyGateReceipt(verifierKey, receiptRaw, {
    inputDigest: digests.inputDigest,
    trustedPolicyDigest: digests.trustedPolicyDigest,
  });
  if (!verified.ok) {
    if (verified.rejection === 'input-digest-mismatch' || verified.rejection === 'policy-digest-mismatch') {
      // Binding mismatches are STALENESS: the receipt is for other bytes
      // or a different trusted policy revision (E13).
      throw new BrokerRejection('EVIDENCE_STALE', `broker: ${verified.detail} (rerun the gate for the exact candidate)`);
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
    `broker: committed ${newSha} on ${ref} (tree ${treeId}, receipt ${receipt.receiptId}, input ${digests.inputDigest.slice(0, 12)})`,
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
