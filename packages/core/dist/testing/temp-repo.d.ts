/**
 * The fixed timestamp (git raw-date form) stamped onto every commit as
 * both author and committer date. Determinism cornerstone: change it and
 * every fixture SHA changes.
 */
export declare const FIXED_GIT_DATE = "2026-01-01T00:00:00+0000";
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
export declare class TempRepo {
    /** Absolute filesystem path of the repository root. */
    readonly root: string;
    private readonly gitEnv;
    constructor(options?: TempRepoOptions);
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
    git(args: string[], { allowFailure }?: {
        allowFailure?: boolean;
    }): GitResult;
    /**
     * Writes a file-tree spec into the repository. Keys are
     * repo-root-relative posix paths; parent directories are created.
     *
     * Args:
     *   files: mapping of relative posix path to UTF-8 file content.
     * @throws Error on absolute paths or `..` segments (spec writers must
     *   stay inside the repo).
     */
    writeFiles(files: Record<string, string>): void;
    /**
     * Stages files. With no argument stages every change (`git add -A`).
     *
     * Args:
     *   paths: repo-root-relative paths to stage.
     */
    stage(paths?: string[]): void;
    /**
     * Commits the staged tree with a fixed identity and date.
     *
     * Args:
     *   message: commit message.
     * Returns:
     *   string: the resulting HEAD sha (40-char hex).
     */
    commit(message: string): string;
    /**
     * Writes files, stages everything, and commits — the common fixture beat.
     *
     * Args:
     *   files: file-tree spec to write before staging.
     *   message: commit message.
     * Returns:
     *   string: the resulting HEAD sha.
     */
    commitFiles(files: Record<string, string>, message: string): string;
    /**
     * Reads the current HEAD sha.
     *
     * Returns:
     *   string | null: 40-char hex sha, or null while the branch is unborn.
     */
    headSha(): string | null;
    /**
     * Lists currently staged (index vs HEAD) files — what the real
     * `local-staged` changed-file provider would report (pin #5).
     *
     * Returns:
     *   string[]: repo-root-relative posix paths (possibly empty).
     */
    stagedFiles(): string[];
    /**
     * Resolves a repo-root-relative posix path to an absolute path.
     *
     * Args:
     *   relativePath: posix path relative to the repository root.
     */
    path(relativePath: string): string;
    /**
     * Removes the repository. Idempotent; safe to call more than once.
     */
    cleanup(): void;
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
export declare function withTempRepo<T>(options: TempRepoOptions, body: (repo: TempRepo) => T): T | Promise<T>;
//# sourceMappingURL=temp-repo.d.ts.map