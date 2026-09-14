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
import { AttestationSchema, BLOCKING_VERDICTS, CAUSE_NEXT_ACTIONS, HTTP_ENDPOINT_RESOURCE_KIND, evaluateCoveragePolicy, evaluateObligations, loadWaivers, strictCapabilityGaps, verifyAttestationMac, } from '@gateforge/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { resolveRepoPath, sourcesByResourceId } from './pipeline.js';
import { httpRoutesView, readJsonArray } from './state.js';
/** Keeps only blocking entries plausibly tied to a changed file. */
function scopeBlocking(blocking, changed, multiSources) {
    const kept = [];
    for (const entry of blocking) {
        // `unclassified` with a known resource is the only safely
        // attributable kind: the join-aware multi-source map covers the
        // backend source AND every joined frontend-call source, so a
        // frontend-only change keeps the block (plan §12.3). A resource
        // with no mapping cannot be attributed — retain it.
        if (entry.kind === 'unclassified' && entry.resourceId !== null) {
            const sources = multiSources.get(entry.resourceId);
            if (sources === undefined) {
                kept.push(entry);
                continue;
            }
            if (sources.some((source) => changed.has(source)))
                kept.push(entry);
            continue;
        }
        // Every other kind is retained: classifier errors, stale
        // references, detector findings, and scan-completeness failures
        // cannot be safely attributed to unchanged code by single-file
        // location — hiding them would shrink the report dishonestly.
        // Unknown-location blockers stay visible by the same rule.
        kept.push(entry);
    }
    return kept;
}
/**
 * Derives the closed-world coverage inventory from the built graph (plan
 * 2026-09-13 §3.6): every RESOLVED, USER-FACING business table. HTTP
 * endpoints are routes, not tables (ADR 0004 D8), and unclassified
 * resources generate no obligations, so neither participates.
 *
 * Args:
 *   graph: the built resource graph with effective classifications bound.
 *
 * Returns:
 *   CoverageInventoryTable-style entries: name + lifecycle-enabled
 *   operations, sorted by name (deterministic).
 */
export function coverageInventory(graph) {
    const ALL = ['create', 'read', 'update', 'delete'];
    const inventory = [];
    for (const resource of graph.resources) {
        if (resource.id === null || resource.exposure !== 'user-facing')
            continue;
        if (resource.kind === HTTP_ENDPOINT_RESOURCE_KIND)
            continue;
        if (resource.classification === null)
            continue;
        const lifecycle = resource.classification.lifecycle;
        inventory.push({
            name: resource.name,
            operations: ALL.filter((operation) => lifecycle[operation] === true),
        });
    }
    inventory.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return inventory;
}
/**
 * Coverage-policy evaluation for the run (plan §3.6, ADR 0005 D5).
 * Opt-in: an absent/empty `coveragePolicy` config section means the
 * feature is off. When enabled, the policy is validated against the
 * CURRENT run's inventory on EVERY run: unknown table names throw a
 * UsageError (exit 2), and uncovered/undispositioned requirements become
 * blocking findings carrying cause `CRUD_COVERAGE_MISSING`. Resolved
 * test mappings (browser-e2e-declared bindings, plan Phases 2-3) supply
 * the mapped-coverage facts — a mapped journey clears its table/operation
 * exactly as a recorded owner disposition does; both remain inputs and
 * never substitute for runtime proof.
 *
 * Args:
 *   config: the validated `.gateforge.yml`.
 *   graph: the built resource graph (inventory source).
 *   mappedCoverage: coverage facts derived from resolved test mappings
 *     (empty when the sidecar is absent or no binding declares
 *     browser-e2e).
 *
 * Returns:
 *   BlockingEntry[]: coverage findings (empty when the feature is off).
 *
 * Throws:
 *   UsageError: when a policy table name is absent from the inventory
 *     (configuration error — fail closed, never silently uncheckable).
 */
export function coveragePolicyBlocking(config, graph, mappedCoverage = []) {
    const policy = config.coveragePolicy;
    if (policy === undefined || policy.tables.length === 0)
        return [];
    const result = evaluateCoveragePolicy(policy.tables, coverageInventory(graph), mappedCoverage);
    if (result.configErrors.length > 0) {
        const first = result.configErrors[0];
        throw new UsageError(`${first?.detail}${result.configErrors.length > 1 ? ` (and ${result.configErrors.length - 1} more coverage-policy configuration error(s))` : ''}`);
    }
    return result.blocking.map((finding) => ({
        kind: 'finding',
        resourceId: null,
        name: finding.table,
        detail: finding.detail,
        location: null,
        cause: finding.cause,
        nextAction: finding.nextAction,
    }));
}
/**
 * Strict E2E preflight (plan Phase 0 item 4, ADR 0005 D1): when strict
 * E2E mode is on, every obligation demanding a contract whose proof
 * channel is unavailable becomes a blocking entry with a PRECISE
 * capability error (contract + missing observer + next action). A strict
 * setup lacking browser observation stays visibly incomplete — it cannot
 * advertise an operational blocking E2E gate.
 *
 * Args:
 *   obligations: the run's obligations (preflight is setup-wide, never
 *     diff-narrowed).
 *
 * Returns:
 *   BlockingEntry[]: one blocking entry per unsupported obligation.
 */
export function strictPreflightBlocking(obligations) {
    return strictCapabilityGaps(obligations.map((obligation) => ({ id: obligation.id, contract: obligation.contract }))).map((gap) => ({
        kind: 'finding',
        resourceId: null,
        name: gap.contract,
        detail: `${gap.detail} Required observer: ${gap.observer}`,
        location: null,
        cause: gap.cause,
        nextAction: gap.nextAction,
    }));
}
/**
 * Strict-mode waiver treatment (plan §3.3, ADR 0005 D4): a waived
 * in-scope E2E obligation is NOT proof and cannot authorize the change.
 * Under strict E2E mode the verdict becomes blocking `missing` with cause
 * `ENFORCEMENT_UNTRUSTED`; the original waiver text stays in the reason
 * (legacy/reporting use remains explicit). Every obligation in the engine
 * is an E2E proof obligation — unit/component results never reach the
 * grader — so all waived verdicts convert. Baselined obligations are
 * baseline-clean only in later phases' receipt path; `check` does not
 * consume baselines for grading today.
 *
 * Args:
 *   verdicts: the evaluated verdicts (sorted).
 *
 * Returns:
 *   ObligationVerdict[]: identical unless strict mode converted waived
 *   entries to blocking ones (order and determinism preserved).
 */
export function applyStrictE2E(verdicts) {
    return verdicts.map((entry) => {
        if (entry.verdict !== 'waived')
            return entry;
        const cause = 'ENFORCEMENT_UNTRUSTED';
        return {
            ...entry,
            verdict: 'missing',
            reason: `strict E2E mode: ${entry.reason ?? 'waived'} — a waiver is not proof and cannot ` +
                'authorize the change (plan §3.3); the obligation still requires its own witnessed evidence',
            cause,
            nextAction: CAUSE_NEXT_ACTIONS[cause],
        };
    });
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
    // Native annotation claims (run state) plus declared mapping claims
    // (plan §5.3, Phase 3): both normalize through the one resolver seam so
    // a mapped existing test grades on the SAME path as an annotated one.
    // Mapping claims carry intent only — dedup happens at the seam.
    const claims = [...readJsonArray(stateDir, 'claims.json'), ...(input.mappingClaims ?? [])];
    const authorized = authorizeRecords(readJsonArray(stateDir, 'records.json'), stateDir, {
        verifierKey: input.witnessVerifierKey,
        live: input.witnessAttestation,
        expectedInputDigest: input.evidenceContext?.expectedInputDigest,
        snapshotUnavailable: input.evidenceContext?.snapshotUnavailable,
        expectedInvocationId: input.evidenceContext?.expectedInvocationId,
        requireInvocationId: input.evidenceContext?.requireInvocationId,
        changedInputs: input.evidenceContext?.changedInputs,
    });
    const records = authorized.records;
    // Complete runtime route inventory (plan §9, D2): derived from the
    // graph only — every applicable `http.endpoint` resource, including
    // routes with no consumer and no obligation. Never accepted from a
    // claim or evidence payload; sorted deterministically. Absent/
    // incomplete context blocks HTTP satisfaction in the core resolver.
    const httpRoutes = httpRoutesView(graph);
    const scoped = scopeObligations(input);
    const verdicts = [];
    for (const obligation of scoped) {
        const entries = evaluateObligations([obligation], {
            claims,
            records,
            waivers: waiverLoad.waivers,
            classification: classifications.get(obligation.resourceId) ?? null,
            resource: resourceById.get(obligation.resourceId) ?? null,
            httpRoutes,
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
    const sources = sourcesByResourceId(graph);
    const scopedBlocking = input.changedFiles === null || input.changedFiles === undefined
        ? [...input.blocking]
        : scopeBlocking(input.blocking, new Set(input.changedFiles), sources);
    // Evidence-context blockers are never diff-scoped away and never
    // waived: a changed-input or unauthenticated-evidence run must stay
    // visible even when every obligation is waived or unchanged.
    // Coverage-policy findings are inventory-wide and stay visible too
    // (plan §3.6: validated against the current inventory on every run).
    // Strict-capability preflight is setup-wide: a strict setup demanding
    // an unavailable proof channel cannot advertise an operational gate.
    const strictE2E = config.enforcement?.strictE2E === true;
    const strictBlocking = strictE2E ? strictPreflightBlocking(obligations) : [];
    const blocking = [
        ...scopedBlocking,
        ...authorized.evidenceBlocking,
        ...coveragePolicyBlocking(config, graph, input.mappedCoverage ?? []),
        ...strictBlocking,
    ];
    // Strict E2E mode (plan §3.3): waived obligations are not proof.
    const gradedVerdicts = strictE2E ? applyStrictE2E(verdicts) : verdicts;
    const blockingRun = blocking.length > 0 || gradedVerdicts.some((entry) => BLOCKING_VERDICTS.includes(entry.verdict));
    return {
        verdicts: gradedVerdicts,
        blocking,
        waiverCounts: {
            total: waiverLoad.waivers.length + waiverLoad.staleOwner.length + waiverLoad.expired.length,
            active: waiverLoad.waivers.length,
            expired: waiverLoad.expired.length,
            staleOwner: waiverLoad.staleOwner.length,
        },
        blockingRun,
    };
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
 * GF-23 provenance gate (ADR 0001 D2c) with v2 single-envelope
 * authorization (plan §11.5–§11.6): only records carrying
 * service-issued provenance keep their `witnessed` tier. The checks:
 * - hash recomputation (recordId = sha256 over the record's canonical
 *   identity) happens in the engine itself (`isProvenancedRecord`), so
 *   arbitrary or transplanted hex ids demote everywhere;
 * - AUTHENTICATED SINGLE-ENVELOPE MEMBERSHIP happens here. A record is
 *   authorized only when ONE validated v2 envelope simultaneously
 *   matches its runId, the expected input digest, the required
 *   invocation identity, and its recordId. The run manifest — like
 *   records.json — lives in the suite-writable state directory, so a
 *   bare `recordIds` list proves nothing, and the legacy v1
 *   `recordIdsMac` NEVER authorizes evidence (even when it verifies
 *   under its own format: different signed bytes, no digest binding).
 *   Candidates are the durable manifest `attestation` and the live
 *   `GET /ledger-attestation` envelope; each validates independently,
 *   and an invalid durable envelope contributes nothing — not even
 *   partial fields. Contexts are never merged: an id from envelope A
 *   with the digest of envelope B authorizes nothing.
 * - Run identity: the record's runId must equal the authorizing
 *   envelope's runId, so sets cannot be transplanted across runs.
 * Fail closed: without a verifier key — or when no envelope validates
 * for the expected context — every witnessed record demotes to
 * claimed-tier, which the engine grades invalid for evidence contracts
 * (never satisfied).
 */
function authorizeRecords(records, stateDir, auth = {}) {
    const issuedRecordId = /^[0-9a-f]{64}$/;
    const verifierKey = typeof auth.verifierKey === 'string' && auth.verifierKey.length > 0 ? auth.verifierKey : null;
    const expectedDigest = typeof auth.expectedInputDigest === 'string' && auth.expectedInputDigest.length > 0
        ? auth.expectedInputDigest
        : null;
    const requireInvocation = auth.requireInvocationId === true;
    const expectedInvocation = typeof auth.expectedInvocationId === 'string' && auth.expectedInvocationId.length > 0
        ? auth.expectedInvocationId
        : null;
    const evidenceBlocking = [];
    const block = (detail) => {
        evidenceBlocking.push({
            kind: 'finding',
            resourceId: null,
            name: null,
            detail,
            location: null,
        });
    };
    const witnessedCount = records.filter((record) => typeof record === 'object' &&
        record !== null &&
        record['trust'] === 'witnessed').length;
    // The run changed its own inputs around/after the suite (test-gates
    // post-suite check): the whole evidence run blocks, and active
    // waivers must not hide it — hence a dedicated blocker, always.
    if (auth.changedInputs === true) {
        block('evidence-context: the test-gates run changed its own source or configuration inputs ' +
            'after the suite ran; pre-change evidence cannot certify the changed tree (fail closed)');
    }
    if (auth.snapshotUnavailable === true && (witnessedCount > 0 || auth.changedInputs === true)) {
        block('evidence-context: input snapshot unavailable (no usable Git inventory); ' +
            'evidence authorization is unavailable (snapshot-unavailable) — fail closed');
    }
    /**
     * Validates one envelope candidate for the expected context.
     *
     * Args:
     *   candidate: the durable or live envelope value (untrusted input).
     *   manifestRunId: the manifest's own runId (durable only) — a
     *     mismatch with the envelope runId means the suite-writable
     *     manifest was tampered or swapped.
     *   label: durable/live label for diagnostics.
     *
     * Returns:
     *   The valid envelope, or the rejection reason.
     */
    const validateEnvelope = (candidate, manifestRunId, label) => {
        if (candidate === undefined || candidate === null) {
            return { rejection: 'missing', detail: `${label} attestation envelope is missing` };
        }
        // No trusted digest (snapshot unavailable, or the run changed its
        // own inputs): no envelope can validate — authorizing against an
        // unknown digest would reintroduce the F2 hole.
        if (expectedDigest === null || auth.changedInputs === true) {
            return {
                rejection: 'digest-mismatch',
                detail: auth.changedInputs === true
                    ? `${label} attestation cannot authorize: the run changed its own inputs (fail closed)`
                    : `${label} attestation cannot authorize: input snapshot unavailable (fail closed)`,
            };
        }
        const parsed = AttestationSchema.safeParse(candidate);
        if (!parsed.success) {
            const legacy = typeof candidate === 'object' &&
                candidate !== null &&
                'recordIdsMac' in candidate;
            return {
                rejection: 'malformed',
                detail: `${label} attestation envelope is malformed (expected attestationVersion 2 with ` +
                    `runId, invocationId, inputDigest, sorted unique recordIds, and mac)` +
                    (legacy ? '; legacy v1 recordIdsMac never authorizes evidence — run a fresh test-gates run' : ''),
            };
        }
        const envelope = parsed.data;
        if (verifierKey === null) {
            return {
                rejection: 'mac-fail',
                detail: `${label} attestation cannot verify without a witness verifier key (fail closed)`,
            };
        }
        const macOk = verifyAttestationMac(verifierKey, {
            runId: envelope.runId,
            invocationId: envelope.invocationId,
            inputDigest: envelope.inputDigest,
            recordIds: envelope.recordIds,
        }, envelope.mac);
        if (!macOk) {
            return {
                rejection: 'mac-fail',
                detail: `${label} attestation signature fails; the envelope was forged or tampered (fail closed)`,
            };
        }
        if (expectedDigest !== null && envelope.inputDigest !== expectedDigest) {
            return {
                rejection: 'digest-mismatch',
                detail: `${label} attestation inputDigest does not match the current input snapshot; ` +
                    'old evidence cannot certify changed source or configuration (fail closed)',
            };
        }
        if (requireInvocation && expectedInvocation !== null && envelope.invocationId !== expectedInvocation) {
            return {
                rejection: 'invocation-mismatch',
                detail: `${label} attestation invocationId does not match this test-gates invocation; ` +
                    'a restored old bundle cannot satisfy a new invocation (fail closed)',
            };
        }
        if (manifestRunId !== null && manifestRunId !== envelope.runId) {
            return {
                rejection: 'manifest-run-mismatch',
                detail: `${label} attestation runId does not match the manifest runId; ` +
                    'the suite-writable manifest was tampered or swapped (fail closed)',
            };
        }
        return {
            envelope: {
                runId: envelope.runId,
                invocationId: envelope.invocationId,
                inputDigest: envelope.inputDigest,
                recordIds: new Set(envelope.recordIds),
            },
        };
    };
    const validEnvelopes = [];
    let durablePresent = false;
    let durableRejection = null;
    let durableDetail = null;
    let legacyOnly = false;
    // Durable channel: the manifest's v2 attestation envelope.
    let manifestValue = null;
    try {
        manifestValue = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8'));
    }
    catch {
        manifestValue = null; // missing/unreadable manifest: durable channel unavailable
    }
    if (manifestValue !== null && typeof manifestValue === 'object') {
        const manifestRunId = typeof manifestValue['runId'] === 'string' && manifestValue['runId'].length > 0
            ? manifestValue['runId']
            : null;
        const durable = manifestValue['attestation'];
        if (durable !== undefined) {
            durablePresent = true;
            const result = validateEnvelope(durable, manifestRunId, 'durable');
            if ('envelope' in result) {
                validEnvelopes.push(result.envelope);
            }
            else {
                durableRejection = result.rejection;
                durableDetail = result.detail;
            }
        }
        else if (Array.isArray(manifestValue['recordIds']) &&
            typeof manifestValue['recordIdsMac'] === 'string') {
            // Old-format evidence only: a legacy v1 MAC, even verifying, never
            // authorizes. Distinguished from "missing" so migration is explicit.
            durablePresent = true;
            legacyOnly = true;
            durableRejection = 'malformed';
            durableDetail =
                'durable evidence uses the legacy v1 recordIdsMac format, which never authorizes ' +
                    'evidence (it binds no input snapshot); run a fresh test-gates run for a v2 attestation';
        }
    }
    // Live channel: the verifier-authenticated v2 envelope, validated
    // independently — a valid live envelope is usable alone, and an
    // invalid durable envelope contributes nothing to it.
    let liveRejection = null;
    let liveDetail = null;
    if (auth.live !== undefined && auth.live !== null) {
        const result = validateEnvelope(auth.live, null, 'live');
        if ('envelope' in result) {
            validEnvelopes.push(result.envelope);
        }
        else {
            liveRejection = result.rejection;
            liveDetail = result.detail;
        }
    }
    // Explicit evidence-context blockers (visible even when no obligation
    // would otherwise need a record; never waived, never diff-scoped
    // away). Missing-vs-malformed stays distinguished. A run that changed
    // its own inputs reports the single generic blocker — per-envelope
    // details would only restate it.
    if (auth.changedInputs !== true) {
        if (durablePresent && durableRejection !== null && durableDetail !== null) {
            block(`evidence-context: ${durableDetail}`);
        }
        if (liveRejection !== null && liveDetail !== null && validEnvelopes.length === 0) {
            block(`evidence-context: ${liveDetail}`);
        }
    }
    if (witnessedCount > 0 && validEnvelopes.length === 0 && !durablePresent && auth.live == null) {
        if (verifierKey === null) {
            block('evidence-context: no witness verifier key; suite-writable artifacts alone cannot ' +
                'prove issuance and witnessed records demote (fail closed)');
        }
        else if (!legacyOnly) {
            block('evidence-context: no evidence attestation envelope found (missing); ' +
                'witnessed records demote (fail closed)');
        }
    }
    const demoted = records.map((record) => {
        if (typeof record !== 'object' || record === null)
            return record;
        const candidate = record;
        if (candidate['trust'] !== 'witnessed')
            return record;
        const proven = typeof candidate['recordId'] === 'string' &&
            issuedRecordId.test(candidate['recordId']) &&
            validEnvelopes.some((envelope) => candidate['runId'] === envelope.runId && envelope.recordIds.has(candidate['recordId']));
        return proven ? record : { ...record, trust: 'claimed' };
    });
    return { records: demoted, evidenceBlocking: evidenceBlocking };
}
//# sourceMappingURL=evaluate.js.map