/**
 * Verdict evaluation shared by `check` and `test-gates`.
 *
 * Evaluates policy obligations against the run-state claims/records and
 * the configured waivers, using the REAL verdict engine (pin #9). The
 * batch wrapper's context carries ONE classification, so obligations are
 * evaluated one at a time with the classification of their own resource
 * — heterogeneous resources must never borrow each other's business
 * meaning. Detector provenance is attached for the invariant-8 trace.
 *
 * Optional diff scoping (`changedFiles`): only obligations whose resource
 * source file changed are evaluated, and only blocking entries pointing
 * at changed files survive — the `check --changed` contract (GF-09's
 * resource-change set).
 */
import { BLOCKING_VERDICTS, blockingEntryFingerprint, evaluateObligations, fingerprint, loadWaivers, verifyLedgerMac, } from '@gateforge/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoPath, sourceByResourceId, sourcesByResourceId } from './pipeline.js';
import { readJsonArray } from './state.js';
/**
 * Pin-#2 fingerprint of an obligation — the identity the baseline
 * stores. Shared by `check` (baseline application) and `adopt` (red-set
 * capture) so both sides hash exactly the same way.
 */
export function obligationFingerprint(obligation) {
    return fingerprint({
        resourceId: obligation.resourceId,
        contract: obligation.contract,
        policyId: obligation.policyId,
        lifecycle: obligation.lifecycle,
    });
}
/** Keeps only blocking entries plausibly tied to a changed file. */
function scopeBlocking(blocking, changed, sources) {
    const kept = [];
    for (const entry of blocking) {
        if (entry.kind === 'unclassified' && entry.resourceId !== null) {
            const source = sources.get(entry.resourceId);
            if (source !== undefined && changed.has(source))
                kept.push(entry);
            continue;
        }
        if ((entry.kind === 'unresolved' || entry.kind === 'finding') &&
            entry.location !== null) {
            if (changed.has(entry.location.file))
                kept.push(entry);
            continue;
        }
        // Unattributable entries stay visible: never hide a block we cannot
        // prove belongs to an unchanged file (stale references carry no
        // location, so they always surface).
        kept.push(entry);
    }
    return kept;
}
/**
 * Evaluates obligations and blocks per the run inputs.
 *
 * Args:
 *   input: cwd, config, graph, obligations, blocking, state dir,
 *     injected instant, and optional diff scope.
 *
 * Returns:
 *   EvaluateResult: verdicts (sorted), scoped blocking entries, waiver
 *   counts, and the blocking flag.
 */
export function evaluateRun(input) {
    const { cwd, config, graph, obligations, stateDir, now } = input;
    const classifications = new Map();
    const detectors = new Map();
    const resourceById = new Map();
    for (const resource of graph.resources) {
        if (resource.id === null)
            continue;
        classifications.set(resource.id, resource.classification);
        detectors.set(resource.id, resource.detector);
        resourceById.set(resource.id, { kind: resource.kind, attributes: resource.attributes });
    }
    const waiverLoad = loadWaivers(resolveRepoPath(cwd, config.waivers), { now });
    const claims = readJsonArray(stateDir, 'claims.json');
    const records = demoteUnprovenRecords(readJsonArray(stateDir, 'records.json'), stateDir, {
        verifierKey: input.witnessVerifierKey,
        live: input.witnessAttestation,
    });
    const scoped = scopeObligations(input);
    const verdicts = [];
    for (const obligation of scoped) {
        const entries = evaluateObligations([obligation], {
            claims,
            records,
            waivers: waiverLoad.waivers,
            classification: classifications.get(obligation.resourceId) ?? null,
            resource: resourceById.get(obligation.resourceId) ?? null,
            now,
        });
        const entry = entries[0];
        if (entry === undefined)
            continue;
        verdicts.push({
            ...entry,
            detector: detectors.get(obligation.resourceId) ?? null,
        });
    }
    verdicts.sort((a, b) => (a.obligation.id < b.obligation.id ? -1 : a.obligation.id > b.obligation.id ? 1 : 0));
    const sources = sourceByResourceId(graph);
    const blocking = input.changedFiles === null || input.changedFiles === undefined
        ? [...input.blocking]
        : scopeBlocking(input.blocking, new Set(input.changedFiles), sources);
    // Adoption-baseline forgiveness (phase 8 C) runs LAST — after diff
    // scoping — and only over what this run actually evaluated, so the
    // baseline can never resurrect forgivable-looking debt outside scope.
    const applied = applyBaseline(input.baseline?.fingerprints ?? null, { verdicts, blocking });
    const blockingRun = applied.blocking.length > 0 ||
        applied.verdicts.some((entry) => BLOCKING_VERDICTS.includes(entry.verdict));
    return {
        verdicts: applied.verdicts,
        blocking: applied.blocking,
        baselined: applied.baselined,
        waiverCounts: {
            total: waiverLoad.waivers.length + waiverLoad.staleOwner.length + waiverLoad.expired.length,
            active: waiverLoad.waivers.length,
            expired: waiverLoad.expired.length,
            staleOwner: waiverLoad.staleOwner.length,
        },
        blockingRun,
    };
}
/**
 * Applies the adoption baseline (phase 8 C): baselined blocking verdicts
 * are re-graded `waived` — a recorded, dated forgiveness whose reason
 * names the receipt — and baselined blocking entries are dropped, with
 * counts returned so every report stays loud about how much debt the
 * baseline carries (never silently green). Everything unbaselined blocks
 * exactly as before; a null/empty set changes nothing.
 */
function applyBaseline(fingerprints, run) {
    if (fingerprints === null || fingerprints.size === 0) {
        return { verdicts: run.verdicts, blocking: run.blocking, baselined: null };
    }
    let obligations = 0;
    const verdicts = run.verdicts.map((entry) => {
        if (!BLOCKING_VERDICTS.includes(entry.verdict))
            return entry;
        if (!fingerprints.has(obligationFingerprint(entry.obligation)))
            return entry;
        obligations += 1;
        return {
            ...entry,
            verdict: 'waived',
            reason: `baselined: adopted as forgiven (was ${entry.verdict}); baseline is shrink-only`,
        };
    });
    const blocking = [];
    let blockingEntries = 0;
    for (const entry of run.blocking) {
        if (fingerprints.has(blockingEntryFingerprint(entry))) {
            blockingEntries += 1;
            continue;
        }
        blocking.push(entry);
    }
    return { verdicts, blocking, baselined: { obligations, blockingEntries } };
}
/** Diff-scopes the obligation list itself (check --changed). */
function scopeObligations(input) {
    if (input.changedFiles === null || input.changedFiles === undefined) {
        return [...input.obligations];
    }
    const changed = new Set(input.changedFiles);
    const sources = sourcesByResourceId(input.graph);
    return input.obligations.filter((obligation) => {
        const resourceSources = sources.get(obligation.resourceId);
        if (resourceSources === undefined)
            return false;
        return resourceSources.some((source) => changed.has(source));
    });
}
/**
 * GF-23 provenance gate (ADR 0001 D2c): only records carrying
 * service-issued provenance keep their `witnessed` tier. The checks:
 * - hash recomputation (recordId = sha256 over the record's canonical
 *   identity) happens in the engine itself (`isProvenancedRecord`), so
 *   arbitrary or transplanted hex ids demote everywhere;
 * - AUTHENTICATED ISSUANCE MEMBERSHIP happens here. The run manifest —
 *   like records.json — lives in the suite-writable state directory, so
 *   plain `recordIds` membership proves nothing: a hostile suite can
 *   fabricate records and the id list alike, and the id hash is public.
 *   A set is therefore trusted ONLY when its integrity is protected by
 *   the witness VERIFIER KEY (a secret the orchestrator shares with the
 *   witness and this CLI, never with the suite):
 *     1. the manifest's `recordIds` with a `recordIdsMac` that
 *        verifies (`verifyLedgerMac`), or
 *     2. the live witness `GET /ledger-attestation` response, which the
 *        caller fetched verifier-authenticated and MAC-verified.
 * - Run identity: the record's runId must equal the manifest's (or the
 *   live attestation's) runId, so sets cannot be transplanted across
 *   runs.
 * Fail closed: without a verifier key — or when neither authenticated
 * set exists or verifies — every witnessed record demotes to
 * claimed-tier, which the engine grades invalid for evidence contracts
 * (never satisfied). An unauthenticated manifest append (witness started
 * without a verifier key, or tampered) demotes the same way.
 */
function demoteUnprovenRecords(records, stateDir, attestation = {}) {
    const issuedRecordId = /^[0-9a-f]{64}$/;
    const verifierKey = typeof attestation.verifierKey === 'string' && attestation.verifierKey.length > 0
        ? attestation.verifierKey
        : null;
    const trusted = new Set();
    let manifestRunId = null;
    let liveRunId = null;
    // 1. Durable channel: manifest recordIds + verifying MAC.
    if (verifierKey !== null) {
        try {
            const manifest = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8'));
            if (typeof manifest.runId === 'string' && manifest.runId.length > 0) {
                manifestRunId = manifest.runId;
            }
            if (manifestRunId !== null &&
                Array.isArray(manifest.recordIds) &&
                typeof manifest.recordIdsMac === 'string' &&
                verifyLedgerMac(verifierKey, manifestRunId, manifest.recordIds.filter((id) => typeof id === 'string'), manifest.recordIdsMac)) {
                for (const id of manifest.recordIds) {
                    if (typeof id === 'string' && issuedRecordId.test(id))
                        trusted.add(id);
                }
            }
        }
        catch {
            manifestRunId = null; // missing/unreadable manifest: durable channel unavailable
        }
        // 2. Live channel: verifier-authenticated ledger attestation, MAC-
        //    verified client-side before it can contribute trust.
        const live = attestation.live;
        if (live !== undefined &&
            live !== null &&
            typeof live.runId === 'string' &&
            live.runId.length > 0 &&
            verifyLedgerMac(verifierKey, live.runId, live.recordIds, live.mac)) {
            for (const id of live.recordIds) {
                if (typeof id === 'string' && issuedRecordId.test(id))
                    trusted.add(id);
            }
            liveRunId = live.runId;
        }
    }
    return records.map((record) => {
        if (typeof record !== 'object' || record === null)
            return record;
        const candidate = record;
        if (candidate['trust'] !== 'witnessed')
            return record;
        const proven = typeof candidate['recordId'] === 'string' &&
            issuedRecordId.test(candidate['recordId']) &&
            trusted.has(candidate['recordId']) &&
            ((manifestRunId !== null && candidate['runId'] === manifestRunId) ||
                (liveRunId !== null && candidate['runId'] === liveRunId));
        return proven ? record : { ...record, trust: 'claimed' };
    });
}
//# sourceMappingURL=evaluate.js.map