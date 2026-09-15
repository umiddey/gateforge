/**
 * `gateforge adopt` (phase 8 workstream C): retroactive enforcement for
 * existing repos. One command, three loud steps:
 *
 * 1. Runs the compile + static gate (the same pipeline as `check`,
 *    all-files scope) and captures every currently-unresolved
 *    fingerprint — blocking obligation verdicts via the pin-#2
 *    obligation fingerprint, blocking entries (unclassified/unresolved
 *    resources, detector/graph findings, stale references) via the
 *    whole-entry fingerprint — PLUS the classification-blocked RESOURCE
 *    identities ([classification] entries and their `unclassified`
 *    shadows) as the receipt's classification layer (two-layer
 *    adoption): resource-scoped, merge-stable identity where the
 *    whole-entry fingerprint is not (detail text and line numbers move
 *    in an upstream merge; a plane-unresolved resource has no
 *    plane-qualified id at all).
 * 2. Writes those fingerprints as the INITIAL baseline via
 *    `adoptBaseline` — THE ONE SANCTIONED BULK-ADD this engine ever
 *    performs. It is sanctioned by a loud sibling receipt,
 *    `.gateforge/baselines/adoption.json` (dated, count-annotated,
 *    commit-referenced, and carrying the adopted `classificationBlocked`
 *    resource set); `check` honors a baseline only when that record
 *    exists, so the bulk-add can never act silently. Everything after
 *    adoption stays fail-closed: `baseline update` remains
 *    subset-only (GF-07/08), new debt blocks, and both adopted layers
 *    are SHRINK-ONLY from here.
 * 3. Applies the enforcement wiring through the shared `init --blocking`
 *    path (pre-commit hook block + CI template + engine reference),
 *    idempotent like every gateforge write.
 *
 * Idempotence / invariant: a second `adopt` on an already-adopted repo
 * is a NO-OP SUCCESS (exit 0) that refuses the second bulk-add and
 * points at `gateforge baseline update` — never an error, never a
 * re-seed. Crash-consistency note: the baseline is written BEFORE the
 * record; a crash in between leaves an unrecorded baseline, which
 * forgives nothing (record-gated) and which the next `adopt` replaces
 * with the freshly verified red set — the record's existence, not the
 * file's, is what sanctions forgiveness.
 */
import { existsSync } from 'node:fs';
import {
  ADOPTION_RECORD_FILENAME,
  adoptBaseline,
  adoptClassificationBlocked,
  blockingEntryFingerprint,
  BLOCKING_VERDICTS,
  classificationBlockedIdentity,
  loadAdoptionRecord,
  loadBaseline,
  writeAdoptionRecord,
  writeBaseline,
} from '@gateforge/core';
import { dirname, join } from 'node:path';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { evaluateRun, obligationFingerprint } from '../evaluate.js';
import { headSha, resolveRepoPath, runPipeline } from '../pipeline.js';
import { engineRootFromInvocation, ensureBlockingWiring } from './blocking.js';
import { loadConfigAt } from './common.js';

export const ADOPT_USAGE = 'usage: gateforge adopt';

/** Groups the adopted red set by source for the adoption report. */
function groupReds(reds: ReadonlyMap<string, string>): string[] {
  const counts = new Map<string, number>();
  for (const label of reds.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(
    ([label, count]) => `  ${label}: ${count}`,
  );
}

/**
 * Runs the adopt subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand (none supported beyond --help).
 *
 * Returns:
 *   number: exit code — 0 adopted (or idempotent no-op), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/pipeline/baseline layers.
 */
export async function adoptCommand(io: Io, argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeLine(io.stdout, ADOPT_USAGE);
    return 0;
  }
  if (argv.length > 0) {
    throw new UsageError(`unknown arguments for adopt (${ADOPT_USAGE}): ${argv.join(' ')}`);
  }
  if (!existsSync(join(io.cwd, '.gateforge.yml'))) {
    throw new UsageError('no .gateforge.yml found — run `gateforge init` first');
  }

  const config = loadConfigAt(io.cwd);
  const baselinePath = resolveRepoPath(io.cwd, config.baselines);
  const recordPath = join(dirname(baselinePath), ADOPTION_RECORD_FILENAME);

  // INVARIANT: exactly one bulk-add per repo, keyed on the receipt's
  // existence. Already adopted → re-assert the wiring (idempotent),
  // refuse the re-seed, exit 0.
  const existingRecord = loadAdoptionRecord(recordPath);
  if (existingRecord !== null) {
    ensureBlockingWiring(io, engineRootFromInvocation());
    const adoptedClassifications = existingRecord.classificationBlocked?.length ?? 0;
    writeLine(
      io.stdout,
      `already adopted at ${existingRecord.adoptedAt} — ${existingRecord.adopted} fingerprint(s) in the baseline` +
        (existingRecord.classificationBlocked !== undefined
          ? ` + ${adoptedClassifications} classification-blocked resource(s) in the receipt`
          : ' (receipt predates the classification layer: not adopted for it)') +
        '; a second bulk-add is refused (GF-07/08). Shrink as debt resolves: `gateforge baseline update`.',
    );
    return 0;
  }

  // Step 1: the compile + static gate, all-files — adoption captures
  // ALL current debt, not a diff's worth. The verdict pass runs through
  // the same evaluator `check` uses, with forgiveness DISABLED (baseline:
  // null) — the red set must be captured raw, never pre-forgiven.
  const stateDir = join(io.cwd, '.gateforge', 'test-gates');
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });
  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    obligations: pipeline.policy.obligations,
    blocking: pipeline.policy.blocking,
    stateDir,
    now: pipeline.now,
    changedFiles: null,
    baseline: null,
  });
  const reds = new Map<string, string>();
  // The classification layer (two-layer adoption): the resource ids of
  // the classification-blocked ([classification] entries with a derived
  // identity, plus their `unclassified` shadows — the same resource's
  // definitional block), captured as the adopted starting point alongside
  // the fingerprint baseline. Identity, not the whole-entry fingerprint:
  // a plane-unresolved resource has no plane-qualified id, and its bare
  // name survives upstream merges that shift every line number.
  const classificationBlocked = new Set<string>();
  let proven = 0;
  for (const verdict of evaluated.verdicts) {
    if (!BLOCKING_VERDICTS.includes(verdict.verdict)) {
      proven += 1;
      continue;
    }
    reds.set(obligationFingerprint(verdict.obligation), `verdict:${verdict.verdict}`);
  }
  for (const entry of evaluated.blocking) {
    reds.set(blockingEntryFingerprint(entry), `entry:${entry.kind}`);
    const identity = classificationBlockedIdentity(entry);
    if (identity !== null) classificationBlocked.add(identity);
  }

  // An unadopted baseline can only be a crashed previous adopt or a
  // hand-edit; either way it is UNRECORDED, so it forgives nothing today
  // and is replaced (not merged — merging would launder unverified
  // fingerprints into the sanctioned set) by the freshly captured red set.
  if (existsSync(baselinePath)) {
    const existing = loadBaseline(baselinePath);
    if (existing.fingerprints.length > 0) {
      writeLine(
        io.stdout,
        `warning: replacing unrecorded baseline content (${existing.fingerprints.length} fingerprint(s) ` +
          'with no adoption record — unrecorded baselines forgive nothing) with the verified red set',
      );
    }
  }

  // Step 2: the sanctioned bulk-add, receipt written last (see module
  // doc for the crash window — the state in between forgives nothing).
  // The receipt carries BOTH adopted layers: the fingerprint baseline and
  // the classification-blocked resource ids (sorted, unique, possibly
  // empty — the field's presence is this receipt claiming the layer).
  writeBaseline(baselinePath, adoptBaseline([...reds.keys()]));
  writeAdoptionRecord(recordPath, {
    schemaVersion: 1,
    adoptedAt: pipeline.now,
    gitSha: headSha(io.cwd),
    adopted: reds.size,
    proven,
    classificationBlocked: adoptClassificationBlocked([...classificationBlocked]),
  });

  // Step 3: enforcement wiring through the shared init --blocking path.
  ensureBlockingWiring(io, engineRootFromInvocation());

  // The adoption report: counts, groups, wiring, and the standing rule.
  writeLine(io.stdout, `adopted as forgiven: ${reds.size}; already proven: ${proven}`);
  if (reds.size > 0) {
    writeLine(io.stdout, 'adoption set (grouped):');
    for (const line of groupReds(reds)) writeLine(io.stdout, line);
  }
  writeLine(
    io.stdout,
    `classification layer adopted: ${classificationBlocked.size} blocked resource(s) recorded in the receipt ` +
      '(waived by identity; the set is shrink-only — a resource leaves it via `gateforge baseline update ' +
      '--classification-blocked` once it carries a real classification)',
  );
  writeLine(io.stdout, `adoption record: ${recordPath} (${pipeline.now})`);
  writeLine(
    io.stdout,
    'the baseline is shrink-only from here: resolve debt and run `gateforge baseline update` (GF-07/08 unchanged); ' +
      'new unproven work blocks (check exits 1).',
  );
  return 0;
}
