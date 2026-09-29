/**
 * The Vitest runner adapter behind the runner-neutral `RunnerAdapter`
 * contract (plan 2026-09-25 phase 4: Jest/Vitest + supertest).
 *
 * - enumerate: the project's own vitest CLI runs `list --run --json` —
 *   the runnable set, fixed BEFORE the run. Vitest's list omits skipped
 *   tests (a bounded, documented divergence: a selection that would run
 *   nothing enumerates `unavailable`, which is the honest verdict).
 * - tag: the pack's Vitest reporter (`vitest/reporter`) spools the same
 *   lifecycle events the Playwright reporter writes, and the in-test
 *   helper (`@gate-forge/pack-playwright/vitest`) resolves the
 *   supervisor-issued session for the running test and rewrites its
 *   supertest traffic through the per-test session proxy origin.
 * - execute: `vitest run --reporter=json` into the EXCLUDED run-state
 *   dir plus the gateforge reporter; the selection granularity is the
 *   test FILE (the same granularity the supervised Playwright run
   * composes).
 * - parse: the jest-compatible JSON document, strictly. A row without
 *   an attributable file/title identity is NEVER attributed to a test;
 *   runner-assisted retries surface through the reporter's flags
 *   document ({@link mergeVitestRunnerFlags}).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RunnerExecutionEnvelope,
  RunnerInstanceOutcome,
} from '@gate-forge/core';
import type {
  RunnerAdapter,
  RunnerChildEnv,
  RunnerChildEnvContext,
  RunnerEnumeration,
  RunnerExecuteRequest,
  RunnerRawResults,
  RunnerSessionTag,
  RunnerTestIdentity,
} from '@gate-forge/witness/adapter';
import { ENV_APP_BASE_URL, ENV_RUN_ID, ENV_RUN_TOKEN, ENV_STATE_DIR, ENV_WITNESS_URL } from '@gate-forge/witness/constants';
import { buildWitnessedSessionRunnerEnv } from './runner-env.js';
import { untrustedEnv } from './reconcile.js';

/** Per-test session variables a runner adapter publishes to the test. */
export const VITEST_ENV_SESSION_ID = 'GATEFORGE_SESSION_ID';
export const VITEST_ENV_SESSION_TOKEN = 'GATEFORGE_SESSION_TOKEN';
export const VITEST_ENV_SESSION_PROXY_URL = 'GATEFORGE_SESSION_PROXY_URL';

/** The variables that carry ONE test's identity to its traffic. */
export const VITEST_IDENTITY_ENV: readonly string[] = [
  VITEST_ENV_SESSION_ID,
  VITEST_ENV_SESSION_TOKEN,
  VITEST_ENV_SESSION_PROXY_URL,
];

/** The runner-flags document the reporter seals (retry detection). */
const RUNNER_FLAGS_FILE = 'runner-flags.json';

/** One jest-compatible assertion row (structural subset of the reporter JSON). */
interface VitestAssertionRow {
  readonly ancestorTitles?: readonly unknown[];
  readonly title?: unknown;
  readonly status?: unknown;
  readonly fullName?: unknown;
}

/** One jest-compatible suite row. */
interface VitestSuiteRow {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly assertionResults?: readonly VitestAssertionRow[];
}

/** The jest-compatible JSON document the Vitest reporter writes. */
export interface VitestJsonReport {
  readonly numTotalTests?: unknown;
  readonly testResults?: readonly VitestSuiteRow[];
}

/**
 * The flag that keeps the runner's persistent result cache out of the
 * candidate workspace (see {@link VitestRunnerAdapter.enumerate}).
 */
const NO_CACHE_FLAG = ['--no-cache'] as const;

/** Options the Vitest runner adapter accepts. */
export interface VitestRunnerAdapterOptions {
  /**
   * Run-scoped witness wiring for `execute` (the trusted caller's
   * channel). Absent falls back to the ambient
   * `GATEFORGE_WITNESS_URL`/`GATEFORGE_RUN_TOKEN`/
   * `GATEFORGE_APP_BASE_URL`.
   */
  witness?: { url?: string; token?: string; appBaseUrl?: string };
  /** Explicit vitest CLI entry (absolute `vitest.mjs` or a bin name). */
  vitestEntry?: string;
}

/**
 * The Vitest runner adapter.
 *
 * The child's vitest resolves from the project under test first
 * (`<cwd>/node_modules/vitest/vitest.mjs`, the same local-first rule
 * the supervised Playwright run applies to its CLI), then the parent
 * process's own module graph, then `vitest` on PATH.
 */
export class VitestRunnerAdapter implements RunnerAdapter<VitestJsonReport | null> {
  readonly runner = 'vitest';

  readonly capabilities = {
    inventory: 'available',
    resolveInstances: 'available',
    execute: 'available',
  } as const;

  constructor(private readonly options: VitestRunnerAdapterOptions = {}) {}

  /**
   * Job 1: the runnable set, fixed BEFORE the run (the project's own
   * vitest CLI, JSON output).
   *
   * Args:
   *   cwd: absolute repo root the vitest project lives under.
   *
   * Returns:
   *   Promise<RunnerEnumeration>: the enumerated tests, or an
   *   `unavailable` verdict with a single cause. An empty project, a
   *   vitest failure, and an unreadable listing are all `unavailable`.
   */
  async enumerate(cwd: string): Promise<RunnerEnumeration> {
    const entry = this.vitestEntryOf(cwd);
    if (entry === null) {
      return {
        status: 'unavailable',
        detail: `vitest enumeration found no vitest CLI under ${cwd} — install vitest in the project`,
        tests: [],
      };
    }
    // `--no-cache`: vitest's persistent result cache lives INSIDE the
    // candidate workspace (`node_modules/.vite`), so an ordinary run
    // mutates candidate bytes after the authority froze the tree and the
    // fail-closed drift gate then refuses the whole run. The cache buys
    // nothing here (the run is bounded and the selection is fixed), so
    // neither supervised child ever writes into the workspace.
    const outcome = await this.spawnVitest(cwd, entry, ['list', '--run', '--json', ...NO_CACHE_FLAG]);
    if (outcome.timedOut) {
      return {
        status: 'unavailable',
        detail: `vitest enumeration exceeded its timeout and was killed — an unavailable run never proves coverage`,
        tests: [],
      };
    }
    if (outcome.code !== 0 || outcome.error !== null) {
      return {
        status: 'unavailable',
        detail: `vitest enumeration failed (exit ${String(outcome.code)}): ${firstLine(outcome.stderr)} — the expected set is unavailable, never faked empty`,
        tests: [],
      };
    }
    const tests = parseVitestListing(outcome.stdout, cwd);
    if (tests === null) {
      return {
        status: 'unavailable',
        detail: 'vitest enumeration produced an unreadable JSON listing — fail closed',
        tests: [],
      };
    }
    if (tests.length === 0) {
      return {
        status: 'unavailable',
        detail: `vitest enumerated no runnable tests under ${cwd} — a zero-test run never proves coverage`,
        tests: [],
      };
    }
    return {
      status: 'discovered',
      detail: `enumerated ${String(tests.length)} vitest test(s) via the project's vitest CLI`,
      tests: tests.sort((a, b) => (a.logicalKey < b.logicalKey ? -1 : a.logicalKey > b.logicalKey ? 1 : 0)),
    };
  }

  /**
   * Job 2: the per-test tag. The pack's Vitest reporter spools the
   * lifecycle events; the in-test helper resolves the supervisor
   * session for the running test and rewrites its supertest traffic
   * through that session's proxy origin.
   *
   * Args:
   *   session: the test being tagged.
   *   context: run-scoped, non-secret witness wiring.
   *
   * Returns:
   *   RunnerChildEnv: the run identity plus the session-scoped tag.
   */
  childEnv(_session: RunnerSessionTag, context: RunnerChildEnvContext): RunnerChildEnv {
    return {
      vars: {
        [ENV_WITNESS_URL]: context.witnessUrl,
        [ENV_RUN_TOKEN]: context.runToken,
        [ENV_APP_BASE_URL]: context.appBaseUrl,
        [ENV_STATE_DIR]: '<run-state dir>',
        [ENV_RUN_ID]: '<run id>',
        [VITEST_ENV_SESSION_ID]: context.sessionId,
        [VITEST_ENV_SESSION_TOKEN]: context.sessionToken,
        [VITEST_ENV_SESSION_PROXY_URL]: context.sessionProxyUrl,
      },
      tagChannel: 'session-proxy',
      identityVars: VITEST_IDENTITY_ENV,
      mechanism:
        'gateforge vitest reporter spools the test lifecycle and the in-test helper resolves the ' +
        'supervisor session, rewriting supertest traffic through the per-test session proxy origin',
    };
  }

  /**
   * Job 3: runs the SELECTED vitest files under the jest-compatible
   * JSON reporter plus the pack's gateforge reporter, with the
   * witnessed-session env allowlist (the run identity the reporter
   * needs to address the lifecycle spool plus the non-secret run
   * wiring — never the verifier key, never any other parent-side name).
   *
   * Args:
   *   request: the exact selection, run identity, and wall-clock bound.
   *
   * Returns:
   *   Promise<RunnerExecutionEnvelope>: the structured outcome envelope
   *   (a runner exit code alone is never a gate result).
   */
  async execute(request: RunnerExecuteRequest): Promise<RunnerExecutionEnvelope> {
    const entry = this.vitestEntryOf(request.cwd);
    if (entry === null) {
      return envelopeIncomplete(null, `vitest execution found no vitest CLI under ${request.cwd} — install vitest in the project`);
    }
    const files = new Set<string>();
    for (const logicalKey of request.logicalKeys) {
      const file = logicalKeyFileOf(logicalKey);
      if (file === null) {
        return envelopeIncomplete(
          null,
          `vitest execution cannot run '${logicalKey}': not a <file>#<title path> identity this adapter enumerated`,
        );
      }
      files.add(file);
    }
    const reportPath = join(request.stateDir, 'vitest', request.runId, 'report.json');
    const argv = [
      'run',
      '--run',
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
      `--reporter=${vitestReporterModulePath()}`,
      ...NO_CACHE_FLAG,
      ...[...files].sort(),
    ];
    const child = spawn(entry.command, [...entry.prefix, ...argv], {
      cwd: request.cwd,
      env: buildWitnessedSessionRunnerEnv(
        {
          [ENV_WITNESS_URL]: this.options.witness?.url ?? process.env[ENV_WITNESS_URL] ?? '',
          [ENV_RUN_TOKEN]: this.options.witness?.token ?? process.env[ENV_RUN_TOKEN] ?? '',
          [ENV_STATE_DIR]: request.stateDir,
          [ENV_RUN_ID]: request.runId,
          [ENV_APP_BASE_URL]: this.options.witness?.appBaseUrl ?? process.env[ENV_APP_BASE_URL] ?? '',
        },
        process.env,
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outcome = await new Promise<{ code: number | null; timedOut: boolean; error: Error | null }>((settle) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, request.timeoutMs);
      child.stdout?.resume();
      child.stderr?.resume();
      child.once('error', (error) => {
        clearTimeout(timer);
        settle({ code: null, timedOut: false, error });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        settle({ code, timedOut, error: null });
      });
    });
    if (outcome.error !== null) {
      return envelopeIncomplete(null, `vitest execution could not start (${entry.command}): ${outcome.error.message}`);
    }
    if (outcome.timedOut) {
      return envelopeIncomplete(
        null,
        `vitest execution exceeded its ${String(request.timeoutMs)}ms bound and was killed — an incomplete run never grades complete`,
      );
    }
    let report = '';
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch {
      report = '';
    }
    let envelope = this.parseResults({ processExit: outcome.code, report, cwd: request.cwd });
    if (!envelope.complete && report === '') {
      envelope = {
        ...envelope,
        incompleteDetail: `vitest produced no JSON report at ${reportPath} (exit ${String(outcome.code)}) — fail closed`,
      };
    }
    // Retry evidence lives in the runner-flags document the gateforge
    // reporter seals (the JSON reporter has no retry surface).
    const flags = this.readRunnerFlags(request.stateDir, request.runId);
    if (flags !== null && flags.retriesDetected) {
      envelope = {
        ...envelope,
        complete: false,
        incompleteDetail:
          envelope.incompleteDetail ??
          'vitest runner-assisted retry detected (required retries are zero) — the run blocks',
        retriesDetected: true,
        retriesDetail: 'the gateforge vitest reporter observed retryCount > 0 for at least one test',
      };
    }
    return envelope;
  }

  /**
   * Job 4: the jest-compatible JSON document, strictly mapped.
   *
   * Args:
   *   raw: the JSON report text plus the runner exit status.
   *
   * Returns:
   *   RunnerExecutionEnvelope: reporter INPUT, never a verdict. An
   *   unreadable report, a zero-test run, and a report whose rows carry
   *   no attributable identity are all `complete: false`.
   */
  parseResults(raw: RunnerRawResults): RunnerExecutionEnvelope {
    if (raw.report.trim() === '') {
      return envelopeIncomplete(raw.processExit, 'no vitest JSON report — a missing report never proves anything');
    }
    let document: VitestJsonReport;
    try {
      document = parseVitestReport(raw.report);
    } catch (error) {
      return envelopeIncomplete(raw.processExit, `unparsable vitest JSON report — fail closed: ${describeError(error)}`);
    }
    const rows: Array<{ identity: TestIdentityKey; row: VitestAssertionRow; frameworkId: string }> = [];
    let suiteCount = 0;
    const base = raw.cwd ?? process.cwd();
    for (const suite of document.testResults ?? []) {
      const reportedFile = typeof suite.name === 'string' ? suite.name.replace(/^file:\/\//, '') : '';
      const file =
        reportedFile !== '' && isAbsolute(reportedFile)
          ? relative(base, reportedFile).split('\\').join('/')
          : reportedFile;
      for (const row of suite.assertionResults ?? []) {
        suiteCount += 1;
        const identity = vitestIdentityOf(file, row);
        if (identity !== null) {
          rows.push({ identity, row, frameworkId: `${identity.file}::${identity.titlePath.join('::')}` });
        }
      }
    }
    if (suiteCount > 0 && rows.length === 0) {
      return envelopeIncomplete(
        raw.processExit,
        `vitest report carries ${String(suiteCount)} row(s) with no attributable file/title identity — ` +
          'an unidentified row is never attributed to a test',
      );
    }
    if ((document.numTotalTests ?? 0) === 0 && suiteCount === 0) {
      return envelopeIncomplete(raw.processExit, 'vitest report covers zero tests — a zero-test run is incomplete');
    }
    if (suiteCount > 0 && rows.length > 0 && rows.every((entry) => entry.row.status === 'skipped')) {
      return envelopeIncomplete(raw.processExit, 'vitest report ran only skipped cases — nothing executed');
    }
    const exitDetail = vitestExitIncompleteDetail(raw.processExit);
    const outcomes: RunnerInstanceOutcome[] = rows.map((entry) => ({
      logicalKey: `${entry.identity.file}#${entry.identity.titlePath.join('>')}`,
      project: null,
      frameworkId: entry.frameworkId,
      status:
        entry.row.status === 'passed' ? 'passed' : entry.row.status === 'skipped' ? 'skipped' : 'failed',
      attempt: 1,
    }));
    if (exitDetail !== null) return { ...envelopeIncomplete(raw.processExit, exitDetail), outcomes };
    return {
      processExit: raw.processExit,
      complete: true,
      outcomes,
      fixtureOutcome: 'passed' as const,
    };
  }

  /**
   * The runner's native parsed report (diagnostics surfaces).
   *
   * Args:
   *   raw: the JSON report text plus the runner exit status.
   *
   * Returns:
   *   VitestJsonReport | null: the parsed document, or null when the
   *   report is absent or unparsable (never a guess).
   */
  parseReport(raw: RunnerRawResults): VitestJsonReport | null {
    if (raw.report.trim() === '') return null;
    try {
      return parseVitestReport(raw.report);
    } catch {
      return null;
    }
  }

  /** The runner-flags document of one run (null when absent/broken). */
  private readRunnerFlags(stateDir: string, runId: string): { retriesDetected: boolean } | null {
    try {
      const parsed = JSON.parse(readFileSync(join(stateDir, 'vitest', runId, RUNNER_FLAGS_FILE), 'utf8')) as {
        retriesDetected?: unknown;
      };
      return { retriesDetected: parsed.retriesDetected === true };
    } catch {
      return null;
    }
  }

  /** The vitest CLI entry for a project (local-first), or null. */
  private vitestEntryOf(cwd: string): { command: string; prefix: string[] } | null {
    if (this.options.vitestEntry !== undefined) {
      return this.options.vitestEntry.endsWith('.mjs')
        ? { command: process.execPath, prefix: [this.options.vitestEntry] }
        : { command: this.options.vitestEntry, prefix: [] };
    }
    const localEntry = join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
    if (existsSync(localEntry)) return { command: process.execPath, prefix: [localEntry] };
    return null;
  }

  /**
   * One bounded vitest CLI invocation (stdout/stderr captured).
   *
   * ENUMERATION runs the CONSUMER's own vitest config, so the child
   * environment is the `untrustedEnv` one: every ambient `GATEFORGE_*`
   * name is stripped, which keeps the verifier key, the run token and
   * the witness URL out of reach of the repository being gated. The
   * ambient `GATEFORGE_REPORTER_FAIL_RUN` the old merge carried is
   * stripped by the same rule, so the list child cannot be armed to
   * fail a run it never reports.
   */
  private spawnVitest(
    cwd: string,
    entry: { command: string; prefix: string[] },
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; error: Error | null }> {
    return new Promise((settle) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn(entry.command, [...entry.prefix, ...args], {
        cwd,
        env: untrustedEnv(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 120_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        settle({ code: null, stdout, stderr, timedOut: false, error });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        settle({ code, stdout, stderr, timedOut, error: null });
      });
    });
  }
}

/**
 * Merges the gateforge reporter's runner-flags document into an
 * envelope (retry detection is only observable from the reporter, not
 * from the JSON document).
 *
 * Args:
 *   envelope: the envelope `parseResults` produced.
 *   flagsJson: the runner-flags document text (empty when absent).
 *
 * Returns:
 *   RunnerExecutionEnvelope: the envelope with retry evidence merged;
 *   a retry-detected run blocks (required retries are zero).
 */
export function mergeVitestRunnerFlags(
  envelope: RunnerExecutionEnvelope,
  flagsJson: string,
): RunnerExecutionEnvelope {
  let flags: { retriesDetected?: unknown };
  try {
    flags = JSON.parse(flagsJson) as { retriesDetected?: unknown };
  } catch {
    return envelope;
  }
  if (flags.retriesDetected !== true) return envelope;
  return {
    ...envelope,
    complete: false,
    incompleteDetail:
      envelope.incompleteDetail ??
      'vitest runner-assisted retry detected (required retries are zero) — the run blocks',
    retriesDetected: true,
    retriesDetail: 'the gateforge vitest reporter observed retryCount > 0 for at least one test',
  };
}

/** One parsed identity key. */
interface TestIdentityKey {
  readonly file: string;
  readonly titlePath: string[];
}

/**
 * The identity of one jest-compatible assertion row, or null when the
 * row carries no attributable identity (a row without a suite file or
 * a non-empty title is never attributed to a test).
 */
function vitestIdentityOf(file: string, row: VitestAssertionRow): TestIdentityKey | null {
  if (file === '' || typeof row.title !== 'string' || row.title === '') return null;
  const ancestors = Array.isArray(row.ancestorTitles)
    ? row.ancestorTitles.filter((title): title is string => typeof title === 'string')
    : [];
  return { file, titlePath: [...ancestors, row.title] };
}

/** Parses the `vitest list --json` document into identities. */
function parseVitestListing(stdout: string, cwd: string): RunnerTestIdentity[] | null {
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(document)) return null;
  const tests: RunnerTestIdentity[] = [];
  for (const entry of document) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { name?: unknown; file?: unknown };
    if (typeof record.name !== 'string' || typeof record.file !== 'string') continue;
    const file = repoPosix(record.file);
    const relativeFile = relative(cwd, file).split('\\').join('/');
    const titlePath = record.name.split(' > ');
    tests.push({
      logicalKey: `${relativeFile}#${titlePath.join('>')}`,
      project: null,
      file: relativeFile,
      titlePath,
      blockingAnnotations: [],
      // The pack reporter spools `<file>#<title path>` — registration
      // must name the same id.
      frameworkId: `${relativeFile}#${titlePath.join('>')}`,
    });
  }
  return tests;
}

/** Strictly parses the jest-compatible JSON report. */
function parseVitestReport(report: string): VitestJsonReport {
  const document: unknown = JSON.parse(report);
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('the vitest JSON report is not an object');
  }
  return document as VitestJsonReport;
}

/** The file part of a logical key, or null (never a wildcard). */
function logicalKeyFileOf(logicalKey: string): string | null {
  const hash = logicalKey.indexOf('#');
  if (hash <= 0) return null;
  const file = logicalKey.slice(0, hash);
  if (file === '' || logicalKey.slice(hash + 1).includes('#')) return null;
  return file;
}

/** Vitest exit codes, fail closed (0 passed, 1 failures). */
function vitestExitIncompleteDetail(exit: number | null): string | null {
  if (exit === null) return 'vitest ended without an exit status — incomplete';
  if (exit >= 2) return `vitest ended with status ${String(exit)} (fatal/internal error) — incomplete`;
  return null;
}

/** Single-cause incomplete envelope (no outcomes are ever invented). */
function envelopeIncomplete(processExit: number | null, detail: string): RunnerExecutionEnvelope {
  return {
    processExit,
    complete: false,
    incompleteDetail: detail,
    outcomes: [],
    fixtureOutcome: 'unknown' as const,
  };
}

/** Absolute-normalizes then posix-normalizes a reported suite path. */
function repoPosix(path: string): string {
  return path.replace(/^file:\/\//, '').split('\\').join('/');
}

/** The pack's Vitest reporter module path (built JS, or the TS source). */
function vitestReporterModulePath(): string {
  const candidates = [
    // When this module runs from dist (the published/compiled layout).
    fileURLToPath(new URL('../vitest/reporter.js', import.meta.url)),
    // When this module runs from src (the monorepo test layout).
    fileURLToPath(new URL('../../dist/vitest/reporter.js', import.meta.url)),
    // Last resort: the TypeScript source, loadable by the child's
    // vite-node runner.
    fileURLToPath(new URL('../vitest/reporter.ts', import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] as string;
}

/** First non-empty line of a captured stream (bounded). */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? 'no output' : line.trim().slice(0, 300);
}

/** Single-line message of an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
