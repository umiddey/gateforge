/**
 * `@gateforge/pack-fastapi` — FastAPI server-route detector (ADR 0004,
 * plan phase 2). The default export is the CLI in-process contract.
 */
export { createFastapiDetector, DEFAULT_COMMAND, pythonEnvironment, type FastapiDetector, type FastapiDetectorOptions, } from './detector.js';
export { pathDerivedResourceName, operationForMethod } from './facts.js';
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
declare const _default: import("./detector.js").FastapiDetector;
export default _default;
//# sourceMappingURL=index.d.ts.map