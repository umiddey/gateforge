/**
 * Test-gates run state (the orchestration surface G6 consumes).
 *
 * `gateforge test-gates` materializes a run state directory (default
 * `.gateforge/test-gates/`, overridable with `--out`) before any suite
 * runs, and `gateforge check` reads the same directory. The layout is
 * the documented protocol between the CLI, G6's witness service +
 * Playwright reporter, and the verifier:
 *
 * - `manifest.json`  — pin #4 RunManifest (validated).
 * - `obligations.json` — every obligation the suite must cover, with its
 *   pin #2 fingerprint and resource source/location.
 * - `env.json`       — the ambient contract for the suite: the per-run
 *   token, run id, state dir, obligations path, and (when a witness
 *   service is wired, `--witness-url`) its URL. G6 fills the URL when it
 *   spawns the loopback witness service (pin #7, header
 *   `x-gateforge-run: <token>`; env vars `GATEFORGE_WITNESS_URL` +
 *   `GATEFORGE_RUN_TOKEN`).
 * - `claims.json` / `records.json` — reporter output: claims extracted
 *   from `{type: 'gateforge', description: '<obligation id>'}` annotations
 *   and evidence records posted through the witness service. Consumed by
 *   check/test-gates verdict evaluation (records without service-issued
 *   provenance stay claimed — GF-23).
 * - `report.json`    — the canonical json-format run report.
 *
 * All functions take ABSOLUTE directories; commands resolve the
 * repo-relative default against their cwd. Reads are fail-closed: a
 * state file that exists but is not valid JSON is a usage error (exit 2),
 * never a silent skip.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, fingerprint, } from '@gateforge/core';
import { UsageError } from './errors.js';
/** Default run-state directory, repo-root-relative. */
export const DEFAULT_STATE_DIR = '.gateforge/test-gates';
/** Resolves the run-state directory: override (absolute or relative) or default. */
export function resolveStateDir(cwd, override) {
    return resolve(cwd, override ?? DEFAULT_STATE_DIR);
}
/**
 * Builds the suite-visible obligation list: pin-#2 fingerprints plus the
 * resource source/location from the graph (empty when the resource is
 * gone — the reporter still sees the obligation id it must cover).
 *
 * Args:
 *   obligations: policy-generated obligations.
 *   graph: built resource graph (source/location lookup).
 *
 * Returns:
 *   StateObligation[]: one entry per obligation.
 */
export function stateObligations(obligations, graph) {
    const lookup = new Map();
    for (const resource of graph.resources) {
        if (resource.id !== null)
            lookup.set(resource.id, { source: resource.source, location: resource.location });
    }
    return obligations.map((obligation) => {
        const entry = lookup.get(obligation.resourceId);
        return {
            id: obligation.id,
            resourceId: obligation.resourceId,
            contract: obligation.contract,
            policyId: obligation.policyId,
            lifecycle: obligation.lifecycle,
            fingerprint: fingerprint({
                resourceId: obligation.resourceId,
                contract: obligation.contract,
                policyId: obligation.policyId,
                lifecycle: obligation.lifecycle,
            }),
            source: entry?.source ?? '',
            location: entry?.location ?? null,
        };
    });
}
/** Reads an optional JSON array state file; absent → [], invalid → error. */
export function readJsonArray(stateDir, name) {
    const path = join(stateDir, name);
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw new UsageError(`cannot read '${path}': ${error.message}`);
    }
    let document;
    try {
        document = JSON.parse(raw);
    }
    catch (error) {
        throw new UsageError(`state file '${path}' is not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(document)) {
        throw new UsageError(`state file '${path}' must contain a JSON array`);
    }
    return document;
}
/** Writes one JSON document into the state dir (creating it). */
function writeStateFile(stateDir, name, value) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, name), `${canonicalJson(value)}\n`, 'utf8');
}
/** Persists the validated run manifest. */
export function writeManifest(stateDir, manifest) {
    writeStateFile(stateDir, 'manifest.json', manifest);
}
/** Persists the suite-visible obligations document (sorted by id). */
export function writeObligations(stateDir, obligations) {
    const sorted = [...obligations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    writeStateFile(stateDir, 'obligations.json', {
        schemaVersion: 1,
        obligations: sorted,
    });
}
/** Persists the ambient env record and returns it (fresh token unless adopted). */
export function writeEnv(stateDir, manifest, witnessUrl, runToken) {
    const record = {
        GATEFORGE_RUN_ID: manifest.runId,
        GATEFORGE_RUN_TOKEN: runToken ?? randomUUID(),
        GATEFORGE_STATE_DIR: stateDir,
        GATEFORGE_OBLIGATIONS: join(stateDir, 'obligations.json'),
        GATEFORGE_WITNESS_URL: witnessUrl,
    };
    writeStateFile(stateDir, 'env.json', record);
    return record;
}
/** Persists the canonical json-format run report. */
export function writeReport(stateDir, report) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'report.json'), `${report}\n`, 'utf8');
}
//# sourceMappingURL=state.js.map