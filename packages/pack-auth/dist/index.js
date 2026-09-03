/**
 * @gateforge/pack-auth — Authorization discovery pack.
 *
 * Detects role-guard + tenant-isolation patterns in TypeScript / JavaScript
 * HTTP route definitions and emits one `auth.resource` per guarded
 * endpoint. Each resource carries `attributes.roleRequirement` (string[]
 * of accepted roles) and `attributes.tenancy` (`'tenant-bound' | 'none'`),
 * which the policy engine maps onto the auth obligation vocabulary.
 *
 * Vocabulary:
 *
 *   - `auth:role-allowed` — the principal with the required role reaches
 *     the handler and produces the handler's success status.
 *   - `auth:role-denied` — the authenticated principal WITHOUT the
 *     required role is rejected with 401/403 BEFORE state mutation.
 *   - `auth:tenant-isolated` — a principal of a different tenant than
 *     the target entity is rejected (cross-tenant guard).
 *   - `auth:denied-no-side-effect` — a denied request leaves the
 *     persisted entity UNCHANGED (verified by a follow-up GET).
 *   - `auth:forged-token-rejected` — a token whose signature does not
 *     validate is rejected with 401 and never reaches the handler.
 *
 * Limitations (documented in the README):
 *
 *   - Python/FastAPI `Depends()` patterns are NOT covered by this pack —
 *     the brief restricts the detector to TS/JS. The FastAPI equivalent
 *     is deferred to a future pack.
 *   - The detector does NOT cross-reference role identity providers; a
 *     `requireRole('admin')` call site is treated as authoritative for
 *     classification. Production users MUST classify role lists in the
 *     project config to bind them to a known taxonomy.
 */
import { createAuthDetector } from './detector.js';
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createAuthDetector, } from './detector.js';
export { AuthEntityAdapterSchema, validateAuthEntityAdapter, } from './adapter-schema.js';
export { AUTH_OBLIGATION_CONTRACTS, obligationId, } from './obligations.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
export default createAuthDetector();
//# sourceMappingURL=index.js.map