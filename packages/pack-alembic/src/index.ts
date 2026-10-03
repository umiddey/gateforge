/**
 * @gate-forge/pack-alembic — opt-in Alembic migration obligations.
 *
 * A repository without an `alembic` key in `.gateforge.yml` does not load
 * this compiler. The default export is the GPP/3 detector, which reports
 * revision facts and does not by itself create obligations.
 */
import { createAlembicDetector } from './detector.js';

export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export {
  createAlembicDetector,
  DEFAULT_COMMAND,
  pythonEnvironment,
  type AlembicDetector,
  type AlembicDetectorOptions,
} from './detector.js';
export {
  ALEMBIC_DATA_PRESERVED,
  ALEMBIC_LINEAGE_INTACT,
  ALEMBIC_MERGE_CLEAN,
  ALEMBIC_POLICY_ID,
  ALEMBIC_ROUNDTRIP_VERIFIED,
  ALEMBIC_WITNESS_KIND,
  compileAlembic,
  executePreservation,
  executeRoundtrip,
  filesDigest,
  globMatches,
  mergeTargetWorktree,
  previousHead,
  type AlembicCompileResult,
  type ChainLocation,
} from './compile.js';
export { scanLineage, runPython, type ScanLineage, type ScannedMigration, type RunnerResult } from './execute.js';
export {
  SCRATCH_PREFIX,
  ScratchUnsafeError,
  createScratchDatabase,
  dropScratchDatabase,
  isScratchDatabaseName,
  scratchDatabaseExists,
  urlForDatabase,
} from './scratch.js';
export { detectAlembicVersionsDir, renderAlembicOptIn } from './opt-in.js';

/** Default CLI in-process plugin module: `{ discover(paths) }`. */
export default createAlembicDetector();
