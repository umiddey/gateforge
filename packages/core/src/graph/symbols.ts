/**
 * The resource-graph symbol table (go/no-go first action #2):
 * cross-module inheritance resolution so inherited tablenames stop
 * being `unresolved` when statically resolvable.
 *
 * Detectors contribute class symbols as resources with the reserved
 * {@link CLASS_SYMBOL_KIND} kind (see `ClassSymbolAttributesSchema`).
 * The graph indexes them and resolves a subclass's inherited tablename
 * by walking declared base names through the repo-wide table:
 *
 * 1. a base name matching a symbol's exact `qname` wins first;
 * 2. then a unique same-file symbol whose last name segment matches
 *    (lexical-scope preference — function-local shadowing is legal);
 * 3. then a unique repo-wide last-name match;
 * 4. ambiguous or missing bases end the walk with a typed cause.
 *
 * The walk follows base chains in declaration order (first literal
 * tablename wins, mirroring MRO-ish expectations) and is cycle-guarded.
 * Resolution is purely additive: the graph only ever resolves or keeps
 * the detector's typed unresolved entry — it never rewrites one.
 */
import type { Resource } from '../schemas/resource.js';
import type { GraphFinding } from './schema.js';
import { CLASS_SYMBOL_KIND, ClassSymbolAttributesSchema, type GraphUnresolved } from './schema.js';
import { compareStrings, compareLocations } from './util.js';

/** A validated class symbol, extracted from a class-symbol resource. */
export interface ClassSymbol {
  /** Scope-qualified class name (dotted). */
  qname: string;
  /** Kind used for a table materialized from this class. */
  resourceKind: string;
  /** Direct base names as written, in declaration order. */
  baseNames: string[];
  /** Literal tablename declared on the class itself, if any. */
  tableName: string | null;
  /** `__abstract__ = True` base — never materializes directly. */
  abstract: boolean;
  /** Detector assertion that this class's tablename is unresolved. */
  tablenameUnresolved: boolean;
  /** Repo-root-relative declaration file. */
  source: string;
  /** Exact declaration location. */
  location: { file: string; line: number; col: number };
  /** Detector that contributed the symbol. */
  detectorId: string;
  /** Detector version at the handshake. */
  detectorVersion: string;
}

/** The repo-wide symbol table: qname index + last-name-segment index. */
export interface SymbolTable {
  /** qname → symbol (first by source order on duplicate qnames). */
  byQname: Map<string, ClassSymbol>;
  /** Last name segment → symbols sorted by location (may be ambiguous). */
  byLastName: Map<string, ClassSymbol[]>;
}

/** Outcome of resolving one class's inherited tablename. */
export type InheritanceResolution =
  | { ok: true; name: string; baseQname: string }
  | { ok: false; cause: string };

/**
 * Extracts class symbols from detector resources. Resources that claim
 * the reserved class-symbol kind but carry malformed attributes are
 * reported as `INVALID_RESOURCE` findings and skipped — a hostile or
 * broken symbol payload degrades to "unresolved stays unresolved",
 * never to a crash or silent drop.
 *
 * Args:
 *   detectors: all detector contributions (symbol table is repo-wide).
 *   findings: accumulator; malformed class-symbol resources append here.
 *
 * Returns:
 *   SymbolTable: qname and last-name indexes of the valid symbols.
 */
export function buildSymbolTable(
  detectors: { detectorId: string; detectorVersion: string; resources: Resource[] }[],
  findings: GraphFinding[],
): SymbolTable {
  const candidates: ClassSymbol[] = [];
  for (const detector of detectors) {
    for (const resource of detector.resources) {
      if (resource.kind !== CLASS_SYMBOL_KIND) continue;
      const parsed = ClassSymbolAttributesSchema.safeParse(resource.attributes);
      if (!parsed.success) {
        findings.push({
          code: 'INVALID_RESOURCE',
          detail: `class-symbol resource from ${detector.detectorId} has malformed attributes: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          locations: [resource.location],
          detectorId: detector.detectorId,
        });
        continue;
      }
      candidates.push({
        qname: parsed.data.qname,
        resourceKind: parsed.data.resourceKind,
        baseNames: parsed.data.baseNames ?? [],
        tableName: parsed.data.tableName ?? null,
        abstract: parsed.data.abstract ?? false,
        tablenameUnresolved: parsed.data.tablenameUnresolved ?? false,
        source: resource.source,
        location: resource.location,
        detectorId: detector.detectorId,
        detectorVersion: detector.detectorVersion,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      compareStrings(a.source, b.source) ||
      compareLocations(a.location, b.location),
  );

  const byQname = new Map<string, ClassSymbol>();
  const byLastName = new Map<string, ClassSymbol[]>();
  for (const symbol of candidates) {
    const existing = byQname.get(symbol.qname);
    if (existing !== undefined) {
      findings.push({
        code: 'DUPLICATE_CLASS_QNAME',
        detail: `class qname '${symbol.qname}' declared by ${symbol.detectorId} duplicates an earlier declaration from ${existing.detectorId}; the earlier symbol (sorted by source, line, col) wins`,
        locations: [existing.location, symbol.location],
        detectorId: symbol.detectorId,
      });
      continue;
    }
    byQname.set(symbol.qname, symbol);
    const lastName = symbol.qname.split('.').at(-1) ?? symbol.qname;
    const bucket = byLastName.get(lastName);
    if (bucket === undefined) byLastName.set(lastName, [symbol]);
    else bucket.push(symbol);
  }
  return { byQname, byLastName };
}

/**
 * Resolves the inherited tablename of a class through the symbol
 * table, following declared base names in order. Per base name:
 * exact qname match, then unique same-file last-name match, then
 * unique repo-wide last-name match. The first literal tablename on
 * any followed chain wins; all failure causes of the first failing
 * base are reported when none succeeds.
 *
 * Args:
 *   symbol: the class whose tablename is missing.
 *   table: the repo-wide symbol table.
 *
 * Returns:
 *   InheritanceResolution: the literal name + defining base qname on
 *   success, or a single-cause typed explanation on failure.
 */
export function resolveInheritedName(
  symbol: ClassSymbol,
  table: SymbolTable,
): InheritanceResolution {
  return walk(symbol, new Set([symbol.qname]), table);
}

function walk(
  symbol: ClassSymbol,
  visited: Set<string>,
  table: SymbolTable,
): InheritanceResolution {
  let firstFailure: InheritanceResolution | null = null;
  for (const baseName of symbol.baseNames) {
    const base = lookupBase(baseName, symbol, table);
    if (base === undefined) {
      const failure: InheritanceResolution = {
        ok: false,
        cause: `base class '${baseName}' of '${symbol.qname}' not found in the symbol table`,
      };
      firstFailure ??= failure;
      continue;
    }
    if (base.tableName !== null) {
      return { ok: true, name: base.tableName, baseQname: base.qname };
    }
    if (visited.has(base.qname)) {
      const failure: InheritanceResolution = {
        ok: false,
        cause: `inheritance cycle at '${base.qname}' while resolving '${symbol.qname}'`,
      };
      firstFailure ??= failure;
      continue;
    }
    visited.add(base.qname);
    const nested = walk(base, visited, table);
    if (nested.ok) return nested;
    firstFailure ??= nested;
  }
  return (
    firstFailure ?? {
      ok: false,
      cause: `'${symbol.qname}' declares no base carrying a literal tablename`,
    }
  );
}

function lookupBase(
  baseName: string,
  from: ClassSymbol,
  table: SymbolTable,
): ClassSymbol | undefined {
  const exact = table.byQname.get(baseName);
  if (exact !== undefined) return exact;
  const candidates = table.byLastName.get(baseName) ?? [];
  const sameFile = candidates.filter((c) => c.source === from.source);
  if (sameFile.length === 1) return sameFile[0];
  if (candidates.length === 1) return candidates[0];
  return undefined;
}

/**
 * Builds a lookup of `file:line` → class symbol for one detector's
 * symbols. Detector unresolved entries whose location points at a
 * class statement are matched through this map, which is how a
 * resolved symbol retires its detector's unresolved entry.
 *
 * Args:
 *   symbols: the detector's own class symbols.
 *
 * Returns:
 *   Map<string, ClassSymbol>: keyed by `${file}:${line}`.
 */
export function locationIndex(
  symbols: ClassSymbol[],
): Map<string, ClassSymbol> {
  const index = new Map<string, ClassSymbol>();
  for (const symbol of symbols) {
    index.set(`${symbol.location.file}:${symbol.location.line}`, symbol);
  }
  return index;
}

/**
 * Sorts unresolved entries into their deterministic output order:
 * location (file, line, col), then reason code, then detail, then
 * detector id.
 *
 * Args:
 *   entries: unresolved entries in any order.
 *
 * Returns:
 *   GraphUnresolved[]: a new sorted array.
 */
export function sortUnresolved(entries: GraphUnresolved[]): GraphUnresolved[] {
  return [...entries].sort((a, b) => {
    const byLocation = compareLocations(a.reason.location, b.reason.location);
    if (byLocation !== 0) return byLocation;
    return (
      compareStrings(a.reason.code, b.reason.code) ||
      compareStrings(a.reason.detail, b.reason.detail) ||
      compareStrings(a.detectorId, b.detectorId)
    );
  });
}
