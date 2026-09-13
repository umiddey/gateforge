import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENV_RUN_TOKEN,
  ENV_STATE_DIR,
  ENV_WITNESS_URL,
  RUN_HEADER,
  WITNESS_URL_FILE,
} from '../constants.js';
import type {
  PersistenceRequest,
  PersistenceResponse,
  PreObservationRequest,
  PreObservationResponse,
  RecordsRequest,
  RecordsResponse,
} from '../witness/types.js';

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

  /** POST /records (pin #7). */
  async postRecords(request: RecordsRequest): Promise<RecordsResponse> {
    const body = await this.request<RecordsResponse>('/records', request);
    return body;
  }

  /**
   * POST /witness/pre-observation (audit round 4): engine-side id-set
   * snapshot BEFORE a claimed create; pass the returned
   * `observationId` to `verifyPersistence` so the issued record carries
   * `before: {entityAbsent}`.
   */
  async preObserve(request: PreObservationRequest): Promise<PreObservationResponse> {
    return this.request<PreObservationResponse>('/witness/pre-observation', request);
  }

  /**
   * POST /witness/http-observation (ADR 0004 D7, plan §8 / D1):
   * consumes one witness-observed HTTP exchange matching (method, path)
   * and issues witnessed `http.request` records for the declaring
   * test's claimed obligations. Transport-only: test attribution is
   * suite-claimed, never independently verified. The claim set may be
   * given as `claimIds`, or as the singular legacy `claimId`/
   * `obligationId` pair (folded in by the server; a split assignment
   * with distinct values is refused with 400).
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

  async verifyPersistence(
    request: PersistenceRequest & { testId: string; claimId: string },
  ): Promise<PersistenceResponse> {
    return this.request<PersistenceResponse>('/witness/persistence', request);
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

  private async request<T>(path: string, payload: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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