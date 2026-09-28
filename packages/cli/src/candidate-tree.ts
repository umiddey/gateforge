/**
 * Raw candidate-tree ingestion (plan 2026-09-19 Phase 3 item 6): the
 * immutable Git tree id of a workspace candidate, built from RAW BYTES
 * without ever running candidate-controlled Git machinery.
 *
 * Why raw: `git add -A` applies clean filters from the candidate's own
 * `.gitattributes`, honors candidate `core.hooksPath`, and follows the
 * ambient `GIT_*` environment — a hostile candidate can execute code or
 * rewrite bytes during authority ingestion. This module instead:
 *
 * - walks the workspace with the process filesystem (never `git add`,
 *   `git checkout`, `git diff`, or any hook-running porcelain);
 * - hashes each regular file with `git hash-object -w --stdin` (no
 *   `--path`, so no clean/smudge filter can apply) into the AUTHORITY
 *   object store selected by an explicit `--git-dir`;
 * - builds the tree with `git mktree -z` from NUL-delimited records;
 * - runs every Git child with a sanitized environment (ambient
 *   `GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_DIR`/object-directory/config
 *   overrides stripped) plus `--no-replace-objects`;
 * - rejects symlinks, submodules (nested `.git`), fifos/sockets/devices,
 *   and anything that is not a regular file — fail closed, never a
 *   silent omission.
 *
 * Shared by the broker (authority side) and `test-gates` sealing
 * (controller side binds the tested tree into the v2 receipt).
 */
import { lstatSync, opendirSync, readFileSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import {
  RuntimeReuseBoundaryError,
  type RuntimeReuseMount,
  validateRuntimeReuseMounts,
} from './runtime-reuse.js';

/** 40-char lowercase sha1 hex. */
const TREE_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Git environment keys that can redirect object-store writes, index
 * selection, work-tree resolution, or configuration. Stripped from every
 * child spawned here; the caller-supplied explicit `--git-dir` is the
 * only object-store selector.
 */
const STRIPPED_GIT_ENV = [
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_OBJECTS',
] as const;

/**
 * Builds the sanitized child environment for authority Git plumbing:
 * ambient redirectors stripped, everything else inherited.
 */
export function sanitizedAuthorityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env };
  for (const key of STRIPPED_GIT_ENV) delete child[key];
  child['GIT_OPTIONAL_LOCKS'] = '0';
  return child;
}

/** One included candidate-tree entry with its Git mode, blob id, and repo-relative path. */
export interface CandidateTreeEntry {
  /** `100644` or `100755` (executability preserved, like `git add`). */
  mode: string;
  /** 40-char blob id. */
  sha: string;
  /** Repo-relative posix path. */
  path: string;
}

/** Candidate-tree id and the entries used to build it. */
export interface CandidateTreeSnapshot {
  /** 40-character immutable Git tree id. */
  treeId: string;
  /** Sorted file entries included in the tree. */
  entries: CandidateTreeEntry[];
}

/**
 * Resolves the absolute git dir of the repository at `cwd`.
 *
 * Returns:
 *   string | null: absolute git dir, or null when `cwd` is not inside a
 *   Git work tree (a non-git workspace seals `candidateTreeId: null`).
 */
export function resolveGitDir(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--absolute-git-dir'], {
    cwd,
    env: sanitizedAuthorityEnv(env),
    encoding: 'utf8',
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const dir = (result.stdout ?? '').trim().split('\n')[0] ?? '';
  return dir.length > 0 ? dir : null;
}

/**
 * Runs one Git plumbing command against an explicit object store.
 */
function plumbing(
  gitDir: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  input?: string | Buffer,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', ['--git-dir', gitDir, '--no-replace-objects', ...args], {
    env: sanitizedAuthorityEnv(env),
    encoding: 'buffer',
    input: input as unknown as string,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new UsageError(`candidate tree ingestion: cannot run git: ${(result.error as Error).message}`);
  }
  return {
    status: result.status ?? -1,
    stdout: (result.stdout ?? Buffer.alloc(0)).toString('utf8'),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString('utf8'),
  };
}

/**
 * Collects raw tree entries by walking the workspace, excluding run state
 * and approved documentation/cache paths. Rejects anything that is not a
 * regular file.
 *
 * Args:
 *   gitDir: authority object store used to hash tree entries.
 *   env: sanitized child-process environment.
 *   workspace: absolute candidate root.
 *   excludeDir: absolute run-state path, if any.
 *   symlinks: reject or record symlink entries.
 *   reuseMounts: explicitly approved runtime dependency mounts.
 *   docsExclusions: approved documentation directories.
 *   cacheExclusions: exact approved Python bytecode files.
 *
 * Returns:
 *   CandidateTreeEntry[]: raw candidate entries after approved exclusions.
 *
 * Throws:
 *   UsageError: unreadable directories or unsupported entries.
 */
function collectEntries(
  gitDir: string,
  env: NodeJS.ProcessEnv,
  workspace: string,
  excludeDir: string | null,
  symlinks: 'reject' | 'record',
  reuseMounts: readonly RuntimeReuseMount[],
  docsExclusions: readonly string[],
  cacheExclusions: readonly string[],
): CandidateTreeEntry[] {
  // Repo-relative posix prefix of the excluded output tree (null = none).
  // Only a directory strictly INSIDE the workspace can be excluded; an
  // outside state dir excludes nothing (prefix never matches).
  let excludePrefix: string | null = null;
  if (excludeDir !== null) {
    const rel = excludeDir.split('\\').join('/').replace(/\/+$/, '');
    const root = workspace.split('\\').join('/').replace(/\/+$/, '');
    if (rel === root) {
      throw new UsageError('candidate tree ingestion: the run-state directory is the workspace root (fail closed)');
    }
    if (rel.startsWith(`${root}/`)) excludePrefix = rel.slice(root.length + 1);
  }
  const excluded = (rel: string): boolean =>
    (excludePrefix !== null && (rel === excludePrefix || rel.startsWith(`${excludePrefix}/`))) ||
    docsExclusions.some((folder) => rel === folder || rel.startsWith(`${folder}/`)) ||
    cacheExclusions.includes(rel);
  const inspectExcludedDirectory = (directory: string, relativeDirectory: string): void => {
    let handle;
    try {
      handle = opendirSync(directory);
    } catch (error) {
      throw new UsageError(
        `candidate tree ingestion: cannot inspect approved documentation folder '${relativeDirectory}': ${(error as Error).message}`,
      );
    }
    try {
      let dirent;
      while ((dirent = handle.readSync()) !== null) {
        const relativePath = `${relativeDirectory}/${dirent.name}`;
        const absolute = join(directory, dirent.name);
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          throw new UsageError(`candidate tree ingestion: approved documentation folder contains symlink '${relativePath}' (fail closed)`);
        }
        if (stat.isDirectory()) {
          inspectExcludedDirectory(absolute, relativePath);
        } else if (!stat.isFile()) {
          throw new UsageError(`candidate tree ingestion: approved documentation folder contains unsupported entry '${relativePath}' (fail closed)`);
        }
      }
    } finally {
      handle.closeSync();
    }
  };
  const entries: CandidateTreeEntry[] = [];
  const stack: Array<{ dir: string; rel: string }> = [{ dir: workspace, rel: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (excluded(current.rel)) continue;
    let handle;
    try {
      handle = opendirSync(current.dir);
    } catch (error) {
      throw new UsageError(
        `candidate tree ingestion: cannot read directory '${current.rel || '.'}': ${(error as Error).message}`,
      );
    }
    try {
      let dirent;
      while ((dirent = handle.readSync()) !== null) {
        const name = dirent.name;
        if (name === '.' || name === '..') continue;
        const rel = current.rel.length > 0 ? `${current.rel}/${name}` : name;
        const absolute = join(current.dir, name);
        if (current.rel === '' && name === '.git') continue;
        if (name === '.git') {
          throw new UsageError(
            `candidate tree ingestion: nested '.git' at '${rel}' — submodule candidates cannot be verified (fail closed)`,
          );
        }
        let stat;
        try {
          stat = lstatSync(absolute);
        } catch (error) {
          throw new UsageError(
            `candidate tree ingestion: cannot inspect '${rel}': ${(error as Error).message}`,
          );
        }
        if (cacheExclusions.includes(rel)) {
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new UsageError(`candidate tree ingestion: approved Python bytecode exclusion '${rel}' is not a regular file (fail closed)`);
          }
          continue;
        }
        if (docsExclusions.includes(rel)) {
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new UsageError(`candidate tree ingestion: approved documentation exclusion '${rel}' is not a real directory (fail closed)`);
          }
          inspectExcludedDirectory(absolute, rel);
          continue;
        }
        if (stat.isSymbolicLink()) {
          const reuseMount = reuseMounts.find((mount) => mount.path === rel);
          if (reuseMount !== undefined) {
            // The external dependency bytes are bound by the reuse digest.
            // Keep only a stable marker here, never the absolute link target.
            const marker = `gateforge-runtime-reuse-mount:v1:${rel}`;
            const hashed = plumbing(gitDir, env, ['hash-object', '-w', '--stdin'], Buffer.from(marker, 'utf8'));
            if (hashed.status !== 0) {
              throw new UsageError(`candidate tree ingestion: hash-object failed for runtime reuse mount '${rel}'`);
            }
            const mountSha = hashed.stdout.trim();
            if (!TREE_PATTERN.test(mountSha)) {
              throw new UsageError(`candidate tree ingestion: hash-object returned an unusable id for '${rel}'`);
            }
            entries.push({ mode: '120000', sha: mountSha, path: rel });
            continue;
          }
          if (symlinks === 'reject') {
            throw new UsageError(
              `candidate tree ingestion: symlink at '${rel}' — symlink candidates cannot be verified (fail closed)`,
            );
          }
          // Faithful git semantics (like `git add`): a symlink is a
          // 120000 blob whose bytes are the link-target string. Never
          // followed, never resolved — the target string is the identity.
          let target: string;
          try {
            target = readlinkSync(absolute);
          } catch (error) {
            throw new UsageError(
              `candidate tree ingestion: cannot read symlink '${rel}': ${(error as Error).message}`,
            );
          }
          const hashed = plumbing(gitDir, env, ['hash-object', '-w', '--stdin'], Buffer.from(target, 'utf8'));
          if (hashed.status !== 0) {
            throw new UsageError(`candidate tree ingestion: hash-object failed for '${rel}': ${hashed.stderr.trim()}`);
          }
          const linkSha = hashed.stdout.trim();
          if (!TREE_PATTERN.test(linkSha)) {
            throw new UsageError(`candidate tree ingestion: hash-object returned an unusable id for '${rel}'`);
          }
          entries.push({ mode: '120000', sha: linkSha, path: rel });
          continue;
        }
        if (stat.isDirectory()) {
          stack.push({ dir: absolute, rel });
          continue;
        }
        if (!stat.isFile()) {
          throw new UsageError(
            `candidate tree ingestion: unsupported entry at '${rel}' — only regular files can be verified (fail closed)`,
          );
        }
        let bytes: Buffer;
        try {
          bytes = readFileSync(absolute);
        } catch (error) {
          throw new UsageError(
            `candidate tree ingestion: cannot read '${rel}': ${(error as Error).message}`,
          );
        }
        const hashed = plumbing(gitDir, env, ['hash-object', '-w', '--stdin'], bytes);
        if (hashed.status !== 0) {
          throw new UsageError(`candidate tree ingestion: hash-object failed for '${rel}': ${hashed.stderr.trim()}`);
        }
        const sha = hashed.stdout.trim();
        if (!TREE_PATTERN.test(sha)) {
          throw new UsageError(`candidate tree ingestion: hash-object returned an unusable id for '${rel}'`);
        }
        entries.push({
          mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
          sha,
          path: rel,
        });
      }
    } finally {
      handle.closeSync();
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Builds one tree object from direct children (blobs + subtrees).
 */
function buildLevel(
  gitDir: string,
  env: NodeJS.ProcessEnv,
  children: Array<{ mode: string; sha: string; name: string }>,
): string {
  const sorted = [...children].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = sorted
    .map((child) => {
      const kind = child.mode === '040000' ? 'tree' : 'blob';
      return `${child.mode} ${kind} ${child.sha}\t${child.name}\0`;
    })
    .join('');
  const built = plumbing(gitDir, env, ['mktree', '-z'], Buffer.from(lines, 'utf8'));
  if (built.status !== 0) {
    throw new UsageError(`candidate tree ingestion: mktree failed: ${built.stderr.trim()}`);
  }
  const treeId = built.stdout.trim();
  if (!TREE_PATTERN.test(treeId)) {
    throw new UsageError('candidate tree ingestion: mktree returned an unusable tree id');
  }
  return treeId;
}

/**
 * Computes the immutable tree id of a workspace candidate from raw bytes.
 *
 * Args:
 *   gitDir: absolute git dir of the authority object store.
 *   workspace: absolute workspace path.
 *   env: process environment, sanitized for child processes.
 *   excludeDir: optional run-state output directory excluded from the tree.
 *   symlinks: whether to reject or record symlink entries.
 *   reuseMounts: approved runtime dependency mounts.
 *   docsExclusions: owner-approved documentation folders to omit.
 *   cacheExclusions: exact owner-approved Python bytecode files to omit.
 *
 * Returns:
 *   string: 40-character Git tree id.
 */
export function computeCandidateTreeId(
  gitDir: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  excludeDir?: string | null,
  symlinks: 'reject' | 'record' = 'reject',
  reuseMounts: readonly RuntimeReuseMount[] = [],
  docsExclusions: readonly string[] = [],
  cacheExclusions: readonly string[] = [],
): string {
  return computeCandidateTree(
    gitDir,
    workspace,
    env,
    excludeDir ?? null,
    symlinks,
    reuseMounts,
    docsExclusions,
    cacheExclusions,
    false,
  );
}

/**
 * Computes the immutable tree id and returns the entries from that same walk.
 *
 * Args:
 *   gitDir: absolute git dir of the authority object store.
 *   workspace: absolute workspace path.
 *   env: process environment, sanitized for child processes.
 *   excludeDir: optional run-state output directory excluded from the tree.
 *   symlinks: whether to reject or record symlink entries.
 *   reuseMounts: approved runtime dependency mounts.
 *   docsExclusions: owner-approved documentation folders to omit.
 *   cacheExclusions: exact owner-approved Python bytecode files to omit.
 *
 * Returns:
 *   CandidateTreeSnapshot: tree id and the sorted entries used to build it.
 */
export function computeCandidateTreeSnapshot(
  gitDir: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  excludeDir?: string | null,
  symlinks: 'reject' | 'record' = 'reject',
  reuseMounts: readonly RuntimeReuseMount[] = [],
  docsExclusions: readonly string[] = [],
  cacheExclusions: readonly string[] = [],
): CandidateTreeSnapshot {
  return computeCandidateTree(
    gitDir,
    workspace,
    env,
    excludeDir ?? null,
    symlinks,
    reuseMounts,
    docsExclusions,
    cacheExclusions,
    true,
  );
}

/**
 * Builds the candidate tree and avoids the snapshot allocation for id-only callers.
 *
 * Args:
 *   gitDir: absolute git dir of the authority object store.
 *   workspace: absolute workspace path.
 *   env: process environment, sanitized for child processes.
 *   excludeDir: optional run-state output directory excluded from the tree.
 *   symlinks: whether to reject or record symlink entries.
 *   reuseMounts: approved runtime dependency mounts.
 *   docsExclusions: owner-approved documentation folders to omit.
 *   cacheExclusions: exact approved Python bytecode files to omit.
 *   includeEntries: whether to return the entries used by the tree walk.
 *
 * Returns:
 *   string | CandidateTreeSnapshot: tree id, with entries when requested.
 *
 * Throws:
 *   UsageError: on plumbing failures or unsupported entries (fail closed).
 */
function computeCandidateTree(
  gitDir: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  excludeDir: string | null,
  symlinks: 'reject' | 'record',
  reuseMounts: readonly RuntimeReuseMount[],
  docsExclusions: readonly string[],
  cacheExclusions: readonly string[],
  includeEntries: false,
): string;
function computeCandidateTree(
  gitDir: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  excludeDir: string | null,
  symlinks: 'reject' | 'record',
  reuseMounts: readonly RuntimeReuseMount[],
  docsExclusions: readonly string[],
  cacheExclusions: readonly string[],
  includeEntries: true,
): CandidateTreeSnapshot;
function computeCandidateTree(
  gitDir: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  excludeDir: string | null,
  symlinks: 'reject' | 'record',
  reuseMounts: readonly RuntimeReuseMount[],
  docsExclusions: readonly string[],
  cacheExclusions: readonly string[],
  includeEntries: boolean,
): string | CandidateTreeSnapshot {
  try {
    validateRuntimeReuseMounts(workspace, reuseMounts);
  } catch (error) {
    throw new UsageError(
      error instanceof RuntimeReuseBoundaryError
        ? `candidate tree ingestion: ${error.message}`
        : `candidate tree ingestion: runtime reuse boundary validation failed`,
    );
  }
  const entries = collectEntries(
    gitDir,
    env,
    workspace,
    excludeDir,
    symlinks,
    reuseMounts,
    docsExclusions,
    cacheExclusions,
  );
  // Group by parent directory; build deepest-first so every subtree id
  // exists before its parent references it (mimics `git write-tree`).
  const filesByDir = new Map<string, CandidateTreeEntry[]>();
  const subdirsByDir = new Map<string, Set<string>>();
  const allDirs = new Set<string>(['']);
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const dir = slash < 0 ? '' : entry.path.slice(0, slash);
    const list = filesByDir.get(dir) ?? [];
    list.push(entry);
    filesByDir.set(dir, list);
    allDirs.add(dir);
    let cursor = dir;
    while (cursor !== '') {
      const parentSlash = cursor.lastIndexOf('/');
      const parent = parentSlash < 0 ? '' : cursor.slice(0, parentSlash);
      const name = parentSlash < 0 ? cursor : cursor.slice(parentSlash + 1);
      const set = subdirsByDir.get(parent) ?? new Set<string>();
      set.add(name);
      subdirsByDir.set(parent, set);
      allDirs.add(parent);
      cursor = parent;
    }
  }
  const treeByDir = new Map<string, string>();
  const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
  const ordered = [...allDirs].sort((a, b) => depthOf(b) - depthOf(a));
  for (const dir of ordered) {
    const children: Array<{ mode: string; sha: string; name: string }> = [];
    for (const file of filesByDir.get(dir) ?? []) {
      const slash = file.path.lastIndexOf('/');
      const name = slash < 0 ? file.path : file.path.slice(slash + 1);
      children.push({ mode: file.mode, sha: file.sha, name });
    }
    for (const name of subdirsByDir.get(dir) ?? []) {
      const childDir = dir === '' ? name : `${dir}/${name}`;
      const sha = treeByDir.get(childDir);
      if (sha === undefined) {
        throw new UsageError(`candidate tree ingestion: missing subtree for '${childDir}' (fail closed)`);
      }
      children.push({ mode: '040000', sha, name });
    }
    treeByDir.set(dir, buildLevel(gitDir, env, children));
  }
  const treeId = treeByDir.get('') ?? '';
  if (!TREE_PATTERN.test(treeId)) {
    throw new UsageError('candidate tree ingestion: failed to build the root tree (fail closed)');
  }
  const kind = plumbing(gitDir, env, ['cat-file', '-t', treeId]);
  if (kind.status !== 0 || kind.stdout.trim() !== 'tree') {
    throw new UsageError('candidate tree ingestion: pinned object is not a tree (fail closed)');
  }
  return includeEntries ? { treeId, entries } : treeId;
}
