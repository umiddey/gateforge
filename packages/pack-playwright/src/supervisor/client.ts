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
import http from 'node:http';
import https from 'node:https';
import { VERIFIER_HEADER, RUN_HEADER, DEFAULT_REQUEST_TIMEOUT_MS, ENGINE_PAGE_VISIT_BUDGET_MS } from '../constants.js';
import type {
  ExpectedSetRequest,
  ExpectedSetResponse,
  ExecutionTraceResponse,
  ObserveDeclarationsRequest,
  ObserveDeclarationsResponse,
  ObserveFinalizeRequest,
  ObserveFinalizeResponse,
  ServerE2eDeclarationsRequest,
  ServerE2eDeclarationsResponse,
  ServerPersistenceIntentRequest,
  ServerPersistenceResponse,
  ServerPreObservationResponse,
  SessionCloseRequest,
  SessionCloseResponse,
  SessionOpenRequest,
  SessionOpenResponse,
  SessionReleaseRequest,
  SessionReleaseResponse,
  TwinShapesResponse,
  PageSweepRequest,
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
   * POST /sessions/release: gives the worker's slot back BEFORE the
   * runner's outcome for that test has arrived (the worker-side
   * lifecycle end), so the next test the same worker runs opens its
   * session at once. The session itself stops accepting submissions and
   * its proxy dies here; the outcome is still owed and is recorded by
   * the later {@link closeSession}.
   */
  async releaseSession(request: SessionReleaseRequest): Promise<SessionReleaseResponse> {
    return this.request<SessionReleaseResponse>('/sessions/release', request);
  }

  /**
   * POST /runs/observe-declarations (Observe channel, Phase 2):
   * registers the obligations the trusted mapping layer declared kind
   * `observed-e2e` — the witness then (and only then) stamps
   * `channel: 'observe'` records for them.
   */
  async registerObserveDeclarations(
    request: ObserveDeclarationsRequest,
  ): Promise<ObserveDeclarationsResponse> {
    return this.request<ObserveDeclarationsResponse>('/runs/observe-declarations', request);
  }

  /** POST /runs/page-sweep: visits unproven page obligations after the suite. */
  async sweepPages(request: PageSweepRequest): Promise<{ visits: unknown[] }> {
    return this.request<{ visits: unknown[] }>(
      '/runs/page-sweep',
      request,
      this.timeoutMs + request.pages.length * ENGINE_PAGE_VISIT_BUDGET_MS,
    );
  }

  /**
   * POST /observe/finalize (Observe channel, Phase 2): resolves one
   * OPEN session's observe-declared claims against its own proxied
   * traffic plus independent adapter reads. Non-resolutions ride
   * `notes` — never satisfaction, never a throw beyond transport/
   * auth failures.
   */
  async finalizeObserve(request: ObserveFinalizeRequest): Promise<ObserveFinalizeResponse> {
    return this.request<ObserveFinalizeResponse>('/observe/finalize', request);
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
    let response: { status: number; ok: boolean; bodyText: string };
    try {
      response = await this.exchange('/runs/execution-trace', { method: 'GET', timeoutMs: this.timeoutMs });
    } catch {
      return null; // transport failure: the caller fails closed
    }
    if (!response.ok) return null;
    try {
      return JSON.parse(response.bodyText) as ExecutionTraceResponse;
    } catch {
      return null;
    }
  }

  /**
   * GET /runs/twin-shapes (E64): the request SHAPES each test's
   * session exercised — method, route template, and the values of the
   * owner's query-key allowlist. Never a URL, a body or a
   * non-allowlisted value, and never evidence: it exists so a run can
   * say whether a raw test and its witnessed twin covered the same path.
   *
   * Returns:
   *   Promise<TwinShapesResponse | null>: the shapes, or null when the
   *   witness cannot serve them (fail closed downstream — never an
   *   empty success).
   */
  async twinShapes(): Promise<TwinShapesResponse | null> {
    let response: { status: number; ok: boolean; bodyText: string };
    try {
      response = await this.exchange('/runs/twin-shapes', { method: 'GET', timeoutMs: this.timeoutMs });
    } catch {
      return null; // transport failure: the caller fails closed
    }
    if (!response.ok) return null;
    try {
      return JSON.parse(response.bodyText) as TwinShapesResponse;
    } catch {
      return null;
    }
  }

  /**
   * One HTTP exchange with ONLY this client's deadline. node:http(S)
   * `request` carries no timeout of its own, so `init.timeoutMs` — the
   * computed budget — drives the AbortSignal and is the single
   * deadline. The previous global fetch could not honour it: undici
   * fixes headersTimeout/bodyTimeout at 300 000 ms regardless of any
   * option or signal, so every supervisor call longer than five
   * minutes (a page sweep past a handful of pages) died at exactly
   * 300 s with "fetch failed". Resolves with status + body text;
   * rejects on any transport failure (abort, connect, reset).
   */
  private exchange(
    path: string,
    init: { method: 'GET' | 'POST'; timeoutMs: number; payload?: unknown },
  ): Promise<{ status: number; ok: boolean; bodyText: string }> {
    const target = new URL(`${this.url}${path}`);
    const body = init.payload === undefined ? undefined : JSON.stringify(init.payload);
    const headers: Record<string, string> = { ...this.headers() };
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const isHttps = target.protocol === 'https:';
    // An executor-form promise, deliberately: the settled-resolver
    // Promise static is Node 22+ and every package pins node >=20.
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), init.timeoutMs);
      // One options shape for both schemes: https.RequestOptions extends
      // http.RequestOptions with only optional TLS fields.
      const options: https.RequestOptions = { method: init.method, headers, signal: controller.signal };
      const onResponse = (response: http.IncomingMessage): void => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        response.on('end', () => {
          clearTimeout(timer);
          const status = response.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
      };
      const request = isHttps
        ? https.request(target, options, onResponse)
        : http.request(target, options, onResponse);
      request.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      request.end(body);
    });
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
  private async request<T>(path: string, payload: unknown, timeoutMs: number = this.timeoutMs): Promise<T> {
    let response: { status: number; ok: boolean; bodyText: string };
    try {
      response = await this.exchange(path, { method: 'POST', timeoutMs, payload });
    } catch (error) {
      throw new WitnessRequestError(0, `supervisor call to ${path} failed: ${(error as Error).message}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText) as unknown;
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
