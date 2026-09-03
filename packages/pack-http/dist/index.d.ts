export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createHttpDetector, resourceNameFromPath, type HttpDetector, type HttpDetectorOptions, type HttpOrigin, } from './detector.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
declare const _default: {
    discover(paths: readonly string[]): import("@gateforge/plugin-protocol").DiscoveryOutcome;
};
export default _default;
//# sourceMappingURL=index.d.ts.map