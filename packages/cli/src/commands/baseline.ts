/**
 * `gateforge baseline update <fingerprint...>`: shrink the baseline to
 * the given fingerprints.
 *
 * Baselines store forgiven obligation fingerprints (pin #3); invariant 4
 * allows ONLY strict subsets — removals of resolved obligations. Adding
 * or laundering fingerprints fails closed via `updateBaseline` (GF-07
 * reject, GF-08 pass), and the next document is written with the core
 * writer. The baseline path comes from `.gateforge.yml` `baselines`.
 *
 * The classification layer (two-layer adoption) shrinks through the SAME
 * command — the adopted set's only mutation: `--classification-blocked
 * <resourceId>...` keeps exactly the listed adopted ids (a resource that
 * gained a real classification is simply not listed and leaves the set;
 * an empty value `--classification-blocked=` keeps none). The set is
 * shrink-only (GF-07/08 mirrored): listing an id that is not currently
 * adopted fails closed via `shrinkClassificationBlocked`, so the
 * sanctioned starting point can never grow. Both layers may be updated
 * in one call; a repo without an adoption record has nothing to shrink
 * and fails closed.
 */
import { loadAdoptionRecord, loadBaseline, shrinkClassificationBlocked, updateBaseline, writeAdoptionRecord, writeBaseline, ADOPTION_RECORD_FILENAME } from '@gate-forge/core';
import { dirname, join } from 'node:path';
import { parseArgs } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { resolveRepoPath } from '../pipeline.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { UsageError } from '../errors.js';

export const BASELINE_USAGE =
  'usage: gateforge baseline update <fingerprint> [<fingerprint> ...] ' +
  '[--classification-blocked <resourceId>]...';

/**
 * Collects the values of a repeatable string flag. A bare `--flag` (no
 * value) is a parse error upstream; an explicitly empty value
 * (`--flag=`) yields one empty-string entry the caller interprets.
 */
function repeatableFlag(options: Record<string, unknown>, name: string): string[] {
  const value = options[name];
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  throw new UsageError(`flag '--${name}' requires a value (${BASELINE_USAGE})`);
}

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
  rejectUnknownFlags(options, ['help', 'classification-blocked'], BASELINE_USAGE);
  const sub = positionals[0];
  if (sub !== 'update') {
    throw new UsageError(
      `unknown baseline subcommand '${sub ?? '<none>'}' (${BASELINE_USAGE})`,
    );
  }
  const fingerprints = positionals.slice(1);
  // Keep-semantics: `--classification-blocked` lists the ids that REMAIN
  // adopted; a resource that gained a real classification is not listed
  // and leaves the set. The explicit empty value (`=`) keeps none — the
  // only way to reach an empty adopted set. Absent flag = this layer is
  // untouched.
  const classificationFlagValues = repeatableFlag(options, 'classification-blocked');
  const classificationIds =
    classificationFlagValues.length === 1 && classificationFlagValues[0] === ''
      ? []
      : classificationFlagValues;
  if (fingerprints.length === 0 && classificationFlagValues.length === 0) {
    throw new UsageError(
      `baseline update requires at least one fingerprint to keep (${BASELINE_USAGE})`,
    );
  }

  const config = loadConfigAt(io.cwd);
  const path = resolveRepoPath(io.cwd, config.baselines);
  const current = loadBaseline(path);
  if (fingerprints.length > 0) {
    const next = updateBaseline(current, fingerprints);
    writeBaseline(path, next);
    writeLine(
      io.stdout,
      `baseline updated: ${next.fingerprints.length} fingerprint(s) (was ${current.fingerprints.length})`,
    );
  }

  if (classificationFlagValues.length > 0) {
    const recordPath = join(dirname(path), ADOPTION_RECORD_FILENAME);
    const record = loadAdoptionRecord(recordPath);
    if (record === null) {
      // Fail closed: without an adoption receipt there is no adopted
      // classification set, so there is nothing to shrink — and a shrink
      // must never fabricate the layer it operates on.
      throw new UsageError(
        `no adoption record at ${recordPath} — the classification layer is only ` +
          'shrinkable after `gateforge adopt` recorded it',
      );
    }
    const next = shrinkClassificationBlocked(record, classificationIds);
    writeAdoptionRecord(recordPath, next);
    writeLine(
      io.stdout,
      `classification set updated: ${(next.classificationBlocked ?? []).length} resource(s) remain adopted (was ${(record.classificationBlocked ?? []).length})`,
    );
  }
  return 0;
}