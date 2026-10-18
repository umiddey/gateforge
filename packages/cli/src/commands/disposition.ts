/**
 * `gateforge disposition extend <endpoint-id|table>`: rewrite ONE owner
 * disposition's `expiresAt` in the document that owns it — the
 * `behaviorPolicy` document for endpoints, the `coveragePolicy` section
 * of `.gateforge.yml` for tables — and append an audit entry to the
 * disposition's `extensions` list.
 *
 * The command is a TEXT EDIT of trusted policy, nothing more: it never
 * pins, never approves a digest, and never runs the gate. The edited
 * revision participates in the trusted-policy digest like any other
 * owner edit, so the printout names the existing digest/pin flow as the
 * next step (the gate refuses the revision until the owner re-approves
 * it — by design, the same as any hand edit).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BehaviorDispositionSchema,
  BehaviorPolicySchema,
  CoverageDispositionSchema,
  DISPOSITION_MAX_DAYS,
  GateforgeConfigSchema,
  dispositionExpiry,
  type BehaviorDisposition,
  type CoverageDisposition,
  type GateforgeConfig,
} from '@gate-forge/core';
import {
  isMap,
  isSeq,
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
  type Document,
  type YAMLMap,
} from 'yaml';
import { parseArgs, stringFlag } from '../args.js';
import { clockFromConfig } from '../clock.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { resolveRepoPath } from '../repo-path.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';

export const DISPOSITION_USAGE =
  'usage: gateforge disposition extend <endpoint-id|table> --expires <ISO-date|datetime>\n' +
  '       --owner <name> --reason "why"\n' +
  '       Rewrites `expiresAt` on ONE owner disposition and records an audit entry in its\n' +
  '       `extensions` list. The target is a behaviorPolicy endpoint id or a coveragePolicy\n' +
  '       table name. An expired disposition blocks its endpoint/table until extended or\n' +
  `       rewritten. --expires must be in the future and no further than the configured\n` +
  `       maximum (${String(DISPOSITION_MAX_DAYS)} days by default, \`disposition.maxDays\`) out. A disposition\n` +
  '       without an `expiresAt` has no timer to extend (record one by editing the policy).\n' +
  '       This command only EDITS trusted policy — it never pins and never approves a\n' +
  '       digest; the existing digest/pin flow applies to the edited revision.';

/** Flags the command accepts (plus the implicit `help`). */
const DISPOSITION_FLAGS = ['owner', 'reason', 'expires', 'help'] as const;

/** A bare `--expires` date means UTC midnight of that day (waiver convention). */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** One located disposition inside its owning YAML document. */
interface LocatedDisposition {
  /** Whether the disposition follows the behavior document's shape. */
  isBehavior: boolean;
  /** The schema-validated disposition as it stands on disk. */
  previous: BehaviorDisposition | CoverageDisposition;
  /** The previous `expiresAt` — the audit entry's `previousExpiresAt`. */
  previousExpiresAt: string;
  /** Absolute path of the YAML file that owns the disposition. */
  documentPath: string;
  /** Human name of the document for messages. */
  documentLabel: string;
  /** Human name of the target for messages (`endpoint 'x'`). */
  targetLabel: string;
  /** The parsed document (comment/format preserving) to edit and write. */
  document: Document;
  /** The disposition mapping node the edit mutates. */
  dispositionNode: YAMLMap;
}

/** First zod issue of a document validation, as one readable line. */
function firstIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = error.issues[0];
  return issue === undefined ? 'unknown' : `${issue.path.join('.') || '<document>'}: ${issue.message}`;
}

/**
 * Refuses the two unusable states of a FOUND disposition: absent (the
 * target has no disposition at all) and timer-less (the audit entry's
 * `previousExpiresAt` must honestly name the replaced expiry, so a
 * disposition without an `expiresAt` has nothing to extend).
 */
function requireExpiringDisposition<T extends BehaviorDisposition | CoverageDisposition | undefined>(
  disposition: T,
  targetLabel: string,
): Exclude<T, undefined> & { expiresAt: string } {
  if (disposition === undefined) {
    throw new UsageError(
      `disposition extend: ${targetLabel} has no owner disposition to extend — record one in the policy first`,
    );
  }
  if (disposition.expiresAt === undefined) {
    throw new UsageError(
      `disposition extend: ${targetLabel} has no disposition \`expiresAt\` to extend — ` +
        'a disposition without a timer stands as written; record an expiresAt by editing the policy',
    );
  }
  // Both unusable states threw above, so the narrowed shape is proven at
  // runtime; TS cannot express that narrowing on an unresolved generic.
  return disposition as Exclude<T, undefined> & { expiresAt: string };
}

/**
 * The disposition mapping node of the endpoint/table at `index`, read
 * off the comment-preserving parse of the SAME text the typed view was
 * validated from.
 */
function dispositionNodeAt(document: Document, indexPath: readonly string[], index: number, targetLabel: string): YAMLMap {
  let node: unknown = document.contents;
  for (const key of indexPath) {
    node = isMap(node) ? node.get(key, true) : null;
  }
  const item = isSeq(node) ? node.items[index] : null;
  const disposition = isMap(item) ? item.get('disposition', true) : null;
  if (!isMap(disposition)) {
    throw new UsageError(
      `disposition extend: ${targetLabel} disposition is not a YAML mapping — fix the document by hand`,
    );
  }
  return disposition;
}

/**
 * Locates the named endpoint in the behaviorPolicy document. Returns
 * null when the id names no endpoint there; throws when the endpoint is
 * found but its disposition cannot be extended.
 *
 * Args:
 *   io: process context (cwd resolves the repo-relative document path).
 *   config: validated `.gateforge.yml`.
 *   target: the endpoint id to find (`resourceId`).
 *
 * Returns:
 *   LocatedDisposition | null.
 */
function locateBehaviorDisposition(
  io: Io,
  config: GateforgeConfig,
  target: string,
): LocatedDisposition | null {
  if (config.behaviorPolicy === undefined) return null;
  const documentPath = resolveRepoPath(io.cwd, config.behaviorPolicy);
  let raw: string;
  try {
    raw = readFileSync(documentPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new UsageError(`disposition extend: cannot read behavior policy file '${documentPath}' (${code})`);
  }
  // The typed lookup runs against the PRODUCTION schema, so the edit
  // never reasons about an unvalidated document.
  const parsed = BehaviorPolicySchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw new UsageError(
      `disposition extend: behavior policy '${config.behaviorPolicy}' is invalid: ${firstIssue(parsed.error)}`,
    );
  }
  const index = parsed.data.endpoints.findIndex((endpoint) => endpoint.resourceId === target);
  const endpoint = parsed.data.endpoints[index];
  if (index === -1 || endpoint === undefined) return null;
  const previous = requireExpiringDisposition(endpoint.disposition, `endpoint '${target}'`);
  const document = parseDocument(raw);
  return {
    isBehavior: true,
    previous,
    previousExpiresAt: previous.expiresAt,
    documentPath,
    documentLabel: `behavior policy '${config.behaviorPolicy}'`,
    targetLabel: `endpoint '${target}'`,
    document,
    dispositionNode: dispositionNodeAt(document, ['endpoints'], index, `endpoint '${target}'`),
  };
}

/**
 * Locates the named table in the `coveragePolicy` section of
 * `.gateforge.yml` (the config the command already loaded, validated).
 * Returns null when the name names no table there; throws when the
 * table is found but its disposition cannot be extended.
 *
 * Args:
 *   io: process context.
 *   config: validated `.gateforge.yml`.
 *   target: the table name to find.
 *
 * Returns:
 *   LocatedDisposition | null.
 */
function locateCoverageDisposition(
  io: Io,
  config: GateforgeConfig,
  target: string,
): LocatedDisposition | null {
  if (config.coveragePolicy === undefined) return null;
  const documentPath = join(io.cwd, '.gateforge.yml');
  const raw = readFileSync(documentPath, 'utf8');
  const index = config.coveragePolicy.tables.findIndex((table) => table.name === target);
  const table = config.coveragePolicy.tables[index];
  if (index === -1 || table === undefined) return null;
  const previous = requireExpiringDisposition(table.disposition, `table '${target}'`);
  const document = parseDocument(raw);
  return {
    isBehavior: false,
    previous,
    previousExpiresAt: previous.expiresAt,
    documentPath,
    documentLabel: `config '.gateforge.yml' coveragePolicy`,
    targetLabel: `table '${target}'`,
    document,
    dispositionNode: dispositionNodeAt(document, ['coveragePolicy', 'tables'], index, `table '${target}'`),
  };
}

/**
 * Every disposition-bearing id the two documents declare, for the
 * unknown-target diagnostic.
 */
function knownDispositionTargets(
  io: Io,
  config: GateforgeConfig,
): { endpoints: readonly string[]; tables: readonly string[] } {
  const endpoints: string[] = [];
  const tables: string[] = [];
  if (config.behaviorPolicy !== undefined) {
    try {
      const parsed = BehaviorPolicySchema.safeParse(
        parseYaml(readFileSync(resolveRepoPath(io.cwd, config.behaviorPolicy), 'utf8')),
      );
      if (parsed.success) {
        for (const endpoint of parsed.data.endpoints) endpoints.push(endpoint.resourceId);
      }
    } catch {
      // The location error above already named the unreadable document.
    }
  }
  if (config.coveragePolicy !== undefined) {
    for (const table of config.coveragePolicy.tables) tables.push(table.name);
  }
  return { endpoints, tables };
}

/** Cheap close-match suggestions for an unresolvable target id. */
function closeMatches(known: readonly string[], target: string): string[] {
  const needle = target.toLowerCase();
  return known
    .filter((candidate) => {
      const haystack = candidate.toLowerCase();
      return haystack.includes(needle) || needle.includes(haystack);
    })
    .slice(0, 5);
}

/**
 * Runs the `disposition` subcommand (today: `extend`).
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 disposition extended, 2 usage/validation.
 * @throws UsageError (exit 2) on any usage or fail-closed problem.
 */
export async function dispositionCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, DISPOSITION_USAGE);
    return 0;
  }
  const subcommand = positionals[0];
  if (subcommand !== 'extend') {
    throw new UsageError(
      `disposition requires the subcommand 'extend' as its first argument (${DISPOSITION_USAGE})`,
    );
  }
  const target = positionals[1];
  if (target === undefined || positionals.length > 2) {
    throw new UsageError(
      `disposition extend requires exactly one <endpoint-id|table> target (${DISPOSITION_USAGE})`,
    );
  }
  rejectUnknownFlags(options, DISPOSITION_FLAGS, DISPOSITION_USAGE);
  const owner = stringFlag(options, 'owner');
  const reason = stringFlag(options, 'reason');
  const rawExpires = stringFlag(options, 'expires');
  const missing = (
    [
      ['owner', owner],
      ['reason', reason],
      ['expires', rawExpires],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([name]) => `'--${name}'`);
  if (missing.length > 0) {
    throw new UsageError(`disposition extend requires ${missing.join(', ')} (${DISPOSITION_USAGE})`);
  }

  const config = loadConfigAt(io.cwd);
  // `clockFromConfig` is the same injected run clock every evaluator
  // uses — the wall clock never joins, and `clock.mode: fixed` repos get
  // deterministic audit entries.
  const now = clockFromConfig(config).now();
  const maxDurationMs = (config.disposition?.maxDays ?? DISPOSITION_MAX_DAYS) * 86_400_000;

  const located = locateBehaviorDisposition(io, config, target) ?? locateCoverageDisposition(io, config, target);
  if (located === null) {
    // The target must name something the policy actually declares: an
    // extend against a typo would silently never apply.
    const known = knownDispositionTargets(io, config);
    const candidates = [...known.endpoints, ...known.tables];
    if (candidates.length === 0) {
      throw new UsageError(
        `disposition extend: no endpoint or table named '${target}' — the behaviorPolicy and ` +
          'coveragePolicy documents declare no disposition targets at all',
      );
    }
    const suggestions = closeMatches(candidates, target);
    throw new UsageError(
      `disposition extend: no endpoint or table named '${target}'` +
        (suggestions.length > 0
          ? ` — policy targets: ${suggestions.join(', ')}`
          : ` — policy targets: ${candidates.slice(0, 5).join(', ')}`),
    );
  }

  // A bare date means UTC midnight of that day (waiver convention), and
  // the normalization is printed verbatim, never silent.
  const expiresAt =
    rawExpires !== undefined && DATE_ONLY.test(rawExpires)
      ? `${rawExpires}T00:00:00.000Z`
      : (rawExpires as string);

  const judgment = dispositionExpiry({ expiresAt }, { now, maxDurationMs });
  if (judgment.state === 'expired') {
    throw new UsageError(
      `disposition extend: --expires '${expiresAt}' is not in the future (injected run clock: ${now}) — ` +
        'an extension that is expired at creation would block, not extend',
    );
  }
  if (judgment.state === 'over-max') {
    throw new UsageError(
      `disposition extend: --expires '${expiresAt}' ${judgment.detail} — ` +
        'shorten it or raise `disposition.maxDays` in .gateforge.yml (a trusted-policy edit the owner re-approves)',
    );
  }

  // The updated disposition (previous fields + new expiry + the audit
  // entry) is validated through the production schema, and the edited
  // document through the production document schema, BEFORE anything is
  // written — a fail-closed edit, never a half-written policy.
  const extension = {
    at: now,
    by: owner as string,
    reason: reason as string,
    previousExpiresAt: located.previousExpiresAt,
  };
  const updatedDisposition = {
    ...located.previous,
    expiresAt,
    extensions: [...(located.previous.extensions ?? []), extension],
  };
  const parsed = located.isBehavior
    ? BehaviorDispositionSchema.safeParse(updatedDisposition)
    : CoverageDispositionSchema.safeParse(updatedDisposition);
  if (!parsed.success) {
    throw new UsageError(
      `disposition extend: updated disposition is invalid: ${firstIssue(parsed.error)}`,
    );
  }

  located.dispositionNode.set('expiresAt', expiresAt);
  located.dispositionNode.set('extensions', updatedDisposition.extensions);
  const updatedText = stringifyYaml(located.document);
  const edited = parseYaml(updatedText);
  const documentValid = located.isBehavior
    ? BehaviorPolicySchema.safeParse(edited)
    : GateforgeConfigSchema.safeParse(edited);
  if (!documentValid.success) {
    throw new UsageError(
      `disposition extend: the edited ${located.documentLabel} would not load: ${firstIssue(documentValid.error)}`,
    );
  }

  writeFileSync(located.documentPath, updatedText, 'utf8');

  const remainingDays = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / 86_400_000));
  writeLine(io.stdout, `disposition extended: ${located.targetLabel} in ${located.documentLabel}`);
  writeLine(
    io.stdout,
    `  expires: ${located.previousExpiresAt} -> ${expiresAt} (in ${String(remainingDays)} day${remainingDays === 1 ? '' : 's'})`,
  );
  writeLine(io.stdout, `  recorded: at=${extension.at} by=${extension.by}`);
  writeLine(io.stdout, `  reason: ${extension.reason}`);
  writeLine(
    io.stdout,
    'note: the policy changed — this edit participates in the trusted policy digest, so the pinned digest no\n' +
      '  longer matches and the gate refuses the revision until the owner re-approves it through the existing\n' +
      '  digest/pin flow (`gateforge enforcement pin --pin-file PATH --confirm`, outside the repo). This command\n' +
      '  never pins and never approves a digest.',
  );
  return 0;
}
