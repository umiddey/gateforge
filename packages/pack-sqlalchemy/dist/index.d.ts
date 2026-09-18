export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createSqlalchemyDetector, DEFAULT_COMMAND, pythonEnvironment, applyPlaneMapping, applyPlanesConfig, PLANE_RULE_CONTRADICTION, type SqlalchemyDetector, type SqlalchemyDetectorOptions, } from './detector.js';
export { DEFAULT_PLANES_CONFIG, NO_PLANE_MAPPING, PLANES_CONFIG_PATH, byTableName, planeRuleMatches, readPlanesConfigOrNull, parsePlanesConfigText, resolvePlaneByRules, type PlaneConfigRule, type PlaneContext, type PlaneMatchInput, type PlaneResolution, type PlaneRule, type PlaneRuleHit, type PlanesConfig, type SqlalchemyPlane, } from './planes.js';
export { EntityAdapterSchema, validateEntityAdapter, type EntityAdapter, type EntityAdapterContext, type NormalizedEntity, type EntityAdapterValidation, } from './adapter-schema.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
declare const _default: import("./detector.js").SqlalchemyDetector;
export default _default;
//# sourceMappingURL=index.d.ts.map