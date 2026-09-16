/** Default cadence between spool polls (the fixture's resolve waits 5s). */
export declare const DEFAULT_DRAIN_POLL_MS = 50;
/** Handle for a running drain (see {@link startSupervisorSpoolDrain}). */
export interface SpoolDrainHandle {
    /**
     * Stops the drain: performs one final sweep of both spools (lifecycle
     * events AND persistence intents), then force-closes every session the
     * runner left open (outcome unknown — the supervisor did not observe a
     * completed test). Resolves with the lifecycle CONFLICTS observed
     * (empty in a genuine run): a re-begin over an open worker slot, an
     * end without a matching begin, or a second end for the same test —
     * plus the TYPED server-persistence intent failures (each names the
     * intent, the witness cause, and the next action). Genuine serial
     * reporter events never conflict — any conflict is worker-side forgery
     * or runner confusion and must fail the run closed downstream.
     */
    stop: () => Promise<{
        conflicts: string[];
        intentFailures: string[];
    }>;
}
/**
 * Starts the spool drain loop for one supervised run.
 *
 * Args:
 *   options: stateDir + runId locate the spools; witnessUrl/runToken/
 *     verifierKey authenticate the supervisor channel; pollMs tunes the
 *     poll cadence (tests only); serverE2eObligations, when provided,
 *     are registered BEFORE any intent forwarding (the trusted mapping
 *     layer's `kind: server-e2e` declarations — the witness stamps
 *     server-channel records for these obligations only).
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
    serverE2eObligations?: readonly string[];
}): SpoolDrainHandle;
//# sourceMappingURL=drain.d.ts.map