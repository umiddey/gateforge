/**
 * Serial-group selection expansion (plan seam): when a selected test
 * belongs to a describe in serial mode, the run must select every test
 * of that serial group in file order — a serial journey's later steps
 * consume the state its earlier steps create, so executing a mapped
 * later step without the group's own first step fails by construction.
 *
 * The expansion is additive and narrow:
 *
 * - members come from the FULL planned set (`allRows`), so quarantined
 *   rows (they left planning before this point) are never re-added;
 * - a member is only added inside the selected test's OWN file and
 *   project — an expansion never leaks across files or projects;
 * - a scope that declares nothing serial expands nothing (the
 *   detection itself is `@gate-forge/pack-playwright`'s static
 *   serial-scope reader — Playwright's own listing never exposes a
 *   suite's declared mode);
 * - the result reports one record per expanded group, in file order,
 *   naming exactly what was added.
 */
import { join } from 'node:path';
import {
  readSerialScopes,
  scopeCoversTest,
  serialScopeOfTest,
  serialScopeTitle,
  type SerialScope,
} from '@gate-forge/pack-playwright';
import type { PlannedRow } from './execution.js';

/** One expanded serial group, exactly as the report records it. */
export interface SerialExpansionRecord {
  /** The group's title path (' > ' joined); null for a file-level serial scope. */
  describe: string | null;
  /** The repo-relative file the group lives in. */
  file: string;
  /** How many group members this expansion added to the selection. */
  added: number;
  /** The added members' logical keys, in FILE order (not key order). */
  logicalKeys: string[];
}

/** The expanded selection: rows, added keys, and the per-group records. */
export interface SerialExpansionResult {
  /** The original selection plus every added member, sorted by logical key. */
  rows: PlannedRow[];
  /** The added members' logical keys, sorted. */
  addedLogicalKeys: string[];
  /** One record per expanded group, ordered by (file, group position). */
  expansions: SerialExpansionRecord[];
}

/**
 * Expands a narrowed selection to the serial groups its selected tests
 * belong to.
 *
 * Args:
 *   cwd: absolute repository root (spec files resolve from here).
 *   rows: the current selection (a named or changed-slice plan).
 *   allRows: the FULL planned set the members may be drawn from.
 *   lineOf: a logical key's catalog source line (members are ordered
 *     and ranged by it; a row the catalog never located can still join
 *     a file-level scope).
 *
 * Returns:
 *   SerialExpansionResult: the expanded selection; identity when no
 *   selected test sits in a serial scope.
 */
export function expandSerialSelection(input: {
  cwd: string;
  rows: readonly PlannedRow[];
  allRows: readonly PlannedRow[];
  lineOf: (logicalKey: string) => number | undefined;
}): SerialExpansionResult {
  const { cwd, rows, allRows, lineOf } = input;
  if (rows.length === 0) {
    return { rows: [...rows], addedLogicalKeys: [], expansions: [] };
  }
  const selected = new Set(rows.map((row) => row.planned.logicalKey));
  const added = new Set<string>();
  /** One record per (file, serial scope), keyed by file + scope start. */
  const records = new Map<string, { scope: SerialScope; file: string; keys: string[] }>();
  const rowsByFile = new Map<string, PlannedRow[]>();
  for (const row of rows) {
    const fileRows = rowsByFile.get(row.planned.file) ?? [];
    fileRows.push(row);
    rowsByFile.set(row.planned.file, fileRows);
  }

  for (const file of [...rowsByFile.keys()].sort()) {
    const scopes = readSerialScopes(join(cwd, file));
    if (scopes.length === 0) continue;
    for (const row of rowsByFile.get(file) ?? []) {
      const scope = serialScopeOfTest(
        { titlePath: row.planned.titlePath, line: lineOf(row.planned.logicalKey) },
        scopes,
      );
      if (scope === null) continue;
      const recordKey = `${file}\u0000${scope.kind}\u0000${String(scope.startLine)}`;
      const record = records.get(recordKey) ?? { scope, file, keys: [] };
      records.set(recordKey, record);
      // Members: the full plan's rows of the same file AND project that
      // the group's serial chain covers, in file order.
      const members = allRows
        .filter(
          (candidate) =>
            candidate.planned.file === file &&
            candidate.planned.project === row.planned.project &&
            !selected.has(candidate.planned.logicalKey),
        )
        .map((candidate, index) => ({
          candidate,
          line: lineOf(candidate.planned.logicalKey),
          index,
        }))
        .filter(({ candidate }) => {
          if (added.has(candidate.planned.logicalKey)) return false;
          return scopeCoversTest(scope, {
            titlePath: candidate.planned.titlePath,
            line: lineOf(candidate.planned.logicalKey),
          });
        })
        .sort((left, right) => {
          if (left.line !== undefined && right.line !== undefined && left.line !== right.line) {
            return left.line - right.line;
          }
          if (left.line !== right.line) return left.line === undefined ? 1 : -1;
          return left.index - right.index;
        });
      for (const { candidate } of members) {
        added.add(candidate.planned.logicalKey);
        record.keys.push(candidate.planned.logicalKey);
      }
    }
  }

  if (added.size === 0) {
    return { rows: [...rows], addedLogicalKeys: [], expansions: [] };
  }
  const addedRows = allRows.filter((candidate) => added.has(candidate.planned.logicalKey));
  const rowsByKey = new Map([...rows, ...addedRows].map((row) => [row.planned.logicalKey, row]));
  const expansions = [...records.values()]
    .filter((record) => record.keys.length > 0)
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : left.scope.startLine - right.scope.startLine))
    .map((record) => ({
      describe: serialScopeTitle(record.scope),
      file: record.file,
      added: record.keys.length,
      logicalKeys: [...record.keys],
    }));
  return {
    rows: [...rowsByKey.values()].sort((a, b) => (a.planned.logicalKey < b.planned.logicalKey ? -1 : 1)),
    addedLogicalKeys: [...added].sort(),
    expansions,
  };
}
