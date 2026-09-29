/**
 * The runner-adapter contract (plan 2026-09-25 phase 0): the four jobs
 * every test runner performs so the witness can produce the SAME trusted
 * evidence for it.
 *
 * WHY this shape. The witness is an HTTP proxy plus a DB/queue reader; a
 * proxy does not care who sends the traffic. Everything runner-specific
 * collapses into four operations:
 *
 * 1. `enumerate()` — LIST the tests BEFORE the run. The expected set is
 *    fixed first (the same rule the Playwright path already follows).
 * 2. `childEnv()` — TAG every request with the test identity: a
 *    per-test session proxy URL (what Playwright uses today) or a signed
 *    session header.
 * 3. `execute()` — RUN the suite under trusted supervision.
 * 4. `parseResults()` — READ the outcome in a structured format (native
 *    JSON or JUnit XML). Terminal colors are never parsed.
 *
 * Honesty rules baked into the contract (frozen JSON keys, cause codes
 * and exit codes — additions only):
 * - A runner's own "passed" is never authority. `parseResults` produces
 *   reporter INPUT; the verdict comes from `superviseExecution` in
 *   `@gate-forge/core` plus the witness-issued session trace.
 * - An empty enumeration is `unavailable`, never a discovered run of
 *   zero tests: nothing executed proves nothing.
 * - A runner that cannot attribute its traffic (no session tag) says so
 *   with `tagChannel: 'none'`; the supervisor then refuses to attribute
 *   ANY exchange to that test instead of guessing.
 * - `execute` and `parseResults` share the envelope so a caller can read
 *   a runner's report without spawning the runner.
 */
import type { RunnerCapabilities, RunnerExecutionEnvelope } from '@gate-forge/core';

/** Runner name the contract's cross-references accept today. */
export type RunnerName = 'playwright' | 'cypress' | 'pytest' | 'vitest' | (string & {});

/**
 * How a runner's traffic is attributed to one test.
 *
 * - `session-proxy`: the test addresses the witness through a per-test
 *   session proxy prefix (Playwright's `page`-level proxy today).
 * - `signed-header`: the test carries a per-test signed session header
 *   on every request (no proxy address to rewrite).
 * - `none`: the runner cannot tag its traffic. Traffic is NEVER
 *   attributed to a test in this mode — the same fail-closed rule the
 *   Playwright path applies to "bypassed every session channel".
 */
export type RunnerTagChannel = 'session-proxy' | 'signed-header' | 'none';

/**
 * One test the runner is expected to run, enumerated BEFORE the run.
 *
 * Mirrors `PlannedInstanceInput` from `@gate-forge/core` so the
 * expected set crosses into supervision without a lossy re-shape.
 */
export interface RunnerTestIdentity {
  /** Stable logical key (the identity join key). */
  logicalKey: string;
  /** Runner project, or null when the runner reports none. */
  project: string | null;
  /** Repo-relative posix file (the identity join key). */
  file: string;
  /** Full title path (the identity join key). */
  titlePath: readonly string[];
  /** Blocking annotations observed pre-run (`.skip` / `.only` / `.fixme`). */
  blockingAnnotations: readonly string[];
  /**
   * The runner's own id for this test, EXACTLY as the runner-side
   * reporter writes it into the lifecycle spool (additive, plan
   * 2026-09-25 runner-agnostic evidence): the pytest node id, the
   * `<file>#<title path>` key for vitest and cypress. Optional — the
   * trusted supervisor registers the expected set with it so the
   * witness-side trace names the same identities the child will spool;
   * a missing id falls back to the logical key.
   */
  frameworkId?: string;
}

/** Outcome of one `enumerate()` call (never a silent empty success). */
export interface RunnerEnumeration {
  /**
   * `discovered` only when the runner reported a real, non-empty test
   * set. A zero-test run, a missing runner, and a collection error are
   * all `unavailable` — nothing executed proves nothing.
   */
  status: 'discovered' | 'unavailable';
  /** Single-cause detail (bounded), always populated when unavailable. */
  detail: string;
  /** The enumerated tests (empty exactly when `status` is `unavailable`). */
  tests: readonly RunnerTestIdentity[];
  /** Runner version the enumeration observed, when the runner reports one. */
  engineVersion?: string;
}

/** The one test a `childEnv()` call is tagging. */
export interface RunnerSessionTag {
  /** The logical key the traffic will be attributed to. */
  logicalKey: string;
  /** The runner's own instance id for this test (spec id, node id). */
  frameworkId: string;
  /** Runner project, or null. */
  project: string | null;
}

/**
 * Run-scoped wiring the adapter needs to build a child's environment.
 *
 * Every field is NON-SECRET: the witness's run token and the per-test
 * session token are the only signing material a test may hold, and
 * neither can mint, seal or re-seal a session (the supervisor's channel
 * is verifier-key authenticated and unreachable from the suite).
 */
export interface RunnerChildEnvContext {
  /** Absolute witness base URL the child talks to. */
  witnessUrl: string;
  /** Run token the child presents on witness calls. */
  runToken: string;
  /** Per-test session id the supervisor opened for the tagged test. */
  sessionId: string;
  /** Per-test session token the child presents for interval/HTTP calls. */
  sessionToken: string;
  /** Absolute per-test session proxy prefix (empty for header tagging). */
  sessionProxyUrl: string;
  /** Absolute base URL of the application under test. */
  appBaseUrl: string;
}

/** The environment one tagged test's process must see. */
export interface RunnerChildEnv {
  /**
   * The variables to ADD to the runner child. The adapter never returns
   * a wholesale `process.env` copy: the caller owns the allowlist.
   */
  vars: Readonly<Record<string, string>>;
  /** How the child's traffic is attributed (see {@link RunnerTagChannel}). */
  tagChannel: RunnerTagChannel;
  /**
   * The variable names carrying the TEST IDENTITY. At least one must
   * differ between two sessions of the same run — the contract suite
   * asserts exactly that, because a constant tag is unattributed
   * traffic wearing a tag.
   */
  identityVars: readonly string[];
  /**
   * The runner-side mechanism the tag travels on (a support-file
   * injection, a plugin fixture, an interceptor). Diagnostic: it is what
   * a failing run's report should name.
   */
  mechanism: string;
}

/** The raw, structured results of one runner execution. */
export interface RunnerRawResults {
  /** The runner process exit status (null when it never started). */
  processExit: number | null;
  /**
   * The working directory the report's file paths are relative to, when
   * the runner reports ABSOLUTE paths (some JSON reporters do). Absent
   * means the report's paths are already repo-relative — or that the
   * adapter attributes nothing, rather than guessing a base.
   */
  cwd?: string;
  /**
   * The runner's structured report: native JSON, JUnit XML, or the
   * witness-facing outcomes document. Never terminal output.
   */
  report: string;
  /** True when the runner reported the run was sharded. */
  sharded?: boolean;
  /** Shard completeness detail, when the runner reported shards. */
  shardDetail?: string;
  /**
   * Setup/teardown/runner-body outcome the runner reported. Absent =
   * unknown, which grades fail-closed downstream.
   */
  fixtureOutcome?: 'passed' | 'failed' | 'unknown';
}

/** What `execute()` is asked to run. */
export interface RunnerExecuteRequest {
  /** Exact logical keys selected for the run (never a wildcard). */
  logicalKeys: readonly string[];
  /** Absolute run-state directory (excluded from tracked inputs). */
  stateDir: string;
  /** Run id the execution binds to. */
  runId: string;
  /** Whole-run wall-clock bound; expiry is an incomplete run. */
  timeoutMs: number;
  /** Absolute repo root the runner configuration lives under. */
  cwd: string;
  /**
   * Selection mode (additive; absent = `full-relevant-suite`, whose
   * execution is byte-identical to before). A `named-selection` run
   * executes ONLY the named tests: the adapter narrows below file
   * granularity wherever its runner can, and any test it cannot
   * exclude is reported, never silently graded.
   */
  mode?: 'full-relevant-suite' | 'mapped-selection' | 'named-selection';
  /**
   * Exact repo-relative `file:line` locations of the selected tests, as
   * the plan fixed them before the run. Playwright executes exactly
   * these. Undefined = file granularity.
   */
  testLocations?: readonly string[];
  /**
   * The runner's own project names to run, exactly as `enumerate`
   * reported them. Part of the identity join key, so a run that does
   * not select them grades its outcomes against a different identity
   * than the expected set was fixed with.
   */
  projects?: readonly string[];
}

/**
 * The runner-adapter contract.
 *
 * @typeParam TReport - the runner's native report shape, when an adapter
 *   wants to expose it (the contract itself only needs the text).
 */
export interface RunnerAdapter<TReport = unknown> {
  /** Runner name this adapter serves, e.g. `cypress`. */
  readonly runner: RunnerName;
  /** Declared capabilities — callers honor, never assume. */
  readonly capabilities: RunnerCapabilities;
  /**
   * Job 1: lists the runner's tests BEFORE the run.
   *
   * Args:
   *   cwd: absolute repo root the runner configuration lives under.
   *
   * Returns:
   *   Promise<RunnerEnumeration>: the expected set, or an `unavailable`
   *   verdict with a single cause. Never an empty `discovered` list.
   */
  enumerate(cwd: string): Promise<RunnerEnumeration>;
  /**
   * Job 2: builds the environment that tags one test's traffic.
   *
   * Args:
   *   session: the test being tagged.
   *   context: run-scoped, non-secret witness wiring.
   *
   * Returns:
   *   RunnerChildEnv: the variables plus the channel the tag travels on.
   */
  childEnv(session: RunnerSessionTag, context: RunnerChildEnvContext): RunnerChildEnv;
  /**
   * Job 3: runs the suite under trusted supervision.
   *
   * Args:
   *   request: the exact selection, run identity, and wall-clock bound.
   *
   * Returns:
   *   Promise<RunnerExecutionEnvelope>: the structured outcome envelope
   *   (a runner exit code alone is never a gate result).
   */
  execute(request: RunnerExecuteRequest): Promise<RunnerExecutionEnvelope>;
  /**
   * Job 4: reads one structured report into the outcome envelope.
   *
   * Args:
   *   raw: the runner's structured report plus its exit status.
   *
   * Returns:
   *   RunnerExecutionEnvelope: reporter INPUT for supervision, never a
   *   verdict. An unreadable report is `complete: false`.
   */
  parseResults(raw: RunnerRawResults): RunnerExecutionEnvelope;
  /**
   * The runner's native parsed report, for callers that need the
   * runner-specific shape (diagnostics surfaces). Optional: an adapter
   * whose report is only ever read as an envelope omits it.
   */
  parseReport?(raw: RunnerRawResults): TReport;
}
