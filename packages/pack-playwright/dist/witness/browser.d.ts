/**
 * The engine-owned browser (plan Phase 1 item 4): Chromium contexts the
 * WITNESS process creates and drives itself — one isolated context per
 * supervisor-opened test session, closed when the session seals.
 *
 * Test code NEVER touches these pages: the worker holds no handle, no
 * URL, and no capability over them. The engine executes the constrained
 * surface operations (create/read/update/archive) with the
 * consumer-declared locators, and observes each step itself:
 * - the rendered control it clicked and the values it typed;
 * - the actual application request the action caused (captured from the
 *   engine page's own network, app-origin only);
 * - the resulting navigation and the rendered row/form it read back.
 *
 * Forgery resistance (why this channel is proof):
 * - fabricated DOM (`page.evaluate` in the worker page) is irrelevant:
 *   the engine reads its OWN page;
 * - mocked responses (`page.route` in the worker) are irrelevant: the
 *   worker cannot route the engine's traffic;
 * - direct API/Node mutations bypass the engine page entirely: no
 *   engine action runs, so no engine-observed action/visible records
 *   exist for them — invented suite-submitted records never satisfy;
 * - HTTP-200-while-error: the engine asserts the rendered status
 *   itself (created/archived values) AND captures the app response
 *   status — a displayed error fails the action fail-closed.
 *
 * Surface selectors are LOCATORS, never proof: a lying descriptor only
 * makes the engine fail to find elements (fail closed).
 */
import { type Browser, type Page } from 'playwright';
import { type SurfaceDescriptor } from '../surface.js';
/** The UI operations the engine can perform (constrained subset). */
export type EngineOperation = 'create' | 'read' | 'update' | 'delete';
/** One app-origin exchange the engine captured during an action. */
export interface EngineCapturedExchange {
    /** Uppercase method (GET, POST, ...). */
    method: string;
    /** Canonical observed path (query/fragment stripped). */
    path: string;
    /** Response status the app answered. */
    status: number;
    /** Response body bytes (bounded snapshot for hashing). */
    body: Buffer;
}
/** What the engine observed performing one action. */
export interface EngineActionObservation {
    /** Entity id OBSERVED from the rendered list (never declared). */
    entityId: string;
    /** The exact input values the engine typed (exact-value echo source). */
    enteredFields: Record<string, string>;
    /** The rendered fields the engine read back after the action. */
    renderedFields: Record<string, string>;
    /** App-origin exchanges captured inside the action window. */
    exchanges: EngineCapturedExchange[];
    /** Engine-side pre-observation marker (filled by the witness layer). */
    preObservationId?: string;
}
/** Fail-closed engine browser error (surfaced as 409/503 downstream). */
export declare class EngineBrowserError extends Error {
    constructor(message: string);
}
/** The browser launcher the engine drives (default: pinned Chromium). */
export interface EngineBrowserLauncher {
    launch(options?: Record<string, unknown>): Promise<Browser>;
}
/**
 * Owns the engine Chromium instance and its per-session contexts.
 *
 * Args:
 *   launcher: browser launcher (default: the pinned Chromium). Tests
 *     inject a failing launcher to prove the fail-closed path; the
 *     driving and observation below stay engine code regardless of
 *     which executable launches.
 */
export declare class EngineBrowserManager {
    private readonly launcher;
    private browser;
    private launching;
    private readonly sessions;
    /**
     * Pinned `--host-resolver-rules` value binding every attested hostname
     * to its startup-approved loopback IPs. Set once at witness startup
     * (before any launch); the browser is then incapable of resolving
     * those names anywhere but loopback, regardless of later DNS changes.
     */
    private dnsPinRules;
    constructor(launcher?: EngineBrowserLauncher);
    /**
     * Installs the DNS pin rules for the next (first) launch.
     *
     * Args:
     *   rules: the `--host-resolver-rules` value, or null when nothing is
     *     pinned (plain launch, previous behavior).
     *
     * Throws:
     *   EngineBrowserError: when the browser already launched — pins must
     *   precede every navigation (fail closed, never silently unbound).
     */
    setDnsPinRules(rules: string | null): void;
    /**
     * Returns the engine page for one session, creating the isolated
     * context on first use.
     *
     * Args:
     *   sessionId: the supervisor-opened session the context belongs to.
     *
     * Returns:
     *   Promise<Page>: the session's engine-owned page.
     *
     * Throws:
     *   EngineBrowserError: when Chromium cannot launch (fail closed —
     *     the capability is honestly unavailable at runtime).
     */
    pageFor(sessionId: string): Promise<Page>;
    /**
     * Closes and forgets one session's engine context (session seal).
     * Late engine calls for the session then recreate nothing — callers
     * must refuse sealed sessions before driving (they do: every browser
     * endpoint requires an OPEN session first).
     *
     * Args:
     *   sessionId: the sealed session.
     */
    closeSession(sessionId: string): Promise<void>;
    /** Closes every engine context and the browser (witness stop). */
    closeAll(): Promise<void>;
    /** Lazy Chromium launch (single flight; fail closed with the cause). */
    private ensureBrowser;
}
/**
 * Drives one constrained surface operation on the engine page and
 * observes every step itself.
 *
 * Args:
 *   page: the session's engine-owned page.
 *   appBase: loopback app base the engine navigates (validated upstream).
 *   surface: the validated consumer descriptor (locators only).
 *   operation: the constrained operation to perform.
 *   input: entered fields (create/update) and/or the target entity id.
 *
 * Returns:
 *   Promise<EngineActionObservation>: the engine's own observation —
 *   observed entity id, entered + rendered fields, captured exchanges.
 *
 * Throws:
 *   EngineBrowserError: fail-closed on every untrusted outcome —
 *   missing rows, ambiguous creation, wrong rendered status, no
 *   application request, or an application error status.
 */
export declare function driveEngineAction(page: Page, appBase: string, surface: SurfaceDescriptor, operation: EngineOperation, input: {
    fields?: Record<string, string>;
    entityId?: string;
}): Promise<EngineActionObservation>;
/**
 * Re-reads the rendered result for one entity on the engine page
 * (the `visible.confirm` counterpart): row read for mutations, form
 * read for reads.
 *
 * Args:
 *   page: the session's engine-owned page.
 *   appBase: loopback app base.
 *   surface: the validated consumer descriptor.
 *   operation: the original action (decides row vs form readback).
 *   entityId: the engine-observed entity id.
 *
 * Returns:
 *   Promise<Record<string, string>>: the rendered fields.
 *
 * Throws:
 *   EngineBrowserError: when the UI no longer exposes the entity.
 */
export declare function readEngineVisible(page: Page, appBase: string, surface: SurfaceDescriptor, operation: EngineOperation, entityId: string): Promise<Record<string, string>>;
//# sourceMappingURL=browser.d.ts.map