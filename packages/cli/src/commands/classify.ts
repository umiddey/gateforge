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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  ClassificationPolicySchema,
  DeleteRulesSchema,
  globMatch,
  type DeleteRule,
  type JsonValue,
} from '@gate-forge/core';
import {
  PLANES_CONFIG_PATH,
  parsePlanesConfigText,
  type SqlalchemyPlane,
} from '@gate-forge/pack-sqlalchemy';
import { parseDocument, parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseArgs, repeatableStringFlag, stringFlag } from '../args.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { runPipeline, resolveRepoPath } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { UsageError } from '../errors.js';

export const CLASSIFY_USAGE =
  'usage: gateforge classify [--json] [--write-snapshot <path>] | gateforge classify plane <file|folder|glob> <tenant|master|global> ' +
  '--reason <text> [--confirm] | gateforge classify delete <file|folder|glob> <hard|archive> ' +
  '[--archive-field <key=value>]... --reason <text> [--confirm]';
export const CLASSIFY_PLANE_USAGE =
  'usage: gateforge classify plane <file|folder|glob> <tenant|master|global> --reason <text> [--confirm]';
export const CLASSIFY_DELETE_USAGE =
  'usage: gateforge classify delete <file|folder|glob> <hard|archive> [--archive-field <key=value>]... --reason <text> [--confirm]';

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
 *   text: reviewed classification input content.
 *
 * Returns:
 *   string[]: config lines with line endings removed.
 */
function configLines(text: string): string[] {
  if (text.length === 0) return [];
  const result = text.replace(/\r\n/g, '\n').split('\n');
  if (result[result.length - 1] === '') result.pop();
  return result;
}

/**
 * Formats an exact line-level diff between classification-input contents.
 *
 * Args:
 *   path: repo-relative config path.
 *   before: existing config contents, or an empty string if absent.
 *   after: proposed config contents.
 *
 * Returns:
 *   string: a unified diff showing every changed line.
 */
function configDiff(path: string, before: string, after: string): string {
  const oldLines = configLines(before);
  const newLines = configLines(after);
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
 * Resolves the `<file|folder|glob>` argument into the `match` pattern the
 * reviewed document carries, plus the wording the messages use.
 *
 * A FOLDER becomes `'<folder>/**'` — the same rule shape the plane
 * proposals write, so classifying 200 routes in `backend/api/v1` is one
 * reviewed answer instead of 200 hand-edited lines. A GLOB is used
 * verbatim after validation. Anything else is one file path, exactly as
 * before. Every form stays repo-relative: an absolute, drive-qualified,
 * backslashed or `..`-escaping source is refused, so a rule can never
 * point outside the repository the gate reads.
 *
 * Args:
 *   source: The raw `<file|folder|glob>` argument.
 *   cwd: Absolute repository root (used to recognize an existing folder).
 *   usage: The calling subcommand's usage line (the refusal quotes it).
 *
 * Returns:
 *   { match: string; label: string }: the rule's `match` pattern and the
 *     human wording ("backend/api/v1/**" reads better in a refusal than a
 *     bare folder name).
 *
 * Raises:
 *   UsageError: The source is not one repo-relative file path, folder, or
 *     glob.
 */
function resolveSourceMatch(source: string, cwd: string, usage: string): { match: string; label: string } {
  const segments = source.split('/');
  const malformed =
    source.length === 0 ||
    source !== source.trim() ||
    source.includes('\\') ||
    source.startsWith('/') ||
    /^[A-Za-z]:/.test(source) ||
    segments.includes('..') ||
    segments.includes('');
  if (malformed) {
    throw new UsageError(
      `classify source must be one repo-relative file path, folder, or glob (${usage})`,
    );
  }
  // A glob is the owner's own pattern: validated as repo-relative here and
  // matched verbatim by the runtime.
  if (/[*?[\]{}]/.test(source)) return { match: source, label: source };
  // An existing directory classifies its whole subtree; the rule the
  // proposal writes uses exactly this shape.
  if (existsSync(join(cwd, source)) && statSync(join(cwd, source)).isDirectory()) {
    return { match: `${source}/**`, label: `${source}/**` };
  }
  return { match: source, label: source };
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
  const { match, label } = resolveSourceMatch(source, io.cwd, CLASSIFY_PLANE_USAGE);
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
  // Overlap is tested in BOTH directions: a broader existing rule already
  // covers the new pattern, and a broader new pattern would swallow a
  // narrower existing rule. Either way an answer is already on record, and
  // a disagreeing one must be edited, never shadowed by a second rule.
  const overlapping = current.rules.filter(
    (rule) =>
      rule.match !== undefined &&
      !(rule.exclude ?? []).some((excluded) => globMatch(match, excluded)) &&
      (globMatch(match, rule.match) || globMatch(rule.match, match)),
  );
  const conflicting = overlapping.filter((rule) => rule.plane !== planeValue);
  if (conflicting.length > 0) {
    // The refusal must be answerable from its own output: it used to name
    // the FILE to edit but not the rule inside it, so the owner had to go
    // hunting through the document to undo a wrong answer — and this
    // command is the only way the product ever suggests that answer, so
    // there was no other way back from it.
    throw new UsageError(
      `classify plane will not add a conflicting rule for '${label}'; edit the existing owner-reviewed rule in '${PLANES_CONFIG_PATH}':\n` +
        conflicting
          .map(
            (rule) =>
              `  rule with match '${rule.match}' has plane '${rule.plane}'; change its \`plane\` key to '${planeValue}'` +
              ` (and its \`reason\` to your own words) to classify '${label}'`,
          )
          .join('\n'),
    );
  }
  if (overlapping.length > 0) {
    writeLine(io.stdout, `${label} already has the reviewed ${planeValue} plane in ${PLANES_CONFIG_PATH}; no change`);
    return 0;
  }

  const rule = { match, plane: planeValue as SqlalchemyPlane, reason: reason.trim() };
  const after = `${JSON.stringify({ rules: [...current.rules, rule] }, null, 2)}\n`;
  writeLine(io.stdout, configDiff(PLANES_CONFIG_PATH, before, after));
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
 * Previews or explicitly appends one owner delete-semantics rule to the
 * classification policy.
 *
 * Declaring semantics is an evidence CONTRACT, not a suppression: the rule
 * can only resolve DELETE_SEMANTICS_UNRESOLVED for the resources whose
 * source file it matches. Detector evidence that disagrees still blocks,
 * so this command can never quietly change what a run grades.
 *
 * Args:
 *   io: process context.
 *   argv: arguments after `classify`.
 *
 * Returns:
 *   Promise<number>: zero for a preview or write, two for invalid input.
 */
async function classifyDeleteCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, CLASSIFY_DELETE_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['help', 'reason', 'confirm', 'archive-field'], CLASSIFY_DELETE_USAGE);
  if (positionals.length !== 3 || positionals[0] !== 'delete') {
    throw new UsageError(CLASSIFY_DELETE_USAGE);
  }
  const source = positionals[1] as string;
  const semantics = positionals[2] as string;
  if (semantics !== 'hard' && semantics !== 'archive') {
    throw new UsageError(`classify delete requires hard or archive (${CLASSIFY_DELETE_USAGE})`);
  }
  const reason = stringFlag(options, 'reason');
  if (reason === undefined || reason.trim().length === 0) {
    throw new UsageError(`classify delete requires --reason (${CLASSIFY_DELETE_USAGE})`);
  }
  const archiveFields: Record<string, string> = {};
  for (const entry of repeatableStringFlag(options, 'archive-field') ?? []) {
    const separator = entry.indexOf('=');
    const key = separator === -1 ? '' : entry.slice(0, separator).trim();
    const value = separator === -1 ? '' : entry.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new UsageError(
        `--archive-field must be key=value with both parts set (${CLASSIFY_DELETE_USAGE})`,
      );
    }
    archiveFields[key] = value;
  }
  const archiveFieldCount = Object.keys(archiveFields).length;
  if (semantics === 'archive' && archiveFieldCount === 0) {
    throw new UsageError(
      `classify delete archive needs the owner-owned archived state the run grades removal against: ` +
        `pass --archive-field <key=value> at least once (${CLASSIFY_DELETE_USAGE})`,
    );
  }
  if (semantics === 'hard' && archiveFieldCount > 0) {
    throw new UsageError(
      `classify delete hard removes the row: --archive-field applies to archive semantics only ` +
        `(${CLASSIFY_DELETE_USAGE})`,
    );
  }

  const { match, label } = resolveSourceMatch(source, io.cwd, CLASSIFY_DELETE_USAGE);
  const policyPath = loadConfigAt(io.cwd).classificationPolicy;
  const path = resolveRepoPath(io.cwd, policyPath);
  if (!existsSync(path)) {
    throw new UsageError(
      `classify delete updates only an existing owner-reviewed '${policyPath}'; add the reviewed file before using this command`,
    );
  }
  const before = readFileSync(path, 'utf8');
  // The YAML document API (not a re-serialization) keeps the owner's
  // comments and key order byte for byte.
  const document = parseDocument(before);
  const existing = document.get('deleteRules');
  const parsed = DeleteRulesSchema.safeParse(existing === undefined || existing === null ? [] : existing);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(
      `'${policyPath}' carries a deleteRules block this command cannot read ` +
        `(${issue?.path.join('.') ?? 'deleteRules'}: ${issue?.message ?? 'invalid rule'})`,
    );
  }
  const current: DeleteRule[] = parsed.data;
  const declared = current.find((rule) => rule.match === match);
  if (declared !== undefined) {
    const declaredFields = declared.archiveFields ?? {};
    const same =
      declared.semantics === semantics &&
      Object.keys(declaredFields).length === archiveFieldCount &&
      Object.entries(archiveFields).every(([key, value]) => declaredFields[key] === value);
    if (same) {
      writeLine(io.stdout, `${label} already declares ${semantics} delete semantics in ${policyPath}; no change`);
      return 0;
    }
    throw new UsageError(
      `classify delete will not add a second rule for '${label}'; edit the existing owner-reviewed rule in '${policyPath}':\n` +
        `  rule with match '${match}' declares semantics '${declared.semantics}'; change its \`semantics\` key to '${semantics}'` +
        ' (and its `reason` to your own words), or narrow this command to another source',
    );
  }

  const rule: DeleteRule = {
    match,
    semantics,
    ...(archiveFieldCount > 0 ? { archiveFields } : {}),
    reason: reason.trim(),
  };
  document.set('deleteRules', [...current, rule]);
  const after = document.toString();
  const validated = ClassificationPolicySchema.safeParse(parseYaml(after));
  if (!validated.success) {
    throw new UsageError(
      `refusing to write a '${policyPath}' this release cannot read back: ${validated.error.issues[0]?.message ?? 'invalid policy'}`,
    );
  }
  writeLine(io.stdout, configDiff(policyPath, before, after));
  writeLine(io.stdout, `${policyPath} is an owner-reviewed classification input.`);
  writeLine(
    io.stdout,
    'If an approved policy pin is in use, this changes the trusted-policy digest and must be re-approved before strict gates run.',
  );
  if (options['confirm'] !== true) {
    writeLine(io.stdout, 'dry run only; rerun this command with --confirm to write the rule');
    return 0;
  }
  writeFileSync(path, after, 'utf8');
  writeLine(io.stdout, `updated ${policyPath}`);
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
  if (positionals[0] === 'delete') return classifyDeleteCommand(io, argv);
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
