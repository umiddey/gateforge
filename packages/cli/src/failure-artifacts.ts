/**
 * Keeps Playwright's failure artifacts of a run whose state directory is
 * thrown away (`test-gates --result-only` without a witness URL runs in a
 * temporary directory). Playwright writes into the trusted config's
 * `outputDir` only for failed tests (error-context, screenshots, traces),
 * so without this a red supervised test left nothing to diagnose.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Directory name the trusted config uses for Playwright's `outputDir`. */
export const PLAYWRIGHT_ARTIFACTS_DIR = 'playwright-artifacts';

/** Directory under the project state dir that holds the last run's failure artifacts. */
export const LAST_FAILURES_DIR = 'last-failures';

/**
 * Copies `<runStateDir>/playwright-artifacts` to `<keepStateDir>/last-failures`,
 * replacing the previous run's copy, when the run produced any artifact.
 * Earlier copies are removed even when this run produced none, so the
 * directory never shows a stale failure next to a green run.
 *
 * Args:
 *   runStateDir: the (temporary) state directory the run used.
 *   keepStateDir: the project's own state directory that outlives the run.
 *
 * Returns:
 *   string | null: the kept directory, or null when the run produced no artifact.
 */
export function keepFailureArtifacts(runStateDir: string, keepStateDir: string): string | null {
  const source = join(runStateDir, PLAYWRIGHT_ARTIFACTS_DIR);
  const target = join(keepStateDir, LAST_FAILURES_DIR);
  rmSync(target, { recursive: true, force: true });
  if (!existsSync(source) || readdirSync(source).length === 0) return null;
  mkdirSync(keepStateDir, { recursive: true });
  cpSync(source, target, { recursive: true });
  return target;
}
