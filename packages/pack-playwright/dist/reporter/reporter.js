/**
 * The gateforge Playwright reporter (plan §4.6/§4.7, GF-23/GF-24).
 *
 * Per test it extracts claims from `{type: 'gateforge', description:
 * '<obligation id>'}` annotations; at run end it writes the run-state
 * artifacts the CLI's verifier consumes:
 *
 * - `claims.json`  — Claim-shaped entries (schemaVersion, obligationId,
 *   testId, testFile, location) extracted from annotations.
 * - `records.json` — the WITNESS-ISSUED ledger verbatim: the witness is
 *   the only issuer of recordIds, and the reporter copies `GET
 *   /records` — it never reconstructs records from test-side data, so a
 *   fabricated bundle never enters this file (GF-23).
 * - `ledger.json`  — per-claim verdicts for downstream tools.
 *
 * It then computes a per-claim ledger with the REAL verdict engine
 * (`evaluateObligation`, G3) — never trusting the test — and prints a
 * gate pass/fail summary. Exit-code semantics: the AUTHORITATIVE code
 * comes from `gateforge test-gates` (contract 4); the reporter only
 * writes `process.exitCode = 1` when a blocking verdict exists AND
 * `GATEFORGE_REPORTER_FAIL_RUN=1` is explicitly set (best-effort in
 * standalone runs, where Playwright's own exit handling may clobber it).
 *
 * Claim-registry vs records mismatch (GF-24): obligations in the run
 * document with no claim, and records with no matching claim, are
 * printed as ledger notes — the CLI grades the former `missing`, so
 * bypassing the fixture can never read satisfied.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalOf } from '../json.js';
import { CLAIM_ANNOTATION_TYPE, ENV_OBLIGATIONS, ENV_REPORTER_FAIL_RUN, ENV_STATE_DIR, ENV_WITNESS_URL, } from '../constants.js';
import { WitnessClient } from '../fixture/witness-client.js';
import { resolveWitnessUrl } from '../fixture/witness-client.js';
import { claimOf, isBlocking, ledgerRowFor, parseObligationsDocument, } from './ledger.js';
/**
 * The gateforge reporter. No options today; the constructor signature is
 * the Playwright reporter contract (`(options: object)`).
 */
export class GateforgeReporter {
    rows = [];
    constructor(_options = {}) {
        const wired = (process.env[ENV_WITNESS_URL] ?? '') !== '' ||
            (process.env[ENV_STATE_DIR] ?? '') !== '';
        if (!wired) {
            console.warn(`[gateforge] no witness/state wiring (${ENV_WITNESS_URL} or ${ENV_STATE_DIR}); ` +
                'claims/records will not be written and evidence primitives fail closed');
        }
    }
    /** Collects claims + test identity at test end (synchronous). */
    onTestEnd(test, result) {
        const claims = (test.annotations ?? [])
            .filter((annotation) => annotation.type === CLAIM_ANNOTATION_TYPE)
            .map((annotation) => annotation.description ?? '')
            .filter((description) => description.length > 0);
        if (claims.length === 0)
            return;
        this.rows.push({
            testId: test.id,
            testFile: test.location?.file ?? '',
            location: test.location === undefined || test.location === null
                ? null
                : { file: test.location.file, line: test.location.line, col: test.location.column },
            claims,
            status: result.status,
        });
    }
    /** Writes the run-state artifacts and prints the gate ledger. */
    async onEnd() {
        const stateDir = process.env[ENV_STATE_DIR];
        if (stateDir === undefined || stateDir === '') {
            if (this.rows.length > 0) {
                console.warn('[gateforge] claims collected but no state dir: artifacts not written');
            }
            return;
        }
        // claims.json — the claim registry (GF-24's left side). Empty when
        // the suite bypassed the fixture (GF-24) — the CLI still grades the
        // run's obligations `missing`.
        const claims = this.rows.flatMap((row) => row.claims.map((obligationId) => ({
            schemaVersion: 1,
            obligationId,
            testId: row.testId,
            ...(row.testFile === '' ? {} : { testFile: row.testFile }),
            ...(row.location === null ? {} : { location: row.location }),
        })));
        writeJson(stateDir, 'claims.json', claims);
        // records.json — ONLY the witness-issued ledger (GF-23 enforcement).
        let records = [];
        try {
            const client = new WitnessClient(resolveWitnessUrl());
            const ledger = (await client.listRecords());
            records = Array.isArray(ledger.records) ? ledger.records : [];
        }
        catch (error) {
            console.warn(`[gateforge] cannot fetch the witness ledger: ${error.message}`);
        }
        writeJson(stateDir, 'records.json', records);
        const obligationsRaw = readObligationsRaw();
        const obligations = obligationsRaw === null ? null : parseObligationsDocument(obligationsRaw);
        const classifications = await this.fetchClassifications();
        const now = this.runInstant(stateDir);
        // Advisory route inventory (plan §9): the CLI-derived
        // `http-routes.json` when present. Absent → null, and the core
        // resolver returns its blocking missing-context result for HTTP
        // rows. Never authoritative: the CLI recomputes from source.
        const httpRoutes = readHttpRoutes(stateDir);
        const ledger = this.ledgerRows(obligations, classifications, records, now, httpRoutes);
        writeJson(stateDir, 'ledger.json', ledger);
        this.printLedger(ledger);
        this.printRegistryMismatches(obligations, records);
        const blocking = ledger.some((row) => isBlocking(row.verdict));
        if (blocking && process.env[ENV_REPORTER_FAIL_RUN] === '1') {
            // Playwright overrides `process.exitCode` after reporters run, so
            // setting it here does not fail the run (1.58.2 observed; the
            // spike documented the same). GATEFORGE_REPORTER_FAIL_RUN=1 is an
            // explicit opt-in to hard-exit: the gate ledger above is already
            // printed, so exiting here loses nothing but the runner summary.
            process.exit(1);
        }
    }
    /** The witness classification projection (real lifecycle + primaryKey). */
    async fetchClassifications() {
        try {
            const client = new WitnessClient(resolveWitnessUrl());
            const response = (await authenticatedFetch(client.url, '/classifications', client.token));
            if (typeof response !== 'object' || response === null)
                return {};
            const resources = response['resources'];
            if (typeof resources !== 'object' || resources === null)
                return {};
            const out = {};
            for (const [resourceId, view] of Object.entries(resources)) {
                const entry = view;
                const lifecycle = (entry['lifecycle'] ?? {});
                out[resourceId] = {
                    primaryKey: Array.isArray(entry['primaryKey'])
                        ? entry['primaryKey'].filter((key) => typeof key === 'string')
                        : ['id'],
                    exposure: typeof entry['exposure'] === 'string' ? entry['exposure'] : 'user-facing',
                    plane: typeof entry['plane'] === 'string' ? entry['plane'] : 'tenant',
                    ...(typeof entry['evidenceAdapter'] === 'string'
                        ? { evidenceAdapter: entry['evidenceAdapter'] }
                        : {}),
                    // The claims lane (http.endpoint resources) MUST reach the
                    // engine: without it a user-facing adapter-free entry fails the
                    // engine's classification validation and grades unclassified.
                    ...(entry['evidenceLane'] === 'adapter' || entry['evidenceLane'] === 'claims'
                        ? { evidenceLane: entry['evidenceLane'] }
                        : {}),
                    lifecycle: {
                        create: lifecycle['create'] === true,
                        read: lifecycle['read'] === true,
                        update: lifecycle['update'] === true,
                        delete: lifecycle['delete'] === true,
                        ...(lifecycle['deleteSemantics'] === 'hard' || lifecycle['deleteSemantics'] === 'archive'
                            ? { deleteSemantics: lifecycle['deleteSemantics'] }
                            : {}),
                        // Owner-owned archived state must reach the engine: it grades
                        // archive postconditions against it (audit round 5).
                        ...(typeof lifecycle['archiveFields'] === 'object' &&
                            lifecycle['archiveFields'] !== null &&
                            !Array.isArray(lifecycle['archiveFields'])
                            ? {
                                archiveFields: lifecycle['archiveFields'],
                            }
                            : {}),
                        ...(Array.isArray(lifecycle['updateableFields'])
                            ? {
                                updateableFields: lifecycle['updateableFields'].filter((field) => typeof field === 'string'),
                            }
                            : {}),
                    },
                };
            }
            return out;
        }
        catch {
            return {};
        }
    }
    ledgerRows(obligations, classifications, records, now, httpRoutes) {
        const classMap = {};
        for (const [resourceId, view] of Object.entries(classifications)) {
            const primaryKey = view.primaryKey.length > 0 ? view.primaryKey : ['id'];
            classMap[resourceId] = {
                exposure: view.exposure === 'internal' ? 'internal' : 'user-facing',
                plane: view.plane === 'master' ? 'master' : view.plane === 'global' ? 'global' : 'tenant',
                ...(view.evidenceAdapter === undefined ? {} : { evidenceAdapter: view.evidenceAdapter }),
                ...(view.evidenceLane === undefined ? {} : { evidenceLane: view.evidenceLane }),
                lifecycle: view.lifecycle,
                primaryKey,
            };
        }
        const rows = [];
        for (const row of this.rows) {
            for (const obligationId of row.claims) {
                rows.push(ledgerRowFor(claimOf(obligationId, {
                    id: row.testId,
                    location: row.location === null
                        ? null
                        : {
                            file: row.location.file,
                            line: row.location.line,
                            column: row.location.col,
                        },
                }), obligations, classMap, records, now, httpRoutes));
            }
        }
        return rows.sort((a, b) => a.claim === b.claim ? (a.testId < b.testId ? -1 : 1) : a.claim < b.claim ? -1 : 1);
    }
    /** Deterministic instant: the run manifest's injected `startedAt`. */
    runInstant(stateDir) {
        try {
            const manifest = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8'));
            if (typeof manifest.startedAt === 'string')
                return manifest.startedAt;
        }
        catch {
            // fall through
        }
        return new Date().toISOString();
    }
    /** Prints the per-claim verdict ledger + gate summary. */
    printLedger(rows) {
        const width = Math.max('CLAIMED OBLIGATION'.length, ...rows.map((row) => row.claim.length));
        console.log('\n=== GATEFORGE VERDICTS ===');
        if (rows.length === 0) {
            console.log('no gateforge claims found in this run');
            console.log('==========================\n');
            return;
        }
        for (const row of rows) {
            console.log(`${String(row.verdict).toUpperCase().padEnd(10)} ${row.claim.padEnd(width)}  ${row.testFile}`);
            if (row.reason !== null) {
                console.log(`           - ${row.reason}`);
            }
            if (row.recordIds.length > 0) {
                console.log(`           - records: ${row.recordIds.join(', ')}`);
            }
        }
        const blocking = rows.filter((row) => isBlocking(row.verdict));
        if (blocking.length === 0) {
            console.log(`GATEFORGE GATE: PASS (${rows.length}/${rows.length} claimed obligations satisfied)`);
        }
        else {
            console.log(`GATEFORGE GATE: FAIL (${blocking.length}/${rows.length} claimed obligations not satisfied)`);
        }
        console.log('==========================\n');
    }
    /** GF-24 observability: obligations nobody claimed + records nobody claimed. */
    printRegistryMismatches(obligations, records) {
        const claimed = new Set(this.rows.flatMap((row) => row.claims));
        if (obligations !== null) {
            const unclaimed = obligations.obligations
                .filter((entry) => !claimed.has(entry.id))
                .map((entry) => entry.id)
                .sort();
            if (unclaimed.length > 0) {
                console.warn(`[gateforge] obligations without any claim (will grade missing): ${unclaimed.join(', ')}`);
            }
        }
        const claimedPairs = new Set(this.rows.flatMap((row) => row.claims.map((claim) => `${claim}\u0000${row.testId}`)));
        const orphans = records
            .filter((record) => !claimedPairs.has(`${record.obligationId}\u0000${record.testId}`))
            .map((record) => `${record.obligationId} (${record.testId})`)
            .sort();
        if (orphans.length > 0) {
            console.warn(`[gateforge] witness records with no matching claim (claim-registry mismatch, GF-24): ${orphans.join(', ')}`);
        }
    }
}
// Playwright custom reporters MUST be the module's default export.
export default GateforgeReporter;
/**
 * Reads the CLI-derived advisory route inventory (`http-routes.json`,
 * written by `test-gates` beside the obligations document). Returns
 * null when absent or malformed — the core resolver then returns its
 * blocking missing-context result for HTTP rows. Advisory only: the
 * authoritative CLI recomputes this list from source.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   readonly HttpRouteCandidate[] | null: the advisory inventory or null.
 */
function readHttpRoutes(stateDir) {
    let raw;
    try {
        raw = readFileSync(join(stateDir, 'http-routes.json'), 'utf8');
    }
    catch {
        return null;
    }
    let document;
    try {
        document = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document))
        return null;
    const routes = document['routes'];
    if (!Array.isArray(routes))
        return null;
    const candidates = [];
    for (const entry of routes) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            return null;
        const candidate = entry;
        if (typeof candidate['resourceId'] !== 'string' ||
            typeof candidate['method'] !== 'string' ||
            typeof candidate['canonicalPath'] !== 'string') {
            return null;
        }
        candidates.push({
            resourceId: candidate['resourceId'],
            method: candidate['method'],
            canonicalPath: candidate['canonicalPath'],
        });
    }
    return candidates;
}
/** Reads the obligations document path from env (null when unset/broken). */
function readObligationsRaw() {
    const path = process.env[ENV_OBLIGATIONS];
    if (path === undefined || path === '')
        return null;
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
/** Writes one GF-canonical JSON state artifact. */
function writeJson(stateDir, name, value) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, name), `${canonicalOf(value)}\n`, 'utf8');
}
/** Authenticated GET helper for reporter-side witness calls. */
async function authenticatedFetch(url, path, token) {
    const response = await fetch(`${url}${path}`, {
        headers: { 'x-gateforge-run': token, accept: 'application/json' },
    });
    if (!response.ok) {
        throw new Error(`witness ${path} answered HTTP ${response.status}`);
    }
    return response.json();
}
//# sourceMappingURL=reporter.js.map