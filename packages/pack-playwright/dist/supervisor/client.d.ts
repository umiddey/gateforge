import type { ExpectedSetRequest, ExpectedSetResponse, ExecutionTraceResponse, ServerE2eDeclarationsRequest, ServerE2eDeclarationsResponse, ServerPersistenceIntentRequest, ServerPersistenceResponse, ServerPreObservationResponse, SessionCloseRequest, SessionCloseResponse, SessionOpenRequest, SessionOpenResponse } from '../witness/types.js';
/**
 * The supervisor-grade witness client.
 *
 * Args:
 *   url: witness base URL (loopback).
 *   token: the run token (outer auth gate).
 *   verifierKey: the witness verifier key (the supervisor capability;
 *     the tested suite never receives it).
 *   timeoutMs: per-call timeout.
 */
export declare class SupervisorClient {
    readonly url: string;
    readonly token: string;
    readonly verifierKey: string;
    readonly timeoutMs: number;
    constructor(url: string, token: string, verifierKey: string, timeoutMs?: number);
    /**
     * POST /runs/expected-set (fix 2a): registers the expected test set
     * BEFORE the run; idempotent for an identical set.
     *
     * Args:
     *   request: the expected tests (identity-shaped).
     *
     * Returns:
     *   Promise<ExpectedSetResponse>: bound + enumeration digest + count.
     *
     * Throws:
     *   WitnessRequestError: on any refusal (401/403/409/400) — the CLI
     *     turns a refusal into a fail-closed run block.
     */
    registerExpectedSet(request: ExpectedSetRequest): Promise<ExpectedSetResponse>;
    /**
     * POST /sessions/open (fix 3): opens one test session on the
     * supervisor's behalf (drained from the runner's lifecycle spool).
     */
    openSession(request: SessionOpenRequest): Promise<SessionOpenResponse>;
    /**
     * POST /sessions/close (fix 3): seals the session with the observed
     * outcome; sealing is final.
     */
    closeSession(request: SessionCloseRequest): Promise<SessionCloseResponse>;
    /**
     * POST /runs/server-e2e-declarations: registers the obligations the
     * trusted mapping layer declared kind `server-e2e` — the witness then
     * (and only then) stamps `channel: 'server'` records for them.
     */
    registerServerE2eDeclarations(request: ServerE2eDeclarationsRequest): Promise<ServerE2eDeclarationsResponse>;
    /**
     * POST /witness/server-persistence: forwards one drained persistence
     * claim intent. The witness executes the adapter SERVER PROBE itself
     * and either stamps a witnessed `channel: 'server'` record (post) or
     * stores its before-state (pre) — or answers a TYPED failure (the
     * cause code rides `WitnessRequestError.detail`), which is never
     * satisfaction.
     */
    verifyServerPersistence(request: ServerPersistenceIntentRequest): Promise<ServerPersistenceResponse | ServerPreObservationResponse>;
    /**
     * GET /runs/execution-trace (fix 2b): the witness-side session record
     * — THE execution authority supervision grades completeness from.
     *
     * Returns:
     *   Promise<ExecutionTraceResponse | null>: the trace, or null when
     *   the witness cannot serve it (fail closed downstream — never an
     *   empty success).
     */
    executionTrace(): Promise<ExecutionTraceResponse | null>;
    /** The supervisor headers (run token + verifier key). */
    private headers;
    /** POST with supervisor headers; errors map to typed WitnessRequestError. */
    private request;
}
//# sourceMappingURL=client.d.ts.map