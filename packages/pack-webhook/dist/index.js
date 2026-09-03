/**
 * @gateforge/pack-webhook — Webhook contract pack.
 *
 * Pure TypeScript detector that walks `.ts`/`.tsx`/`.js`/`.mjs` sources
 * and discovers webhook endpoint patterns across four surfaces:
 *
 *   - Express   (route registration with webhook-shaped path)
 *   - Fastify   (route registration with webhook-shaped path)
 *   - Hono      (route registration with webhook-shaped path)
 *   - Decorator (NestJS-style `@webhook(...)` or `@on('webhook.x')`)
 *
 * Every webhook endpoint becomes a `webhook.endpoint` resource with a
 * stable id (`webhook.<provider>.<endpoint>`) and typed attributes
 * (`signatureHeader`, `signatureAlgorithm`, `replayWindow`, `maxBody`,
 * `framework`, `path`, `httpMethods[]`, `provider`). Duplicate ids
 * surface as `DUPLICATE_RESOURCE_ID` findings rather than silently
 * overwriting; signature-shaped ambiguities emit `AMBIGUOUS_WEBHOOK`.
 *
 * The pack ships an entity-adapter schema (mirror of
 * `@gateforge/pack-sqlalchemy`'s) so the in-memory delivery log can be
 * witnessed GET-only for the `webhook:replay-idempotent` and
 * `webhook:retry-bounded` contracts.
 *
 * Default export is the CLI in-process plugin contract
 * (`discover(paths)`); see README.md for setup + the example server
 * (`example/webhook/server.js`, port 3003).
 */
import { createWebhookDetector } from './detector.js';
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createWebhookDetector, discoverWebhooks, } from './detector.js';
export { WEBHOOK_OBLIGATION_CONTRACTS, obligationId, } from './obligations.js';
export { WebhookEntityAdapterSchema, validateWebhookEntityAdapter, } from './adapter-schema.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
export default createWebhookDetector();
//# sourceMappingURL=index.js.map