/**
 * `@gate-forge/pack-fastapi` — FastAPI server-route detector (ADR 0004,
 * plan phase 2). The default export is the CLI in-process contract.
 */
export {
  createFastapiDetector,
  DEFAULT_COMMAND,
  DEFAULT_FASTAPI_SCAN_CONFIG,
  FASTAPI_SCAN_CONFIG_PATH,
  pythonEnvironment,
  readFastapiScanConfigOrNull,
  type FastapiDetector,
  type FastapiDetectorOptions,
  type FastapiScanConfig,
} from './detector.js';
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
import { createFastapiDetector } from './detector.js';

export default createFastapiDetector();
