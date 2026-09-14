import type { BrowserActionRequest, BrowserActionResponse, BrowserSurfaceRequest, BrowserVisibleRequest, BrowserVisibleResponse, IntervalCloseResponse, IntervalOpenResponse, PersistenceRequest, PersistenceResponse, PreObservationRequest, PreObservationResponse, RecordsRequest, RecordsResponse, SessionResolveRequest, SessionResolveResponse } from '../witness/types.js';
/** A witness call that failed (status + single-cause diagnostic). */
export declare class WitnessRequestError extends Error {
    readonly status: number;
    readonly detail: string | null;
    constructor(status: number, message: string, detail?: string | null);
}
/**
 * Resolves the witness base URL: env first, then the spawned-witness
 * file in the run-state dir (written by the reporter when it auto-spawns
 * a witness without `--witness-url`).
 *
 * Returns:
 *   string: the witness base URL.
 *
 * Throws:
 *   Error: with the exact setup step required when no witness is wired.
 */
export declare function resolveWitnessUrl(): string;
/**
 * The fixture's witness transport.
 *
 * Args:
 *   url: witness base URL (default: resolved from env/state file).
 *   token: run token (default: GATEFORGE_RUN_TOKEN).
 *   timeoutMs: per-call timeout.
 */
export declare class WitnessClient {
    readonly url: string;
    readonly token: string;
    readonly timeoutMs: number;
    constructor(url?: string, token?: string | undefined, timeoutMs?: number);
    /** POST /records (pin #7; Phase 1: requires the supervisor-issued session credential). */
    postRecords(request: RecordsRequest): Promise<RecordsResponse>;
    /**
     * POST /sessions/resolve (Phase 1, worker side): asks for the OPEN
     * session bound to the exact (workerIndex, testId) pair.
     *
     * Deliberately the ONLY session-lifecycle call on the suite-side
     * client (enforcement-review fix 3): open and close live on the
     * supervisor channel (`SupervisorClient`, verifier-key authenticated)
     * and are dispatched by the trusted CLI's spool drain — the tested
     * suite has NO reachable path to mint, seal, or re-seal a session,
     * and with it no path to forge the execution record supervision
     * grades. Resolve only ever answers for a session the supervisor
     * already opened; it cannot create or extend one.
     *
     * Returns:
     *   SessionResolveResponse when an open session answers; null when the
     *   witness answers 404 (not yet opened, or sealed).
     */
    resolveSession(request: SessionResolveRequest): Promise<SessionResolveResponse | null>;
    /**
     * POST /sessions/intervals/open (Phase 1): marks the start of a
     * UI-action observation interval on the witness's monotonic clock.
     * Proxy exchanges completing inside the interval are the session's
     * browser evidence; everything outside (setup traffic) is never
     * credited.
     */
    beginActionInterval(request: {
        sessionId: string;
        sessionToken: string;
        operation: string;
    }): Promise<IntervalOpenResponse>;
    /**
     * POST /sessions/intervals/close (Phase 1): seals the interval. A
     * closed interval can never be stretched later (409 on re-close).
     */
    endActionInterval(request: {
        sessionId: string;
        sessionToken: string;
        intervalId: string;
    }): Promise<IntervalCloseResponse>;
    /**
     * POST /witness/pre-observation (audit round 4): engine-side id-set
     * snapshot BEFORE a claimed create; pass the returned
     * `observationId` to `verifyPersistence` so the issued record carries
     * `before: {entityAbsent}`. Phase 1: requires the supervisor-issued
     * session credential — the snapshot belongs to the open test session.
     */
    preObserve(request: PreObservationRequest): Promise<PreObservationResponse>;
    /**
     * POST /witness/http-observation (ADR 0004 D7, plan §8 / D1):
     * consumes one witness-observed HTTP exchange matching (method, path)
     * and issues witnessed `http.request` records for the declaring
     * test's claimed obligations. Phase 1: the caller must hold a valid
     * OPEN session and only an exchange observed through THAT session's
     * proxy prefix within one of its recorded action intervals can be
     * consumed — the claim set may be given as `claimIds`, or as the
     * singular legacy `claimId`/`obligationId` pair (folded in by the
     * server; a split assignment with distinct values is refused with 400).
     */
    observeHttp(request: {
        claimIds?: string[];
        claimId?: string;
        obligationId?: string;
        testId: string;
        method: string;
        path: string;
        expectedStatus?: number;
        sessionId: string;
        sessionToken: string;
    }): Promise<{
        recordId: string;
        runId: string;
        trust: string;
        status: number;
        records: Array<{
            recordId: string;
            obligationId: string;
        }>;
    }>;
    /**
     * POST /witness/persistence (Phase 1): runs the engine-side adapter
     * read under the supervisor-opened session, so the persistence record
     * binds to the same channel the UI action used.
     */
    verifyPersistence(request: PersistenceRequest & {
        testId: string;
        claimId: string;
        sessionId: string;
        sessionToken: string;
    }): Promise<PersistenceResponse>;
    /**
     * POST /browser/surface (plan Phase 1 item 4): registers the
     * consumer-declared surface descriptor + the app base the ENGINE must
     * drive for this session. Validated engine-side (structure, loopback,
     * fingerprint); selectors are locators only.
     */
    registerBrowserSurface(request: BrowserSurfaceRequest): Promise<{
        registered: true;
    }>;
    /**
     * POST /browser/action (plan Phase 1 item 4): the ENGINE performs one
     * constrained surface operation on its own page and returns its own
     * observation (observed entity id, entered + rendered fields, app
     * status, pre-observation id, issued record ids). Test code supplies
     * intent only — it never touches the engine page.
     */
    browserAction(request: BrowserActionRequest): Promise<BrowserActionResponse>;
    /**
     * POST /browser/visible (plan Phase 1 item 4): the ENGINE re-reads
     * the rendered result for the engine-observed entity and returns the
     * rendered fields.
     */
    browserVisible(request: BrowserVisibleRequest): Promise<BrowserVisibleResponse>;
    /** GET /records — the issued ledger for this run. */
    listRecords(): Promise<{
        records: IssuedLedgerRecord[];
    }>;
    private request;
}
/** One witness-issued ledger record as seen by the ledger endpoint. */
export interface IssuedLedgerRecord {
    recordId: string;
    runId: string;
    trust: 'witnessed' | 'claimed';
    obligationId: string;
    kind: string;
    testId: string;
    payload: unknown;
    issuedAt?: string;
}
//# sourceMappingURL=witness-client.d.ts.map