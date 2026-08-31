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
import { type GraphUnresolved } from './schema.js';
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
    location: {
        file: string;
        line: number;
        col: number;
    };
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
export type InheritanceResolution = {
    ok: true;
    name: string;
    baseQname: string;
} | {
    ok: false;
    cause: string;
};
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
export declare function buildSymbolTable(detectors: {
    detectorId: string;
    detectorVersion: string;
    resources: Resource[];
}[], findings: GraphFinding[]): SymbolTable;
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
export declare function resolveInheritedName(symbol: ClassSymbol, table: SymbolTable): InheritanceResolution;
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
export declare function locationIndex(symbols: ClassSymbol[]): Map<string, ClassSymbol>;
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
export declare function sortUnresolved(entries: GraphUnresolved[]): GraphUnresolved[];
//# sourceMappingURL=symbols.d.ts.map