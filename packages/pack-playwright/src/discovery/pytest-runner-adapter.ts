/**
 * The pytest runner adapter behind the runner-neutral `RunnerAdapter`
 * contract (plan 2026-09-25 phase 3).
 *
 * pytest is promoted from a diagnostics runner (§3.5) to a
 * witness-producing runner with the SAME evidence rules as Playwright:
 * - enumerate: the CONFIGURED §3.5 argv runs `--collect-only -q`
 *   (`collectPytestSuite`) — the expected set is fixed BEFORE the run;
 * - tag: the pack's pytest plugin (`python/gateforge_pytest_plugin.py`)
 *   resolves the supervisor-issued session for the running test and
 *   routes its `httpx` client through the per-test session proxy origin
 *   (the `session-proxy` channel, exactly like the Playwright fixture);
 * - execute: the configured argv plus a junit-XML report into the
 *   EXCLUDED run-state dir; the plugin is loaded through PYTHONPATH and
 *   stays inert without supervised wiring;
 * - parse: strict junit parsing (`parseJunitXml`, fail closed) mapped
 *   onto the supervision envelope.
 *
 * Identity: a junit row joins an enumerated test on (file, title path)
 * — the `file` attribute pytest's `junit_family=xunit1` emits. A row
 * without it is NEVER attributed to a test (the same fail-closed rule
 * the Playwright path applies to traffic that bypassed every session
 * channel), and a report whose rows cannot be attributed never grades
 * complete. Runner-assisted retries surface as duplicated rows for one
 * identity and are reported as `retriesDetected` (required retries are
 * zero).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type GateforgeConfig } from '@gate-forge/core';
import type {
  DiagnosticSuite,
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
import {
  parseJunitXml,
  type JunitDocument,
  type JunitTestCase,
} from './pytest-adapter.js';
import { collectPytestSuite, type PytestCollectedCase } from './pytest-adapter.js';
import { buildWitnessedPytestSessionEnv } from './runner-env.js';

/** Per-test session variables a runner adapter publishes to the test. */
export const PYTEST_ENV_SESSION_ID = 'GATEFORGE_SESSION_ID';
export const PYTEST_ENV_SESSION_TOKEN = 'GATEFORGE_SESSION_TOKEN';
export const PYTEST_ENV_SESSION_PROXY_URL = 'GATEFORGE_SESSION_PROXY_URL';

/** The variables that carry ONE test's identity to its traffic. */
export const PYTEST_IDENTITY_ENV: readonly string[] = [
  PYTEST_ENV_SESSION_ID,
  PYTEST_ENV_SESSION_TOKEN,
  PYTEST_ENV_SESSION_PROXY_URL,
];

/** The runner-side plugin module name (`-p gateforge_pytest_plugin`). */
export const PYTEST_PLUGIN_MODULE = 'gateforge_pytest_plugin';

/** Directory the pack ships the pytest plugin in (added to PYTHONPATH). */
export function pytestPluginDir(): string {
  return fileURLToPath(new URL('../../python', import.meta.url));
}

/** Options the pytest runner adapter accepts. */
export interface PytestRunnerAdapterOptions {
  /** The configured suite; absent means read `<cwd>/.gateforge.yml`. */
  suite?: DiagnosticSuite;
  /** Pre-loaded config; absent means load `<cwd>/.gateforge.yml`. */
  config?: GateforgeConfig;
  /**
   * Run-scoped witness wiring for `execute` (the trusted caller's
   * channel — the plugin resolves per-test sessions from it). Absent
   * falls back to the ambient `GATEFORGE_WITNESS_URL`/`GATEFORGE_RUN_TOKEN`.
   */
  witness?: { url?: string; token?: string };
}

/**
 * The pytest runner adapter.
 *
 * Every invocation composes ONLY the configured argv plus collection /
 * report flags (the §3.5 discipline): no directory guessing, no
 * commands the config did not name.
 */
export class PytestRunnerAdapter implements RunnerAdapter<JunitDocument | null> {
  readonly runner = 'pytest';

  readonly capabilities = {
    inventory: 'available',
    resolveInstances: 'available',
    execute: 'available',
  } as const;

  constructor(private readonly options: PytestRunnerAdapterOptions = {}) {}

  /**
   * Job 1: the expected set, fixed BEFORE the run (configured-argv
   * collection, node ids preserved).
   *
   * Args:
   *   cwd: absolute repo root the `.gateforge.yml` suite config lives under.
   *
   * Returns:
   *   Promise<RunnerEnumeration>: the enumerated tests, or an
   *   `unavailable` verdict with a single cause. A repo with no pytest
   *   suite configured, a collection error, and a zero-test collection
   *   are all `unavailable` — nothing executed proves nothing.
   */
  async enumerate(cwd: string): Promise<RunnerEnumeration> {
    let suites: DiagnosticSuite[];
    try {
      suites = this.suitesOf(cwd);
    } catch (error) {
      return {
        status: 'unavailable',
        detail: `pytest enumeration could not load the gateforge config: ${describeError(error)}`,
        tests: [],
      };
    }
    if (suites.length === 0) {
      return {
        status: 'unavailable',
        detail:
          `pytest enumeration found no configured pytest diagnostic suite in ${cwd} ` +
          '(register one under diagnostics.suites with runner: pytest)',
        tests: [],
      };
    }
    const tests: RunnerTestIdentity[] = [];
    for (const suite of suites) {
      const collection = await collectPytestSuite(suite, cwd);
      if (collection.status !== 'discovered') {
        return {
          status: 'unavailable',
          detail: `pytest enumeration failed: ${collection.detail}`,
          tests: [],
        };
      }
      for (const collected of collection.cases) {
        tests.push(collectedIdentityOf(collected));
      }
    }
    const unique = [...new Map(tests.map((test) => [test.logicalKey, test])).values()].sort(byLogicalKey);
    if (unique.length === 0) {
      return {
        status: 'unavailable',
        detail: `pytest enumeration collected no tests under ${cwd} — a zero-test run never proves coverage`,
        tests: [],
      };
    }
    return { status: 'discovered', detail: `enumerated ${String(unique.length)} pytest test(s) via configured argv`, tests: unique };
  }

  /**
   * Job 2: the per-test tag. The plugin resolves the supervisor-issued
   * session for the running test and routes its httpx client through
   * that session's proxy origin, so every exchange is attributed to
   * THAT session.
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
        [PYTEST_ENV_SESSION_ID]: context.sessionId,
        [PYTEST_ENV_SESSION_TOKEN]: context.sessionToken,
        [PYTEST_ENV_SESSION_PROXY_URL]: context.sessionProxyUrl,
      },
      tagChannel: 'session-proxy',
      identityVars: PYTEST_IDENTITY_ENV,
      mechanism:
        'gateforge pytest plugin resolves the supervisor session for the running test and routes its ' +
        'httpx client through the per-test session proxy origin',
    };
  }

  /**
   * Job 3: runs the SELECTED pytest tests under a junit-XML report with
   * the pack plugin loaded (per-test sessions + proxied httpx). The
   * child environment is the witnessed-session allowlist: the run
   * identity the plugin needs to address the lifecycle spool plus the
   * non-secret run wiring — never the verifier key, never any other
   * parent-side name.
   *
   * Args:
   *   request: the exact selection, run identity, and wall-clock bound.
   *
   * Returns:
   *   Promise<RunnerExecutionEnvelope>: the structured outcome envelope
   *   (a runner exit code alone is never a gate result).
   */
  async execute(request: RunnerExecuteRequest): Promise<RunnerExecutionEnvelope> {
    let suites: DiagnosticSuite[];
    try {
      suites = this.suitesOf(request.cwd);
    } catch (error) {
      return envelopeIncomplete(null, `pytest execution could not load the gateforge config: ${describeError(error)}`);
    }
    const suite = suites[0];
    if (suite === undefined) {
      return envelopeIncomplete(null, 'pytest execution found no configured pytest diagnostic suite to run');
    }
    const nodeIds: string[] = [];
    for (const logicalKey of request.logicalKeys) {
      const nodeId = logicalKeyToNodeId(logicalKey);
      if (nodeId === null) {
        return envelopeIncomplete(
          null,
          `pytest execution cannot run '${logicalKey}': not a <file>#<title path> identity this adapter enumerated`,
        );
      }
      nodeIds.push(nodeId);
    }
    const reportPath = join(request.stateDir, 'pytest', `${request.runId}`, 'report.xml');
    const pluginDir = pytestPluginDir();
    const argv = [
      ...suite.argv,
      '-o',
      'junit_family=xunit1',
      `--junitxml=${reportPath}`,
      '-p',
      PYTEST_PLUGIN_MODULE,
      ...nodeIds,
    ];
    const child = spawn(argv[0] ?? '', argv.slice(1), {
      cwd: join(request.cwd, suite.cwd),
      env: buildWitnessedPytestSessionEnv(
        {
          [ENV_WITNESS_URL]: this.options.witness?.url ?? process.env[ENV_WITNESS_URL] ?? '',
          [ENV_RUN_TOKEN]: this.options.witness?.token ?? process.env[ENV_RUN_TOKEN] ?? '',
          [ENV_STATE_DIR]: request.stateDir,
          [ENV_RUN_ID]: request.runId,
          [ENV_APP_BASE_URL]: process.env[ENV_APP_BASE_URL] ?? '',
        },
        process.env,
        pluginDir,
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
      return envelopeIncomplete(null, `pytest execution could not start (${argv[0] ?? ''}): ${outcome.error.message}`);
    }
    if (outcome.timedOut) {
      return envelopeIncomplete(
        null,
        `pytest execution exceeded its ${String(request.timeoutMs)}ms bound and was killed — an incomplete run never grades complete`,
      );
    }
    let report = '';
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch {
      report = '';
    }
    const envelope = this.parseResults({ processExit: outcome.code, report });
    if (!envelope.complete && report === '') {
      return {
        ...envelope,
        incompleteDetail: `pytest produced no junit report at ${reportPath} (exit ${String(outcome.code)}) — fail closed`,
      };
    }
    return envelope;
  }

  /**
   * Job 4: strict junit parsing mapped onto the supervision envelope.
   *
   * Args:
   *   raw: the junit-XML document text plus the runner exit status.
   *
   * Returns:
   *   RunnerExecutionEnvelope: reporter INPUT, never a verdict. An
   *   unreadable report, a zero-test run, a collection error, a run of
   *   only skipped cases, and a report whose rows carry no attributable
   *   pytest identity are all `complete: false`.
   */
  parseResults(raw: RunnerRawResults): RunnerExecutionEnvelope {
    if (raw.report.trim() === '') {
      return envelopeIncomplete(raw.processExit, 'no junit report — a missing report never proves anything');
    }
    let document: JunitDocument;
    try {
      document = parseJunitXml(raw.report);
    } catch (error) {
      return envelopeIncomplete(raw.processExit, `unparsable junit report — fail closed: ${describeError(error)}`);
    }
    const rows: Array<{ identity: string; case: JunitTestCase; frameworkId: string }> = [];
    for (const testCase of document.cases) {
      const identity = junitIdentityOf(testCase);
      if (identity !== null) {
        rows.push({
          identity: identity.logicalKey,
          case: testCase,
          frameworkId: `${identity.file}::${identity.titlePath.join('::')}`,
        });
      }
    }
    if (document.cases.length > 0 && rows.length === 0) {
      return envelopeIncomplete(
        raw.processExit,
        `junit report carries ${String(document.cases.length)} row(s) with no attributable pytest ` +
          'file identity — an unidentified row is never attributed to a test',
      );
    }
    const collectionError = document.cases.some((testCase) => testCase.name === 'pytest_collection');
    if (collectionError) {
      return envelopeIncomplete(raw.processExit, 'junit report carries a pytest collection error — the expected set never ran');
    }
    if (document.tests === 0) {
      return envelopeIncomplete(raw.processExit, 'junit report covers zero tests — a zero-test run is incomplete');
    }
    if (document.cases.length > 0 && document.cases.every((testCase) => testCase.outcome === 'skipped')) {
      return envelopeIncomplete(raw.processExit, 'junit report ran only skipped/expected-failure cases — nothing executed');
    }
    const attemptsByIdentity = new Map<string, number>();
    for (const row of rows) attemptsByIdentity.set(row.identity, (attemptsByIdentity.get(row.identity) ?? 0) + 1);
    const retriesDetected = rows.some((row) => (attemptsByIdentity.get(row.identity) ?? 0) > 1);
    const seen = new Set<string>();
    const outcomes: RunnerInstanceOutcome[] = [];
    for (const row of rows) {
      if (seen.has(row.identity)) continue;
      seen.add(row.identity);
      const attempt = attemptsByIdentity.get(row.identity) ?? 1;
      const status: RunnerInstanceOutcome['status'] =
        row.case.outcome === 'passed'
          ? 'passed'
          : row.case.outcome === 'skipped'
            ? 'skipped'
            : 'failed';
      outcomes.push({
        logicalKey: row.identity,
        project: null,
        frameworkId: row.frameworkId,
        status,
        attempt,
        expectedFailure: row.case.skipType === 'pytest.xfail' || row.case.skipType === 'xfail',
      });
    }
    const exitDetail = exitIncompleteDetail(raw.processExit);
    if (exitDetail !== null) return { ...envelopeIncomplete(raw.processExit, exitDetail), outcomes };
    // The junit body IS the runner's own fixture/teardown outcome: an
    // `<error>` row means a setup or teardown failure, which grades
    // 'failed'; a clean parsed body grades 'passed'. A missing or
    // unparsable report never got here (fail closed above as 'unknown').
    const fixtureOutcome: 'passed' | 'failed' = document.cases.some((testCase) => testCase.outcome === 'error')
      ? 'failed'
      : 'passed';
    return {
      processExit: raw.processExit,
      complete: true,
      outcomes,
      fixtureOutcome,
      ...(retriesDetected
        ? {
            retriesDetected: true,
            retriesDetail:
              'junit report carries duplicated rows for at least one test identity — a runner-assisted retry executed',
          }
        : {}),
    };
  }

  /**
   * The runner's native parsed report (diagnostics surfaces).
   *
   * Args:
   *   raw: the junit-XML document text plus the runner exit status.
   *
   * Returns:
   *   JunitDocument | null: the parsed document, or null when the
   *   report is absent or unparsable (never a guess).
   */
  parseReport(raw: RunnerRawResults): JunitDocument | null {
    if (raw.report.trim() === '') return null;
    try {
      return parseJunitXml(raw.report);
    } catch {
      return null;
    }
  }

  /** The configured pytest suites (option override, else the config). */
  private suitesOf(cwd: string): DiagnosticSuite[] {
    if (this.options.suite !== undefined) return [this.options.suite];
    const config = this.options.config ?? loadConfig(`${cwd}/.gateforge.yml`);
    return (config.diagnostics?.suites ?? []).filter((suite) => suite.runner === 'pytest');
  }
}

/** One enumerated test's identity from its collected node id. */
function collectedIdentityOf(collected: PytestCollectedCase): RunnerTestIdentity {
  const logicalKey = `${collected.file}#${collected.titlePath.join('>')}`;
  return {
    logicalKey,
    project: null,
    file: collected.file,
    titlePath: collected.titlePath,
    blockingAnnotations: [],
  };
}

/**
 * The (file, title path) identity of one junit row, or null when the
 * row cannot be attributed: the pytest `file` attribute must be present
 * and the dotted classname must start with the file's module path.
 */
function junitIdentityOf(testCase: JunitTestCase): { logicalKey: string; file: string; titlePath: string[] } | null {
  if (testCase.file === undefined || testCase.file === '') return null;
  const file = testCase.file.split('\\').join('/');
  const module = file.replace(/\.[^.]+$/, '').split('/').join('.');
  const segments = testCase.classname.split('.').filter((segment) => segment !== '');
  if (module !== '' && segments.slice(0, module.split('.').length).join('.') !== module) return null;
  const classPath = module === '' ? segments : segments.slice(module.split('.').length);
  const titlePath = [...classPath, testCase.name];
  return { logicalKey: `${file}#${titlePath.join('>')}`, file, titlePath };
}

/** The pytest node id of a `<file>#<title path>` identity, or null. */
function logicalKeyToNodeId(logicalKey: string): string | null {
  const hash = logicalKey.indexOf('#');
  if (hash <= 0) return null;
  const file = logicalKey.slice(0, hash);
  const titlePath = logicalKey.slice(hash + 1);
  if (file === '' || titlePath === '' || titlePath.includes('#')) return null;
  return `${file}::${titlePath.split('>').join('::')}`;
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

/** Exit-status honesty: pytest's own exit codes, fail closed. */
function exitIncompleteDetail(exit: number | null): string | null {
  if (exit === null) return 'pytest ended without an exit status — incomplete';
  if (exit === 5) return 'pytest collected no tests (exit 5) — a zero-test run is incomplete';
  if (exit >= 2) return `pytest ended with status ${String(exit)} (interrupted/internal/usage error) — incomplete`;
  return null;
}

/** Logical-key sort (stable enumeration order). */
function byLogicalKey(a: RunnerTestIdentity, b: RunnerTestIdentity): number {
  return a.logicalKey < b.logicalKey ? -1 : a.logicalKey > b.logicalKey ? 1 : 0;
}

/** Single-line message of an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
