/**
 * @gateforge/pack-sqlalchemy — SQLAlchemy CRUD discovery pack.
 *
 * Detects SQLAlchemy tables from Python source (AST only, stdlib, no
 * imports/execution) and exposes the pinned GPP/3 discovery vocabulary
 * of the resource graph: business `sqlalchemy.table` resources,
 * `gateforge.class` symbol resources for cross-module inheritance
 * resolution, typed `unresolved` entries for computed names (GF-21),
 * and `DUPLICATE_TABLE_NAME` / `CLASS_NAME_REPEATED_IN_FILE` /
 * `PARSE_ERROR` findings (GF-20/GF-01/GF-19).
 *
 * The default export is the CLI in-process plugin contract
 * (`discover(paths)`); the same python detector runs under the CLI's
 * subprocess transport via `python3 -m gateforge_sqlalchemy_detector`.
 * Plane evidence is configured declaratively via `.gateforge/planes.json`
 * (or programmatically via the factory); declarative rules resolve with
 * explicit-beats-general precedence — a table claimed by a `tables`
 * rule ignores `match` globs, and conflicts fail closed within a tier.
 *
 * See README.md for setup, both transports, the plane-config schema and
 * evaluation semantics, the classification workflow, and the
 * entity-adapter schema + example adapter.
 */
import { createSqlalchemyDetector } from './detector.js';
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createSqlalchemyDetector, DEFAULT_COMMAND, pythonEnvironment, applyPlaneMapping, applyPlanesConfig, PLANE_RULE_CONTRADICTION, } from './detector.js';
export { DEFAULT_PLANES_CONFIG, NO_PLANE_MAPPING, PLANES_CONFIG_PATH, byTableName, planeRuleMatches, readPlanesConfigOrNull, resolvePlaneByRules, } from './planes.js';
export { EntityAdapterSchema, validateEntityAdapter, } from './adapter-schema.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
export default createSqlalchemyDetector();
//# sourceMappingURL=index.js.map