/**
 * Staged-candidate verification (plan 2026-09-13 Phase 5 items 3–4):
 * `check --staged` gates the EXACT staged bytes — never the working tree.
 *
 * Contract (fail closed everywhere):
 * - FREEZE: the index tree identity is recorded with read-only-equivalent
 *   plumbing — the index is COPIED to a scratch file and
 *   `GIT_INDEX_FILE=<copy> git write-tree` computes the tree id. The
 *   user's index, worktree, and refs are never written by this module.
 * - IDENTITY: the base/parent identity is HEAD (or the empty tree for an
 *   initial commit); `MERGE_HEAD` records a second parent for merges.
 * - MATERIALIZATION: an isolated candidate checkout of the frozen tree is
 *   produced with `git read-tree <tree>` + `git checkout-index --prefix`
 *   into a scratch directory (NUL-delimited plumbing throughout — spaces,
 *   newlines, renames, and deletions in filenames are handled by Git, not
 *   by string splitting). The checkout is then turned into a throwaway Git
 *   repository (`git init` + `git add -A`) so the regular gate pipeline
 *   (config, snapshot, state dir) runs against the staged bytes unchanged.
 * - NO CONCEALED CONVENIENCE: this module never stages, stashes, resets,
 *   commits, or otherwise modifies the user's worktree or index.
 * - RECHECK: immediately before a result may authorize the candidate, the
 *   tree id is recomputed from a FRESH copy of the user's index; any
 *   drift (index or HEAD moved during the run) is a typed
 *   `ENFORCEMENT_UNTRUSTED` block — different bytes never receive
 *   authorization.
 * - UNSUPPORTED CANDIDATES are explicit typed blocks, never fallbacks:
 *   symlinks and submodules in the candidate (until implemented), and
 *   unmerged (conflicting) index entries. Partial staging is FINE — the
 *   gate evaluates exactly what is staged.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CAUSE_NEXT_ACTIONS, normalizeChangedFiles, type CauseCode } from '@gateforge/core';
import { UsageError } from './errors.js';

/** The verify argument a generated hook accepts to prove activation. */
export const HOOK_VERIFY_ARG = '--gateforge-verify';

/** Marker lines delimiting the gateforge-managed block of a hook file. */
export const HOOK_MARKER_BEGIN = '# >>> gateforge pre-commit v1 >>>';
export const HOOK_MARKER_END = '# <<< gateforge pre-commit v1 <<<';

/** The well-known empty-tree object id (initial-commit diff base). */
const EMPTY_TREE_ID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** One staged change (frozen index vs base), NUL-delimited plumbing data. */
export interface StagedChange {
  /** Destination path (the path the candidate carries). */
  path: string;
  /** Git one-letter change status (A/M/D/T/R/C). */
  status: 'A' | 'M' | 'D' | 'T' | 'R' | 'C';
  /** Source path for renames/copies (R/C statuses only). */
  oldPath?: string;
}

/**
 * A typed staged-candidate block (plan §5.4): the candidate cannot be
 * verified, so the gate blocks with a stable cause code instead of
 * falling back to weaker evidence. Never thrown for ordinary config or
 * git failures — those stay {@link UsageError} (exit 2).
 */
export class StagedCandidateBlockError extends Error {
  /** The §5.4 cause code this block reports. */
  readonly causeCode: CauseCode;
  /** The §5.4 next action text. */
  readonly nextAction: string;

  /**
   * Args:
   *   causeCode: the typed cause (e.g. ENFORCEMENT_UNTRUSTED).
   *   detail: precise human-readable reason (names the offending path).
   *   nextAction: actionable next step; defaults to the §5.4 action for
   *     the cause.
   */
  constructor(causeCode: CauseCode, detail: string, nextAction: string = CAUSE_NEXT_ACTIONS[causeCode]) {
    super(detail);
    this.name = 'StagedCandidateBlockError';
    this.causeCode = causeCode;
    this.nextAction = nextAction;
  }
}

/** A frozen staged candidate (identity + materialized checkout). */
export interface StagedCandidate {
  /** Frozen index tree id (40-char hex). */
  treeId: string;
  /** HEAD at freeze time, or null for an initial commit. */
  headSha: string | null;
  /** MERGE_HEAD at freeze time, or null outside merge commits. */
  mergeHeadSha: string | null;
  /** Parents the staged candidate would be committed onto: [], [HEAD], or [HEAD, MERGE_HEAD]. */
  parentShas: string[];
  /** Staged changes (frozen index vs base), sorted by path. */
  changed: StagedChange[];
  /** Normalized union of changed paths (including rename sources). */
  changedPaths: string[];
  /** Scratch directory owning the index copy and the checkout (absolute). */
  scratchDir: string;
  /** Absolute path of the materialized candidate checkout (after materialization). */
  checkoutDir: string | null;
}

/** Options for one git invocation against the USER's repository. */
interface GitCall {
  args: readonly string[];
  /** Extra environment (GIT_INDEX_FILE etc.); GIT_* scratch vars are stripped. */
  extraEnv?: Readonly<Record<string, string>>;
  /** When true a nonzero exit does not throw. */
  allowFailure?: boolean;
}

/**
 * Runs one git command in the user's repository with a sanitized
 * environment (caller GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE never leak
 * into candidate plumbing).
 *
 * Args:
 *   cwd: absolute repository root.
 *   env: process environment.
 *   call: args, extra env, allowFailure.
 *
 * Returns:
 *   {status, stdout, stderr}: raw spawn result.
 *
 * Throws:
 *   UsageError: when git cannot be run at all (missing binary).
 */
function git(cwd: string, env: NodeJS.ProcessEnv, call: GitCall): { status: number; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv['GIT_DIR'];
  delete childEnv['GIT_WORK_TREE'];
  delete childEnv['GIT_INDEX_FILE'];
  Object.assign(childEnv, call.extraEnv ?? {});
  const result = spawnSync('git', [...call.args], { cwd, env: childEnv, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw new UsageError(`staged candidate: cannot run git: ${result.error.message}`);
  }
  const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf8');
  const stderr = (result.stderr ?? Buffer.alloc(0)).toString('utf8');
  if (result.status !== 0 && !call.allowFailure) {
    throw new UsageError(
      `staged candidate: git ${call.args.join(' ')} failed (exit ${result.status ?? -1})` +
        (stderr.trim().length > 0 ? `: ${stderr.trim().split('\n')[0]}` : ''),
    );
  }
  return { status: result.status ?? -1, stdout, stderr };
}

/** 40-char lowercase hex sha shape. */
function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * Resolves a git object identity (`HEAD`, `MERGE_HEAD`), or null when it
 * does not exist (unborn HEAD, no merge in progress).
 *
 * Args:
 *   cwd: repository root.
 *   env: process environment.
 *   ref: the ref to resolve.
 *
 * Returns:
 *   string | null: 40-char sha, or null.
 */
function resolveSha(cwd: string, env: NodeJS.ProcessEnv, ref: string): string | null {
  const out = git(cwd, env, { args: ['rev-parse', '--verify', '-q', `${ref}^{commit}`], allowFailure: true });
  const sha = out.stdout.trim();
  return out.status === 0 && isSha(sha) ? sha : null;
}

/**
 * Parses `git diff-index --cached --name-status -z -M <base>` output:
 * NUL-delimited records, with rename/copy records carrying
 * `status\0src\0dst\0` (git emits the SOURCE path first). Never splits on
 * newlines — filenames may legally contain them.
 *
 * Args:
 *   raw: raw NUL-delimited stdout.
 *
 * Returns:
 *   StagedChange[]: parsed change records.
 */
function parseNameStatus(raw: string): StagedChange[] {
  const parts = raw.split('\0');
  const changes: StagedChange[] = [];
  let index = 0;
  while (index < parts.length) {
    const statusToken = parts[index];
    index += 1;
    if (statusToken === undefined || statusToken.length === 0) continue;
    const status = statusToken[0] as StagedChange['status'];
    if (status === 'R' || status === 'C') {
      // Rename/copy: git lists the SOURCE path first, then the DEST.
      const src = parts[index];
      index += 1;
      const dst = parts[index];
      index += 1;
      if (src === undefined || src.length === 0 || dst === undefined || dst.length === 0) continue;
      changes.push({ status, path: dst, oldPath: src });
      continue;
    }
    const dst = parts[index];
    index += 1;
    if (dst === undefined || dst.length === 0) continue;
    if (status === 'A' || status === 'M' || status === 'D' || status === 'T') {
      changes.push({ status, path: dst });
    }
  }
  return changes;
}

/**
 * Computes the tree id of an index file copy (`GIT_INDEX_FILE` plumbing;
 * the user's index is never touched). Unmerged entries make write-tree
 * fail — surfaced as a typed block, never a guess.
 *
 * Args:
 *   cwd: repository root.
 *   env: process environment.
 *   indexPath: scratch copy of the index.
 *
 * Returns:
 *   string: 40-char tree id.
 *
 * Throws:
 *   StagedCandidateBlockError: when the index has unmerged conflicts.
 *   UsageError: on other git plumbing failures.
 */
function writeTreeOfIndexCopy(cwd: string, env: NodeJS.ProcessEnv, indexPath: string): string {
  const out = git(cwd, env, {
    args: ['write-tree'],
    extraEnv: { GIT_INDEX_FILE: indexPath },
    allowFailure: true,
  });
  if (out.status !== 0) {
    const unmerged = git(cwd, env, { args: ['ls-files', '-u'], allowFailure: true });
    if (unmerged.stdout.trim().length > 0) {
      throw new StagedCandidateBlockError(
        'ENFORCEMENT_UNTRUSTED',
        'the staged index has unmerged conflict entries; resolve the conflicts and restage — ' +
          'a candidate with conflicts cannot be verified',
        'Resolve the merge conflicts, restage, and re-run the gate.',
      );
    }
    throw new UsageError(`staged candidate: git write-tree failed (exit ${out.status}): ${out.stderr.trim()}`);
  }
  const treeId = out.stdout.trim();
  if (!isSha(treeId)) {
    throw new UsageError('staged candidate: git write-tree returned an unusable tree id');
  }
  return treeId;
}

/**
 * Copies the user's index into the scratch directory (the freeze root of
 * trust: every tree computation reads the copy, never the live index).
 *
 * Args:
 *   cwd: repository root.
 *   scratchDir: scratch directory for the copy.
 *
 * Returns:
 *   string: absolute path of the index copy.
 */
function copyIndex(cwd: string, env: NodeJS.ProcessEnv, scratchDir: string): string {
  const indexPath = join(scratchDir, 'staged-index');
  const gitDir = git(cwd, env, { args: ['rev-parse', '--absolute-git-dir'] }).stdout.trim();
  const source = join(gitDir, 'index');
  if (existsSync(source)) {
    cpSync(source, indexPath);
  } else {
    // Unborn index (nothing ever staged): an empty file behaves exactly
    // like Git's empty index for write-tree/read-tree/checkout-index.
    writeFileSync(indexPath, Buffer.alloc(0));
  }
  return indexPath;
}

/**
 * Rejects unsupported candidate entry modes with typed blocks (plan
 * Phase 5 item 4: symlinks/submodules stay explicit blocks until
 * implemented — never a silent pass-through).
 *
 * Args:
 *   treeId: the frozen candidate tree.
 *   cwd: repository root.
 *   env: process environment.
 *
 * Throws:
 *   StagedCandidateBlockError: on the first symlink or submodule entry.
 */
function assertSupportedTree(cwd: string, env: NodeJS.ProcessEnv, treeId: string): void {
  const out = git(cwd, env, { args: ['ls-tree', '-r', '-z', treeId] });
  for (const entry of out.stdout.split('\0')) {
    if (entry.length === 0) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const mode = entry.slice(0, tab).split(' ')[0] ?? '';
    const path = entry.slice(tab + 1);
    if (mode === '120000') {
      throw new StagedCandidateBlockError(
        'ENFORCEMENT_UNTRUSTED',
        `the staged candidate contains symlink '${path}'; symlink candidates are not verifiable yet ` +
          '(explicit block until implemented — never a fallback)',
        'Replace the staged symlink with a regular file, or run the gate without --staged after implementing symlink support.',
      );
    }
    if (mode === '160000') {
      throw new StagedCandidateBlockError(
        'ENFORCEMENT_UNTRUSTED',
        `the staged candidate contains submodule '${path}'; submodule candidates are not verifiable yet ` +
          '(explicit block until implemented — never a fallback)',
        'Remove the staged submodule, or run the gate without --staged after implementing submodule support.',
      );
    }
  }
}

/**
 * Freezes the staged candidate (plan Phase 5 item 3): records the index
 * tree identity, parent/base identity (HEAD, MERGE_HEAD, or none for an
 * initial commit), and the staged change set vs the base — without
 * writing anything to the user's repository. Partial staging is fine:
 * the candidate is exactly what is staged.
 *
 * Args:
 *   cwd: absolute repository root.
 *   env: process environment.
 *
 * Returns:
 *   StagedCandidate: the frozen identity (checkoutDir not yet set).
 *
 * Throws:
 *   StagedCandidateBlockError: unmerged index, symlink, or submodule.
 *   UsageError: outside a git repository or on plumbing failure.
 */
export function freezeStagedCandidate(cwd: string, env: NodeJS.ProcessEnv): StagedCandidate {
  git(cwd, env, { args: ['rev-parse', '--git-dir'] });
  const scratchDir = mkdtempSync(join(tmpdir(), 'gateforge-staged-'));
  try {
    const indexPath = copyIndex(cwd, env, scratchDir);
    const treeId = writeTreeOfIndexCopy(cwd, env, indexPath);
    assertSupportedTree(cwd, env, treeId);
    const headSha = resolveSha(cwd, env, 'HEAD');
    const mergeHeadSha = resolveSha(cwd, env, 'MERGE_HEAD');
    const base = headSha ?? EMPTY_TREE_ID;
    const changed = parseNameStatus(
      git(cwd, env, {
        args: ['diff-index', '--cached', '--name-status', '-z', '-M', base],
        extraEnv: { GIT_INDEX_FILE: indexPath },
      }).stdout,
    );
    const changedPaths = normalizeChangedFiles(
      changed.flatMap((change) => (change.oldPath !== undefined ? [change.oldPath, change.path] : [change.path])),
    );
    return {
      treeId,
      headSha,
      mergeHeadSha,
      parentShas: mergeHeadSha !== null ? [headSha as string, mergeHeadSha] : headSha !== null ? [headSha] : [],
      changed,
      changedPaths,
      scratchDir,
      checkoutDir: null,
    };
  } catch (error) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Materializes an isolated checkout of the frozen tree (plan Phase 5
 * item 3): `git read-tree` + `git checkout-index` into a scratch
 * directory, then a throwaway Git repository is initialized inside it so
 * the regular gate pipeline (config load, input snapshot, run state) runs
 * against the staged bytes unchanged. The user's worktree/index/refs are
 * never modified.
 *
 * Args:
 *   cwd: absolute repository root the tree objects live in.
 *   env: process environment.
 *   frozen: the frozen candidate from {@link freezeStagedCandidate}.
 *
 * Returns:
 *   string: absolute path of the candidate checkout.
 */
export function materializeStagedCandidate(cwd: string, env: NodeJS.ProcessEnv, frozen: StagedCandidate): string {
  const checkoutDir = join(frozen.scratchDir, 'checkout');
  mkdirSync(checkoutDir, { recursive: true });
  const indexPath = join(frozen.scratchDir, 'staged-index');
  git(cwd, env, { args: ['read-tree', frozen.treeId], extraEnv: { GIT_INDEX_FILE: indexPath } });
  git(cwd, env, {
    args: ['checkout-index', '-a', '-f', '--prefix', `${checkoutDir}/`],
    extraEnv: { GIT_INDEX_FILE: indexPath },
  });
  // Throwaway repository so inventory-based machinery (ls-files, input
  // snapshot) sees exactly the staged bytes. Isolated config: no user
  // hooks/templates/system config can leak into the scratch repo.
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete childEnv['GIT_DIR'];
  delete childEnv['GIT_WORK_TREE'];
  delete childEnv['GIT_INDEX_FILE'];
  for (const args of [['init', '-q'], ['add', '-A']]) {
    const result = spawnSync('git', args, { cwd: checkoutDir, env: childEnv, encoding: 'buffer' });
    if (result.error !== undefined || result.status !== 0) {
      throw new UsageError(
        `staged candidate: preparing the isolated checkout failed (git ${args.join(' ')}, ` +
          `exit ${result.status ?? -1}): ${(result.stderr ?? Buffer.alloc(0)).toString('utf8').trim()}`,
      );
    }
  }
  frozen.checkoutDir = checkoutDir;
  return checkoutDir;
}

/**
 * Re-checks the candidate immediately before authorizing (plan Phase 5
 * item 4): recomputes the index tree from a FRESH copy of the user's
 * index and re-resolves HEAD/MERGE_HEAD. ANY drift is a typed block —
 * different bytes never receive authorization.
 *
 * Args:
 *   cwd: absolute repository root.
 *   env: process environment.
 *   frozen: the frozen candidate.
 *
 * Returns:
 *   {ok: true} | {ok: false, detail}: the typed recheck outcome.
 */
export function recheckStagedCandidate(
  cwd: string,
  env: NodeJS.ProcessEnv,
  frozen: StagedCandidate,
): { ok: true } | { ok: false; detail: string } {
  try {
    const freshIndex = join(frozen.scratchDir, 'recheck-index');
    const gitDir = git(cwd, env, { args: ['rev-parse', '--absolute-git-dir'] }).stdout.trim();
    const source = join(gitDir, 'index');
    if (existsSync(source)) {
      cpSync(source, freshIndex);
    } else {
      writeFileSync(freshIndex, Buffer.alloc(0));
    }
    const treeNow = writeTreeOfIndexCopy(cwd, env, freshIndex);
    const headNow = resolveSha(cwd, env, 'HEAD');
    const mergeNow = resolveSha(cwd, env, 'MERGE_HEAD');
    if (treeNow !== frozen.treeId || headNow !== frozen.headSha || mergeNow !== frozen.mergeHeadSha) {
      return {
        ok: false,
        detail:
          'the staged candidate changed during verification; re-run the gate ' +
          `(frozen tree ${frozen.treeId.slice(0, 12)} vs current ${treeNow.slice(0, 12)})`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof StagedCandidateBlockError) {
      return { ok: false, detail: `the staged candidate changed during verification; re-run the gate (${error.message})` };
    }
    return { ok: false, detail: `the staged candidate could not be re-checked: ${(error as Error).message}` };
  }
}

/**
 * Removes the candidate scratch directory (checkout + index copies).
 *
 * Args:
 *   frozen: the frozen candidate (idempotent).
 */
export function releaseStagedCandidate(frozen: StagedCandidate): void {
  rmSync(frozen.scratchDir, { recursive: true, force: true });
}

/**
 * Resolves the repository's hook directory (`core.hooksPath` honored via
 * `git rev-parse --git-path hooks`), as an absolute path.
 *
 * Args:
 *   cwd: repository root (relative hooksPath values resolve against it).
 *   env: process environment.
 *
 * Returns:
 *   string | null: absolute hooks directory, or null outside a repo.
 */
export function resolveHooksDir(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  if (value.length === 0) return null;
  return resolve(cwd, value);
}

/** The strict staged gate invocation hooks execute (same gate as CI). */
export const HOOK_GATE_COMMAND = 'check --staged --require-e2e';

/**
 * Builds the generated pre-commit hook script (plan Phase 5 items 1–2):
 * activates with `--gateforge-verify`, resolves the engine robustly
 * (repo-local node_modules/.bin, then PATH, then $GATEFORGE_CLI — a
 * missing engine BLOCKS the commit, fail closed), and execs the strict
 * staged gate (`check --staged --require-e2e`) — the same gate CI runs —
 * so the hook always gates the exact staged candidate. The script states
 * the honest standard-mode limit (ADR 0005 D1): `--no-verify` bypasses
 * the local hook.
 *
 * Returns:
 *   string: the hook script text (marker-delimited, POSIX sh).
 */
export function gateforgeHookScript(): string {
  return `\
${HOOK_MARKER_BEGIN}
# Generated by \`gateforge init --blocking\` (ADR 0005 D1/D3).
# Gates the EXACT staged candidate — never the working tree:
#   gateforge ${HOOK_GATE_COMMAND}
# freezes the index, materializes an isolated checkout of the staged
# bytes, and runs the same strict gate as CI against those bytes.
# Honest limit: \`git commit --no-verify\`, an alternate core.hooksPath,
# or direct Git plumbing bypasses this hook. Standard enforcement
# additionally requires the trusted server check; managed mode moves the
# authoritative commit outside the agent's write boundary.
# Engine resolution: repo-local node_modules/.bin, then PATH, then
# $GATEFORGE_CLI. A missing engine BLOCKS the commit (fail closed).
if [ "$1" = "${HOOK_VERIFY_ARG}" ]; then
  echo "gateforge: pre-commit hook active (staged-candidate gate)"
  exit 0
fi
GF_BIN=""
if [ -f "node_modules/.bin/gateforge" ]; then
  GF_BIN="node_modules/.bin/gateforge"
elif command -v gateforge >/dev/null 2>&1; then
  GF_BIN="gateforge"
fi
if [ -n "$GATEFORGE_CLI" ] && [ -x "$GATEFORGE_CLI" ]; then
  GF_BIN="$GATEFORGE_CLI"
fi
if [ -z "$GF_BIN" ]; then
  echo "gateforge: CLI engine not found (install gateforge, add node_modules, or set GATEFORGE_CLI) - commit blocked (fail closed)" >&2
  exit 1
fi
case "$GF_BIN" in
  */*) exec node "$GF_BIN" ${HOOK_GATE_COMMAND} ;;
  *)   exec "$GF_BIN" ${HOOK_GATE_COMMAND} ;;
esac
${HOOK_MARKER_END}
`;
}

/** Whether a hook file body carries the gateforge marker block. */
export function hasGateforgeMarker(body: string): boolean {
  return body.includes(HOOK_MARKER_BEGIN) && body.includes(HOOK_MARKER_END);
}

/**
 * Verifies hook ACTIVATION (plan Phase 5 item 1) beyond mere existence:
 * regular file, exec bit set, gateforge marker present, and the script
 * actually executes its verify mode (`--gateforge-verify`) successfully.
 *
 * Args:
 *   hookPath: absolute path of the pre-commit hook.
 *
 * Returns:
 *   {ok, detail}: the typed activation outcome.
 */
export function verifyHookActivation(hookPath: string): { ok: boolean; detail: string } {
  let body: string;
  try {
    body = readFileSync(hookPath, 'utf8');
  } catch (error) {
    return { ok: false, detail: `hook file '${hookPath}' is unreadable: ${(error as Error).message}` };
  }
  if (!hasGateforgeMarker(body)) {
    return { ok: false, detail: `hook '${hookPath}' does not carry the gateforge marker block` };
  }
  try {
    // owner/group/other execute — the exec bit git requires to run hooks.
    if ((statSync(hookPath).mode & 0o111) === 0) {
      return { ok: false, detail: `hook '${hookPath}' is not executable (missing exec bit)` };
    }
  } catch (error) {
    return { ok: false, detail: `hook '${hookPath}' could not be stat-ed: ${(error as Error).message}` };
  }
  const run = spawnSync(hookPath, [HOOK_VERIFY_ARG], { encoding: 'utf8', timeout: 10_000 });
  if (run.error !== undefined || run.status !== 0) {
    return {
      ok: false,
      detail:
        `hook '${hookPath}' did not execute its ${HOOK_VERIFY_ARG} check ` +
        `(exit ${run.status ?? -1}${run.error !== undefined ? `: ${run.error.message}` : ''})`,
    };
  }
  if (!(run.stdout ?? '').includes('gateforge: pre-commit hook active')) {
    return { ok: false, detail: `hook '${hookPath}' verify output missing (unexpected script content)` };
  }
  return { ok: true, detail: `hook '${hookPath}' is installed and active (exec bit + verified invocation)` };
}
