/**
 * Trusted evidence primitives (plan §5.3, invariant 6, GF-22).
 *
 * The fixture exposes EXACTLY four surfaces — `ui`, `visible`,
 * `persistence`, `finalize` — on a frozen object with a closure-private
 * record list. There is no boolean/escape-hatch primitive (no
 * `prove(kind, true)`), no way to state an entity id for persistence
 * evidence, and no way to substitute an adapter: persistence evidence is
 * minted ONLY by the engine-side witness running the reviewed adapter
 * (GET-only), stamped from the ADAPTER RESPONSE.
 *
 * UI primitives drive the RENDERED app (create/read/update/archive) and
 * read the visible result back from the DOM, so the entityId in a
 * `ui.action` record is observed, not declared. Receipts returned by UI
 * primitives are frozen and branded with a per-instance symbol —
 * `visible.confirm`/`persistence.verify` reject anything without the
 * own-property brand (GF-22: hand-rolled or `Object.create`-branded
 * forgeries fail closed).
 *
 * Every record is submitted to the loopback witness service under EVERY
 * claim the test declares (one obligation id per annotation); the
 * witness issues service provenance, and the ENGINE decides verdicts —
 * never the test. A test using primitives but declaring no claim, or a
 * claim whose evidence was never collected, fails `finalize()` (the
 * gate would grade the claim `missing` anyway; finalize mirrors that
 * fail-fast in the test).
 */
import type { Page, TestInfo } from 'playwright/test';
import { WitnessClient } from './witness-client.js';
/** A UI-action receipt: the ONLY token `visible`/`persistence` accept. */
export interface Receipt {
    readonly kind: 'ui';
    readonly operation: 'create' | 'read' | 'update' | 'delete';
    readonly resourceId: string;
    readonly entityId: string;
    readonly fields: Record<string, string>;
    readonly mode: 'row' | 'form';
    /**
     * Create only: the engine-side pre-observation taken BEFORE the UI
     * action, bound into the persistence record so the engine can verify
     * the entity was absent before (create postcondition, audit round 4).
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
        create(input: {
            fields: {
                first_name: string;
                last_name: string;
            };
        }): Promise<Receipt>;
        read(input: {
            entityId: string;
        }): Promise<Receipt>;
        update(input: {
            entityId: string;
            fields: Partial<{
                first_name: string;
                last_name: string;
            }>;
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
    /** ADR 0004 D7: consumes one proxy-observed request for an http:* claim. */
    http: Readonly<{
        observe(request: {
            method: string;
            path: string;
        }): Promise<{
            status: number;
            recordId: string;
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
 *   page: the test's page (the primitives drive the rendered UI on it).
 *   testInfo: the running test's info (annotations + testId).
 *   baseURL: the app-under-test base; defaults to GATEFORGE_APP_BASE_URL
 *     then GATEFORGE_TARGET_BASE_URL.
 *   client: witness transport override (tests inject their own).
 *
 * Returns:
 *   EvidenceApi: the frozen primitive surface.
 *
 * Throws:
 *   Error: when the test declares no gateforge claim, when no app base
 *   or witness is wired, or when an action/verification fails fail-closed.
 */
export declare function createEvidence({ page, testInfo, baseURL, client, }: {
    page: Page;
    testInfo: TestInfo;
    baseURL?: string;
    client?: WitnessClient;
}): EvidenceApi;
//# sourceMappingURL=evidence.d.ts.map