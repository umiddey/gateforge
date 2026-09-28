/**
 * The gateforge Vitest reporter (plan 2026-09-25 phase 4): the
 * runner-side half of the Vitest+supertest witness channel.
 *
 * While the supervised Vitest run executes, this reporter writes the
 * same lifecycle spool events the Playwright reporter writes
 * (testBegin / testEnd with the test identity, outcome, attempt) plus a
 * runner-flags document recording runner-assisted retries — the
 * TRUSTED CLI drain reads the spool and performs the witness's
 * supervisor calls (session open/seal); this process holds no
 * supervisor rights at all.
 *
 * Identity: a test's reconciliation key is
 * `<repo-relative posix file>#<title path joined by '>'>` — the same
 * key shape every runner adapter uses. The in-test helper
 * (`@gate-forge/pack-playwright/vitest`) resolves its session by the
 * EXACT identity this reporter writes, so the two must never drift.
 *
 * The reporter is INERT without supervised wiring: without the
 * run-scoped `GATEFORGE_STATE_DIR`/`GATEFORGE_RUN_ID` variables every
 * hook is a no-op, so a plain `vitest run` behaves exactly as without
 * the reporter.
 *
 * Loaded by the VitestRunnerAdapter through `--reporter=<this module>`;
 * Vitest instantiates custom reporters with `new`.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { canonicalOf } from '../json.js';
import { CLAIM_INJECTIONS_FILE } from '../constants.js';

/** Env the runner child receives from the adapter's allowlist. */
const ENV_STATE_DIR = 'GATEFORGE_STATE_DIR';
const ENV_RUN_ID = 'GATEFORGE_RUN_ID';

/** The runner-flags document the adapter merges into its envelope. */
const RUNNER_FLAGS_FILE = 'runner-flags.json';

/** One observed Vitest test entity (structural subset of vitest's TestCase). */
interface VitestTestCase {
  /** The runner-assigned test id (a string in vitest 3.x). */
  readonly id: string;
  /** The leaf test title. */
  readonly name: string;
  /** The suite chain (vitest 3.x entities carry `parent`). */
  readonly parent?: { readonly name: string; readonly type: string; readonly parent?: unknown } | null;
  /** Legacy alias for the suite chain (tasks carry `suite`). */
  readonly suite?: { readonly name: string; readonly type: string; readonly suite?: unknown } | null;
  /** The owning module. */
  readonly module: { readonly moduleId: string };
  /** The observed result (state is `passed`/`failed`/`skipped` when done). */
  readonly result?: () => { readonly state?: string; readonly errors?: readonly unknown[] } | undefined;
  /** The raw task (retryCount lives on `task.result.retryCount`). */
  readonly task?: { readonly result?: { readonly retryCount?: number } | null };
}

/** The spool event this reporter writes (mirrors the CLI drain's reader). */
interface SpoolEvent {
  readonly kind: 'testBegin' | 'testEnd';
  readonly testId: string;
  readonly workerIndex: number;
  readonly file: string | null;
  readonly titlePath: string[];
  readonly project: string | null;
  readonly outcome?: string;
  readonly attempt?: number;
}

/** The reconciliation identity of one test. */
interface TestIdentity {
  readonly testId: string;
  readonly file: string;
  readonly titlePath: string[];
}

/**
 * The title path of one test entity: the suite chain's names, then the
 * leaf title (the same join `vitest list --json` prints with ' > ').
 */
function titlePathOf(testCase: VitestTestCase): string[] {
  const segments: string[] = [];
  let current: unknown = testCase.parent ?? testCase.suite;
  while (typeof current === 'object' && current !== null) {
    const suite = current as { name: string; type: string; parent?: unknown; suite?: unknown };
    if (suite.type !== 'suite') break;
    segments.unshift(suite.name);
    current = suite.parent ?? suite.suite;
  }
  segments.push(testCase.name);
  return segments;
}

/**
 * The reconciliation identity of one test entity: repo-relative posix
 * file plus the title path, keyed `<file>#<titlePath.join('>')>`.
 */
function identityOf(testCase: VitestTestCase): TestIdentity {
  const file = relative(process.cwd(), testCase.module.moduleId).split('\\').join('/');
  const titlePath = titlePathOf(testCase);
  return { file, titlePath, testId: `${file}#${titlePath.join('>')}` };
}

/**
 * The gateforge Vitest reporter. No options today; the constructor
 * signature is Vitest's custom-reporter contract (options object).
 */
export default class GateforgeVitestReporter {
  private readonly stateDir: string | null;
  private readonly spoolFile: string | null;
  private readonly flagsFile: string | null;
  private retriesDetected = false;

  constructor(_options: object = {}) {
    const stateDir = process.env[ENV_STATE_DIR];
    const runId = process.env[ENV_RUN_ID];
    const wired = stateDir !== undefined && stateDir !== '' && runId !== undefined && runId !== '';
    this.stateDir = wired ? (stateDir as string) : null;
    this.spoolFile = wired ? join(stateDir as string, 'spool', runId as string, 'events.jsonl') : null;
    this.flagsFile = wired ? join(stateDir as string, 'vitest', runId as string, RUNNER_FLAGS_FILE) : null;
  }

  /** Spools one lifecycle event (never crashes the run on failure). */
  private appendEvent(event: SpoolEvent): void {
    if (this.spoolFile === null) return;
    try {
      mkdirSync(dirname(this.spoolFile), { recursive: true });
      appendFileSync(this.spoolFile, `${canonicalOf(event as unknown as Record<string, unknown>)}\n`, 'utf8');
    } catch (error) {
      console.warn(`[gateforge] cannot append to the lifecycle spool: ${(error as Error).message}`);
    }
  }

  /** testBegin: the trusted drain opens the session for this identity. */
  onTestCaseReady(testCase: VitestTestCase): void {
    if (this.spoolFile === null) return;
    const identity = identityOf(testCase);
    this.appendEvent({
      kind: 'testBegin',
      testId: identity.testId,
      workerIndex: 0,
      file: identity.file,
      titlePath: identity.titlePath,
      project: null,
      ...this.claimsFor(identity),
    });
  }

  /**
   * testEnd: the observed outcome plus the attempt count (a
   * runner-assisted retry shows up as retryCount > 0 and is recorded in
   * the runner-flags document, which the adapter surfaces as
   * `retriesDetected` — required retries are zero).
   */
  onTestCaseResult(testCase: VitestTestCase): void {
    if (this.spoolFile === null) return;
    const identity = identityOf(testCase);
    const result = testCase.result?.();
    const state = result?.state;
    const outcome =
      state === 'passed' || state === 'failed' || state === 'skipped' ? state : 'failed';
    const retryCount = testCase.task?.result?.retryCount ?? 0;
    if (retryCount > 0) this.retriesDetected = true;
    this.appendEvent({
      kind: 'testEnd',
      testId: identity.testId,
      workerIndex: 0,
      file: identity.file,
      titlePath: identity.titlePath,
      project: null,
      outcome,
      attempt: retryCount + 1,
    });
  }

  /** Seals the runner-flags document with the observed retry signal. */
  onTestRunEnd(): void {
    if (this.flagsFile === null) return;
    try {
      mkdirSync(dirname(this.flagsFile), { recursive: true });
      writeFileSync(
        this.flagsFile,
        `${canonicalOf({ schemaVersion: 1, retriesDetected: this.retriesDetected })}\n`,
        'utf8',
      );
    } catch (error) {
      console.warn(`[gateforge] cannot write the runner flags: ${(error as Error).message}`);
    }
  }

  /**
   * Mapped obligation ids for one reconciliation key (from the
   * CLI-written claim-injections document; malformed documents
   * contribute nothing).
   */
  private claimsFor(identity: TestIdentity): { claims?: string[] } {
    if (this.stateDir === null) return {};
    let raw: string;
    try {
      raw = readFileSync(join(this.stateDir, CLAIM_INJECTIONS_FILE), 'utf8');
    } catch {
      return {};
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      return {};
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return {};
    const injections = (document as Record<string, unknown>)['injections'];
    if (typeof injections !== 'object' || injections === null || Array.isArray(injections)) return {};
    const claims = (injections as Record<string, unknown>)[identity.testId];
    if (!Array.isArray(claims)) return {};
    const clean = [...new Set(claims.filter((claim): claim is string => typeof claim === 'string' && claim !== ''))].sort();
    return clean.length > 0 ? { claims: clean } : {};
  }
}
