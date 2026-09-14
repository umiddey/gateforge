import { type LedgerRow } from './ledger.js';
/** Minimal reporter-side test shape (Playwright's TestCase in practice). */
export interface ReporterTest {
    id: string;
    title?: string;
    titlePath?: () => string[];
    annotations?: Array<{
        type: string;
        description?: string;
    }>;
    location?: {
        file: string;
        line: number;
        column: number;
    };
    /** Project name when the runner exposes it (best effort). */
    project?: {
        name?: string;
    } | null;
    /**
     * The enclosing suite (playwright's reporter hierarchy
     * root → project → file → describe), when the runner exposes it —
     * the describe-stack source for the catalog-identity title path.
     */
    parent?: ReporterSuiteLike | null;
}
/** Structural subset of the runner's suite node (see {@link ReporterTest}). */
export interface ReporterSuiteLike {
    /** Suite title ('' for root, project-less, and file suites). */
    title?: string;
    /** Source location; MISSING for root and project suites. */
    location?: {
        file: string;
        line: number;
        column: number;
    } | null;
    /** Suite kind when the runner exposes it (`root`/`project`/`file`/`describe`). */
    type?: 'root' | 'project' | 'file' | 'describe';
    parent?: ReporterSuiteLike | null;
}
/**
 * Computes the honest aggregate line (plan Phase 4 item 7, §2 row): the
 * reporter NEVER prints an overall gate pass based only on claimed rows
 * while unclaimed obligations block. Pure and deterministic — exported
 * so the honesty contract is directly testable.
 *
 * Args:
 *   rows: the per-claim ledger rows.
 *   unclaimedObligations: count of run obligations with no claim row.
 *
 * Returns:
 *   string: the aggregate summary line.
 */
export declare function gateSummaryLine(rows: readonly LedgerRow[], unclaimedObligations: number): string;
/** Constructor options for the gateforge reporter (trusted-config path). */
export interface GateforgeReporterOptions {
    /** Run-state dir override (precedence over GATEFORGE_STATE_DIR env). */
    stateDir?: string;
    /** Run id override (precedence over GATEFORGE_RUN_ID env). */
    runId?: string;
    /** Runner-outcomes path override (precedence over GATEFORGE_OUTCOMES_FILE env). */
    outcomesPath?: string;
    /** Obligations document path override (precedence over GATEFORGE_OBLIGATIONS env). */
    obligationsPath?: string;
}
/**
 * The gateforge reporter. No options today; the constructor signature is
 * the Playwright reporter contract (`(options: object)`).
 */
export declare class GateforgeReporter {
    private readonly rows;
    /**
     * Phase 4 claim injections (reconciliation key → obligation ids),
     * loaded once from the CLI-written run-state document. Declarations
     * only — they never satisfy anything by themselves.
     */
    private readonly injections;
    /** Phase 4 runner-outcome capture (supervision input, ADR 0005 D2). */
    private readonly runnerOutcomes;
    private runStatus;
    private readonly runnerErrors;
    /** The lifecycle spool file (null when the run has no state dir). */
    private readonly spoolFile;
    /** Resolved run-state paths (options win, env is the legacy fallback). */
    private readonly resolved;
    constructor(options?: GateforgeReporterOptions);
    /**
     * Lifecycle spool write (enforcement-review fix 3): announces the
     * STARTED test to the trusted CLI's drain — which opens the witness
     * session on the supervisor channel, carrying the mapped obligation
     * claims for sidecar/native-mapped tests (Phase 4 claim injection) —
     * and binds worker → session there. The runner itself performs no
     * privileged call. Synchronous API: the CLI's poll cadence absorbs
     * the dispatch latency (the fixture's session resolve waits up to 5s).
     */
    onTestBegin(test: ReporterTest, result: {
        workerIndex?: number;
    }): void;
    /** Runner-level error hook: a global setup/teardown/runner error. */
    onError(error: {
        message?: string;
    }): void;
    /** Collects claims + test identity + the outcome row at test end (synchronous). */
    onTestEnd(test: ReporterTest, result: {
        status: string;
        workerIndex?: number;
        retry?: number;
    }): void;
    /** Playswright `onEnd`: seal the run-level outcome + write artifacts. */
    onEnd(result?: {
        status?: string;
    }): Promise<void>;
    /** Full title path of a test (runner API when present, else [title]). */
    /**
     * The catalog-identity title path: describe titles + the test title —
     * NOT the runner's full path. Playwright's suite hierarchy is
     * root → project → file → describe; identity joins (supervision,
     * claim injections) use the SAME shape the native `--list` enumeration
     * reports (describes + title), so the root/project/file suites are
     * stripped here — by suite `type` when exposed, else by the location
     * heuristic (root/project suites carry no source location; the file
     * suite is the outermost suite that does). A project name or file name
     * must never leak into the identity. Without a parent chain, the bare
     * title keeps the row visible (never misjoined).
     */
    private titlePathOf;
    /**
     * The runner project name for the supervision identity: the
     * `project`-typed ancestor's title (reporter-API `TestCase` carries no
     * `project` member), else the first location-less ancestor, else the
     * runner-provided `project.name` best-effort. Absence stays `null` —
     * never a fabricated project.
     */
    private projectOf;
    /**
     * Whether this suite is at or above the describe level (root, project,
     * or the file suite itself) — walking must stop here. By `type` when
     * exposed; otherwise the file suite is the OUTERMOST suite with a
     * source location (its parent is root/project or absent).
     */
    private isDescribeBoundary;
    /** Repo-relative posix file of a test (null when unknown). */
    private repoRelativeOf;
    /** Native annotation claims of one test (`{type: 'gateforge'}`). */
    private annotationClaimsOf;
    /** Injection-key lookup for one test: `<file>#<titlePath.join('>')>`. */
    private injectedClaimsFor;
    /** Writes the runner-outcomes document when the supervisor asked for it. */
    private writeRunnerOutcomes;
    /** The witness classification projection (real lifecycle + primaryKey). */
    private fetchClassifications;
    private ledgerRows;
    /** Deterministic instant: the run manifest's injected `startedAt`. */
    private runInstant;
    /**
     * Prints the per-claim verdict ledger + the HONEST aggregate line
     * (plan Phase 4 item 7): never an overall pass while unclaimed
     * obligations block; the authoritative CLI remains the only final
     * gate result.
     */
    private printLedger;
    /** GF-24 observability: obligations nobody claimed + records nobody claimed. */
    private printRegistryMismatches;
}
export default GateforgeReporter;
export type { LedgerRow };
//# sourceMappingURL=reporter.d.ts.map