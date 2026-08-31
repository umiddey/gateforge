/**
 * Temporary git repository builder (fixture harness, G7).
 *
 * Creates throwaway git repositories under the OS tmpdir for adversarial
 * fixtures (GF-01..GF-24). Everything runs offline through `child_process`
 * git: no network, no wall-clock-dependent output, no reliance on the
 * developer's git configuration. Author/committer identity and both dates
 * are pinned to fixed values, so identical file-tree specs produce
 * byte-identical commit SHAs across machines — fixtures may assert on SHAs.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The fixed timestamp (git raw-date form) stamped onto every commit as
 * both author and committer date. Determinism cornerstone: change it and
 * every fixture SHA changes.
 */
export const FIXED_GIT_DATE = '2026-01-01T00:00:00+0000';

/** Fixed author/committer identity for fixture commits. */
const FIXED_IDENTITY = {
  GIT_AUTHOR_NAME: 'gateforge fixtures',
  GIT_AUTHOR_EMAIL: 'fixtures@gateforge.invalid',
  GIT_COMMITTER_NAME: 'gateforge fixtures',
  GIT_COMMITTER_EMAIL: 'fixtures@gateforge.invalid',
};

/** Flags stripping every source of nondeterminism from the git invocation. */
const FIXED_FLAGS = [
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'gc.auto=0',
];

/** Result of one git invocation. */
export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Options for {@link TempRepo} construction. */
export interface TempRepoOptions {
  /** Files written before the first command runs (repo-root-relative, posix keys). */
  files?: Record<string, string>;
  /** Initial branch name. Default `main`. */
  branch?: string;
  /** tmpdir prefix. Default `gateforge-fixture-`. */
  prefix?: string;
}

/**
 * A disposable git repository under the OS tmpdir.
 *
 * Args:
 *   options: optional initial file tree, branch name, and tmpdir prefix.
 *
 * Returns:
 *   TempRepo: use `writeFiles`/`stage`/`commit` to build history,
 *   `cleanup` (or {@link withTempRepo}) to remove it.
 */
export class TempRepo {
  /** Absolute filesystem path of the repository root. */
  readonly root: string;

  private readonly gitEnv: NodeJS.ProcessEnv;

  constructor(options: TempRepoOptions = {}) {
    this.root = mkdtempSync(join(tmpdir(), options.prefix ?? 'gateforge-fixture-'));
    // GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_NOSYSTEM=1 insulate fixtures
    // from user/system git config (hooks, signing, identity defaults).
    this.gitEnv = {
      ...process.env,
      ...FIXED_IDENTITY,
      GIT_AUTHOR_DATE: FIXED_GIT_DATE,
      GIT_COMMITTER_DATE: FIXED_GIT_DATE,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    this.git(['init', '--initial-branch', options.branch ?? 'main', '--quiet']);
    if (options.files !== undefined) this.writeFiles(options.files);
  }

  /**
   * Runs one git command in the repository.
   *
   * Args:
   *   args: argument vector (without the `git` binary).
   *   allowFailure: when true a non-zero exit does not throw.
   *
   * Returns:
   *   GitResult: exit status plus captured stdout/stderr.
   * @throws Error naming the failing command when `allowFailure` is false.
   */
  git(args: string[], { allowFailure = false }: { allowFailure?: boolean } = {}): GitResult {
    const result = spawnSync('git', [...FIXED_FLAGS, ...args], {
      cwd: this.root,
      env: this.gitEnv,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!allowFailure && result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed (exit ${result.status}) in ${this.root}\n` +
          `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  /**
   * Writes a file-tree spec into the repository. Keys are
   * repo-root-relative posix paths; parent directories are created.
   *
   * Args:
   *   files: mapping of relative posix path to UTF-8 file content.
   * @throws Error on absolute paths or `..` segments (spec writers must
   *   stay inside the repo).
   */
  writeFiles(files: Record<string, string>): void {
    for (const [rawKey, content] of Object.entries(files)) {
      const key = rawKey.split('\\').join('/');
      if (key.startsWith('/') || key.split('/').includes('..')) {
        throw new Error(`file-tree spec key escapes the repo root: '${rawKey}'`);
      }
      const absolute = join(this.root, ...key.split('/'));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }
  }

  /**
   * Stages files. With no argument stages every change (`git add -A`).
   *
   * Args:
   *   paths: repo-root-relative paths to stage.
   */
  stage(paths?: string[]): void {
    this.git(['add', ...(paths ?? ['-A'])]);
  }

  /**
   * Commits the staged tree with a fixed identity and date.
   *
   * Args:
   *   message: commit message.
   * Returns:
   *   string: the resulting HEAD sha (40-char hex).
   */
  commit(message: string): string {
    this.git(['commit', '--no-gpg-sign', '--allow-empty', '--quiet', '-m', message]);
    const sha = this.headSha();
    if (sha === null) throw new Error('commit succeeded but HEAD is unborn');
    return sha;
  }

  /**
   * Writes files, stages everything, and commits — the common fixture beat.
   *
   * Args:
   *   files: file-tree spec to write before staging.
   *   message: commit message.
   * Returns:
   *   string: the resulting HEAD sha.
   */
  commitFiles(files: Record<string, string>, message: string): string {
    this.writeFiles(files);
    this.stage();
    return this.commit(message);
  }

  /**
   * Reads the current HEAD sha.
   *
   * Returns:
   *   string | null: 40-char hex sha, or null while the branch is unborn.
   */
  headSha(): string | null {
    const result = this.git(['rev-parse', 'HEAD'], { allowFailure: true });
    return result.status === 0 ? result.stdout.trim() : null;
  }

  /**
   * Lists currently staged (index vs HEAD) files — what the real
   * `local-staged` changed-file provider would report (pin #5).
   *
   * Returns:
   *   string[]: repo-root-relative posix paths (possibly empty).
   */
  stagedFiles(): string[] {
    const result = this.git(['diff', '--cached', '--name-only']);
    return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /**
   * Resolves a repo-root-relative posix path to an absolute path.
   *
   * Args:
   *   relativePath: posix path relative to the repository root.
   */
  path(relativePath: string): string {
    return join(this.root, ...relativePath.split('/'));
  }

  /**
   * Removes the repository. Idempotent; safe to call more than once.
   */
  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

/**
 * Runs a fixture body against a fresh {@link TempRepo}, cleaning up on
 * every path (sync throw, async rejection, success).
 *
 * Args:
 *   options: TempRepo construction options.
 *   body: receives the repo; may be async.
 *
 * Returns:
 *   The body's return value (awaited when async).
 */
export function withTempRepo<T>(
  options: TempRepoOptions,
  body: (repo: TempRepo) => T,
): T | Promise<T> {
  const repo = new TempRepo(options);
  let result: T;
  try {
    result = body(repo);
  } catch (error) {
    repo.cleanup();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(() => repo.cleanup());
  }
  repo.cleanup();
  return result;
}
