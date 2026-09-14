/** Default cadence between spool polls (the fixture's resolve waits 5s). */
export declare const DEFAULT_DRAIN_POLL_MS = 50;
/** Handle for a running drain (see {@link startSupervisorSpoolDrain}). */
export interface SpoolDrainHandle {
    /**
     * Stops the drain: performs one final sweep of the spool, then
     * force-closes every session the runner left open (outcome unknown —
     * the supervisor did not observe a completed test). Resolves with the
     * lifecycle CONFLICTS observed (empty in a genuine run): a re-begin
     * over an open worker slot, an end without a matching begin, or a
     * second end for the same test. Genuine serial reporter events never
     * conflict — any conflict is worker-side forgery or runner confusion
     * and must fail the run closed downstream.
     */
    stop: () => Promise<{
        conflicts: string[];
    }>;
}
/**
 * Starts the spool drain loop for one supervised run.
 *
 * Args:
 *   options: stateDir + runId locate the spool; witnessUrl/runToken/
 *     verifierKey authenticate the supervisor channel; pollMs tunes the
 *     poll cadence (tests only).
 *
 * Returns:
 *   SpoolDrainHandle: awaitable stop (final drain + force-close).
 */
export declare function startSupervisorSpoolDrain(options: {
    stateDir: string;
    runId: string;
    witnessUrl: string;
    runToken: string;
    verifierKey: string;
    pollMs?: number;
}): SpoolDrainHandle;
//# sourceMappingURL=drain.d.ts.map