/**
 * Flaky-test quarantine loading (plan 20260925_2013 Phase 2).
 *
 * Owner-approved, always-expiring files in `.gateforge/quarantine/*.yml`
 * that remove ONE test from the required set. The same trust pattern as
 * waivers, with one difference in force: a quarantined test never
 * FORGIVES anything — it never blocks and its evidence is never used,
 * so an obligation only it covered stays `missing`.
 *
 * Fail-closed rules:
 * - ALL FOUR attribution fields (testKey, owner, approver, reason) plus
 *   the expiry are mandatory; a file missing any of them is a
 *   configuration error, never a partially-applied exception.
 * - Expiry is judged against the INJECTED clock, never the wall clock
 *   (invariant 7).
 * - A maximum duration is enforced: a quarantine may never outlive the
 *   documented ceiling, so a "temporary" escape hatch cannot become
 *   permanent by hand-editing the expiry.
 * - Two quarantines on the same test key are ambiguous → error.
 *
 * Loading is synchronous, matching the waivers loader.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { compareStrings } from '../graph/util.js';
import { QuarantineSchema, type Quarantine } from '../schemas/quarantine.js';
import { parseInstant } from '../verdict/index.js';

/** Maximum quarantine lifetime in days: a quarantine always expires. */
export const QUARANTINE_MAX_DAYS = 14;

/** The documented ceiling in milliseconds. */
export const QUARANTINE_MAX_DURATION_MS = QUARANTINE_MAX_DAYS * 86_400_000;

/** Repo-relative quarantine directory. */
export const QUARANTINE_DIR = '.gateforge/quarantine';

/** One fail-closed quarantine-loading problem (file-scoped, actionable). */
export interface QuarantineProblem {
  /** Quarantine file the problem was found in (basename). */
  file: string;
  /** Single-cause human explanation. */
  detail: string;
}

/** Error raised for any fail-closed quarantine configuration problem. */
export class GateforgeQuarantineError extends Error {
  /** Every problem found, file-scoped, in deterministic order. */
  readonly problems: readonly QuarantineProblem[];

  constructor(problems: readonly QuarantineProblem[]) {
    const rendered = problems.map((problem) => `  ${problem.file}: ${problem.detail}`).join('\n');
    super(
      `quarantine configuration failed closed with ${problems.length} problem(s):\n${rendered}`,
    );
    this.name = 'GateforgeQuarantineError';
    this.problems = problems;
  }
}

/** One loaded quarantine with its file and expiry state. */
export interface LoadedQuarantine {
  /** Basename of the file the record came from. */
  file: string;
  /** The schema-valid quarantine document. */
  quarantine: Quarantine;
}

/** Result of loading a quarantine directory against the injected clock. */
export interface QuarantineLoadResult {
  /** Unexpired quarantines — the required set minus these tests. */
  active: LoadedQuarantine[];
  /** Quarantines expired at the injected `now` — each one blocks. */
  expired: LoadedQuarantine[];
}

/** Options for {@link loadQuarantines}. */
export interface QuarantineLoadOptions {
  /** Injected clock instant (Date or ISO-8601) expiry is judged against. */
  now: Date | string;
  /** Maximum allowed lifetime; defaults to the documented 14 days. */
  maxDurationMs?: number;
}

/**
 * Parses one quarantine document (fail-closed: an empty or non-mapping
 * document is a problem, never an empty quarantine).
 *
 * Args:
 *   text: the raw file content.
 *
 * Returns:
 *   unknown: the parsed YAML mapping.
 *
 * @throws Error when the bytes are unparsable or not a mapping.
 */
function parseYamlDocument(text: string): unknown {
  const parsed = parseYaml(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'quarantine document must be a mapping with schemaVersion, testKey, owner, approver, reason, expiresAt',
    );
  }
  return parsed;
}

/**
 * Loads and validates every `*.yml` quarantine file in `dir` (sorted by
 * filename for determinism). A missing directory yields an empty result
 * — most repositories have no quarantines. Any problem (unparsable
 * YAML, missing mandatory field, duplicate test key, over-long duration)
 * fails closed with {@link GateforgeQuarantineError}.
 *
 * Args:
 *   dir: the quarantine directory (`.gateforge/quarantine`).
 *   options: injected clock and optional maximum duration.
 *
 * Returns:
 *   QuarantineLoadResult: active and expired partitions, both sorted by
 *   test key.
 *
 * @throws GateforgeQuarantineError when any file fails closed.
 */
export function loadQuarantines(
  dir: string,
  options: QuarantineLoadOptions,
): QuarantineLoadResult {
  const now = parseInstant(options.now);
  const maxDurationMs = options.maxDurationMs ?? QUARANTINE_MAX_DURATION_MS;
  if (!existsSync(dir)) return { active: [], expired: [] };
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
    .map((entry) => entry.name)
    .sort(compareStrings);

  const problems: QuarantineProblem[] = [];
  const parsed: LoadedQuarantine[] = [];
  for (const file of files) {
    let document: unknown;
    try {
      document = parseYamlDocument(readFileSync(join(dir, file), 'utf8'));
    } catch (error) {
      problems.push({
        file,
        detail: `not parsable YAML: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const result = QuarantineSchema.safeParse(document);
    if (!result.success) {
      for (const issue of result.error.issues) {
        problems.push({ file, detail: `${issue.path.join('.') || '<quarantine>'}: ${issue.message}` });
      }
      continue;
    }
    const duration = Date.parse(result.data.expiresAt) - now.getTime();
    if (duration > maxDurationMs) {
      problems.push({
        file,
        detail:
          `expiresAt '${result.data.expiresAt}' exceeds the maximum quarantine duration ` +
          `(${String(Math.round(maxDurationMs / 86_400_000))} days from now)`,
      });
      continue;
    }
    parsed.push({ file, quarantine: result.data });
  }

  const byTestKey = new Map<string, string>();
  for (const entry of parsed) {
    const firstFile = byTestKey.get(entry.quarantine.testKey);
    if (firstFile !== undefined) {
      problems.push({
        file: entry.file,
        detail:
          `test key '${entry.quarantine.testKey}' is already quarantined by '${firstFile}' — ` +
          'one quarantine per test, never two overlapping exceptions',
      });
      continue;
    }
    byTestKey.set(entry.quarantine.testKey, entry.file);
  }

  if (problems.length > 0) throw new GateforgeQuarantineError(problems);

  const active: LoadedQuarantine[] = [];
  const expired: LoadedQuarantine[] = [];
  for (const entry of parsed) {
    if (now.getTime() >= Date.parse(entry.quarantine.expiresAt)) expired.push(entry);
    else active.push(entry);
  }
  const byTest = (a: LoadedQuarantine, b: LoadedQuarantine) =>
    compareStrings(a.quarantine.testKey, b.quarantine.testKey);
  return { active: [...active].sort(byTest), expired: [...expired].sort(byTest) };
}

/**
 * Serializes one quarantine document in the stable on-disk form
 * (block YAML, trailing newline).
 *
 * Args:
 *   quarantine: the schema-valid document.
 *
 * Returns:
 *   string: the file content.
 */
export function serializeQuarantine(quarantine: Quarantine): string {
  const body = stringifyYaml({
    schemaVersion: quarantine.schemaVersion,
    testKey: quarantine.testKey,
    owner: quarantine.owner,
    approver: quarantine.approver,
    reason: quarantine.reason,
    expiresAt: quarantine.expiresAt,
  });
  return `${body.endsWith('\n') ? body : `${body}\n`}`;
}

/**
 * Writes one quarantine document, creating parent directories as needed.
 * Fail-closed: a write failure surfaces as a {@link GateforgeQuarantineError}.
 *
 * Args:
 *   path: destination file path.
 *   quarantine: the schema-valid document to write.
 *
 * @throws GateforgeQuarantineError when the file cannot be written.
 */
export function writeQuarantine(path: string, quarantine: Quarantine): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeQuarantine(quarantine), 'utf8');
  } catch (error) {
    throw new GateforgeQuarantineError([
      {
        file: basename(path),
        detail: `could not be written: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]);
  }
}
