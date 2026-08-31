/**
 * `gateforge baseline update <fingerprint...>`: shrink the baseline to
 * the given fingerprints.
 *
 * Baselines store forgiven obligation fingerprints (pin #3); invariant 4
 * allows ONLY strict subsets — removals of resolved obligations. Adding
 * or laundering fingerprints fails closed via `updateBaseline` (GF-07
 * reject, GF-08 pass), and the next document is written with the core
 * writer. The baseline path comes from `.gateforge.yml` `baselines`.
 */
import { loadBaseline, updateBaseline, writeBaseline } from '@gateforge/core';
import { parseArgs } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { resolveRepoPath } from '../pipeline.js';
import { loadConfigAt } from './common.js';
import { UsageError } from '../errors.js';

export const BASELINE_USAGE =
  'usage: gateforge baseline update <fingerprint> [<fingerprint> ...]';

/**
 * Runs the baseline subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 updated, 2 usage/config/rejection.
 * @throws GateforgeBaselineError / errors (exit 2) on any problem.
 */
export function baselineCommand(io: Io, argv: readonly string[]): number {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, BASELINE_USAGE);
    return 0;
  }
  const sub = positionals[0];
  if (sub !== 'update') {
    throw new UsageError(
      `unknown baseline subcommand '${sub ?? '<none>'}' (${BASELINE_USAGE})`,
    );
  }
  const fingerprints = positionals.slice(1);
  if (fingerprints.length === 0) {
    throw new UsageError(`baseline update requires at least one fingerprint to keep (${BASELINE_USAGE})`);
  }

  const config = loadConfigAt(io.cwd);
  const path = resolveRepoPath(io.cwd, config.baselines);
  const current = loadBaseline(path);
  const next = updateBaseline(current, fingerprints);
  writeBaseline(path, next);
  writeLine(
    io.stdout,
    `baseline updated: ${next.fingerprints.length} fingerprint(s) (was ${current.fingerprints.length})`,
  );
  return 0;
}