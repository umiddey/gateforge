/**
 * Resource graph (G2): detector-output ingestion, id/path
 * normalization, symbol-table inheritance resolution, duplicate-table
 * detection, and stale-reference validation (invariant 9 / GF-06).
 */
export { CLASS_SYMBOL_KIND, RESOURCE_NAME_ATTRIBUTE, ClassSymbolAttributesSchema, DetectorOutputSchema, FindingSchema, GraphFindingSchema, GraphResourceSchema, GraphUnresolvedSchema, ResourceGraphSchema, StaleReferenceKindSchema, StaleReferenceSchema, } from './schema.js';
export { buildResourceGraph, GRAPH_DETECTOR_ID } from './build.js';
export { buildSymbolTable, locationIndex, resolveInheritedName, sortUnresolved, } from './symbols.js';
export { compareLocations, compareStrings } from './util.js';
//# sourceMappingURL=index.js.map