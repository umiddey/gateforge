/**
 * Supervisor surface of the Playwright evidence pack (enforcement-
 * review fixes 2/3): the pieces the TRUSTED CLI process uses to hold
 * the session-lifecycle authority the runner child must never have.
 * The persistence-intents spool + forwarding add the server-witnessed
 * persistence channel: the suite may only WRITE intents; the witness
 * (verifier-key surface) probes and stamps.
 *
 * `appendFreezeReleaseEvent` is the accepted-prepared-candidate marker
 * the trusted CLI appends to the SAME append-ordered spool file, so the
 * global preparation freeze and the runner's own lifecycle events share
 * one ordering (see `discovery/prepare-barrier.ts`).
 */
export {
  appendFreezeReleaseEvent,
  appendPersistenceIntent,
  appendSpoolEvent,
  persistenceIntentsPathFor,
  readPersistenceIntents,
  readSpoolEvents,
  spoolPathFor,
} from './spool.js';
export type { SpoolEvent, SpoolEventKind } from './spool.js';
export type {
  PersistenceIntent,
  PersistenceIntentOperation,
  PersistenceIntentPhase,
  PersistenceIntentExpectation,
} from './spool.js';
export { SupervisorClient } from './client.js';
export { startSupervisorSpoolDrain, DEFAULT_DRAIN_POLL_MS } from './drain.js';
export type { SpoolDrainHandle } from './drain.js';