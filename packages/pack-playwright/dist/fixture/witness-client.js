import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_RUN_TOKEN, ENV_STATE_DIR, ENV_WITNESS_URL, RUN_HEADER, WITNESS_URL_FILE, } from '../constants.js';
/** A witness call that failed (status + single-cause diagnostic). */
export class WitnessRequestError extends Error {
    status;
    detail;
    constructor(status, message, detail = null) {
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
export function resolveWitnessUrl() {
    const fromEnv = process.env[ENV_WITNESS_URL];
    if (fromEnv !== undefined && fromEnv !== '')
        return fromEnv;
    const stateDir = process.env[ENV_STATE_DIR];
    if (stateDir !== undefined && stateDir !== '') {
        try {
            const record = JSON.parse(readFileSync(join(stateDir, WITNESS_URL_FILE), 'utf8'));
            if (typeof record.url === 'string' && record.url !== '')
                return record.url;
        }
        catch {
            // fall through to the actionable error
        }
    }
    throw new Error(`no witness service is wired: set ${ENV_WITNESS_URL} (or run under 'gateforge test-gates', ` +
        'which exports it) so evidence primitives can submit records');
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
    url;
    token;
    timeoutMs;
    constructor(url = resolveWitnessUrl(), token = process.env[ENV_RUN_TOKEN], timeoutMs = 5000) {
        this.url = url;
        if (token === undefined || token === '') {
            throw new Error(`${ENV_RUN_TOKEN} is required to talk to the witness service`);
        }
        this.token = token;
        this.timeoutMs = timeoutMs;
    }
    /** POST /records (pin #7; Phase 1: requires the supervisor-issued session credential). */
    async postRecords(request) {
        const body = await this.request('/records', request);
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
    async resolveSession(request) {
        try {
            return await this.request('/sessions/resolve', request);
        }
        catch (error) {
            if (error instanceof WitnessRequestError && error.status === 404)
                return null;
            throw error;
        }
    }
    /**
     * POST /sessions/intervals/open (Phase 1): marks the start of a
     * UI-action observation interval on the witness's monotonic clock.
     * Proxy exchanges completing inside the interval are the session's
     * browser evidence; everything outside (setup traffic) is never
     * credited.
     */
    async beginActionInterval(request) {
        return this.request('/sessions/intervals/open', request);
    }
    /**
     * POST /sessions/intervals/close (Phase 1): seals the interval. A
     * closed interval can never be stretched later (409 on re-close).
     */
    async endActionInterval(request) {
        return this.request('/sessions/intervals/close', request);
    }
    /**
     * POST /witness/pre-observation (audit round 4): engine-side id-set
     * snapshot BEFORE a claimed create; pass the returned
     * `observationId` to `verifyPersistence` so the issued record carries
     * `before: {entityAbsent}`. Phase 1: requires the supervisor-issued
     * session credential — the snapshot belongs to the open test session.
     */
    async preObserve(request) {
        return this.request('/witness/pre-observation', request);
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
    async observeHttp(request) {
        const body = await this.request('/witness/http-observation', request);
        const records = Array.isArray(body['records'])
            ? body['records']
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
     * POST /witness/persistence (Phase 1): runs the engine-side adapter
     * read under the supervisor-opened session, so the persistence record
     * binds to the same channel the UI action used.
     */
    async verifyPersistence(request) {
        return this.request('/witness/persistence', request);
    }
    /**
     * POST /browser/surface (plan Phase 1 item 4): registers the
     * consumer-declared surface descriptor + the app base the ENGINE must
     * drive for this session. Validated engine-side (structure, loopback,
     * fingerprint); selectors are locators only.
     */
    async registerBrowserSurface(request) {
        return this.request('/browser/surface', request);
    }
    /**
     * POST /browser/action (plan Phase 1 item 4): the ENGINE performs one
     * constrained surface operation on its own page and returns its own
     * observation (observed entity id, entered + rendered fields, app
     * status, pre-observation id, issued record ids). Test code supplies
     * intent only — it never touches the engine page.
     */
    async browserAction(request) {
        return this.request('/browser/action', request);
    }
    /**
     * POST /browser/visible (plan Phase 1 item 4): the ENGINE re-reads
     * the rendered result for the engine-observed entity and returns the
     * rendered fields.
     */
    async browserVisible(request) {
        return this.request('/browser/visible', request);
    }
    /** GET /records — the issued ledger for this run. */
    async listRecords() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            response = await fetch(`${this.url}/records`, {
                method: 'GET',
                headers: { [RUN_HEADER]: this.token, accept: 'application/json' },
                signal: controller.signal,
            });
        }
        catch (error) {
            throw new WitnessRequestError(0, `witness call to /records failed: ${error.message}`);
        }
        finally {
            clearTimeout(timer);
        }
        let body;
        try {
            body = await response.json();
        }
        catch {
            body = null;
        }
        if (!response.ok) {
            const record = isObject(body) ? body : {};
            throw new WitnessRequestError(response.status, typeof record['error'] === 'string' ? record['error'] : `witness answered HTTP ${response.status}`, typeof record['detail'] === 'string' ? record['detail'] : null);
        }
        const records = isObject(body) && Array.isArray(body['records']) ? body['records'] : [];
        return { records: records };
    }
    async request(path, payload) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
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
        }
        catch (error) {
            clearTimeout(timer);
            throw new WitnessRequestError(0, `witness call to ${path} failed: ${error.message}`);
        }
        clearTimeout(timer);
        let body;
        try {
            body = await response.json();
        }
        catch {
            body = null;
        }
        if (!response.ok) {
            const record = isObject(body) ? body : {};
            throw new WitnessRequestError(response.status, typeof record['error'] === 'string' ? record['error'] : `witness answered HTTP ${response.status}`, typeof record['detail'] === 'string' ? record['detail'] : null);
        }
        return body;
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=witness-client.js.map