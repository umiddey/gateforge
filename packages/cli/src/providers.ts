/**
 * Changed-file providers (architecture contract 5 / pin #5).
 *
 * The three diff providers share one identity surface with the core
 * fixture harness's `ChangedFileProvider`:
 *
 * - `local-staged`: `git diff --cached --name-only` — the staged index
 *   vs HEAD.
 * - `github-pr`: `GITHUB_BASE_REF` (base branch name) → merge-base diff
 *   `git merge-base HEAD <base>` then `git diff --name-only <base> HEAD`.
 * - `gitlab-mr`: `CI_MERGE_REQUEST_DIFF_BASE_SHA` → `git diff --name-only
 *   <base sha> HEAD`.
 *
 * `auto` (config default) picks github-pr when `GITHUB_BASE_REF` is set,
 * gitlab-mr when `CI_MERGE_REQUEST_DIFF_BASE_SHA` is set, else
 * local-staged. All outputs are normalized (posix, deduplicated, sorted)
 * via `normalizeChangedFiles` so GF-09 parity compares identical sets.
 * The provider environment is threaded into every git invocation, so
 * fixture tests control GIT_* variables exactly like anything else.
 */
import { spawnSync } from 'node:child_process';
import { normalizeChangedFiles, type ChangedFileProvider, type ChangedProvider } from '@gateforge/core';
import { UsageError } from './errors.js';

/** git flags keeping invocations deterministic and config-independent. */
const GIT_FLAGS = [
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
];

/**
 * Runs one git command in `cwd`; returns stdout trimmed, or throws a
 * UsageError naming the command and stderr when it fails.
 */
function gitOutput(
  cwd: string,
  args: readonly string[],
  context: string,
  env: NodeJS.ProcessEnv,
): string {
  const result = spawnSync('git', [...GIT_FLAGS, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new UsageError(`${context}: cannot run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    throw new UsageError(
      `${context}: git ${args.join(' ')} failed (exit ${result.status ?? -1})` +
        (stderr.length > 0 ? `: ${stderr.split('\n')[0] ?? ''}` : ''),
    );
  }
  return (result.stdout ?? '').trim();
}

/** Local staged-diff provider: `git diff --cached --name-only` (pin #5). */
export function localStagedProvider(cwd: string, env: NodeJS.ProcessEnv): ChangedFileProvider {
  return {
    provider: 'local-staged',
    changedFiles: () => {
      const out = gitOutput(cwd, ['diff', '--cached', '--name-only'], 'local-staged provider', env);
      return normalizeChangedFiles(out.length > 0 ? out.split('\n') : []);
    },
  };
}

/** GitHub Actions merge-base diff provider (`GITHUB_BASE_REF`, pin #5). */
export function githubPrProvider(cwd: string, env: NodeJS.ProcessEnv): ChangedFileProvider {
  return {
    provider: 'github-pr',
    changedFiles: () => {
      const baseRef = env['GITHUB_BASE_REF'];
      if (baseRef === undefined || baseRef.length === 0) {
        throw new UsageError(
          'github-pr provider requires GITHUB_BASE_REF (base branch name) in the environment',
        );
      }
      const mergeBase = gitOutput(
        cwd,
        ['merge-base', 'HEAD', baseRef],
        `github-pr provider (merge-base HEAD ${baseRef})`,
        env,
      );
      const out = gitOutput(
        cwd,
        ['diff', '--name-only', mergeBase, 'HEAD'],
        `github-pr provider (diff ${mergeBase}..HEAD)`,
        env,
      );
      return normalizeChangedFiles(out.length > 0 ? out.split('\n') : []);
    },
  };
}

/** GitLab merge-request diff provider (`CI_MERGE_REQUEST_DIFF_BASE_SHA`). */
export function gitlabMrProvider(cwd: string, env: NodeJS.ProcessEnv): ChangedFileProvider {
  return {
    provider: 'gitlab-mr',
    changedFiles: () => {
      const baseSha = env['CI_MERGE_REQUEST_DIFF_BASE_SHA'];
      if (baseSha === undefined || baseSha.length === 0) {
        throw new UsageError(
          'gitlab-mr provider requires CI_MERGE_REQUEST_DIFF_BASE_SHA in the environment',
        );
      }
      const out = gitOutput(
        cwd,
        ['diff', '--name-only', baseSha, 'HEAD'],
        `gitlab-mr provider (diff ${baseSha}..HEAD)`,
        env,
      );
      return normalizeChangedFiles(out.length > 0 ? out.split('\n') : []);
    },
  };
}

/** Builds one provider implementation by identity. */
export function providerFor(
  provider: ChangedProvider,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChangedFileProvider {
  switch (provider) {
    case 'local-staged':
      return localStagedProvider(cwd, env);
    case 'github-pr':
      return githubPrProvider(cwd, env);
    case 'gitlab-mr':
      return gitlabMrProvider(cwd, env);
    case 'all-files':
      return { provider: 'all-files', changedFiles: () => [] };
  }
}

/**
 * Resolves the configured provider selection against the environment:
 * `auto` prefers CI providers when their variables are present (GHA, then
 * GitLab), else the local staged diff.
 *
 * Args:
 *   configured: `changed.provider` from `.gateforge.yml`.
 *   cwd: repo root.
 *   env: process environment.
 *
 * Returns:
 *   ChangedFileProvider: the resolved provider.
 */
export function resolveProvider(
  configured: 'auto' | ChangedProvider,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChangedFileProvider {
  let identity: ChangedProvider;
  if (configured === 'auto') {
    if (env['GITHUB_BASE_REF'] !== undefined && env['GITHUB_BASE_REF'].length > 0) {
      identity = 'github-pr';
    } else if (
      env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] !== undefined &&
      env['CI_MERGE_REQUEST_DIFF_BASE_SHA'].length > 0
    ) {
      identity = 'gitlab-mr';
    } else {
      identity = 'local-staged';
    }
  } else {
    identity = configured;
  }
  return providerFor(identity, cwd, env);
}