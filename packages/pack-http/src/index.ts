/**
 * @gate-forge/pack-http — Generic HTTP exposure pack.
 *
 * Pure TypeScript detector that walks `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/
 * `.cjs` sources and discovers externally-reachable HTTP artifacts:
 *
 *   - Server routes: Express / Fastify / Hono registrations and NestJS
 *     `@Controller` + `@Get/@Post/…` decorators.
 *   - Frontend API-client calls: `fetch('/…')` and `axios.<method>('/…')`.
 *
 * Every artifact becomes an `http.contract` evidence fact (ADR 0004 D1)
 * with typed attributes (`method`, `normalizedPath`, `origin`, schema
 * symbols, handler names) for the engine's endpoint-compiler join. The
 * pack mints NO classification signals (dogfood remediation phase 4): a
 * path-derived target is a guess that mostly names no discovered
 * resource (route `/absences` vs table `employee_absences` ⇒
 * STALE_SIGNAL_TARGET noise) while unknown exposure already defaults
 * user-facing and unknown lifecycle operations default enabled
 * (ADR 0003 D5). Route→resource linkage is the CLI endpoint compiler's
 * exclusive job (schema-symbol/handler corroboration; typed
 * ENDPOINT_RESOURCE_LINK_UNRESOLVED blocks for ambiguity). Core's
 * STALE_SIGNAL_TARGET detection remains for genuinely stale authority
 * signals — this pack simply produces no false targets.
 *
 * Default export is the CLI in-process plugin contract
 * (`discover(paths)`); see README.md for setup.
 */
import { createHttpDetector } from './detector.js';

export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';

export {
  createHttpDetector,
  type HttpDetector,
  type HttpDetectorOptions,
  type HttpOrigin,
} from './detector.js';

/** The default CLI in-process plugin module: `{ discover(paths) }`. */
// The default export is created LAZILY per discover call: the detector
// resolves paths against `process.cwd()` at call time. An eagerly created
// instance would pin the first repo root it saw and go blind in any
// long-lived host that loads the module once and scans multiple repos.
export default {
  discover(paths: readonly string[]) {
    return createHttpDetector().discover(paths);
  },
};
