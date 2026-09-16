/**
 * The SUPERVISOR's witness transport (enforcement-review fixes 2a/3):
 * every call here requires BOTH the run token (outer gate) and the
 * verifier key (`x-gateforge-verifier`) — the capability the tested
 * suite never receives. This client is meant to run ONLY inside the
 * orchestrating CLI process: it registers the expected set, opens and
 * closes test sessions on the supervisor's behalf (draining the
 * runner's lifecycle spool), and fetches the witness-side execution
 * trace that supervision grades completeness from. The suite-side
 * `WitnessClient` deliberately has none of these methods.
 */
import { VERIFIER_HEADER, RUN_HEADER, DEFAULT_REQUEST_TIMEOUT_MS } from '../constants.js';
import type {
  ExpectedSetRequest,
  ExpectedSetResponse,
  ExecutionTraceResponse,
  ServerE2eDeclarationsRequest,
  ServerE2eDeclarationsResponse,
  ServerPersistenceIntentRequest,
  ServerPersistenceResponse,
  ServerPreObservationResponse,
  SessionCloseRequest,
  SessionCloseResponse,
  SessionOpenRequest,
  SessionOpenResponse,
} from '../witness/types.js';
import { WitnessRequestError } from '../fixture/witness-client.js';

/**
 * The supervisor-grade witness client.
 *
 * Args:
 *   url: witness base URL (loopback).
 *   token: the run token (outer auth gate).
 *   verifierKey: the witness verifier key (the supervisor capability;
 *     the tested suite never receives it).
 *   timeoutMs: per-call timeout.
 */
export class SupervisorClient {
  readonly url: string;
  readonly token: string;
  readonly verifierKey: string;
  readonly timeoutMs: number;

  constructor(
    url: string,
    token: string,
    verifierKey: string,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.url = url;
    this.token = token;
    this.verifierKey = verifierKey;
    this.timeoutMs = timeoutMs;
  }

  /**
   * POST /runs/expected-set (fix 2a): registers the expected test set
   * BEFORE the run; idempotent for an identical set.
   *
   * Args:
   *   request: the expected tests (identity-shaped).
   *
   * Returns:
   *   Promise<ExpectedSetResponse>: bound + enumeration digest + count.
   *
   * Throws:
   *   WitnessRequestError: on any refusal (401/403/409/400) — the CLI
   *     turns a refusal into a fail-closed run block.
   */
  async registerExpectedSet(request: ExpectedSetRequest): Promise<ExpectedSetResponse> {
    return this.request<ExpectedSetResponse>('/runs/expected-set', request);
  }

  /**
   * POST /sessions/open (fix 3): opens one test session on the
   * supervisor's behalf (drained from the runner's lifecycle spool).
   */
  async openSession(request: SessionOpenRequest): Promise<SessionOpenResponse> {
    return this.request<SessionOpenResponse>('/sessions/open', request);
  }

  /**
   * POST /sessions/close (fix 3): seals the session with the observed
   * outcome; sealing is final.
   */
  async closeSession(request: SessionCloseRequest): Promise<SessionCloseResponse> {
    return this.request<SessionCloseResponse>('/sessions/close', request);
  }

  /**
   * POST /runs/server-e2e-declarations: registers the obligations the
   * trusted mapping layer declared kind `server-e2e` — the witness then
   * (and only then) stamps `channel: 'server'` records for them.
   */
  async registerServerE2eDeclarations(
    request: ServerE2eDeclarationsRequest,
  ): Promise<ServerE2eDeclarationsResponse> {
    return this.request<ServerE2eDeclarationsResponse>('/runs/server-e2e-declarations', request);
  }

  /**
   * POST /witness/server-persistence: forwards one drained persistence
   * claim intent. The witness executes the adapter SERVER PROBE itself
   * and either stamps a witnessed `channel: 'server'` record (post) or
   * stores its before-state (pre) — or answers a TYPED failure (the
   * cause code rides `WitnessRequestError.detail`), which is never
   * satisfaction.
   */
  async verifyServerPersistence(
    request: ServerPersistenceIntentRequest,
  ): Promise<ServerPersistenceResponse | ServerPreObservationResponse> {
    return this.request<ServerPersistenceResponse | ServerPreObservationResponse>(
      '/witness/server-persistence',
      request,
    );
  }

  /**
   * GET /runs/execution-trace (fix 2b): the witness-side session record
   * — THE execution authority supervision grades completeness from.
   *
   * Returns:
   *   Promise<ExecutionTraceResponse | null>: the trace, or null when
   *   the witness cannot serve it (fail closed downstream — never an
   *   empty success).
   */
  async executionTrace(): Promise<ExecutionTraceResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.url}/runs/execution-trace`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch {
      return null; // transport failure: the caller fails closed
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return null;
    try {
      return (await response.json()) as ExecutionTraceResponse;
    } catch {
      return null;
    }
  }

  /** The supervisor headers (run token + verifier key). */
  private headers(): Record<string, string> {
    return {
      [RUN_HEADER]: this.token,
      [VERIFIER_HEADER]: this.verifierKey,
      'content-type': 'application/json',
      accept: 'application/json',
      connection: 'close',
    };
  }

  /** POST with supervisor headers; errors map to typed WitnessRequestError. */
  private async request<T>(path: string, payload: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new WitnessRequestError(0, `supervisor call to ${path} failed: ${(error as Error).message}`);
    }
    clearTimeout(timer);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      throw new WitnessRequestError(
        response.status,
        typeof record['error'] === 'string'
          ? record['error']
          : `witness answered HTTP ${String(response.status)} for ${path}`,
        typeof record['detail'] === 'string' ? record['detail'] : null,
      );
    }
    return body as T;
  }
}
