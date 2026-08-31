import { type ChangedFileProvider, type ChangedProvider } from '@gateforge/core';
/** Local staged-diff provider: `git diff --cached --name-only` (pin #5). */
export declare function localStagedProvider(cwd: string, env: NodeJS.ProcessEnv): ChangedFileProvider;
/** GitHub Actions merge-base diff provider (`GITHUB_BASE_REF`, pin #5). */
export declare function githubPrProvider(cwd: string, env: NodeJS.ProcessEnv): ChangedFileProvider;
/** GitLab merge-request diff provider (`CI_MERGE_REQUEST_DIFF_BASE_SHA`). */
export declare function gitlabMrProvider(cwd: string, env: NodeJS.ProcessEnv): ChangedFileProvider;
/** Builds one provider implementation by identity. */
export declare function providerFor(provider: ChangedProvider, cwd: string, env: NodeJS.ProcessEnv): ChangedFileProvider;
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
export declare function resolveProvider(configured: 'auto' | ChangedProvider, cwd: string, env: NodeJS.ProcessEnv): ChangedFileProvider;
//# sourceMappingURL=providers.d.ts.map