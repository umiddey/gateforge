/**
 * Run options the SUPERVISOR hands a witness with the run context.
 *
 * Timing chaos and twin path coverage are run OPTIONS: what the
 * observation proxy perturbs and records is decided by the run, not by
 * the process. Until now the only way to set them was the environment
 * of a witness the CLI SPAWNS, which left a repository that starts its
 * own witness unable to use either feature at all — and the honest
 * failure mode was the worst kind: the run compared nothing, and said
 * nothing.
 *
 * The options therefore travel in the run-context binding, which is
 * already supervisor-authenticated and already happens before any
 * session, proxy exchange or issuance. A run that asks for nothing
 * sends nothing, and a witness that receives nothing behaves exactly as
 * it always did.
 *
 * A witness STARTED with these options (its own environment) keeps
 * working unchanged: the spawn path is byte-identical. When both
 * sources configure the same feature and disagree, the binding is
 * REFUSED — two answers to "what does this run perturb" is a
 * configuration error an owner must see, never a silent winner.
 */
import { compareStrings } from '@gate-forge/core';
import { ENV_TWIN_SHAPES } from '../constants.js';
import type { ChaosOptions } from './chaos.js';
import { MAX_DELAY_CEILING_MS } from './chaos.js';
import type { TwinShapePlan } from './twin-shapes.js';

/** The run options one binding may carry. */
export interface RunOptions {
  /** The seeded release plan, or absent for a run that asked for none. */
  chaos?: ChaosOptions;
  /** The shape-recording plan, or absent when no pair can be compared. */
  twinShapes?: TwinShapePlan;
}

/** The options a witness confirmed it applied, echoed back to the caller. */
export interface AppliedRunOptions {
  chaos: ChaosOptions | null;
  twinShapes: TwinShapePlan | null;
}

/** True for a JSON object (not an array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses the chaos plan a binding carries.
 *
 * Parsed fail-closed and identically to the environment form: a seed
 * that is not a non-negative integer, a bound that is not whole
 * milliseconds within the ceiling, or a missing bound is a
 * configuration error, never a silently different schedule.
 *
 * Args:
 *   raw: the `options.chaos` value from the binding body.
 *
 * Returns:
 *   ChaosOptions: the accepted plan.
 *
 * @throws Error: on any malformed field.
 */
function parseBoundChaos(raw: unknown): ChaosOptions {
  if (!isPlainObject(raw)) throw new Error('run options: options.chaos must be an object');
  const seed = raw['seed'];
  const maxDelayMs = raw['maxDelayMs'];
  const reorder = raw['reorder'];
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0) {
    throw new Error(
      'run options: options.chaos.seed must be a non-negative integer (0, 1, 2, ...), got ' +
        JSON.stringify(seed),
    );
  }
  if (
    typeof maxDelayMs !== 'number' ||
    !Number.isInteger(maxDelayMs) ||
    maxDelayMs < 0 ||
    maxDelayMs > MAX_DELAY_CEILING_MS
  ) {
    throw new Error(
      'run options: options.chaos.maxDelayMs must be a whole number of milliseconds between 0 and ' +
        `${String(MAX_DELAY_CEILING_MS)}, got ${JSON.stringify(maxDelayMs)}`,
    );
  }
  if (typeof reorder !== 'boolean') {
    throw new Error(`run options: options.chaos.reorder must be a boolean, got ${JSON.stringify(reorder)}`);
  }
  return { seed, maxDelayMs, reorder };
}

/**
 * Parses the twin-shape plan a binding carries. The route inventory
 * travels as its TEMPLATES (never a path, never a URL): the run that
 * compiled them is the authority on what a shape may name, and a
 * witness on another machine must not have to read a file to compare
 * two twins honestly.
 *
 * Args:
 *   raw: the `options.twinShapes` value from the binding body.
 *
 * Returns:
 *   TwinShapePlan: the accepted plan.
 *
 * @throws Error: on a malformed allowlist or inventory.
 */
function parseBoundTwinShapes(raw: unknown): TwinShapePlan {
  if (!isPlainObject(raw)) throw new Error('run options: options.twinShapes must be an object');
  const queryKeys = raw['queryKeys'];
  if (!Array.isArray(queryKeys) || queryKeys.some((key) => typeof key !== 'string' || key.trim() === '')) {
    throw new Error('run options: options.twinShapes.queryKeys must be a list of non-empty key names');
  }
  const inventory = raw['inventory'];
  if (inventory !== undefined) {
    if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== 'string' || entry === '')) {
      throw new Error('run options: options.twinShapes.inventory must be a list of non-empty route templates');
    }
  }
  const keys = (queryKeys as string[]).map((key) => key.trim());
  const templates = inventory === undefined ? [] : (inventory as string[]);
  return {
    queryKeys: [...keys].sort(compareStrings),
    ...(templates.length === 0 ? {} : { inventory: { templates: [...templates] } }),
  };
}

/**
 * Parses the additive `options` object of a run-context binding.
 *
 * Absent, null, or an object with no feature is the byte-identical
 * path: this returns an empty plan and the caller binds nothing.
 *
 * Args:
 *   raw: the `options` value from the binding body (any may be absent).
 *
 * Returns:
 *   RunOptions: only the features the run actually asked for.
 *
 * @throws Error: on a malformed feature block.
 */
export function parseRunOptions(raw: unknown): RunOptions {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new Error('run options: options must be an object when present');
  const chaos = raw['chaos'];
  const twinShapes = raw['twinShapes'];
  return {
    ...(chaos === undefined || chaos === null ? {} : { chaos: parseBoundChaos(chaos) }),
    ...(twinShapes === undefined || twinShapes === null ? {} : { twinShapes: parseBoundTwinShapes(twinShapes) }),
  };
}

/**
 * Refuses a binding that disagrees with how this witness was STARTED.
 *
 * A witness booted with `GATEFORGE_CHAOS_SEED` and then handed a
 * different plan is a run whose timing nobody can name: the proxy
 * cannot serve both answers, and picking one silently would make the
 * recorded schedule a fiction. An IDENTICAL plan is accepted (the same
 * run may be retried against a witness that already had it).
 *
 * Args:
 *   started: the options this witness booted with.
 *   bound: the options the binding asked for.
 *
 * @throws Error: naming both plans, when one feature is configured
 *   twice with different values.
 */
export function assertNoStartedConflict(started: AppliedRunOptions, bound: RunOptions): void {
  if (bound.chaos !== undefined && started.chaos !== null) {
    const same =
      started.chaos.seed === bound.chaos.seed &&
      started.chaos.maxDelayMs === bound.chaos.maxDelayMs &&
      started.chaos.reorder === bound.chaos.reorder;
    if (!same) {
      throw new Error(
        'this witness was started with a different timing-chaos plan (seed ' +
          `${String(started.chaos.seed)}, max delay ${String(started.chaos.maxDelayMs)} ms, reorder ` +
          `${started.chaos.reorder ? 'on' : 'off'}) than the run binds (seed ${String(bound.chaos.seed)}, max ` +
          `delay ${String(bound.chaos.maxDelayMs)} ms, reorder ${bound.chaos.reorder ? 'on' : 'off'}); one ` +
          'witness serves one plan — start it without the chaos environment',
      );
    }
  }
  if (bound.twinShapes !== undefined && started.twinShapes !== null) {
    // The plan is a SET (an allowlist and a template list), so the two
    // sources describe the same run when they name the same members,
    // not when they happen to list them in the same order: the
    // environment form reads the inventory from the engine's own file,
    // which is written deduped and sorted, and the bound form is
    // whatever order the run compiled its routes in.
    const samePlan =
      canonicalSet(started.twinShapes.queryKeys) === canonicalSet(bound.twinShapes.queryKeys) &&
      canonicalSet(started.twinShapes.inventory?.templates ?? []) ===
        canonicalSet(bound.twinShapes.inventory?.templates ?? []);
    if (!samePlan) {
      throw new Error(
        'this witness was started with a different twin path coverage plan than the run binds; one witness ' +
          `serves one plan — start it without ${ENV_TWIN_SHAPES}`,
      );
    }
  }
}

/** The members of a plan list, deduped and ordered, as one comparable string. */
function canonicalSet(values: readonly string[]): string {
  return [...new Set(values)].sort(compareStrings).join(',');
}
