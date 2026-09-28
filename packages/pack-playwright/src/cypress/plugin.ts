/**
 * The Cypress side of the witness channel (plan 2026-09-25 phase 2).
 *
 * Cypress exposes exactly two runner-side seams, and this module uses
 * both — nothing else about a Cypress run is trusted:
 *
 * - `setupNodeEvents` (`on('task')` + `on('after:run')`) runs in the
 *   Cypress PROCESS. The pack registers the lifecycle tasks the
 *   generated support file calls (`gateforge:test-begin` /
 *   `gateforge:test-end`): each appends the same lifecycle spool event
 *   the Playwright reporter writes (testBegin with the obligation
 *   claims, testEnd with the outcome and attempt), and `test-begin`
 *   additionally resolves the supervisor-issued session for the
 *   running test and hands its proxy origin to the browser. That
 *   process holds no verifier key and no supervisor rights — the
 *   TRUSTED CLI drain reads the spool and performs the witness calls.
 * - `on('after:run')` receives mocha's own results. The plugin writes
 *   them to the run's report document in the pack's fixed shape
 *   (`<stateDir>/cypress/<runId>/report.json`): per spec, per test the
 *   title path, the state, and the ATTEMPT COUNT. A runner-assisted
 *   retry (Cypress `retries`) is therefore visible in the report and
 *   blocks the run — required retries are zero.
 *
 * Everything is INERT without supervised wiring: with no
 * `GATEFORGE_STATE_DIR`/`GATEFORGE_RUN_ID` in the environment the tasks
 * are not registered, the support file's calls fail loudly, and a
 * plain `cypress run` behaves exactly as without the pack.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalOf } from '../json.js';
import { claimInjectionsFor } from '../runner-claims.js';

/** The Cypress task the support file calls when a test starts. */
const TASK_TEST_BEGIN = 'gateforge:test-begin';

/** The Cypress task the support file calls when a test ends. */
const TASK_TEST_END = 'gateforge:test-end';

/** Header the run token travels in (the same name the fixture uses). */
const RUN_HEADER = 'x-gateforge-run';

/** How long a started test waits for the drain to open its session. */
const SESSION_RESOLVE_TIMEOUT_MS = 10_000;

/** Poll cadence for the session resolve (supervisor → witness latency). */
const SESSION_RESOLVE_POLL_MS = 50;

/** The spool event this plugin writes (the drain's reader shape). */
interface SpoolEvent {
  readonly kind: 'testBegin' | 'testEnd';
  readonly testId: string;
  readonly workerIndex: number;
  readonly file: string | null;
  readonly titlePath: string[];
  readonly project: string | null;
  readonly outcome?: string;
  readonly attempt?: number;
  readonly claims?: string[];
}

/** One observed Cypress test (structural subset of mocha's result). */
interface MochaTestResult {
  readonly title?: unknown;
  readonly state?: unknown;
  readonly attempts?: unknown;
}

/** One observed spec run (structural subset of `after:run` results). */
interface MochaSpecResult {
  readonly spec?: { readonly relative?: unknown };
  readonly tests?: readonly MochaTestResult[];
}

/** The `after:run` payload shape this plugin reads. */
interface AfterRunResults {
  readonly runs?: readonly MochaSpecResult[];
}

/**
 * The run-scoped wiring the plugin reads from its own environment.
 *
 * The two halves are independent on purpose: a run-scoped state dir
 * means the lifecycle spool is this run's record (the tasks register
 * and spool even with no witness attached), while a witness URL and run
 * token are what a test needs before its traffic can be attributed.
 */
interface PluginEnv {
  readonly stateDir: string | null;
  readonly runId: string | null;
  readonly witnessUrl: string | null;
  readonly runToken: string | null;
  readonly appBaseUrl: string;
}

/** One test identity the support file reports. */
interface TestIdentityPayload {
  readonly testId?: unknown;
  readonly file?: unknown;
  readonly titlePath?: unknown;
  readonly state?: unknown;
  readonly attempt?: unknown;
}

/** The session credential the browser receives for one test. */
export interface CypressSessionCredential {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly proxyUrl: string | null;
}

/** The report document `parseResults` reads. */
export interface CypressRunReport {
  readonly schemaVersion: 1;
  readonly retriesDetected: boolean;
  readonly specs: Array<{
    readonly file: string;
    readonly tests: Array<{
      readonly titlePath: string[];
      readonly state: string;
      readonly attempts: number;
    }>;
  }>;
}

/** The Cypress `on` registration surface this plugin uses. */
interface PluginRegistrar {
  (event: 'task', handlers: Record<string, (payload: unknown) => unknown>): void;
  (event: 'after:run', handler: (results: unknown) => void | Promise<void>): void;
}

/** The run-scoped wiring read from the environment, once. */
function pluginEnv(): PluginEnv {
  const stateDir = process.env['GATEFORGE_STATE_DIR'] ?? '';
  const runId = process.env['GATEFORGE_RUN_ID'] ?? '';
  const witnessUrl = process.env['GATEFORGE_WITNESS_URL'] ?? '';
  const runToken = process.env['GATEFORGE_RUN_TOKEN'] ?? '';
  const spooled = stateDir !== '' && runId !== '';
  return {
    stateDir: spooled ? stateDir : null,
    runId: spooled ? runId : null,
    witnessUrl: witnessUrl === '' ? null : witnessUrl,
    runToken: runToken === '' ? null : runToken,
    appBaseUrl: process.env['GATEFORGE_APP_BASE_URL'] ?? '',
  };
}

/**
 * Registers the gateforge Cypress tasks and the run report writer.
 *
 * Args:
 *   on: Cypress's `setupNodeEvents(on, config)` registrar.
 *
 * Returns:
 *   void
 */
export function registerGateforgeCypressPlugin(on: PluginRegistrar): void {
  const env = pluginEnv();
  if (env.stateDir === null || env.runId === null) return;
  // With a run-scoped state dir the tasks ARE registered even when no
  // witness is wired: the lifecycle spool is the runner's own record,
  // and a test that then addresses a configured app without an open
  // session is refused rather than passing untagged.
  const spoolFile = join(env.stateDir, 'spool', env.runId, 'events.jsonl');
  const reportFile = join(env.stateDir, 'cypress', env.runId, 'report.json');
  on('task', {
    [TASK_TEST_BEGIN]: async (payload: unknown) => {
      const identity = identityOf(payload);
      appendEvent(spoolFile, {
        kind: 'testBegin',
        testId: identity.testId,
        workerIndex: 0,
        file: identity.file,
        titlePath: identity.titlePath,
        project: null,
        ...claimsFor(env.stateDir as string, identity.testId),
      });
      const credential =
        env.witnessUrl === null || env.runToken === null
          ? { sessionId: '', sessionToken: '', proxyUrl: null }
          : await resolveSession(env, identity);
      return { ...credential, appBaseUrl: env.appBaseUrl };
    },
    [TASK_TEST_END]: (payload: unknown) => {
      const identity = identityOf(payload);
      const state = stateOf(payload);
      appendEvent(spoolFile, {
        kind: 'testEnd',
        testId: identity.testId,
        workerIndex: 0,
        file: identity.file,
        titlePath: identity.titlePath,
        project: null,
        outcome: state === 'passed' ? 'passed' : state === 'pending' ? 'skipped' : 'failed',
        attempt: attemptOf(payload),
      });
      return null;
    },
  });
  on('after:run', (results: unknown) => {
    writeRunReport(reportFile, results as AfterRunResults);
  });
}

/**
 * Normalizes the identity the support file reports, or refuses it: a
 * task payload with no file and no title is never attributed to a test.
 *
 * Args:
 *   payload: the raw `cy.task` payload.
 *
 * Returns:
 *   { testId: string; file: string | null; titlePath: string[] }: the
 *   reconciliation identity (`<file>#<title path>`).
 *
 * Throws:
 *   Error: when the payload carries no file and no title path.
 */
function identityOf(payload: unknown): { testId: string; file: string | null; titlePath: string[] } {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as TestIdentityPayload;
  const file = typeof record.file === 'string' && record.file !== '' ? record.file : null;
  const titlePath = Array.isArray(record.titlePath)
    ? record.titlePath.filter((title): title is string => typeof title === 'string')
    : typeof record.testId === 'string' && record.testId.includes('#')
      ? [(record.testId.split('#')[1] as string)]
      : [];
  if (file === null && titlePath.length === 0) {
    throw new Error(
      'gateforge: the Cypress support file reported a test with no file and no title — ' +
        'such a test can never be attributed to a session',
    );
  }
  const key = `${file ?? '-'}>${titlePath.join('>')}`;
  return { testId: typeof record.testId === 'string' && record.testId !== '' ? record.testId : key, file, titlePath };
}

/** The observed state the support file reports (default: failed). */
function stateOf(payload: unknown): string {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as TestIdentityPayload;
  return typeof record.state === 'string' ? record.state : 'failed';
}

/** The 1-based attempt the support file reports (default: 1). */
function attemptOf(payload: unknown): number {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as TestIdentityPayload;
  return typeof record.attempt === 'number' && record.attempt >= 1 ? Math.trunc(record.attempt) : 1;
}

/** The claims a spooled `testBegin` carries for one key. */
function claimsFor(stateDir: string, testId: string): { claims?: string[] } {
  const claims = claimInjectionsFor(stateDir, testId);
  return claims.length > 0 ? { claims } : {};
}

/** Appends one lifecycle event (never crashes the run on failure). */
function appendEvent(spoolFile: string, event: SpoolEvent): void {
  try {
    mkdirSync(dirname(spoolFile), { recursive: true });
    appendFileSync(spoolFile, `${canonicalOf(event as unknown as Record<string, unknown>)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[gateforge] cannot append to the lifecycle spool: ${(error as Error).message}`);
  }
}

/**
 * Resolves the supervisor-issued session for a started test by asking
 * the witness, exactly like the Playwright fixture and the pytest
 * plugin. The drain opens the session from the spooled `testBegin`, so
 * the first attempts race it and are retried briefly.
 *
 * Args:
 *   env: the run-scoped wiring.
 *   identity: the started test's reconciliation identity.
 *
 * Returns:
 *   Promise<CypressSessionCredential>: the open session's credential.
 *
 * Throws:
 *   Error: when no open session answers within the bound — an
 *   unattributable test fails loudly instead of running untagged.
 */
async function resolveSession(
  env: PluginEnv,
  identity: { testId: string },
): Promise<CypressSessionCredential> {
  const witnessUrl = env.witnessUrl as string;
  const runToken = env.runToken as string;
  const deadline = Date.now() + SESSION_RESOLVE_TIMEOUT_MS;
  let lastDetail = 'no answer';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${witnessUrl.replace(/\/$/, '')}/sessions/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RUN_HEADER]: runToken },
        body: JSON.stringify({ testId: identity.testId, workerIndex: 0 }),
      });
      if (response.ok) {
        const body = (await response.json()) as Partial<CypressSessionCredential>;
        if (typeof body.sessionId === 'string' && body.sessionId !== '') {
          return {
            sessionId: body.sessionId,
            sessionToken: typeof body.sessionToken === 'string' ? body.sessionToken : '',
            proxyUrl: typeof body.proxyUrl === 'string' && body.proxyUrl !== '' ? body.proxyUrl : null,
          };
        }
        lastDetail = 'malformed resolve response';
      } else if (response.status !== 404) {
        lastDetail = `HTTP ${String(response.status)} from /sessions/resolve`;
      }
    } catch (error) {
      lastDetail = (error as Error).message;
    }
    await new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, SESSION_RESOLVE_POLL_MS);
    });
  }
  throw new Error(
    `[gateforge] no open witness session answered for Cypress test '${identity.testId}' within ` +
      `${String(SESSION_RESOLVE_TIMEOUT_MS)}ms (${lastDetail}) — a test whose traffic cannot be ` +
      'attributed is never allowed to pass',
  );
}

/**
 * Writes the run's report document from mocha's own `after:run`
 * results: per spec, per test the title path, the state, and the
 * attempt count. A test with more than one attempt is a
 * runner-assisted retry, which blocks the run.
 *
 * Args:
 *   reportFile: the run-scoped report path.
 *   results: Cypress's `after:run` payload.
 */
function writeRunReport(reportFile: string, results: AfterRunResults): void {
  const specs: CypressRunReport['specs'] = [];
  let retriesDetected = false;
  for (const run of results.runs ?? []) {
    const file = typeof run.spec?.relative === 'string' ? run.spec.relative : '';
    const tests = (run.tests ?? []).map((test) => {
      const titlePath = Array.isArray(test.title)
        ? test.title.filter((title): title is string => typeof title === 'string')
        : [];
      const attempts = Array.isArray(test.attempts) ? test.attempts.length : 1;
      if (attempts > 1) retriesDetected = true;
      return {
        titlePath,
        state: typeof test.state === 'string' ? test.state : 'failed',
        attempts: Math.max(1, attempts),
      };
    });
    specs.push({ file, tests });
  }
  try {
    mkdirSync(dirname(reportFile), { recursive: true });
    const report: CypressRunReport = { schemaVersion: 1, retriesDetected, specs };
    writeFileSync(reportFile, `${canonicalOf(report as unknown as Record<string, unknown>)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[gateforge] cannot write the Cypress run report: ${(error as Error).message}`);
  }
}

/**
 * The generated Cypress support file: the in-browser half of the
 * channel. It opens each test's session through the plugin task, and
 * rewrites `cy.request` traffic addressed at the app origin onto that
 * session's proxy origin, so every exchange is attributed to the test
 * that issued it. Traffic addressed anywhere else (a raw browser
 * `fetch` to the app, a third-party origin) is left ALONE and therefore
 * stays unattributed — the witness credits it to nothing.
 *
 * Args:
 *   projectSupportFile: the project's own support file (required first,
 *     so its hooks and commands keep working), or null.
 *
 * Returns:
 *   string: CommonJS support-file source.
 */
export function cypressSupportSource(projectSupportFile: string | null): string {
  const chained =
    projectSupportFile === null
      ? ''
      : `require(${JSON.stringify(projectSupportFile)});\n`;
  return `// Generated by gateforge (plan 2026-09-25 phase 2). Do not edit.
'use strict';
${chained}
const gateforgeSession = { proxyUrl: null, appBaseUrl: '' };

beforeEach(function () {
  const current = this.currentTest;
  if (!current || typeof current.titlePath !== 'function') return;
  const file = (Cypress.spec && Cypress.spec.relative) || '';
  const titlePath = current.titlePath();
  const attempt = (typeof this.test._currentRetry === 'number' ? this.test._currentRetry : 0) + 1;
  cy.task('gateforge:test-begin', { testId: file + '#' + titlePath.join('>'), file: file, titlePath: titlePath, attempt: attempt })
    .then((session) => {
      gateforgeSession.proxyUrl = session && typeof session.proxyUrl === 'string' ? session.proxyUrl : null;
      gateforgeSession.appBaseUrl = session && typeof session.appBaseUrl === 'string' ? session.appBaseUrl : '';
    });
});

afterEach(function () {
  const current = this.currentTest;
  gateforgeSession.proxyUrl = null;
  if (!current || typeof current.titlePath !== 'function') return;
  const file = (Cypress.spec && Cypress.spec.relative) || '';
  const titlePath = current.titlePath();
  const attempt = (typeof this.test._currentRetry === 'number' ? this.test._currentRetry : 0) + 1;
  cy.task('gateforge:test-end', {
    testId: file + '#' + titlePath.join('>'),
    file: file,
    titlePath: titlePath,
    state: current.state,
    attempt: attempt,
  });
});

// Job 2: cy.request traffic at the app origin crosses THIS test's
// session proxy. Without an open session the request is refused: an
// untagged request can never be witnessed evidence, so it must not
// pass quietly.
Cypress.Commands.overwrite('request', function (originalFn, ...args) {
  const gateforgeRewrite = (value) => {
    if (typeof value !== 'string' || gateforgeSession.appBaseUrl === '') return value;
    let target;
    try {
      target = new URL(value, gateforgeSession.appBaseUrl);
    } catch (error) {
      return value;
    }
    let app;
    try {
      app = new URL(gateforgeSession.appBaseUrl);
    } catch (error) {
      return value;
    }
    if (target.origin !== app.origin) return value;
    if (gateforgeSession.proxyUrl === null || gateforgeSession.proxyUrl === '') {
      throw new Error(
        'gateforge: this cy.request has no open witness session for the running test, so it could ' +
          'never be witnessed evidence — run under gateforge test-gates (or the CypressRunnerAdapter) ' +
          'and use cy.request (not a raw fetch) for app traffic. [GATEFORGE_WITNESS_SESSION_MISSING]'
      );
    }
    return gateforgeSession.proxyUrl + target.pathname + target.search + target.hash;
  };
  const rewritten = args.map((arg) =>
    arg !== null && typeof arg === 'object' && typeof arg.url === 'string'
      ? Object.assign({}, arg, { url: gateforgeRewrite(arg.url) })
      : gateforgeRewrite(arg)
  );
  return originalFn.apply(this, rewritten);
});
`;
}
