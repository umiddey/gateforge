/**
 * @gateforge/pack-http — Generic HTTP exposure pack.
 *
 * Pure TypeScript detector that walks `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/
 * `.cjs` sources and discovers externally-reachable HTTP artifacts:
 *
 *   - Server routes: Express / Fastify / Hono registrations and NestJS
 *     `@Controller` + `@Get/@Post/…` decorators.
 *   - Frontend API-client calls: `fetch('/…')` and `axios.<method>('/…')`.
 *
 * Every artifact becomes an `http-route` resource with a stable id and
 * typed attributes (`method`, `path`, `origin`), and — plan phase 4
 * (ADR 0003 D1/D2) — classification SIGNALS: a code-positive `exposure`
 * signal per artifact and `lifecycle.<op>` signals from the HTTP
 * method, targeted at the path-derived resource name so the core
 * classifier converges routes with tables deterministically. A signal
 * whose target names no discovered resource surfaces as a typed
 * STALE_SIGNAL_TARGET block (a link the engine cannot resolve blocks
 * rather than guesses); a route with no derivable name emits no signal.
 *
 * Default export is the CLI in-process plugin contract
 * (`discover(paths)`); see README.md for setup.
 */
import { createHttpDetector } from './detector.js';

export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';

export {
  createHttpDetector,
  resourceNameFromPath,
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
