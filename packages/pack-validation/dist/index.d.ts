/**
 * @gate-forge/pack-validation — request-schema validation discovery pack.
 *
 * Detects zod / joi / yup / class-validator schemas in TypeScript /
 * JavaScript source and emits one `validation.schema` resource per
 * schema declaration. The default export is the CLI in-process plugin
 * contract (`discover(paths)`).
 *
 * See README.md for setup, the obligation vocabulary, and the example
 * server.
 */
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createValidationDetector, VALIDATION_SCHEMA_KIND, type ValidationDetector, type ValidationDetectorOptions, type ValidationResourceId, } from './detector.js';
export { VALIDATION_OBLIGATIONS, type ValidationObligation } from './obligations.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
declare const _default: import("./detector.js").ValidationDetector;
export default _default;
//# sourceMappingURL=index.d.ts.map