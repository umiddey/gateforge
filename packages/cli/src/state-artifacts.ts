/**
 * The run-state artifacts the ENGINE generates, as paths relative to the
 * state directory.
 *
 * `assertOutputDisjoint` refuses an `--out` that hides a declared input,
 * because a declared input under `--out` is excluded from the evidence
 * digest: the gate would then grade a candidate without the bytes it
 * claims to have graded. That refusal is right and stays.
 *
 * It must, however, not fire on the engine's OWN output. A supervised run
 * writes its synthesized runner config (`trusted.playwright.config.mjs`)
 * into the state directory, and because `gateforge init` declares every
 * `.mjs`/`.js`/`.ts`/`.py` file as a scan glob, that generated file became
 * a declared input — so the documented next command after the first run
 * (`gateforge check`, then `gateforge next`) exited 2 in the very
 * repository it had just run in, until a user deleted the file by hand.
 *
 * So the rule is closed-world and fail-closed, not "everything under
 * `--out` is fine":
 * - a TRACKED file under `--out` still refuses (the committed-source
 *   branch of `assertOutputDisjoint`, unchanged, and it runs first);
 * - any other file under `--out` still refuses, with byte-identical
 *   wording — a hand-written source file parked in the state directory is
 *   exactly the hole the refusal exists for, and no glob or directory
 *   name makes it safe;
 * - only the artifacts listed below are exempt, so the exemption is a
 *   statement about what the engine writes, never about what a glob
 *   happens to match.
 *
 * The exemptions come in exactly two shapes, because the engine's own
 * output names come in exactly two shapes:
 *
 * 1. {@link ENGINE_GENERATED_STATE_FILES} — a fixed name, compared against
 *    the path relative to the state directory when it is at the state
 *    root, and against the BASENAME anywhere below it (a runner adapter
 *    writes some of them inside its own per-run directory).
 * 2. {@link ENGINE_GENERATED_STATE_SUBTREES} — a whole subtree the engine
 *    owns end to end, whose file names it mints rather than fixes (a
 *    `runId`, a service id, a cache key): the lifecycle spool, the
 *    runtime and history logs, the plugin caches, the runner's own
 *    artifacts, the diagnostics and re-seal trees.
 *
 * The Cypress run directory is deliberately NOT a subtree: besides its
 * generated `report.json`, `support.cjs` and `gateforge.config.cjs` it
 * holds `downloads/`, `screenshots/` and `videos/` — content the tested
 * APPLICATION produced during the run, which is not the engine's output
 * and must never be exempted by directory.
 *
 * The Playwright pack's generated names are imported from the pack
 * itself, so a rename there cannot leave this list stale.
 */
import { TRUSTED_CONFIG_FILE, TRUSTED_REPORTER_OPTIONS_FILE } from '@gate-forge/pack-playwright';

/**
 * Generated file names. A name at the state root matches the
 * state-relative path; a name below a per-run directory matches the
 * basename.
 */
export const ENGINE_GENERATED_STATE_FILES: readonly string[] = [
  // CLI run state (cli/src/state.ts and the commands writing beside it).
  'behavior-catalog.json',
  'candidate-tree.json',
  'claim-injections.json',
  'claims.json',
  'classifications.json',
  'diagnostics.json',
  'env.json',
  'execution-result.json',
  'failures.json',
  'http-routes.json',
  'input-snapshot.json',
  'last-full-run.json',
  'manifest.json',
  'obligations.json',
  'receipt.json',
  'records.json',
  'report.json',
  'runner-outcomes.json',
  'run-record.json',
  'run-scope.json',
  'test-catalog.json',
  'twin-inventory.json',
  'twin-shapes.json',
  'witness-url.json',
  // The supervised Playwright run's synthesized runner config
  // (pack-playwright `synthesizeTrustedConfig`).
  TRUSTED_CONFIG_FILE,
  TRUSTED_REPORTER_OPTIONS_FILE,
  // The Cypress runner adapter's generated config, written into its own
  // per-run directory (`cypress/<runId>/`).
  'gateforge.config.cjs',
  'support.cjs',
  // The reporter/health-check artifacts the pytest runner adapter writes
  // per suite and run (`diagnostics/<suite>.xml`, `pytest/<runId>/`).
  'report.xml',
];

/**
 * Generated subtrees the engine owns end to end. Every path below one of
 * these is written by the engine or by the runner it supervises, under
 * names the engine mints.
 */
export const ENGINE_GENERATED_STATE_SUBTREES: readonly string[] = [
  'cache',
  'diagnostics',
  'history',
  'playwright-artifacts',
  'pytest',
  'reseal-chain',
  'reseal-parent',
  'run-recipe',
  'runtime',
  'spool',
  'vitest',
];

/**
 * Whether one repo-relative posix path under the state directory is a
 * path the ENGINE generated (and therefore an output, never an input).
 *
 * Args:
 *   stateRelativePath: posix path relative to the state directory (the
 *     repo-relative `--out` prefix already stripped).
 *
 * Returns:
 *   boolean: true for a generated artifact, false for anything else —
 *     including a path with an empty, `.` or `..` segment.
 */
export function isEngineGeneratedStatePath(stateRelativePath: string): boolean {
  if (stateRelativePath.length === 0) return false;
  const segments = stateRelativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false;
  }
  if (ENGINE_GENERATED_STATE_FILES.includes(stateRelativePath)) return true;
  if (ENGINE_GENERATED_STATE_FILES.includes(segments[segments.length - 1] as string)) return true;
  return ENGINE_GENERATED_STATE_SUBTREES.includes(segments[0] as string);
}
