import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENV_RUN_ID,
  ENV_RUN_TOKEN,
  ENV_STATE_DIR,
  ENV_WITNESS_URL,
  PAGE_OBSERVER_FLUSH_TIMEOUT_MS,
  RUN_HEADER,
  WITNESS_URL_FILE,
} from '../constants.js';
import type {
  BehaviorExecuteRequest,
  BehaviorExecuteResponse,
  BehaviorPrincipalRequest,
  BehaviorPrincipalResponse,
  BrowserActionRequest,
  BrowserActionResponse,
  BrowserSurfaceRequest,
  BrowserVisibleRequest,
  BrowserVisibleResponse,
  IntervalCloseResponse,
  IntervalOpenResponse,
  PersistenceRequest,
  PersistenceResponse,
  PreObservationRequest,
  PreObservationResponse,
  RecordsRequest,
  RecordsResponse,
  SessionCredential,
  SessionIdentityRequest,
  SessionIdentityResponse,
  SessionPageOriginRequest,
  SessionPageOriginResponse,
  SessionPageObserverRequest,
  SessionPageObserverFlushRequest,
  SessionResolveRequest,
  SessionResolveResponse,
  SessionSetupExchangesRequest,
  SessionSetupExchangesResponse,
} from '../witness/types.js';

export type { SessionPageObserverFlushRequest };

/** A witness call that failed (status + single-cause diagnostic). */
export class WitnessRequestError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(status: number, message: string, detail: string | null = null) {
    super(detail === null ? message : `${message}: ${detail}`);
    this.name = 'WitnessRequestError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Appends persistence adapter wall time to the run diagnostics.
 *
 * Args:
 *   durationMs: elapsed wall time for the witness persistence request.
 *   testId: runner-issued test identity associated with the call.
 *   stateDir: Gateforge run-state directory, if a supervised run is active.
 *
 * Returns:
 *   void: writes one JSONL row when run diagnostics are available.
 */
function recordPersistenceTiming(durationMs: number, testId: string, stateDir: string | undefined): void {
  if (stateDir === undefined || stateDir.length === 0) return;
  const diagnosticsDir = join(stateDir, 'diagnostics');
  mkdirSync(diagnosticsDir, { recursive: true });
  appendFileSync(
    join(diagnosticsDir, 'adapter-timing.jsonl'),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: 'verifyPersistence',
      runId: process.env[ENV_RUN_ID] ?? null,
      testId,
      durationMs,
    })}\n`,
    'utf8',
  );
  if (durationMs > 2_000) {
    process.stderr.write(`Gateforge witness adapter verifyPersistence took ${durationMs}ms for ${testId}\n`);
  }
}

/**
 * Resolves the witness base URL: env first, then the spawned-witness
 * file in the run-state dir (written by the reporter when it auto-spawns
 * a witness without `--witness-url`).
 *
 * Returns:
 *   string: the witness base URL.
 *
 * Throws:
 *   Error: with the exact setup step required when no witness is wired.
 */
export function resolveWitnessUrl(): string {
  const fromEnv = process.env[ENV_WITNESS_URL];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const stateDir = process.env[ENV_STATE_DIR];
  if (stateDir !== undefined && stateDir !== '') {
    try {
      const record = JSON.parse(readFileSync(join(stateDir, WITNESS_URL_FILE), 'utf8')) as {
        url?: unknown;
      };
      if (typeof record.url === 'string' && record.url !== '') return record.url;
    } catch {
      // fall through to the actionable error
    }
  }
  throw new Error(
    `no witness service is wired: set ${ENV_WITNESS_URL} (or run under 'gateforge test-gates', ` +
      'which exports it) so evidence primitives can submit records',
  );
}
/**
 * The fixture's witness transport.
 *
 * Args:
 *   url: witness base URL (default: resolved from env/state file).
 *   token: run token (default: GATEFORGE_RUN_TOKEN).
 *   timeoutMs: per-call timeout.
 */
export class WitnessClient {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;

  constructor(
    url: string = resolveWitnessUrl(),
    token: string | undefined = process.env[ENV_RUN_TOKEN],
    timeoutMs = 5000,
  ) {
    this.url = url;
    if (token === undefined || token === '') {
      throw new Error(`${ENV_RUN_TOKEN} is required to talk to the witness service`);
    }
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /** POST /records (pin #7; Phase 1: requires the supervisor-issued session credential). */
  async postRecords(request: RecordsRequest): Promise<RecordsResponse> {
    const body = await this.request<RecordsResponse>('/records', request);
    return body;
  }

  /**
   * POST /sessions/resolve (Phase 1, worker side): asks for the OPEN
   * session bound to the exact (workerIndex, testId) pair.
   *
   * Deliberately the ONLY session-lifecycle call on the suite-side
   * client (enforcement-review fix 3): open and close live on the
   * supervisor channel (`SupervisorClient`, verifier-key authenticated)
   * and are dispatched by the trusted CLI's spool drain — the tested
   * suite has NO reachable path to mint, seal, or re-seal a session,
   * and with it no path to forge the execution record supervision
   * grades. Resolve only ever answers for a session the supervisor
   * already opened; it cannot create or extend one.
   *
   * Returns:
   *   SessionResolveResponse when an open session answers; null when the
   *   witness answers 404 (not yet opened, or sealed).
   */
  async resolveSession(request: SessionResolveRequest): Promise<SessionResolveResponse | null> {
    try {
      return await this.request<SessionResolveResponse>('/sessions/resolve', request);
    } catch (error) {
      if (error instanceof WitnessRequestError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * POST /sessions/identity (plan Phase 4b item 3b): registers the login
   * of the tenant this test just created, for THIS session only.
   *
   * It changes who the engine reads as — nothing else: the engine still
   * performs every read, a wrong tenant makes the row unfound (fail
   * closed), and the credential never reaches a record, the run state, a
   * log or a report. The call carries the session credential, so it can
   * only ever register for the session the caller is running under.
   */
  async registerSessionIdentity(request: SessionIdentityRequest): Promise<SessionIdentityResponse> {
    return this.request<SessionIdentityResponse>('/sessions/identity', request);
  }

  /**
   * POST /sessions/page-origins (plan 0.9.2 item F): reports the origins
   * this test's page requested that the fixture did NOT route onto the
   * session proxy, so the zero-traffic note can name the real cause (a
   * suite base URL that differs from GATEFORGE_APP_BASE_URL) instead of
   * only blaming the fixture page.
   *
   * It is DIAGNOSTIC TEXT: the witness keeps it in memory for this
   * session, mints no record from it, and grades nothing on it. Session
   * authenticated, so it can only ever report for the session the caller
   * is running under.
   */
  async reportSessionPageOrigins(
    request: SessionPageOriginRequest,
  ): Promise<SessionPageOriginResponse> {
    return this.request<SessionPageOriginResponse>('/sessions/page-origins', request);
  }

  /**
   * POST /sessions/setup-exchanges (0.13.9): reports the app-origin
   * calls a HOOK-created (or module-scope) API context made. That
   * traffic never rides any session proxy, so the witness never sees it
   * — this report is the only way a claim whose call went through such
   * a context can name the cause instead of a bare anchor refusal.
   *
   * It is DIAGNOSTIC: the witness keeps the exchanges RUN-scoped in
   * memory, never credits them, and the observe finalize stamps the ONE
   * witnessed `channel: 'setup'` record the verdict engine reads purely
   * for its missing-claim reason. Session authenticated, so it can only
   * ever report while the caller's session is open.
   */
  async reportSessionSetupExchanges(
    request: SessionSetupExchangesRequest,
  ): Promise<SessionSetupExchangesResponse> {
    return this.request<SessionSetupExchangesResponse>('/sessions/setup-exchanges', request);
  }

  /** POST /sessions/page-observer registers the fixture-launched browser with the witness. */
  async registerPageObserver(request: SessionPageObserverRequest): Promise<{ registered: true }> {
    return this.request<{ registered: true }>('/sessions/page-observer', request);
  }

  /** POST /sessions/page-observer/flush persists every quiet visit before the runner closes Chromium. */
  async flushPageObserver(
    request: SessionPageObserverFlushRequest,
    timeoutMs: number = PAGE_OBSERVER_FLUSH_TIMEOUT_MS,
  ): Promise<{ flushed: true }> {
    return this.request<{ flushed: true }>('/sessions/page-observer/flush', request, timeoutMs);
  }

  /**
   * POST /sessions/intervals/open (Phase 1): marks the start of a
   * UI-action observation interval on the witness's monotonic clock.
   * Proxy exchanges completing inside the interval are the session's
   * browser evidence; everything outside (setup traffic) is never
   * credited.
   */
  async beginActionInterval(request: {
    sessionId: string;
    sessionToken: string;
    operation: string;
  }): Promise<IntervalOpenResponse> {
    return this.request<IntervalOpenResponse>('/sessions/intervals/open', request);
  }

  /**
   * POST /sessions/intervals/close (Phase 1): seals the interval. A
   * closed interval can never be stretched later (409 on re-close).
   */
  async endActionInterval(request: {
    sessionId: string;
    sessionToken: string;
    intervalId: string;
  }): Promise<IntervalCloseResponse> {
    return this.request<IntervalCloseResponse>('/sessions/intervals/close', request);
  }

  /**
   * POST /witness/pre-observation (audit round 4): engine-side id-set
   * snapshot BEFORE a claimed create; pass the returned
   * `observationId` to `verifyPersistence` so the issued record carries
   * `before: {entityAbsent}`. Phase 1: requires the supervisor-issued
   * session credential — the snapshot belongs to the open test session.
   */
  async preObserve(request: PreObservationRequest): Promise<PreObservationResponse> {
    return this.request<PreObservationResponse>('/witness/pre-observation', request);
  }

  /**
   * POST /witness/http-observation (ADR 0004 D7, plan §8 / D1):
   * consumes one witness-observed HTTP exchange matching (method, path)
   * and issues witnessed `http.request` records for the declaring
   * test's claimed obligations. Phase 1: the caller must hold a valid
   * OPEN session and only an exchange observed through THAT session's
   * proxy prefix within one of its recorded action intervals can be
   * consumed — the claim set may be given as `claimIds`, or as the
   * singular legacy `claimId`/`obligationId` pair (folded in by the
   * server; a split assignment with distinct values is refused with 400).
   */
  async observeHttp(
    request: {
      claimIds?: string[];
      claimId?: string;
      obligationId?: string;
      testId: string;
      method: string;
      path: string;
      expectedStatus?: number;
      sessionId: string;
      sessionToken: string;
    },
  ): Promise<{
    recordId: string;
    runId: string;
    trust: string;
    status: number;
    records: Array<{ recordId: string; obligationId: string }>;
  }> {
    const body = await this.request<Record<string, unknown>>('/witness/http-observation', request);
    const records = Array.isArray(body['records'])
      ? (body['records'] as Array<{ recordId: string; obligationId: string }>)
      : // Legacy single-record response shape.
        [{ recordId: String(body['recordId'] ?? ''), obligationId: String(request.claimId ?? request.obligationId ?? '') }];
    return {
      recordId: String(body['recordId'] ?? records[0]?.recordId ?? ''),
      runId: String(body['runId'] ?? ''),
      trust: String(body['trust'] ?? ''),
      status: typeof body['status'] === 'number' ? body['status'] : 0,
      records,
    };
  }

  /**
   * POST /witness/persistence and record adapter wall time.
   *
   * Args:
   *   request: persistence observation bound to a supervised test session.
   *
   * Returns:
   *   Promise<PersistenceResponse>: the engine-side adapter result.
   */
  async verifyPersistence(
    request: PersistenceRequest & {
      testId: string;
      claimId: string;
      sessionId: string;
      sessionToken: string;
    },
  ): Promise<PersistenceResponse> {
    const startedAt = performance.now();
    try {
      return await this.request<PersistenceResponse>('/witness/persistence', request);
    } finally {
      recordPersistenceTiming(
        Math.round(performance.now() - startedAt),
        request.testId,
        process.env[ENV_STATE_DIR],
      );
    }
  }

  /**
   * POST /browser/surface (plan Phase 1 item 4): registers the
   * consumer-declared surface descriptor + the app base the ENGINE must
   * drive for this session. Validated engine-side (structure, loopback,
   * fingerprint); selectors are locators only.
   */
  async registerBrowserSurface(
    request: BrowserSurfaceRequest,
  ): Promise<{ registered: true }> {
    return this.request<{ registered: true }>('/browser/surface', request);
  }

  /**
   * POST /browser/action (plan Phase 1 item 4): the ENGINE performs one
   * constrained surface operation on its own page and returns its own
   * observation (observed entity id, entered + rendered fields, app
   * status, pre-observation id, issued record ids). Test code supplies
   * intent only — it never touches the engine page.
   */
  async browserAction(request: BrowserActionRequest): Promise<BrowserActionResponse> {
    return this.request<BrowserActionResponse>('/browser/action', request);
  }

  /**
   * POST /browser/visible (plan Phase 1 item 4): the ENGINE re-reads
   * the rendered result for the engine-observed entity and returns the
   * rendered fields.
   */
  async browserVisible(request: BrowserVisibleRequest): Promise<BrowserVisibleResponse> {
    return this.request<BrowserVisibleResponse>('/browser/visible', request);
  }

  /**
   * POST /behavior/execute (plan 2026-09-19 Phase 6): asks the ENGINE to
   * execute one approved behavior case. The call carries ONLY the
   * allowed case id plus the session credential — actor material,
   * expectations, and subjects resolve engine-side and are never
   * readable or overridable here.
   */
  async proveCase(request: BehaviorExecuteRequest): Promise<BehaviorExecuteResponse> {
    return this.request<BehaviorExecuteResponse>('/behavior/execute', request);
  }

  /**
   * POST /behavior/principal (plan 2026-09-19 Phase 6): asks the ENGINE
   * to drive the prepared execution's principal operation and seal the
   * case record. Same credential-only boundary as `proveCase`.
   */
  async drivePrincipal(request: BehaviorPrincipalRequest): Promise<BehaviorPrincipalResponse> {
    return this.request<BehaviorPrincipalResponse>('/behavior/principal', request);
  }

  /** GET /records — the issued ledger for this run. */
	async listRecords(): Promise<{ records: IssuedLedgerRecord[] }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let response: Response;
		try {
			response = await fetch(`${this.url}/records`, {
				method: 'GET',
				headers: { [RUN_HEADER]: this.token, accept: 'application/json' },
				signal: controller.signal,
			});
		} catch (error) {
			throw new WitnessRequestError(0, `witness call to /records failed: ${(error as Error).message}`);
		} finally {
			clearTimeout(timer);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			body = null;
		}
		if (!response.ok) {
			const record = isObject(body) ? body : {};
			throw new WitnessRequestError(
				response.status,
				typeof record['error'] === 'string' ? record['error'] : `witness answered HTTP ${response.status}`,
				typeof record['detail'] === 'string' ? record['detail'] : null,
			);
		}
		const records = isObject(body) && Array.isArray(body['records']) ? body['records'] : [];
		return { records: records as IssuedLedgerRecord[] };
	}

  private async request<T>(path: string, payload: unknown, timeoutMs: number = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: {
          [RUN_HEADER]: this.token,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new WitnessRequestError(0, `witness call to ${path} failed: ${(error as Error).message}`);
    }
    clearTimeout(timer);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const record = isObject(body) ? body : {};
      throw new WitnessRequestError(
        response.status,
        typeof record['error'] === 'string' ? record['error'] : `witness answered HTTP ${response.status}`,
        typeof record['detail'] === 'string' ? record['detail'] : null,
      );
    }
    return body as T;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One witness-issued ledger record as seen by the ledger endpoint. */
export interface IssuedLedgerRecord {
	recordId: string;
	runId: string;
	trust: 'witnessed' | 'claimed';
	obligationId: string;
	kind: string;
	testId: string;
	payload: unknown;
	issuedAt?: string;
}