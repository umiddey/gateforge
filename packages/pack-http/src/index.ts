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

/**
 * The default CLI in-process plugin module: `{ discover(paths) }`.
 *
 * Like every other pack, the instance is created at module import — safe
 * because `createHttpDetector` resolves the repo root AND its
 * `.gateforge/http-clients.json` document at DISCOVER time, not at factory
 * time. `gateforge check --staged` imports this module at startup and only
 * moves the process cwd to the staged candidate checkout afterwards, so a
 * factory-time capture would grade the user's worktree instead of the
 * staged bytes.
 */
export default createHttpDetector();
