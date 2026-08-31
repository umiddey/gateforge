import type { ChangedProvider } from '../schemas/run-manifest.js';
import type { TempRepo } from './temp-repo.js';
/**
 * Runs `body` with a patched `process.env`, restoring the previous
 * environment on every path (sync throw, async rejection, success).
 * A `undefined` value deletes the variable for the body's duration.
 *
 * Args:
 *   vars: variable name to value (or undefined to unset).
 *   body: closure to run under the patched environment; may be async.
 *
 * Returns:
 *   The body's return value (awaited when async).
 */
export declare function withEnv<V>(vars: Record<string, string | undefined>, body: () => V): V;
/**
 * Minimal changed-file provider surface (pin #5 of architecture
 * contracts). The real providers live with the CLI; fixtures consume
 * this shape so parity tests run against both halves.
 */
export interface ChangedFileProvider {
    /** Provider identity stamped into the run manifest (pin #4). */
    provider: ChangedProvider;
    /**
     * Repo-root-relative posix paths, deduplicated and codepoint-sorted.
     */
    changedFiles(): string[];
}
/**
 * Normalizes a changed-file list: posix separators, deduplicated,
 * codepoint-sorted. Provider outputs are compared as sets by GF-09.
 *
 * Args:
 *   files: raw provider output.
 *
 * Returns:
 *   string[]: canonical form.
 */
export declare function normalizeChangedFiles(files: string[]): string[];
/**
 * Builds a fake changed-file provider from an explicit list — the CI
 * stand-in (`github-pr` / `gitlab-mr` merge-base diff) and the
 * `all-files` full-scan provider for fixtures. The list is snapshotted
 * (defensive copy + normalization) at construction.
 *
 * Args:
 *   provider: provider identity this fake impersonates.
 *   files: raw changed-file list.
 *
 * Returns:
 *   ChangedFileProvider: deterministic, offline, network-free.
 */
export declare function fakeProvider(provider: ChangedProvider, files: string[]): ChangedFileProvider;
/**
 * Real `local-staged` provider over a {@link TempRepo}: reads the
 * repository's actual index (`git diff --cached --name-only`) at call
 * time, so fixtures exercise the genuine local half of GF-09 parity.
 *
 * Args:
 *   repo: the fixture repository.
 *
 * Returns:
 *   ChangedFileProvider: staged files, freshly read on every call.
 */
export declare function localStagedProvider(repo: TempRepo): ChangedFileProvider;
//# sourceMappingURL=env.d.ts.map