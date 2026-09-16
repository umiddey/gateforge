/** Which runner lifecycle transition the event represents. */
export type SpoolEventKind = 'testBegin' | 'testEnd';
/** One runner lifecycle event (spool line). */
export interface SpoolEvent {
    /** The transition: a test started or ended. */
    kind: SpoolEventKind;
    /** The runner-assigned test id. */
    testId: string;
    /** The worker running (or that ran) the test. */
    workerIndex: number;
    /** Repo-relative posix file of the test (identity join key). */
    file: string | null;
    /** Catalog-identity title path (describes + title). */
    titlePath: string[];
    /** Runner project name, or null when the runner exposes none. */
    project: string | null;
    /** testEnd only: the observed outcome ('passed' | 'failed' | …). */
    outcome?: string;
    /** testEnd only: 1-based attempt number (1 = first attempt). */
    attempt?: number;
    /** The mapped/annotated obligation claims declared for this test. */
    claims?: string[];
}
/**
 * Resolves the spool events file for one run.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   runId: the run identity both sides agree on (env-carried).
 *
 * Returns:
 *   string: absolute `<stateDir>/spool/<runId>/events.jsonl` path.
 */
export declare function spoolPathFor(stateDir: string, runId: string): string;
/**
 * Appends one lifecycle event to the run's spool (runner-side; the
 * reporter calls this). The event is sanitized: string fields are
 * coerced/validated, unknown statuses ride as strings, and canonical
 * JSON escapes every control character (NUL included) — the line is
 * NUL-safe by construction. A failed append never crashes the run: the
 * CLI drain then simply never opens that session and the witness
 * rejects the suite's submissions fail-closed.
 *
 * Args:
 *   spoolFile: absolute spool events file (see {@link spoolPathFor}).
 *   event: the lifecycle event to append.
 */
export declare function appendSpoolEvent(spoolFile: string, event: SpoolEvent): void;
/**
 * Reads every COMPLETE spool line past the given byte offset (CLI-side
 * drain). A trailing fragment without its terminating newline is left
 * for the next poll — partial writes are never parsed.
 *
 * Args:
 *   spoolFile: absolute spool events file.
 *   offset: byte offset to read from (0 = from the start).
 *
 * Returns:
 *   {events, nextOffset}: parsed events in file order and the offset to
 *   resume from (equal to `offset` when nothing complete was added).
 */
export declare function readSpoolEvents(spoolFile: string, offset: number): {
    events: SpoolEvent[];
    nextOffset: number;
};
/** Which CRUD operation a persistence intent serves. */
export type PersistenceIntentOperation = 'create' | 'read' | 'update' | 'delete';
/** Whether the intent precedes the mutation (witness before-state) or follows it (the graded observation). */
export type PersistenceIntentPhase = 'pre' | 'post';
/** What the suite expects the witness to observe (expectations never grade — observations do). */
export type PersistenceIntentExpectation = 'expect-present' | 'expect-absent';
/**
 * One persistence claim intent (spool line). `sequence` is 1-based and
 * strictly increasing PER `claimId` — the witness refuses replayed or
 * out-of-order sequences, so a duplicated line can never re-drive a
 * stale observation. `testId` must be the claiming test's identity (the
 * claim join key: the runner test id for native claims, the sidecar
 * logical key for mapped tests).
 *
 * TIMING CONTRACT for `pre` intents: the trusted drain observes the
 * state at its NEXT poll (bounded by `pollMs`, default 50ms), so a suite
 * writes the pre intent, allows one drain tick, THEN mutates — the
 * witness records whatever is true when IT looks, so a mutation racing
 * ahead of the probe honestly grades absent-before=false (the create
 * postcondition then fails closed; it never silently passes).
 */
export interface PersistenceIntent {
    /** The obligated resource id, e.g. `tenant.lead_push_outbox`. */
    entity: string;
    /** The persistence operation the claim requires. */
    operation: PersistenceIntentOperation;
    /** `pre` = before the mutation (create/update); `post` = the graded observation. */
    phase: PersistenceIntentPhase;
    /** The suite's expectation; the witness records what it ACTUALLY observes. */
    intent: PersistenceIntentExpectation;
    /** The entity key: scalar for single-column primary keys, column-keyed object for composite. */
    key: unknown;
    /** The claimed obligation id `<entity>:persistence:<operation>`. */
    claimId: string;
    /** The claiming test's id (the claim join key). */
    testId: string;
    /** 1-based, strictly increasing per claimId. */
    sequence: number;
}
/** Resolves the intents spool file for one run (`<stateDir>/spool/<runId>/persistence-intents.jsonl`). */
export declare function persistenceIntentsPathFor(stateDir: string, runId: string): string;
/**
 * Appends one persistence intent to the run's intents spool (test-side
 * helper; the CONTRACT is the JSONL line, this writer only keeps it
 * canonical and NUL-safe). A failed append never crashes the test: the
 * drain then simply never forwards the intent and the claim grades
 * fail-closed without its witnessed record.
 *
 * Args:
 *   intentsFile: absolute intents spool file (see {@link persistenceIntentsPathFor}).
 *   intent: the claim intent to append.
 */
export declare function appendPersistenceIntent(intentsFile: string, intent: PersistenceIntent): void;
/**
 * Reads every COMPLETE intent line past the given byte offset (CLI-side
 * drain). Trailing fragments without their newline are left for the next
 * poll; structurally invalid lines are skipped (the claim simply never
 * resolves — fail closed, never crash the drain).
 *
 * Args:
 *   intentsFile: absolute intents spool file.
 *   offset: byte offset to read from (0 = from the start).
 *
 * Returns:
 *   {intents, nextOffset}: parsed intents in file order and the offset to
 *   resume from.
 */
export declare function readPersistenceIntents(intentsFile: string, offset: number): {
    intents: PersistenceIntent[];
    nextOffset: number;
};
//# sourceMappingURL=spool.d.ts.map