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
//# sourceMappingURL=spool.d.ts.map