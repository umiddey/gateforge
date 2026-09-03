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
 * Plane mapping is configurable from the project config's
 * classifications file (or programmatically via the factory).
 *
 * See README.md for setup, both transports, the classification
 * workflow, and the entity-adapter schema + example adapter.
 */
import { createSqlalchemyDetector } from './detector.js';

export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export {
  createSqlalchemyDetector,
  DEFAULT_COMMAND,
  pythonEnvironment,
  applyPlaneMapping,
  type SqlalchemyDetector,
  type SqlalchemyDetectorOptions,
} from './detector.js';
export {
  NO_PLANE_MAPPING,
  byTableName,
  type PlaneContext,
  type PlaneRule,
  type SqlalchemyPlane,
} from './planes.js';
export {
  EntityAdapterSchema,
  validateEntityAdapter,
  type EntityAdapter,
  type EntityAdapterContext,
  type NormalizedEntity,
  type EntityAdapterValidation,
} from './adapter-schema.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
export default createSqlalchemyDetector();