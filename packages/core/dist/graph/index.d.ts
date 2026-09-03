/**
 * Resource graph (G2): detector-output ingestion, id/path
 * normalization, symbol-table inheritance resolution, duplicate-table
 * detection, and stale-reference validation (invariant 9 / GF-06).
 */
export { CLASS_SYMBOL_KIND, EVIDENCE_ONLY_RESOURCE_KINDS, HTTP_ENDPOINT_RESOURCE_KIND, isEvidenceOnlyKind, RESOURCE_NAME_ATTRIBUTE, ClassSymbolAttributesSchema, DetectorOutputSchema, FindingSchema, GraphFindingSchema, GraphResourceSchema, GraphUnresolvedSchema, ResourceGraphSchema, StaleReferenceKindSchema, StaleReferenceSchema, } from './schema.js';
export type { ClassSymbolAttributes, DetectorOutput, Finding, GraphFinding, GraphResource, GraphUnresolved, ResourceGraph, ResourceGraphInput, StaleReference, StaleReferenceKind, } from './schema.js';
export { buildResourceGraph, GRAPH_DETECTOR_ID } from './build.js';
export { buildSymbolTable, locationIndex, resolveInheritedName, sortUnresolved, } from './symbols.js';
export type { ClassSymbol, InheritanceResolution, SymbolTable } from './symbols.js';
export { compareLocations, compareStrings } from './util.js';
//# sourceMappingURL=index.d.ts.map