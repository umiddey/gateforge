/**
 * @gateforge/pack-task — Background-task discovery pack.
 *
 * Detects background-task signatures from `.ts`/`.js`/`.mjs` source
 * (AST-light regex, no Python subprocess, no execution) and exposes
 * the pinned GPP/3 discovery vocabulary of the resource graph: one
 * `task.resource` per detected task (BullMQ `Queue`/`Bee-Queue`/custom
 * queue/message handlers/recurring jobs/`@Task`/`@Queue` decorators),
 * plus typed findings `DUPLICATE_TASK_ID`, `AMBIGUOUS_HANDLER`, and
 * `PARSE_ERROR`.
 *
 * Resource ids are stable, dotted (`task.<queue>.<name>`, e.g.
 * `task.email.send`), with attributes carrying the retry policy,
 * idempotency hint, terminal-on error types, observability flag, and
 * the declaration location.
 *
 * The default export is the CLI in-process plugin contract
 * (`discover(paths)`); no subprocess transport is needed. The five
 * obligation contracts (`src/obligations.ts`) are documented in README.
 *
 * See README.md for setup, the resource attribute vocabulary, the
 * obligation contracts, and the audit-trail entity-adapter schema.
 */
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createTaskDetector, discover, } from './detector.js';
export { TaskAuditAdapterSchema, validateTaskAuditAdapter, } from './adapter-schema.js';
export { TASK_OBLIGATION_CONTRACTS, TASK_OBLIGATION_DESCRIPTIONS, obligationsFor, } from './obligations.js';
/** The default CLI in-process plugin module: `{ discover(paths) }`. */
import { createTaskDetector } from './detector.js';
export default createTaskDetector();
//# sourceMappingURL=index.js.map