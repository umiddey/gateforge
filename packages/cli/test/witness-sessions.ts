/**
 * Shared Phase 1 session helpers for CLI-side witness tests: the test
 * acts as its own TRUSTED SUPERVISOR against a real witness — the same
 * verifier-key-authenticated /sessions channel the CLI's spool drain
 * drives in real runs (enforcement-review fix 3). The run token alone
 * never authorizes session lifecycle: /sessions/open answers 403/401
 * without the supervisor capability, so every ledger-building helper
 * must present the verifier key when it opens the session. Submissions
 * without a valid OPEN session remain rejected by the witness.
 */
import { RUN_HEADER, VERIFIER_HEADER } from '../../pack-playwright/src/constants.js';

/** A supervisor-opened session credential (the witness-issued binding). */
export interface TestSession {
  sessionId: string;
  sessionToken: string;
  testId: string;
  workerIndex: number;
  openedTick: number;
  /** The session's dedicated observation-proxy origin (null when no proxy). */
  proxyUrl: string | null;
}

/**
 * Opens a test session the way the trusted supervisor (the CLI's spool
 * drain) does in real runs: the run token is the outer auth gate and the
 * verifier key is the supervisor capability — omit the key only in
 * negative tests that assert the refusal.
 *
 * Args:
 *   witnessUrl: the witness base URL.
 *   token: the run token.
 *   verifierKey: the witness verifier key (the supervisor capability).
 *   testId: the runner-assigned test id to bind.
 *   workerIndex: the worker the test runs on (default 0).
 *
 * Returns:
 *   TestSession: the session binding (credential + dedicated proxy URL).
 */
export async function openTestSession(
  witnessUrl: string,
  token: string,
  verifierKey: string,
  testId: string,
  workerIndex = 0,
): Promise<TestSession> {
  const res = await fetch(`${witnessUrl}/sessions/open`, {
    method: 'POST',
    headers: {
      [RUN_HEADER]: token,
      [VERIFIER_HEADER]: verifierKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ testId, workerIndex }),
  });
  if (!res.ok) throw new Error(`sessions/open answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as TestSession;
}

/** Marks the start of a UI-action observation interval (witness clock). */
export async function beginTestInterval(
  witnessUrl: string,
  token: string,
  session: TestSession,
  operation = 'read',
): Promise<string> {
  const res = await fetch(`${witnessUrl}/sessions/intervals/open`, {
    method: 'POST',
    headers: { [RUN_HEADER]: token, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      operation,
    }),
  });
  if (!res.ok) throw new Error(`sessions/intervals/open answered ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { intervalId: string };
  return body.intervalId;
}

/** Seals a UI-action observation interval. */
export async function endTestInterval(
  witnessUrl: string,
  token: string,
  session: TestSession,
  intervalId: string,
): Promise<void> {
  const res = await fetch(`${witnessUrl}/sessions/intervals/close`, {
    method: 'POST',
    headers: { [RUN_HEADER]: token, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      intervalId,
    }),
  });
  if (!res.ok) throw new Error(`sessions/intervals/close answered ${res.status}: ${await res.text()}`);
}
