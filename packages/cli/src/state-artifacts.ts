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
import { relative, resolve, sep } from 'node:path';
import {
  FREEZE_CONTROL_DIR,
  FREEZE_CONTROL_SPEC_FILE,
  FREEZE_REFUSAL_FILE,
  FREEZE_RELEASE_FILE,
  FREEZE_REQUEST_FILE,
  TRUSTED_CONFIG_FILE,
  TRUSTED_REPORTER_OPTIONS_FILE,
} from '@gate-forge/pack-playwright';

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
  // The global native preparation freeze's control documents
  // (pack-playwright `discovery/prepare-barrier.ts`): the controller's
  // request, the CLI's signed release and its refusal document. The
  // controller SPEC is generated into a private per-run directory
  // OUTSIDE the repository, so it is no longer written here; its name
  // stays registered because a repository that still carries a copy
  // from an earlier build must be owned by this boundary (an exempt
  // output) rather than refused as an undeclared input — exactly the
  // hole the synthesized runner config above already opened.
  FREEZE_CONTROL_SPEC_FILE,
  FREEZE_REFUSAL_FILE,
  FREEZE_RELEASE_FILE,
  FREEZE_REQUEST_FILE,
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
  // The freeze barrier's control directory (pack-playwright
  // `FREEZE_CONTROL_DIR` = `native-freeze`): the controller's request
  // document, the CLI's signed release and its refusal document — and,
  // for a repository that still carries one from an earlier build, the
  // generated controller spec. The engine owns every byte below here,
  // so the subtree is the honest registration even though the fixed
  // names above already cover today's files.
  FREEZE_CONTROL_DIR,
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

/**
 * Builds the static-discovery seed veto for the run's OWN generated
 * state: a repo-relative file is hidden from catalog seeding when,
 * and only when, it sits INSIDE the state directory this run actually
 * resolved AND its state-relative path is an engine-generated
 * artifact in the closed-world registry above.
 *
 * Why the seed needs it: the state directory holds real
 * source-shaped files (`trusted.playwright.config.mjs`, and the freeze
 * control documents an earlier build parked there), and `gateforge init`
 * declares `.mjs`/`.js`/`.ts` scan globs — so after the first run those
 * OUTPUT files were harvested back as tests the repository never
 * declared, and the second run planned a case the runner cannot
 * enumerate.
 *
 * What it deliberately does NOT do:
 * - it is a SEED veto only. The native `--list` enumeration, import
 *   traversal, and every enumerated consumer case are untouched;
 * - it never matches by basename alone, by title, or by a blanket
 *   `.gateforge` rule: a controller lookalike with the same file name
 *   anywhere else stays a candidate;
 * - containment is segment-exact, so a sibling directory that merely
 *   shares a prefix (`.gateforge/test-gates-extra/…`) is never
 *   excluded;
 * - a state directory that is the repository root itself, or outside
 *   it, excludes nothing at all (no prefix, no guess);
 * - it says nothing about the input digest. A hand-written source
 *   file parked in the state directory is still refused by
 *   `assertOutputDisjoint` with byte-identical wording, and a TRACKED
 *   file there still refuses first; a veto here can never make a
 *   tracked file invisible to that refusal, because the veto is
 *   applied to the discovery walk, not to the declared-input check.
 *
 * Args:
 *   cwd: absolute repository root the discovery walk starts from.
 *   stateDir: absolute run-state directory the run resolved (the
 *     `--out` override when the command accepts one, else the
 *     default).
 *
 * Returns:
 *   (repoRelativePath: string) => boolean: true excludes the file
 *   from static candidate seeding.
 */
export function engineGeneratedStateFileFilter(
  cwd: string,
  stateDir: string,
): (repoRelativePath: string) => boolean {
  // Same containment convention as the digest's state prefix
  // (`input-snapshot.ts` `buildFileEntries`): the posix form of the
  // RESOLVED state directory relative to the RESOLVED repo root, which
  // is exactly the coordinate space the discovery walk reports.
  const prefix = relative(resolve(cwd), resolve(stateDir)).split(sep).join('/');
  if (prefix === '' || prefix === '..' || prefix.startsWith('../')) return () => false;
  const under = `${prefix}/`;
  return (file) => file.startsWith(under) && isEngineGeneratedStatePath(file.slice(under.length));
}
