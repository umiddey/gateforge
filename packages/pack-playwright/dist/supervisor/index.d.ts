/**
 * Supervisor surface of the Playwright evidence pack (enforcement-
 * review fixes 2a/3): the pieces the TRUSTED CLI process uses to hold
 * the session-lifecycle authority the runner child must never have.
 */
export { appendSpoolEvent, readSpoolEvents, spoolPathFor } from './spool.js';
export type { SpoolEvent, SpoolEventKind } from './spool.js';
export { SupervisorClient } from './client.js';
export { startSupervisorSpoolDrain, DEFAULT_DRAIN_POLL_MS } from './drain.js';
export type { SpoolDrainHandle } from './drain.js';
//# sourceMappingURL=index.d.ts.map