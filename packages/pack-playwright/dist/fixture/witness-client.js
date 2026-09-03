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
    /** POST /records (pin #7). */
    async postRecords(request) {
        const body = await this.request('/records', request);
        return body;
    }
    /**
     * POST /witness/pre-observation (audit round 4): engine-side id-set
     * snapshot BEFORE a claimed create; pass the returned
     * `observationId` to `verifyPersistence` so the issued record carries
     * `before: {entityAbsent}`.
     */
    async preObserve(request) {
        return this.request('/witness/pre-observation', request);
    }
    /** POST /witness/persistence (pin #7 + testId/claimId binding extension). */
    /**
     * POST /witness/http-observation (ADR 0004 D7): consumes one
     * engine-observed request matching (method, path) and issues the
     * witnessed `http.request` record for the obligation claim.
     */
    async observeHttp(request) {
        return this.request('/witness/http-observation', request);
    }
    async verifyPersistence(request) {
        return this.request('/witness/persistence', request);
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