import type { PersistenceRequest, PersistenceResponse, PreObservationRequest, PreObservationResponse, RecordsRequest, RecordsResponse } from '../witness/types.js';
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
    /** POST /records (pin #7). */
    postRecords(request: RecordsRequest): Promise<RecordsResponse>;
    /**
     * POST /witness/pre-observation (audit round 4): engine-side id-set
     * snapshot BEFORE a claimed create; pass the returned
     * `observationId` to `verifyPersistence` so the issued record carries
     * `before: {entityAbsent}`.
     */
    preObserve(request: PreObservationRequest): Promise<PreObservationResponse>;
    /**
     * POST /witness/http-observation (ADR 0004 D7): consumes one
     * engine-observed request matching (method, path) and issues witnessed
     * `http.request` records for the declaring test's claimed obligations.
     * The claim set may be given as `claimIds`, or as the singular legacy
     * `claimId`/`obligationId` pair (folded in by the server).
     */
    observeHttp(request: {
        claimIds?: string[];
        claimId?: string;
        obligationId?: string;
        testId: string;
        method: string;
        path: string;
        expectedStatus?: number;
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
    verifyPersistence(request: PersistenceRequest & {
        testId: string;
        claimId: string;
    }): Promise<PersistenceResponse>;
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