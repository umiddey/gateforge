/**
 * @gate-forge/pack-task — Background-task discovery pack.
 *
 * Detects background-task signatures from `.ts`/`.js`/`.mjs` source
 * (AST-light regex, no Python subprocess, no execution) and exposes
 * the pinned GPP/3 discovery vocabulary of the resource graph
 * (BullMQ `Queue`/Bee-Queue/custom queue/message handlers/recurring
 * jobs/`@Task`/`@Queue` decorators), plus typed findings
 * `DUPLICATE_TASK_ID`, `AMBIGUOUS_HANDLER`, and `PARSE_ERROR`, and
 * the typed `UNPROVEN_QUEUE_REGISTRATION` unresolved entry for
 * handler-less `register(...)` calls in files with no queue evidence
 * (browser/platform registrations — service workers, caches, workbox,
 * including multi-line call expressions whose receiver sits on a
 * previous line — produce no output at all). The outcome carries no
 * resources and no classification signals (phase 4).
 *
 * Resource identity is stable and dotted (`task.<name>`, e.g.
 * `task.email.send`), carried by the obligation-contract vocabulary.
 *
 * The default export is the CLI in-process plugin contract
 * (`discover(paths)`); no subprocess transport is needed. The five
 * obligation contracts (`src/obligations.ts`) are documented in README.
 *
 * See README.md for setup, the detection vocabulary, the obligation
 * contracts, and the audit-trail entity-adapter schema.
 */
export { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
export { createTaskDetector, discover, type TaskDetector, type TaskDetectorOptions, type TaskResourceAttributes, } from './detector.js';
export { TaskAuditAdapterSchema, validateTaskAuditAdapter, type NormalizedAuditEntity, type TaskAuditAdapter, type TaskAuditAdapterContext, type TaskAuditAdapterValidation, } from './adapter-schema.js';
export { TASK_OBLIGATION_CONTRACTS, TASK_OBLIGATION_DESCRIPTIONS, obligationsFor, type TaskObligationContract, } from './obligations.js';
declare const _default: import("./detector.js").TaskDetector;
export default _default;
//# sourceMappingURL=index.d.ts.map