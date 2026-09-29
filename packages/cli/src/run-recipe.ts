/**
 * The managed-run recipe (managed-run plan (2026-09-29), Part B, feedback E56).
 *
 * Gateforge owns the GENERIC lifecycle of a local witnessed run; the
 * application owns the RECIPE — which services it starts, how its
 * database is reset, what seeds it, when it is healthy. The recipe is
 * the optional `.gateforge/runtime.yml` document (the same document
 * the witnessed pre-commit staged runtime uses, extended additively
 * with the `gateforge run` lifecycle keys; an absent document means
 * `gateforge run` starts and stops nothing).
 *
 * Two rules make the recipe safe to run unattended:
 *
 * - the recipe holds PATHS, never secrets. `env_files` names files
 *   whose values are loaded into the step environment and are never
 *   printed, echoed into a log, or included in a message;
 * - the recipe adds NO authority. `gateforge run` only SEQUENCES the
 *   owner's own commands around the existing engine verdicts: every
 *   claim in the final receipt still comes from `test-gates` and
 *   `check`, which are the only commands allowed to decide anything.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_RECIPE_STEP_TIMEOUT_SECONDS,
  RuntimeConfigSchema,
  type GateforgeConfig,
  type RecipeStep,
} from '@gate-forge/core';
import { UsageError } from './errors.js';

/** Recipe document path used when `.gateforge.yml` declares no `runtime:` key. */
export const DEFAULT_RUNTIME_RECIPE_PATH = '.gateforge/runtime.yml';

/** Exit code reported when a step exceeded its own timeout. */
export const RECIPE_TIMEOUT_EXIT_CODE = 124;

/** The managed-run lifecycle steps of a recipe, in run order. */
export type RunRecipeStepName = 'prepare' | 'reset' | 'seed' | 'services_up' | 'healthcheck' | 'services_down';

/** One loaded recipe step. */
export interface RunRecipeStep {
  /** Recipe key this step came from. */
  name: RunRecipeStepName;
  /** The declared commands, in order. */
  commands: readonly (readonly string[])[];
  /** Wall-clock budget for the whole step. */
  timeoutSeconds: number;
  /** Extra attempts after the first failure. */
  retries: number;
}

/** The app-owned recipe `gateforge run` sequences. */
export interface RunRecipe {
  /** Repository-relative document the recipe came from. */
  path: string;
  /** Preparation step (null when the recipe declares none). */
  prepare: RunRecipeStep | null;
  /** Database/state reset. */
  reset: RunRecipeStep | null;
  /** Fixture seed. */
  seed: RunRecipeStep | null;
  /** Service startup. */
  services_up: RunRecipeStep | null;
  /** Readiness probe. */
  healthcheck: RunRecipeStep | null;
  /** Service shutdown (always last, also after a failure). */
  services_down: RunRecipeStep | null;
  /** Environment files loaded into every step, as absolute paths. */
  envFiles: readonly string[];
}

/** Options for {@link runRecipeStep}. */
export interface RunRecipeStepOptions {
  /** Overrides the step's declared budget (the doctor probes use it). */
  timeoutMs?: number;
  /** Absolute env-file paths layered onto the step environment. */
  envFiles?: readonly string[];
  /** Step name used in the log file name (never a command line). */
  logName?: string;
  /** Receives the absolute log path the step writes to. */
  log?: (logPath: string) => void;
}

/** The outcome of one recipe step. */
export interface RunRecipeStepOutcome {
  /** Exit code of the last command (124 on timeout, 127 when unstartable). */
  code: number;
  /** Commands actually executed (retries included). */
  attempts: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Absolute path of the step's log file. */
  logPath: string;
}

/** Recipe order a managed run consumes for setup, in order. */
const SETUP_STEPS: readonly RunRecipeStepName[] = ['prepare', 'reset', 'seed', 'services_up', 'healthcheck'];

/** Step names are safe log-file labels; a command line never is. */
const SAFE_LOG_NAME = /^[a-z][a-z0-9_-]*$/;

/** What a step executor needs, whether it came from a recipe or a probe. */
export type ExecutableRecipeStep = RecipeStep | Pick<RunRecipeStep, 'commands' | 'timeoutSeconds' | 'retries'>;

/**
 * Loads the declared step budget, keeping the shared 600s default.
 *
 * Args:
 *   declared: the declared budget in seconds, when present.
 *
 * Returns:
 *   number: the budget to enforce, in seconds.
 */
function stepTimeoutSeconds(declared: number | undefined): number {
  return declared ?? DEFAULT_RECIPE_STEP_TIMEOUT_SECONDS;
}

/**
 * Parses a `KEY=value` env file into a plain record. Values are never
 * logged, printed, or placed in any diagnostic; only the file's own
 * NAME is ever reported.
 *
 * Args:
 *   path: absolute path of the env file.
 *
 * Returns:
 *   Record<string, string>: the parsed variables.
 */
function parseEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) values[name] = line.slice(separator + 1);
  }
  return values;
}

/**
 * Builds the environment a recipe step runs with: the operator
 * environment plus the recipe's env files. Nothing is removed — the
 * owner's own shell already scopes what the run may see — and no
 * loaded value is ever printed.
 *
 * Args:
 *   env: operator environment.
 *   envFiles: absolute env-file paths (already validated to exist).
 *
 * Returns:
 *   NodeJS.ProcessEnv: the step environment.
 * @throws UsageError when an env file is missing or unreadable.
 */
function stepEnvironment(env: NodeJS.ProcessEnv, envFiles: readonly string[]): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...env };
  for (const file of envFiles) {
    if (!existsSync(file)) {
      throw new UsageError(`recipe env file '${file}' does not exist (env_files take paths to existing files)`);
    }
    try {
      Object.assign(resolved, parseEnvFile(file));
    } catch (error) {
      throw new UsageError(`recipe env file '${file}' could not be read: ${(error as Error).message}`);
    }
  }
  return resolved;
}

/**
 * Normalizes one recipe step into the shape the executor consumes.
 *
 * Args:
 *   name: the recipe key the step was declared under.
 *   commands: declared argv lists.
 *   declared: the declared step, when the recipe has one.
 *   declaredTimeout: budget override (the `prepare` step declares its
 *     run budget under its own key so the pre-commit budget is
 *     untouched).
 *   declaredRetries: retry override.
 *
 * Returns:
 *   RunRecipeStep | null: the normalized step, or null when the recipe
 *   declares no commands for it.
 */
function normalizeStep(
  name: RunRecipeStepName,
  commands: readonly (readonly string[])[] | undefined,
  declared: RecipeStep | undefined,
  declaredTimeout: number | undefined,
  declaredRetries: number | undefined,
): RunRecipeStep | null {
  const argv = commands ?? declared?.commands;
  if (argv === undefined) return null;
  return {
    name,
    commands: argv,
    timeoutSeconds: stepTimeoutSeconds(declaredTimeout ?? declared?.timeoutSeconds),
    retries: declaredRetries ?? declared?.retries ?? 0,
  };
}

/**
 * Loads and validates the app recipe from `.gateforge/runtime.yml`.
 *
 * Args:
 *   cwd: repository root.
 *   config: the loaded `.gateforge.yml` (its `runtime:` key selects the
 *     document; absent means the default path, and an absent document
 *     means NO recipe).
 *
 * Returns:
 *   RunRecipe | null: the recipe, or null when the repository declares
 *   none (the additive, absent-means-today's-behavior case).
 * @throws UsageError when the document exists but is not a valid recipe
 *   (plain message, exit 2 — Gateforge never runs a half-understood
 *   recipe).
 */
export function loadRunRecipe(cwd: string, config: GateforgeConfig): RunRecipe | null {
  const declared = config.runtime ?? DEFAULT_RUNTIME_RECIPE_PATH;
  const absolute = isAbsolute(declared) ? declared : join(cwd, ...declared.split('/'));
  if (!existsSync(absolute)) {
    if (config.runtime === undefined) return null;
    throw new UsageError(
      `the runtime recipe '${declared}' is configured in .gateforge.yml but missing from the repository; ` +
        'fix: restore the document or remove the runtime key',
    );
  }
  let document: unknown;
  try {
    document = parseYaml(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new UsageError(
      `the runtime recipe '${declared}' is not parsable YAML: ${(error as Error).message.split('\n')[0] ?? 'unknown'}`,
    );
  }
  const parsed = RuntimeConfigSchema.safeParse(document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '(root)' : first.path.map(String).join('.');
    throw new UsageError(
      `the runtime recipe '${declared}' violates its schema at '${where}': ${first?.message ?? 'unknown schema error'}`,
    );
  }
  const runtime = parsed.data;
  const envFiles: string[] = [];
  for (const entry of runtime.env_files ?? []) {
    const file = resolve(cwd, entry);
    if (!existsSync(file)) {
      throw new UsageError(`recipe env file '${entry}' does not exist (env_files take paths to existing files)`);
    }
    envFiles.push(file);
  }
  return {
    path: declared,
    prepare: normalizeStep('prepare', runtime.prepare?.commands, undefined, runtime.prepare?.runTimeoutSeconds, runtime.prepare?.runRetries),
    reset: normalizeStep('reset', undefined, runtime.reset, undefined, undefined),
    seed: normalizeStep('seed', undefined, runtime.seed, undefined, undefined),
    services_up: normalizeStep('services_up', undefined, runtime.services_up, undefined, undefined),
    healthcheck: normalizeStep('healthcheck', undefined, runtime.healthcheck, undefined, undefined),
    services_down: normalizeStep('services_down', undefined, runtime.services_down, undefined, undefined),
    envFiles,
  };
}

/**
 * The setup steps a managed run executes, in order, skipping the ones
 * the recipe does not declare.
 *
 * Args:
 *   recipe: the loaded recipe.
 *
 * Returns:
 *   RunRecipeStep[]: the declared setup steps, in lifecycle order.
 */
export function recipeSetupSteps(recipe: RunRecipe | null): RunRecipeStep[] {
  if (recipe === null) return [];
  return SETUP_STEPS.map((name) => recipe[name]).filter((step): step is RunRecipeStep => step !== null);
}

/**
 * Runs one recipe step to completion: every command in order, retried
 * as declared, inside the step's own budget, with all output appended
 * to a log file. Recipe commands may print secrets, so their output
 * NEVER reaches the console — the console only gets the step line and,
 * on failure, the log path.
 *
 * Args:
 *   step: the step to run.
 *   cwd: working directory for every command.
 *   env: operator environment (env files are layered on top).
 *   options: log name/sink, env files and an optional budget override.
 *
 * Returns:
 *   Promise<RunRecipeStepOutcome>: exit code, attempts, duration and log path.
 */
export async function runRecipeStep(
  step: ExecutableRecipeStep,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: RunRecipeStepOptions = {},
): Promise<RunRecipeStepOutcome> {
  const timeoutMs = options.timeoutMs ?? stepTimeoutSeconds(step.timeoutSeconds) * 1_000;
  const name = options.logName !== undefined && SAFE_LOG_NAME.test(options.logName) ? options.logName : 'step';
  const logPath = join(resolve(cwd), '.gateforge', 'test-gates', 'run-recipe', `${name}-log.txt`);
  mkdirSync(dirname(logPath), { recursive: true });
  options.log?.(logPath);
  const stepEnv = stepEnvironment(env, options.envFiles ?? []);
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let code = 0;
  let attempts = 0;
  for (let attempt = 0; attempt <= (step.retries ?? 0); attempt += 1) {
    code = 0;
    for (const argv of step.commands) {
      attempts += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        code = RECIPE_TIMEOUT_EXIT_CODE;
        break;
      }
      const outcome = await spawnRecipeCommand(argv, cwd, stepEnv, remaining, logPath);
      if (outcome !== 0) {
        code = outcome;
        break;
      }
    }
    if (code === 0) break;
  }
  return { code, attempts, durationMs: Date.now() - started, logPath };
}

/**
 * Spawns one recipe command with the remaining budget, appending its
 * combined output to the step log.
 *
 * Args:
 *   argv: the command as declared (never a shell string).
 *   cwd: working directory.
 *   env: environment for the child.
 *   timeoutMs: remaining budget.
 *   logPath: log file the output is appended to.
 *
 * Returns:
 *   Promise<number>: exit code (124 on timeout, 127 when unstartable).
 */
async function spawnRecipeCommand(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  logPath: string,
): Promise<number> {
  const [file, ...args] = argv;
  if (file === undefined || file.length === 0) return 127;
  return await new Promise<number>((settle) => {
    const log = createWriteStream(logPath, { flags: 'a' });
    const record = (chunk: Buffer): void => {
      log.write(chunk);
    };
    const child = spawn(file, [...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let finished = false;
    const done = (code: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.off('data', record);
      child.stderr.off('data', record);
      log.end();
      settle(code);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(RECIPE_TIMEOUT_EXIT_CODE);
    }, timeoutMs);
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    child.once('error', () => done(127));
    child.once('close', (code) => done(code ?? 1));
  });
}
