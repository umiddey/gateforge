export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createAuthDetector, type AuthDetector, type AuthDetectorOptions, type AuthFramework, type Tenancy, } from './detector.js';
export { AuthEntityAdapterSchema, validateAuthEntityAdapter, type AuthEntityAdapter, type AuthAdapterContext, type NormalizedAuthEntity, type AuthEntityAdapterValidation, } from './adapter-schema.js';
export { AUTH_OBLIGATION_CONTRACTS, obligationId, type AuthObligationContract, } from './obligations.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
declare const _default: import("./detector.js").AuthDetector;
export default _default;
//# sourceMappingURL=index.d.ts.map