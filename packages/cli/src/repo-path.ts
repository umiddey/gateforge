/**
 * Repo-root-relative path resolution (leaf module).
 *
 * `resolveRepoPath` lives here rather than in `pipeline.ts` because the
 * LOW-LEVEL staged-candidate machinery needs it too, and
 * `staged-candidate.ts` is in the import closure of the lightweight
 * `gateforge enforce` command — importing `pipeline.ts` from there would
 * pull the whole classification pipeline (and its detector packs) into a
 * command that only renders CI templates. This module imports nothing
 * but the error type, so both call sites share ONE implementation
 * without adding a heavy edge; `pipeline.ts` re-exports it, so the
 * established import path keeps working unchanged.
 */
import { join } from 'node:path';
import { UsageError } from './errors.js';

/** Resolves a repo-root-relative config path against the cwd. */
export function resolveRepoPath(cwd: string, repoRelative: string): string {
  const normalized = repoRelative.split('\\').join('/');
  if (normalized.startsWith('/')) {
    throw new UsageError(`config path '${repoRelative}' must be repo-root-relative, not absolute`);
  }
  return join(cwd, ...normalized.split('/'));
}