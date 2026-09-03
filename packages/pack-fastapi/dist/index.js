/**
 * `@gateforge/pack-fastapi` — FastAPI server-route detector (ADR 0004,
 * plan phase 2). The default export is the CLI in-process contract.
 */
export { createFastapiDetector, DEFAULT_COMMAND, pythonEnvironment, } from './detector.js';
export { pathDerivedResourceName, operationForMethod } from './facts.js';
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
import { createFastapiDetector } from './detector.js';
export default createFastapiDetector();
//# sourceMappingURL=index.js.map