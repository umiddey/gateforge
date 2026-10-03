/**
 * `gateforge classify`: run detectors + the deterministic classifier and
 * report every resource's effective classification and typed blocks.
 *
 * `--json` prints the GF-canonical JSON of the classification result
 * (decisions with traces, stale/invalid signals) plus the derived
 * effective-classification view; the default text form renders one
 * decision per resource: exposure/plane/primaryKey/rules/defaults plus
 * every typed block with its locations. `--write-snapshot <path>` writes
 * the derived effective-classification view document for review — the
 * pipeline NEVER reads it back as input (ADR 0003 D5).
 *
 * `classify` and `check` share the identical pipeline, so their
 * effective decisions agree byte-for-byte (phase-5 checklist).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { canonicalJson, globMatch, type JsonValue } from '@gate-forge/core';
import {
  PLANES_CONFIG_PATH,
  parsePlanesConfigText,
  type SqlalchemyPlane,
} from '@gate-forge/pack-sqlalchemy';
import { stringify as stringifyYaml } from 'yaml';
import { parseArgs, stringFlag } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { runPipeline, resolveRepoPath } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { UsageError } from '../errors.js';

export const CLASSIFY_USAGE =
  'usage: gateforge classify [--json] [--write-snapshot <path>] | gateforge classify plane <source> <tenant|master|global> ' +
  '--reason <text> [--confirm]';
export const CLASSIFY_PLANE_USAGE =
  'usage: gateforge classify plane <source> <tenant|master|global> --reason <text> [--confirm]';

/** Renders the text form of one classification pass. */
function describeResult(io: Io, pipeline: Awaited<ReturnType<typeof runPipeline>>): void {
  const { graph, classification } = pipeline;
  writeLine(io.stdout, `decisions (${String(classification.decisions.length)}):`);
  for (const resource of graph.resources) {
    const id = resource.id ?? `<unresolved:${resource.name}>`;
    const classificationEntry = resource.classification;
    const trace = resource.classificationTrace;
    writeLine(
      io.stdout,
      `  ${id} [${resource.kind}] ${resource.source}:${String(resource.location.line)}`,
    );
    if (classificationEntry === null || trace === null) {
      writeLine(io.stdout, '    classification: BLOCKED (see blocks below)');
      continue;
    }
    writeLine(
      io.stdout,
      `    exposure: ${String(classificationEntry.exposure)}  plane: ${String(classificationEntry.plane)}  ` +
        `primaryKey: [${classificationEntry.primaryKey.join(', ')}]` +
        (classificationEntry.evidenceAdapter !== undefined
          ? `  adapter: ${classificationEntry.evidenceAdapter}`
          : ''),
    );
    writeLine(
      io.stdout,
      `    lifecycle: create=${String(classificationEntry.lifecycle.create)} read=${String(classificationEntry.lifecycle.read)} ` +
        `update=${String(classificationEntry.lifecycle.update)} delete=${String(classificationEntry.lifecycle.delete)}` +
        (classificationEntry.lifecycle.deleteSemantics !== undefined
          ? ` (${classificationEntry.lifecycle.deleteSemantics})`
          : ' (semantics UNRESOLVED)'),
    );
    writeLine(io.stdout, `    rules: ${trace.rules.join(', ')}`);
    if (trace.defaultsApplied.length > 0) {
      writeLine(io.stdout, `    defaults: ${trace.defaultsApplied.join(', ')}`);
    }
    if (trace.contradictions.length > 0) {
      for (const contradiction of trace.contradictions) {
        writeLine(io.stdout, `    contradiction [${contradiction.dimension}]: ${contradiction.detail}`);
      }
    }
    writeLine(
      io.stdout,
      `    fingerprint: ${trace.decisionFingerprint}  signals: ${String(trace.contributingSignalIds.length)}`,
    );
  }
  const blockCount =
    classification.decisions.reduce((sum, decision) => sum + decision.blocks.length, 0) +
    classification.staleTargets.length +
    classification.invalidSignals.length +
    classification.unauthorizedSuppressive.length;
  writeLine(io.stdout, `blocks (${String(blockCount)}):`);
  for (const decision of classification.decisions) {
    for (const block of decision.blocks) {
      const where = block.locations
        .map((location) => `${location.file}:${String(location.line)}`)
        .join(', ');
      writeLine(
        io.stdout,
        `  [${block.code}] ${decision.resourceId ?? decision.name} — ${block.detail}` +
          (where.length > 0 ? ` (${where})` : ''),
      );
    }
  }
  for (const stale of classification.staleTargets) {
    writeLine(io.stdout, `  [${stale.code}] ${stale.detail}`);
  }
  for (const invalid of classification.invalidSignals) {
    writeLine(io.stdout, `  [${invalid.code}] ${invalid.detail}`);
  }
  for (const unauthorized of classification.unauthorizedSuppressive) {
    writeLine(io.stdout, `  [${unauthorized.code}] ${unauthorized.detail}`);
  }
}

/**
 * Splits config text into comparable lines without a synthetic trailing row.
 *
 * Args:
 *   text: plane config content.
 *
 * Returns:
 *   string[]: config lines with line endings removed.
 */
function planeConfigLines(text: string): string[] {
  if (text.length === 0) return [];
  const result = text.replace(/\r\n/g, '\n').split('\n');
  if (result[result.length - 1] === '') result.pop();
  return result;
}

/**
 * Formats an exact line-level diff between plane config contents.
 *
 * Args:
 *   path: repo-relative config path.
 *   before: existing config contents, or an empty string if absent.
 *   after: proposed config contents.
 *
 * Returns:
 *   string: a unified diff showing every changed line.
 */
function planeConfigDiff(path: string, before: string, after: string): string {
  const oldLines = planeConfigLines(before);
  const newLines = planeConfigLines(after);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const oldStart = removed.length === 0 ? prefix : prefix + 1;
  const newStart = added.length === 0 ? prefix : prefix + 1;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

/**
 * Previews or explicitly appends a non-suppressive plane declaration.
 *
 * Args:
 *   io: process context.
 *   argv: arguments after `classify`.
 *
 * Returns:
 *   Promise<number>: zero for a preview or write, two for invalid input.
 */
async function classifyPlaneCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, CLASSIFY_PLANE_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['help', 'reason', 'confirm'], CLASSIFY_PLANE_USAGE);
  if (positionals.length !== 3 || positionals[0] !== 'plane') {
    throw new UsageError(CLASSIFY_PLANE_USAGE);
  }
  const source = positionals[1] as string;
  const planeValue = positionals[2] as string;
  const reason = stringFlag(options, 'reason');
  if (
    source.length === 0 ||
    source !== source.trim() ||
    source.includes('\\') ||
    source.startsWith('/') ||
    /^[A-Za-z]:/.test(source) ||
    source.split('/').includes('..') ||
    /[*?[\]{}]/.test(source)
  ) {
    throw new UsageError(`classify plane source must be one repo-relative file path (${CLASSIFY_PLANE_USAGE})`);
  }
  if (!['tenant', 'master', 'global'].includes(planeValue)) {
    throw new UsageError(`classify plane requires tenant, master, or global (${CLASSIFY_PLANE_USAGE})`);
  }
  if (reason === undefined || reason.trim().length === 0) {
    throw new UsageError(`classify plane requires --reason (${CLASSIFY_PLANE_USAGE})`);
  }

  const path = resolveRepoPath(io.cwd, PLANES_CONFIG_PATH);
  if (!existsSync(path)) {
    throw new UsageError(
      `classify plane updates only an existing owner-reviewed '${PLANES_CONFIG_PATH}'; add the reviewed file before using this command`,
    );
  }
  const before = readFileSync(path, 'utf8');
  const current = parsePlanesConfigText(before, path);
  const overlapping = current.rules.filter(
    (rule) =>
      rule.match !== undefined &&
      globMatch(source, rule.match) &&
      !(rule.exclude ?? []).some((excluded) => globMatch(source, excluded)),
  );
  const conflicting = overlapping.filter((rule) => rule.plane !== planeValue);
  if (conflicting.length > 0) {
    // The refusal must be answerable from its own output: it used to name
    // the FILE to edit but not the rule inside it, so the owner had to go
    // hunting through the document to undo a wrong answer — and this
    // command is the only way the product ever suggests that answer, so
    // there was no other way back from it.
    throw new UsageError(
      `classify plane will not add a conflicting rule for '${source}'; edit the existing owner-reviewed rule in '${PLANES_CONFIG_PATH}':\n` +
        conflicting
          .map(
            (rule) =>
              `  rule with match '${rule.match}' has plane '${rule.plane}'; change its \`plane\` key to '${planeValue}'` +
              ` (and its \`reason\` to your own words) to classify '${source}'`,
          )
          .join('\n'),
    );
  }
  if (overlapping.length > 0) {
    writeLine(io.stdout, `${source} already has the reviewed ${planeValue} plane in ${PLANES_CONFIG_PATH}; no change`);
    return 0;
  }

  const rule = { match: source, plane: planeValue as SqlalchemyPlane, reason: reason.trim() };
  const after = `${JSON.stringify({ rules: [...current.rules, rule] }, null, 2)}\n`;
  writeLine(io.stdout, planeConfigDiff(PLANES_CONFIG_PATH, before, after));
  writeLine(io.stdout, `${PLANES_CONFIG_PATH} is an owner-reviewed classification input.`);
  writeLine(
    io.stdout,
    'If an approved policy pin is in use, this changes the trusted-policy digest and must be re-approved before strict gates run.',
  );
  if (options['confirm'] !== true) {
    writeLine(io.stdout, 'dry run only; rerun this command with --confirm to write the rule');
    return 0;
  }
  writeFileSync(path, after, 'utf8');
  writeLine(io.stdout, `updated ${PLANES_CONFIG_PATH}`);
  return 0;
}

/**
 * Runs the classify subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 when every decision is block-free, 1 when any
 *   typed classification block exists (fail visible), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function classifyCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (positionals[0] === 'plane') return classifyPlaneCommand(io, argv);
  if (options['help'] === true) {
    writeLine(io.stdout, CLASSIFY_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['json', 'write-snapshot', 'help'], CLASSIFY_USAGE);
  const asJson = options['json'] === true;
  const snapshot = stringFlag(options, 'write-snapshot');

  const config = loadConfigAt(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir: resolveStateDir(io.cwd),
  });

  if (asJson) {
    writeLine(
      io.stdout,
      canonicalJson({
        schemaVersion: 1 as const,
        classification: pipeline.classification as unknown as JsonValue,
        classifications: pipeline.classificationsView as unknown as JsonValue,
      }),
    );
  } else {
    describeResult(io, pipeline);
  }

  if (snapshot !== undefined) {
    writeFileSync(snapshot, stringifyYaml(pipeline.classificationsView), 'utf8');
    writeLine(
      io.stdout,
      `snapshot written (derived artifact, never authoritative input): ${snapshot}`,
    );
  }

  const blocked = pipeline.policy.blocking.filter(
    (entry) => entry.kind === 'classification' || entry.kind === 'unclassified',
  );
  return blocked.length > 0 ? 1 : 0;
}
