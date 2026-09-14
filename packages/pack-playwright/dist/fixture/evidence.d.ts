/**
 * Trusted evidence primitives (plan §5.3, invariant 6, GF-22; engine-
 * browser rewrite per plan Phase 1 item 4).
 *
 * The fixture exposes EXACTLY five surfaces — `ui`, `visible`,
 * `persistence`, `http`, `finalize` — on a frozen object with a
 * closure-private record list. It is APPLICATION-INDEPENDENT: the pack
 * carries no Accounts strings, no product selectors, and no route
 * knowledge. The CONSUMER supplies a declarative {@link SurfaceDescriptor}
 * (list page, row/field selectors, form templates, archive control,
 * status values) — the Accounts description lives in the example tree
 * (`example/e2e/accounts-surface.js`), not here.
 *
 * ENGINE-OWNED BROWSER (plan Phase 1 item 4): the `ui.*` primitives no
 * longer drive a worker-side page. They register the consumer surface
 * with the witness and ask the ENGINE to perform each constrained
 * operation on its own page (`POST /browser/action`), then to re-read
 * the rendered result (`POST /browser/visible`). Test code supplies
 * INTENT (fields, entity id, claims) only — it never touches the engine
 * page, so it cannot manufacture DOM state, intercept the application
 * response, or substitute script/API effects and receive browser
 * credit. Every `ui.action` / `ui.visible-result` record the gate
 * grades is issued engine-side with origin `engine-observed`;
 * suite-submitted UI records never satisfy browser contracts.
 *
 * For create/update the action record's `fields` are the ENTERED input
 * the engine typed (plan §3.6 exact-value echo): the engine
 * echo-checks them against the independently fetched persisted fields,
 * and a mismatch fails the obligation with `EVIDENCE_VALUE_MISMATCH`
 * even when the status was 2xx.
 *
 * Receipts returned by UI primitives are frozen and branded with a
 * per-instance symbol — `visible.confirm`/`persistence.verify` reject
 * anything without the own-property brand (GF-22: hand-rolled or
 * `Object.create`-branded forgeries fail closed).
 *
 * Every engine call runs under the SUPERVISOR-ISSUED test session. The
 * trusted reporter opens one session per started test (`runId,
 * sessionId, testId, worker`) and the fixture resolves it by the exact
 * (workerIndex, testId) pair; a suite-supplied testId or annotation
 * alone cannot mint records for an arbitrary session, because the
 * witness rejects submissions without a valid OPEN session and forces
 * the record's testId onto the session's supervisor-registered value.
 * Sealing (test end) rejects all late submissions and closes the
 * session's engine browser context.
 */
import type { Page, TestInfo } from 'playwright/test';
import { SURFACE_DESCRIPTOR_VERSION, type SurfaceDescriptor } from '../surface.js';
import type { SessionCredential } from '../witness/types.js';
import { WitnessClient } from './witness-client.js';
export { SURFACE_DESCRIPTOR_VERSION, type SurfaceDescriptor };
/** A UI-action receipt: the ONLY token `visible`/`persistence` accept. */
export interface Receipt {
    readonly kind: 'ui';
    readonly operation: 'create' | 'read' | 'update' | 'delete';
    readonly resourceId: string;
    readonly entityId: string;
    readonly fields: Record<string, string>;
    readonly mode: 'row' | 'form';
    /**
     * Create/update only: the engine-side pre-observation taken BEFORE the
     * UI action, bound into the persistence record so the engine can
     * verify the before/after delta (create postcondition, audit round 4).
     */
    readonly preObservationId?: string;
}
/** Outcome of `persistence.verify` (verdict-relevant, witness-issued). */
export interface PersistenceOutcome {
    recordId: string;
    runId: string;
    verdictRelevant: {
        found: boolean;
        fieldsMatch: boolean;
        mismatches?: string[];
    };
}
/** The frozen, no-escape-hatch evidence surface. */
export interface EvidenceApi {
    readonly ui: Readonly<{
        /**
         * The ENGINE drives the rendered create form with the DECLARED input
         * fields (plan §3.6: the journey's entered values are what the
         * engine echo-checks against the persisted state).
         */
        create(input: {
            fields: Record<string, string>;
        }): Promise<Receipt>;
        read(input: {
            entityId: string;
        }): Promise<Receipt>;
        update(input: {
            entityId: string;
            fields: Record<string, string>;
        }): Promise<Receipt>;
        archive(input: {
            entityId: string;
        }): Promise<Receipt>;
    }>;
    readonly visible: Readonly<{
        confirm(receipt: Receipt): Promise<{
            entityId: string;
            fields: Record<string, string>;
        }>;
    }>;
    readonly persistence: Readonly<{
        verify(receipt: Receipt): Promise<PersistenceOutcome>;
    }>;
    /**
     * ADR 0004 D7 (plan §8 / D1): consumes one witness-observed HTTP
     * exchange for an http:* claim. Only an exchange the ENGINE captured
     * during its own action interval can be consumed — a request supplied
     * by another test/worker (or by setup traffic outside every interval)
     * is never credited. Pass an explicit `obligationId` when the test
     * declares more than one claim — omitted selection with several
     * candidates throws instead of silently binding the first claim.
     */
    http: Readonly<{
        observe(request: {
            method: string;
            path: string;
            expectedStatus?: number;
            obligationId?: string;
        }): Promise<{
            status: number;
            recordId: string;
            recordIds: string[];
        }>;
    }>;
    finalize(): Promise<{
        claims: string[];
        records: WitnessRecord[];
    }>;
}
/** One witness-issued record as the finalize ledger reports it. */
export interface WitnessRecord {
    recordId: string;
    runId: string;
    obligationId: string;
    kind: string;
    payload: unknown;
}
/** Claims from the test annotations (`{type: 'gateforge', description}`). */
export declare function claimsFromAnnotations(annotations: readonly {
    type: string;
    description?: string;
}[]): string[];
/** Splits `<resourceId>:<contract>` at the first colon. */
export declare function resourceIdOfClaim(claim: string): string;
/**
 * Creates the evidence API for one test.
 *
 * Args:
 *   page: IGNORED for evidence (kept for call-shape compatibility) —
 *     the engine drives its own page; the worker page is never an
 *     evidence channel.
 *   testInfo: the running test's info (annotations, testId, workerIndex).
 *   surface: REQUIRED consumer-declared {@link SurfaceDescriptor} — the
 *     pack carries no application-specific selectors (plan Phase 1
 *     item 7). Registered with the witness; the ENGINE drives it
 *     against the provisioned attested subject (fake-frontend fix:
 *     the driven origin comes from trusted witness configuration,
 *     never from suite input — there is no app-base parameter here
 *     by design).
 *   client: witness transport override (tests inject their own).
 *   session: pre-resolved session credential (harnesses that opened the
 *     session themselves); default resolves it from the supervisor
 *     channel. A credential whose testId differs from this test's is
 *     refused.
 *   sessionResolveTimeoutMs: bounded wait for the supervisor's session
 *     open (harness tuning; default 5s).
 *
 * Returns:
 *   Promise<EvidenceApi>: the frozen primitive surface.
 *
 * Throws:
 *   Error: on a missing/outdated surface descriptor (migration error
 *     naming the new required `surface` parameter), when the test
 *     declares no gateforge claim and its session carries no
 *     supervisor-registered (mapped) claims, when no app base or witness
 *     or OPEN session is wired, or when an action/verification fails
 *     fail-closed.
 */
export declare function createEvidence({ page, testInfo, surface, client, session, sessionResolveTimeoutMs, }: {
    page?: Page;
    testInfo: TestInfo;
    surface?: SurfaceDescriptor;
    client?: WitnessClient;
    session?: SessionCredential;
    sessionResolveTimeoutMs?: number;
}): Promise<EvidenceApi>;
//# sourceMappingURL=evidence.d.ts.map