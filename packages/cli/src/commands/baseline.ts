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
 * sanctioned starting point can never grow.
 *
 * An adopted family (0.13) shrinks the same way:
 * `--family-pages <fingerprint>...` keeps exactly the listed forgiven
 * fingerprints of the receipt's `pages` family marker (`--family-pages=`
 * keeps none); anything unlisted leaves the sanctioned set and blocks
 * again. The marker itself (dates, commit, every recorded page
 * obligation) is RETAINED — the set shrinks, the family stays adopted,
 * so a repeat `adopt --family pages` still adds nothing. Listing a
 * fingerprint the family never forgave fails closed via
 * `shrinkFamilyForgiven`. Both receipt layers may be updated in one
 * call; a repo without an adoption record has nothing to shrink and
 * fails closed.
 *
 * The http-calls family (0.14 WP5) shrinks the same way through
 * `--family-http-calls <fingerprint>...` (`--family-http-calls=` keeps
 * none). Its marker and its recorded call-finding keys are retained; a
 * call finding the receipt no longer forgives blocks again.
 */
import { loadAdoptionRecord, loadBaseline, shrinkClassificationBlocked, shrinkFamilyForgiven, updateBaseline, writeAdoptionRecord, writeBaseline, ADOPTION_RECORD_FILENAME, type AdoptionRecord } from '@gate-forge/core';
import { dirname, join } from 'node:path';
import { parseArgs } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { resolveRepoPath } from '../pipeline.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { UsageError } from '../errors.js';

export const BASELINE_USAGE =
  'usage: gateforge baseline update <fingerprint> [<fingerprint> ...] ' +
  '[--classification-blocked <resourceId>]... [--family-pages <fingerprint>]... ' +
  '[--family-http-calls <fingerprint>]... | gateforge baseline diff <before> <after>';

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
  rejectUnknownFlags(
    options,
    ['help', 'classification-blocked', 'family-pages', 'family-http-calls'],
    BASELINE_USAGE,
  );
  const sub = positionals[0];
  if (sub === 'diff') {
    if (
      positionals.length !== 3 ||
      options['classification-blocked'] !== undefined ||
      options['family-pages'] !== undefined ||
      options['family-http-calls'] !== undefined
    ) {
      throw new UsageError(`baseline diff requires exactly two baseline files (${BASELINE_USAGE})`);
    }
    const beforePath = resolveRepoPath(io.cwd, positionals[1] as string);
    const afterPath = resolveRepoPath(io.cwd, positionals[2] as string);
    const beforeDocument = loadBaseline(beforePath);
    const afterDocument = loadBaseline(afterPath);
    const beforeRecord = loadAdoptionRecord(join(dirname(beforePath), ADOPTION_RECORD_FILENAME));
    const afterRecord = loadAdoptionRecord(join(dirname(afterPath), ADOPTION_RECORD_FILENAME));
    if (beforeRecord?.obligationFingerprintsById === undefined) {
      throw new UsageError(`baseline at '${beforePath}' has no obligation identity index`);
    }
    if (afterRecord?.obligationFingerprintsById === undefined) {
      throw new UsageError(`baseline at '${afterPath}' has no obligation identity index`);
    }
    const beforeFingerprints = new Set(beforeDocument.fingerprints);
    const afterFingerprints = new Set(afterDocument.fingerprints);
    const before = new Map(
      Object.entries(beforeRecord.obligationFingerprintsById).filter(([, fingerprint]) =>
        beforeFingerprints.has(fingerprint),
      ),
    );
    const after = new Map(
      Object.entries(afterRecord.obligationFingerprintsById).filter(([, fingerprint]) =>
        afterFingerprints.has(fingerprint),
      ),
    );
    const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
    const added = [...after.keys()].filter((id) => !before.has(id)).sort();
    const changed = [...before.keys()]
      .filter((id) => after.has(id) && before.get(id) !== after.get(id))
      .sort();
    writeLine(
      io.stdout,
      `baseline diff: ${changed.length} changed, ${removed.length} removed, ${added.length} added obligation(s) (keyed by obligation id)`,
    );
    for (const id of changed) writeLine(io.stdout, `changed obligation ${id}`);
    for (const id of removed) writeLine(io.stdout, `removed obligation ${id}`);
    for (const id of added) writeLine(io.stdout, `added obligation ${id}`);
    const indexedBefore = new Set(before.values());
    const indexedAfter = new Set(after.values());
    const unmatchedBefore = [...beforeFingerprints].filter((fingerprint) => !indexedBefore.has(fingerprint)).length;
    const unmatchedAfter = [...afterFingerprints].filter((fingerprint) => !indexedAfter.has(fingerprint)).length;
    if (unmatchedBefore > 0 || unmatchedAfter > 0) {
      writeLine(
        io.stdout,
        `non-obligation baseline entries not shown: ${unmatchedBefore} before, ${unmatchedAfter} after`,
      );
    }
    return 0;
  }
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
  // untouched. `--family-pages` is the same keep-semantics over the
  // receipt's `pages` family `forgiven` list; the marker is retained.
  const classificationFlagValues = repeatableFlag(options, 'classification-blocked');
  const classificationIds =
    classificationFlagValues.length === 1 && classificationFlagValues[0] === ''
      ? []
      : classificationFlagValues;
  const familyFlagValues = repeatableFlag(options, 'family-pages');
  const familyKeep =
    familyFlagValues.length === 1 && familyFlagValues[0] === '' ? [] : familyFlagValues;
  const httpCallsFlagValues = repeatableFlag(options, 'family-http-calls');
  const httpCallsKeep =
    httpCallsFlagValues.length === 1 && httpCallsFlagValues[0] === '' ? [] : httpCallsFlagValues;
  if (
    fingerprints.length === 0 &&
    classificationFlagValues.length === 0 &&
    familyFlagValues.length === 0 &&
    httpCallsFlagValues.length === 0
  ) {
    throw new UsageError(
      `baseline update requires at least one fingerprint to keep (${BASELINE_USAGE})`,
    );
  }

  const config = loadConfigAt(io.cwd);
  const path = resolveRepoPath(io.cwd, config.baselines);
  const current = loadBaseline(path);
  // Compute BOTH layers BEFORE any write: a rejected shrink (GF-07, an
  // unknown family fingerprint, a missing receipt) leaves the repo byte-
  // identical — an all-or-nothing update can never half-apply.
  const recordPath = join(dirname(path), ADOPTION_RECORD_FILENAME);
  const nextBaseline = fingerprints.length > 0 ? updateBaseline(current, fingerprints) : null;
  let record: AdoptionRecord | null = null;
  let nextRecord: AdoptionRecord | null = null;
  if (
    classificationFlagValues.length > 0 ||
    familyFlagValues.length > 0 ||
    httpCallsFlagValues.length > 0
  ) {
    record = loadAdoptionRecord(recordPath);
    if (record === null) {
      // Fail closed: without an adoption receipt there is no adopted
      // classification set and no family marker, so there is nothing to
      // shrink — and a shrink must never fabricate the layer it operates
      // on.
      throw new UsageError(
        `no adoption record at ${recordPath} — the adopted layers are only ` +
          'shrinkable after `gateforge adopt` recorded them',
      );
    }
    nextRecord = record;
    if (classificationFlagValues.length > 0) {
      nextRecord = shrinkClassificationBlocked(nextRecord, classificationIds);
    }
    if (familyFlagValues.length > 0) {
      nextRecord = shrinkFamilyForgiven(nextRecord, 'pages', familyKeep);
    }
    if (httpCallsFlagValues.length > 0) {
      nextRecord = shrinkFamilyForgiven(nextRecord, 'http-calls', httpCallsKeep);
    }
  }
  if (nextBaseline !== null) {
    writeBaseline(path, nextBaseline);
    writeLine(
      io.stdout,
      `baseline updated: ${nextBaseline.fingerprints.length} fingerprint(s) (was ${current.fingerprints.length})`,
    );
  }
  if (nextRecord !== null && record !== null) {
    if (classificationFlagValues.length > 0) {
      writeLine(
        io.stdout,
        `classification set updated: ${(nextRecord.classificationBlocked ?? []).length} resource(s) remain adopted (was ${(record.classificationBlocked ?? []).length})`,
      );
    }
    if (familyFlagValues.length > 0) {
      writeLine(
        io.stdout,
        `pages family updated: ${nextRecord.families?.pages?.forgiven.length ?? 0} fingerprint(s) remain forgiven (was ${record.families?.pages?.forgiven.length ?? 0}); the family marker is retained`,
      );
    }
    if (httpCallsFlagValues.length > 0) {
      writeLine(
        io.stdout,
        `http-calls family updated: ${nextRecord.families?.['http-calls']?.forgiven.length ?? 0} fingerprint(s) remain forgiven (was ${record.families?.['http-calls']?.forgiven.length ?? 0}); the family marker is retained`,
      );
    }
    writeAdoptionRecord(recordPath, nextRecord);
  }
  return 0;
}