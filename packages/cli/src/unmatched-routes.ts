/**
 * Unmatched by-id routes: `ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED`
 * (0.9.0, owner decision D7).
 *
 * The endpoint compiler emits one typed entry for a by-id route whose
 * path-derived resource name names no discovered business resource. On
 * a large existing repository that can be dozens of entries, and
 * blocking on them all turns an honest finding into a wall of commits
 * the owner never agreed to gate on. The owner decides, through
 * `endpoints.unmatchedRoutes` in `.gateforge.yml`:
 *
 * - ABSENT — an existing repository that upgraded. The entries are
 *   ADVISORIES: reported, never blocking, and announced with a banner
 *   that names the count, the first examples and the exact key to set.
 * - `warn` — the same non-blocking behavior, once the owner has said
 *   so; the banner drops the "you have not chosen" sentence and keeps
 *   the count, the examples and the key.
 * - `block` — today's strict behavior: the entry is a blocking entry
 *   like every other gate-visible finding.
 *
 * This module owns the PARTITION (blocking vs advisory) and the banner
 * text. It never re-derives the finding: it routes what the compiler
 * already emitted, keyed on the code in the entry detail.
 */
import { ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED } from '@gate-forge/http-contract';
import type { BlockingEntry, GateforgeConfig } from '@gate-forge/core';

/** The code this module routes, as it appears at the head of an entry detail. */
const UNMATCHED_ROUTE_PREFIX = `${ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED}:`;

/** How the owner grades unmatched by-id routes. */
export type UnmatchedRoutesMode = 'block' | 'warn' | 'unchosen';

/**
 * The effective mode from a parsed `.gateforge.yml`: `block` only when
 * the owner said so. ABSENT is `unchosen`, which behaves exactly like
 * `warn` and additionally says the owner has not chosen.
 *
 * Args:
 *   config: the parsed project config.
 *
 * Returns:
 *   UnmatchedRoutesMode: the effective grading mode.
 */
export function unmatchedRoutesMode(config: GateforgeConfig): UnmatchedRoutesMode {
  return config.endpoints?.unmatchedRoutes ?? 'unchosen';
}

/**
 * Whether entries with this code stay blocking under the given mode.
 *
 * Args:
 *   mode: the effective grading mode.
 *
 * Returns:
 *   boolean: true when the entry blocks the gate.
 */
export function unmatchedRoutesBlocking(mode: UnmatchedRoutesMode): boolean {
  return mode === 'block';
}

/**
 * Splits blocking entries into the ones this mode keeps blocking and the
 * ones the owner graded as advisory. Entries of any other code are
 * untouched, so a repository with no unmatched route partitions to an
 * empty advisory list and its blocking list unchanged.
 *
 * Args:
 *   blocking: the run's blocking entries.
 *   mode: the effective grading mode.
 *
 * Returns:
 *   blocking/advisories: the two channels, each sorted as it arrived.
 */
export function partitionUnmatchedRouteEntries(
  blocking: readonly BlockingEntry[],
  mode: UnmatchedRoutesMode,
): { blocking: BlockingEntry[]; advisories: BlockingEntry[] } {
  const advisories: BlockingEntry[] = [];
  if (unmatchedRoutesBlocking(mode)) return { blocking: [...blocking], advisories };
  const kept: BlockingEntry[] = [];
  for (const entry of blocking) {
    if (entry.detail.startsWith(UNMATCHED_ROUTE_PREFIX)) advisories.push(entry);
    else kept.push(entry);
  }
  return { blocking: kept, advisories };
}

/** The advisory entries this module produced, read off a partitioned list. */
export function isUnmatchedRouteEntry(entry: BlockingEntry): boolean {
  return entry.detail.startsWith(UNMATCHED_ROUTE_PREFIX);
}

/**
 * One example line for the banner: the endpoint identity and the names
 * the compiler found near it. The compiler's own sentence carries both,
 * so the banner never re-derives or restates the finding — it shows the
 * owner's own words from the entry.
 *
 * Args:
 *   entry: one advisory entry of this code.
 *
 * Returns:
 *   string: a single example line, location-qualified when known.
 */
function exampleLine(entry: BlockingEntry): string {
  const sentence = entry.detail.slice(UNMATCHED_ROUTE_PREFIX.length).trim();
  return entry.location === null ? `  - ${sentence}` : `  - ${sentence} (${entry.location.file}:${String(entry.location.line)})`;
}

/**
 * The banner `check` and `next` print near the top: how many entries,
 * the first three with their near matches, and the exact setting line
 * that turns blocking on. Loud by design — a finding that is demoted
 * must still be impossible to miss.
 *
 * Args:
 *   advisories: the advisory entries of this code (empty = print nothing).
 *   mode: the effective grading mode; `unchosen` adds the sentence
 *     telling the owner they have not chosen yet.
 *
 * Returns:
 *   string[]: banner lines, empty when there is nothing to say.
 */
export function unmatchedRouteBannerLines(
  advisories: readonly BlockingEntry[],
  mode: UnmatchedRoutesMode,
): string[] {
  if (advisories.length === 0) return [];
  const noun = advisories.length === 1 ? 'route' : 'routes';
  const lines = [
    `note: ${String(advisories.length)} by-id ${noun} whose name matches no discovered resource ${
      advisories.length === 1 ? 'is' : 'are'
    } REPORTED, NOT BLOCKING.`,
    ...(mode === 'unchosen'
      ? ["note: you have not chosen block or warn for these; an upgraded repository starts here."]
      : []),
    ...advisories.slice(0, 3).map(exampleLine),
    `to block commits on them, set in .gateforge.yml:\n  endpoints:\n    unmatchedRoutes: block`,
  ];
  if (advisories.length > 3) {
    lines.push(`  ... and ${String(advisories.length - 3)} more — run 'gateforge check' for every entry`);
  }
  return lines;
}