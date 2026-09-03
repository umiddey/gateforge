export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createWebhookDetector, discoverWebhooks, type WebhookDetector, type WebhookDetectorOptions, type WebhookFramework, type WebhookResourceAttributes, type SignatureAlgorithm, } from './detector.js';
export { WEBHOOK_OBLIGATION_CONTRACTS, obligationId, type WebhookObligationContract, } from './obligations.js';
export { WebhookEntityAdapterSchema, validateWebhookEntityAdapter, type WebhookEntityAdapter, type WebhookEntityAdapterValidation, type EntityAdapterContext, type NormalizedEntity, } from './adapter-schema.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
declare const _default: import("./detector.js").WebhookDetector;
export default _default;
//# sourceMappingURL=index.d.ts.map