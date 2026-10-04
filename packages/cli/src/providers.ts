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
import { normalizeChangedFiles, type ChangedFileProvider, type ChangedProvider, type GateforgeConfig } from '@gate-forge/core';
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
/**
 * The CI merge-request scope preflight (the `auto` provider's silent
 * zero-diff case).
 *
 * In a merge-request pipeline the `auto` provider prefers the platform
 * diff, and falls back to the LOCAL staged diff when the platform
 * exposes no base commit. In a CI job nothing is staged, so
 * `--scope changed` quietly grades ZERO changed files — the whole
 * pipeline then runs for the better part of an hour and fails on debt
 * that was never in the change. The fix is not a better fallback but an
 * honest refusal, in seconds, before anything is spawned.
 *
 * It speaks ONLY in that exact case: an explicitly configured provider
 * is the owner's decision, a pipeline that is not a merge request has
 * no base commit to ask for, a base commit that IS present resolves
 * properly, and a local run is untouched.
 *
 * Args:
 *   config: the trusted config (only `changed.provider` is consulted).
 *   env: the process environment.
 *
 * Returns:
 *   string | null: the refusal message, or null when the run may proceed.
 */
export function mergeRequestScopePreflight(
  config: Pick<GateforgeConfig, 'changed'>,
  env: NodeJS.ProcessEnv,
): string | null {
  if (config.changed.provider !== 'auto') return null;
  if (env['CI'] !== 'true') return null;
  const mergeRequest =
    (env['CI_MERGE_REQUEST_IID'] ?? '').length > 0 || env['GITHUB_EVENT_NAME'] === 'pull_request';
  if (!mergeRequest) return null;
  const baseAvailable =
    (env['GITHUB_BASE_REF'] ?? '').length > 0 ||
    (env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] ?? '').length > 0;
  if (baseAvailable) return null;
  return (
    'CI merge-request pipeline without a base commit: set CI_MERGE_REQUEST_DIFF_BASE_SHA (GitLab) ' +
    'or run with --scope full — the auto scope would have checked 0 changed files'
  );
}

/**
 * Resolves the base revision of the change set a provider
 * diffs against — the revision the staged index (or the
 * working tree) is compared with: HEAD for the staged diff,
 * the merge base for the GitHub PR provider, the CI
 * merge-request base for GitLab.
 *
 * Args:
 *   provider: the resolved provider identity.
 *   cwd: repository root.
 *   env: process environment.
 *
 * Returns:
 *   string | null: the 40-hex base revision, or null when
 *   it cannot be resolved (a repository without commits, or
 *   a platform provider without its base commit).
 */
export function changeBaseRevision(
  provider: ChangedProvider,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  switch (provider) {
    case 'local-staged': {
      const head = spawnSync('git', [...GIT_FLAGS, 'rev-parse', '--verify', 'HEAD'], {
        cwd,
        env,
        encoding: 'utf8',
      });
      const sha = (head.stdout ?? '').trim();
      return head.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    }
    case 'github-pr': {
      const baseRef = env['GITHUB_BASE_REF']?.trim() ?? '';
      if (baseRef.length === 0 || baseRef.startsWith('-') || /[\s\0]/.test(baseRef)) {
        return null;
      }
      const mergeBase = spawnSync('git', [...GIT_FLAGS, 'merge-base', 'HEAD', baseRef], {
        cwd,
        env,
        encoding: 'utf8',
      });
      const sha = (mergeBase.stdout ?? '').trim();
      return mergeBase.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    }
    case 'gitlab-mr': {
      const sha = env['CI_MERGE_REQUEST_DIFF_BASE_SHA']?.trim() ?? '';
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    }
    case 'all-files':
      return null;
  }
}

/**
 * Reads repository files at the base revision of the change
 * set a provider diffs against — the text a policy-input
 * classifier compares the working-tree candidate with.
 *
 * Args:
 *   provider: the resolved provider identity.
 *   cwd: repository root.
 *   env: process environment.
 *
 * Returns:
 *   ((path: string) => string | null) | null: the reader,
 *   or null when the base revision cannot be resolved (then
 *   no file has a base text to compare against).
 */
export function changeBaseTextReader(
  provider: ChangedProvider,
  cwd: string,
  env: NodeJS.ProcessEnv,
): ((path: string) => string | null) | null {
  const revision = changeBaseRevision(provider, cwd, env);
  if (revision === null) return null;
  return (path: string): string | null => {
    const blob = spawnSync('git', [...GIT_FLAGS, 'show', `${revision}:${path}`], {
      cwd,
      env,
      encoding: 'utf8',
    });
    if (blob.status !== 0) return null;
    return blob.stdout ?? '';
  };
}
