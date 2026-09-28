/**
 * The gateforge Vitest helper (plan 2026-09-25 phase 4): the in-test
 * half of the Vitest+supertest witness channel.
 *
 * `gateforgeSupertest(request)` wraps the suite's own supertest import
 * and returns a tagged request function:
 * - `await gate(appBaseUrl)` resolves the running test's session and
 *   returns a supertest builder whose traffic is REWRITTEN from the app
 *   origin onto that test's session proxy origin (resolved from the
 *   supervisor through the exact `(workerIndex, testId)` identity the
 *   pack's Vitest reporter spools) — every exchange is attributed to
 *   THAT session, the same `session-proxy` channel the Playwright
 *   fixture uses. Chain `.get/.post/.send` on the awaited builder
 *   exactly as without gateforge.
 * - `gate(app)` — the IN-PROCESS mode, where supertest calls the app
 *   function/object directly — is REFUSED with a clear message and the
 *   run fails. An in-process call never crosses the proxy, so it can
 *   never be witnessed evidence; silently passing it would be a
 *   counterfeit green.
 *
 * Without supervised wiring (`GATEFORGE_WITNESS_URL` /
 * `GATEFORGE_RUN_TOKEN` / `GATEFORGE_STATE_DIR` / `GATEFORGE_RUN_ID`)
 * a tagged call fails loudly — never silently unwitnessed.
 */
import { isAbsolute, relative } from 'node:path';
import { getCurrentTest } from 'vitest/suite';
import { humanMessage } from '@gate-forge/core';

/** Env the runner child receives from the adapter's allowlist. */
const ENV_WITNESS_URL = 'GATEFORGE_WITNESS_URL';
const ENV_RUN_TOKEN = 'GATEFORGE_RUN_TOKEN';
const ENV_APP_BASE_URL = 'GATEFORGE_APP_BASE_URL';

const RUN_HEADER = 'x-gateforge-run';

/** How long a tagged call waits for the drain to open the session. */
const SESSION_RESOLVE_TIMEOUT_MS = 5_000;
/** Poll cadence for the session resolve (supervisor→witness latency). */
const SESSION_RESOLVE_POLL_MS = 50;

/** The minimal supertest surface the wrapper preserves. */
export type SupertestTest = Record<string, unknown>;

/** The supertest entry: a callable taking a URL string (host mode). */
export type SupertestLike = (url: string) => SupertestTest;

/** One supervisor-issued session credential (the fields the helper uses). */
interface SessionCredential {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly proxyUrl: string | null;
}

/** The reconciliation identity of the RUNNING test. */
interface CurrentIdentity {
  readonly testId: string;
  readonly file: string;
  readonly titlePath: string[];
}

/** Session credentials resolved per test id (one HTTP round-trip each). */
const RESOLVED_BY_TEST_ID = new Map<string, SessionCredential>();

/**
 * The title path of the running test: the suite chain's names, then the
 * leaf title (the same join the pack's Vitest reporter spools).
 */
function titlePathOfCurrent(current: {
  readonly name: string;
  readonly suite?: unknown;
  readonly parent?: unknown;
}): string[] {
  const segments: string[] = [];
  let ancestor: unknown = current.suite ?? current.parent;
  while (typeof ancestor === 'object' && ancestor !== null) {
    const suite = ancestor as { name?: string; type?: string; suite?: unknown; parent?: unknown };
    if (suite.type !== 'suite') break;
    segments.unshift(suite.name ?? '');
    ancestor = suite.suite ?? suite.parent;
  }
  segments.push(current.name);
  return segments;
}

/**
 * The reconciliation identity of the RUNNING test, exactly as the pack's
 * Vitest reporter spools it: `<repo-relative posix file>#<titlePath>`.
 *
 * Returns:
 *   CurrentIdentity | null: the identity, or null outside a test.
 */
function currentIdentity(): CurrentIdentity | null {
  const current = getCurrentTest();
  if (current === undefined || current === null) return null;
  const file =
    current.file !== undefined && current.file !== null
      ? fileRelativize(String(current.file.filepath))
      : null;
  if (file === null) return null;
  const titlePath = titlePathOfCurrent(current);
  return { file, titlePath, testId: `${file}#${titlePath.join('>')}` };
}

/** Repo-relative posix form of an absolute module path (process.cwd()). */
function fileRelativize(path: string): string {
  const clean = path.replace(/^file:\/\//, '');
  return (isAbsolute(clean) ? relative(process.cwd(), clean) : clean).split('\\').join('/');
}

/**
 * Resolves the supervisor-issued session credential for the RUNNING
 * test (polls briefly: the drain opens the session asynchronously after
 * the reporter's testBegin event lands).
 *
 * Returns:
 *   Promise<SessionCredential>: the open session's credential.
 *
 * Throws:
 *   Error: when the wiring is absent, the test is not a gateforge-tagged
 *   vitest test, or no open session answers — fail closed.
 */
async function resolveCurrentSession(): Promise<SessionCredential> {
  const witnessUrl = process.env[ENV_WITNESS_URL];
  const runToken = process.env[ENV_RUN_TOKEN];
  if (
    witnessUrl === undefined ||
    witnessUrl === '' ||
    runToken === undefined ||
    runToken === '' ||
    process.env['GATEFORGE_STATE_DIR'] === undefined ||
    process.env['GATEFORGE_RUN_ID'] === undefined
  ) {
    throw new Error(
      humanMessage({
        type: 'witness-wiring-missing',
        detail:
          'this vitest test addresses the witness without the supervised wiring ' +
          `(missing ${ENV_WITNESS_URL} / ${ENV_RUN_TOKEN} / GATEFORGE_STATE_DIR / GATEFORGE_RUN_ID)`,
        nextAction: 'run under gateforge test-gates or the VitestRunnerAdapter',
      }),
    );
  }
  const identity = currentIdentity();
  if (identity === null) {
    throw new Error(
      humanMessage({
        type: 'witness-session-unknown-test',
        detail: 'gateforgeSupertest can only tag traffic inside a running vitest test',
        nextAction: 'call it from the test body',
      }),
    );
  }
  const cached = RESOLVED_BY_TEST_ID.get(identity.testId);
  if (cached !== undefined) return cached;
  const deadline = Date.now() + SESSION_RESOLVE_TIMEOUT_MS;
  let lastDetail = 'no answer';
  while (Date.now() < deadline) {
    const response = await fetch(`${witnessUrl.replace(/\/$/, '')}/sessions/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RUN_HEADER]: runToken },
      body: JSON.stringify({ testId: identity.testId, workerIndex: 0 }),
    });
    if (response.ok) {
      const body = (await response.json()) as Partial<SessionCredential>;
      if (typeof body.sessionId === 'string' && body.sessionId !== '') {
        const credential: SessionCredential = {
          sessionId: body.sessionId,
          sessionToken: String(body.sessionToken ?? ''),
          proxyUrl: typeof body.proxyUrl === 'string' && body.proxyUrl !== '' ? body.proxyUrl : null,
        };
        RESOLVED_BY_TEST_ID.set(identity.testId, credential);
        return credential;
      }
      lastDetail = 'malformed resolve response';
    } else if (response.status !== 404) {
      lastDetail = `HTTP ${String(response.status)} from /sessions/resolve`;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, SESSION_RESOLVE_POLL_MS));
  }
  throw new Error(
    humanMessage({
      type: 'witness-session-unresolved',
      detail: `no open witness session answered for test '${identity.testId}' within ${String(SESSION_RESOLVE_TIMEOUT_MS)}ms (${lastDetail})`,
      nextAction: 'run under the supervised window so the drain opens a session per started test',
    }),
  );
}

/**
 * Rewrites an app-origin URL onto the session proxy origin (same
 * loopback discipline as the Playwright page routing): the path, query,
 * and hash stay exactly as the suite addressed them.
 *
 * A base URL with no path of its own (`http://127.0.0.1:3000`) becomes
 * the bare proxy ORIGIN, never `<origin>/`: supertest concatenates the
 * per-request path onto the address it is handed, so a trailing slash
 * here would address `//api/accounts`.
 */
function rewriteThroughProxy(target: string, proxyUrl: string, appBaseUrl: string): string {
  if (appBaseUrl === '') return target;
  try {
    const app = new URL(appBaseUrl);
    const proxy = new URL(proxyUrl);
    const parsed = new URL(target, appBaseUrl);
    if (parsed.origin !== app.origin) return target;
    const bare = parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
    return `${proxy.origin}${bare ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return target;
  }
}

/**
 * Wraps the suite's supertest entry with the gateforge session channel.
 *
 * Args:
 *   request: the suite's own supertest import (the callable). Only the
 *     URL-string host mode is supported: in-process supertest calls the
 *     app directly, which bypasses the witness proxy entirely.
 *
 * Returns:
 *   (target: string) => Promise<SupertestTest>: the tagged request
 *   factory. Pass it the app base URL (or an absolute URL) and AWAIT
 *   it: the session must be resolved from the supervisor before any
 *   request is addressed, so the suite reads
 *   `await (await gate(app)).post('/api/accounts').send(...)`. A
 *   non-string target (the app itself) throws immediately with the
 *   refusal, before any request is sent.
 */
export function gateforgeSupertest(request: SupertestLike): (target: string) => Promise<SupertestTest> {
  if (typeof request !== 'function') {
    throw new TypeError('gateforgeSupertest expects the supertest callable (the default export)');
  }
  return (target: unknown): Promise<SupertestTest> => {
    if (typeof target !== 'string' || target.trim() === '') {
      // The in-process mode fails LOUDLY: supertest would call the app
      // function/object directly, no packet ever crosses the session
      // proxy, and the "pass" would be counterfeit.
      throw new Error(
        humanMessage({
          type: 'in-process-client-refused',
          detail:
            'supertest was handed the app itself (in-process mode), which bypasses the gateforge ' +
            'session proxy entirely — such a request can never be witnessed evidence, so it is ' +
            'refused instead of silently passing',
          nextAction: 'pass the app base URL (await gate(baseUrl)), not the app instance',
        }),
      );
    }
    const appBaseUrl = process.env[ENV_APP_BASE_URL] ?? '';
    return (async () => {
      const credential = await resolveCurrentSession();
      if (credential.proxyUrl === null) {
        throw new Error(
          humanMessage({
            type: 'witness-proxy-missing',
            detail:
              'the witness issued no per-session proxy for this run — the run must wire an ' +
              'observation proxy so supertest traffic can be attributed to the session',
            nextAction: 'wire the witness with proxyTarget (test-gates does this for strict runs)',
          }),
        );
      }
      return request(rewriteThroughProxy(target, credential.proxyUrl, appBaseUrl));
    })();
  };
}
