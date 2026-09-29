/**
 * `gateforge run` (managed-run plan, Part B, feedback E56).
 *
 * One command that performs a whole local witnessed proof, in the
 * order a careful engineer would:
 *
 *   1. doctor preflight (STRICT — the first failing precondition ends
 *      the run before a minute is spent);
 *   2. the app recipe: `prepare` → `reset` → `seed` → `services_up` →
 *      `healthcheck`;
 *   3. `gateforge test-gates` (supervised; the user's own flags are
 *      passed through unchanged);
 *   4. `gateforge check --require-e2e` (the strict receipt check);
 *   5. the recipe's `services_down`, ALWAYS — after success, after a
 *      failing gate, and after a failing recipe step.
 *
 * It adds NO authority. Every step is an existing command with its
 * existing verdict: the recipe is the app's own shell, and the only
 * things this module contributes are ORDER, one plain line per step
 * with its duration, and an exit code that is the first failing step's
 * own code. Recipe output goes to a log file under the run-state
 * directory (it may contain secrets) and never to the console.
 *
 * Exit codes (the first failing step wins):
 *
 * | step                    | code                                                                     |
 * |-------------------------|--------------------------------------------------------------------------|
 * | usage / config / recipe | 2                                                                        |
 * | preflight FAIL          | 1                                                                        |
 * | recipe step             | the command's own code; 124 on timeout, 127 when it could not start      |
 * | `test-gates`            | its own code (1 unresolved obligations or a failed suite, 2 config)      |
 * | `check --require-e2e`   | its own code (1 no verifying receipt, 2 config)                          |
 * | success                 | 0                                                                        |
 */
import { parseArgs } from '../args.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { checkCommand } from './check.js';
import { testGatesCommand } from './test-gates.js';
import { loadRunRecipe, recipeSetupSteps, runRecipeStep, type RunRecipe, type RunRecipeStep } from '../run-recipe.js';
import { buildRunPreflight, firstFailingCheck } from '../run-preflight.js';

export const RUN_USAGE = 'usage: gateforge run [--] [test-gates flags]';

/** One recipe step that failed, with the code the run must exit with. */
interface FailedStep {
  /** The step that failed. */
  step: RunRecipeStep;
  /** Its exit code. */
  code: number;
}

/**
 * Runs the whole managed local proof.
 *
 * Args:
 *   io: process context.
 *   argv: `run`'s own flags plus the flags to pass to `test-gates`.
 *
 * Returns:
 *   Promise<number>: the first failing step's code (0 on success).
 * @throws UsageError on a usage error (exit 2).
 */
export async function runCommand(io: Io, argv: readonly string[]): Promise<number> {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);
  const { options, positionals } = parseArgs(own);
  if (options['help'] === true) {
    writeLine(io.stdout, RUN_USAGE);
    return 0;
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument '${positionals[0] ?? ''}' (${RUN_USAGE})`);
  }
  // Every flag this command does not declare belongs to the supervised
  // run: `gateforge run -- --changed` is the honest spelling, and an
  // undeclared flag here is a typo worth naming rather than forwarding.
  rejectUnknownFlags(options, ['help'], RUN_USAGE);

  const config = loadConfigAt(io.cwd);
  const recipe = loadRunRecipe(io.cwd, config);
  const started = Date.now();
  const report = (name: string, durationMs: number): void => {
    writeLine(io.stdout, `  [step] ${name}: ${formatDuration(durationMs)}`);
  };

  const preflightStarted = Date.now();
  const preflight = await buildRunPreflight(io);
  report('preflight', Date.now() - preflightStarted);
  for (const check of preflight.checks) {
    writeLine(io.stdout, `    [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
  }
  const failure = firstFailingCheck(preflight);
  if (failure !== null) {
    writeLine(io.stderr, `run: preflight failed — [${failure.id}] ${failure.detail}`);
    return 1;
  }

  const failed = await runRecipeSetup(io, recipe, report);
  let code = 0;
  if (failed === null) {
    const gatesStarted = Date.now();
    code = await testGatesCommand(io, passthrough);
    report('test-gates', Date.now() - gatesStarted);
    if (code === 0) {
      const checkStarted = Date.now();
      code = await checkCommand(io, ['--require-e2e']);
      report('check --require-e2e', Date.now() - checkStarted);
    }
  } else {
    code = failed.code;
  }
  await runRecipeTeardown(io, recipe, report);
  writeLine(
    io.stdout,
    `gateforge run: ${code === 0 ? 'complete' : 'FAILED'} in ${formatDuration(Date.now() - started)} (exit ${String(code)})`,
  );
  return code;
}

/**
 * Runs the recipe's setup steps in lifecycle order and stops at the
 * first failure, reporting each step with its duration.
 *
 * Args:
 *   io: process context.
 *   recipe: the loaded recipe, or null when the app declares none.
 *   report: prints one plain line per step with its duration.
 *
 * Returns:
 *   Promise<FailedStep | null>: the first failure, or null.
 */
async function runRecipeSetup(
  io: Io,
  recipe: RunRecipe | null,
  report: (name: string, durationMs: number) => void,
): Promise<FailedStep | null> {
  for (const step of recipeSetupSteps(recipe)) {
    const outcome = await runRecipeStep(step, io.cwd, io.env, {
      envFiles: recipe?.envFiles ?? [],
      logName: step.name,
    });
    report(step.name, outcome.durationMs);
    if (outcome.code !== 0) {
      writeLine(io.stderr, `run: recipe step '${step.name}' failed with exit ${String(outcome.code)} — output: ${outcome.logPath}`);
      return { step, code: outcome.code };
    }
  }
  return null;
}

/**
 * Runs the recipe's `services_down` step, always: after success, after
 * a failing gate, and after a failing setup step. A failing teardown is
 * reported, never silently swallowed.
 *
 * Args:
 *   io: process context.
 *   recipe: the loaded recipe, or null when the app declares none.
 *   report: prints one plain line per step with its duration.
 */
async function runRecipeTeardown(
  io: Io,
  recipe: RunRecipe | null,
  report: (name: string, durationMs: number) => void,
): Promise<void> {
  const teardown = recipe === null ? null : recipe.services_down;
  if (teardown === null) return;
  const outcome = await runRecipeStep(teardown, io.cwd, io.env, {
    envFiles: recipe === null ? [] : recipe.envFiles,
    logName: 'services_down',
  });
  report('services_down', outcome.durationMs);
  if (outcome.code !== 0) {
    writeLine(io.stderr, `run: recipe step 'services_down' failed with exit ${String(outcome.code)} — output: ${outcome.logPath}`);
  }
}

/**
 * Formats a duration as a short human line.
 *
 * Args:
 *   durationMs: milliseconds.
 *
 * Returns:
 *   string: e.g. `820ms`, `1.2s` or `2m 03s`.
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${String(durationMs)}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
}
