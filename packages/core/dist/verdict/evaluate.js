/**
 * Verdict engine (Interface pin #9, ADR 0001 D1–D4): the pure evaluator
 * that turns one obligation plus its run evidence into one of the seven
 * verdicts.
 *
 * Contract (pin #9): `evaluateObligation(obligation, {claims, records,
 * waivers, classification, now}) → {verdict, reason, recordIds}` —
 * deterministic, no I/O, clock injected via `now`.
 *
 * Rules encoded here:
 * - `satisfied` requires a `ui.action` record matching the contract's
 *   operation PLUS a service-witnessed `persistence.*` record for the
 *   SAME entity that MEETS THE OPERATION'S POSTCONDITION (plan §5.3).
 *   Trust asymmetry (2026-08-31 audits): the UI action is suite-asserted
 *   — submitted through the run token, stamped claimed-tier at issuance
 *   — and only anchors the entity/operation. The satisfaction weight is
 *   the persistence record, whose contents the witness observed itself
 *   via the engine-side adapter read (`origin: 'engine-observed'`), and
 *   the engine grades that observation against the claimed operation
 *   with EXPECTATIONS THAT NEVER COME FROM THE SUITE (round 5):
 *   create ⇒ engine-observed absence before + presence after; update ⇒
 *   an engine-observed before/after field delta; read ⇒ presence;
 *   delete ⇒ absent (hard) or matching the classification's
 *   owner-declared `archiveFields` (archive). UI-semantic `crud:`
 *   contracts FAIL CLOSED — no witness-controlled UI observation
 *   channel exists — as do contracts outside the persistence namespace.
 *   Fabricated persistence records demote to claimed and can never
 *   satisfy (D2, GF-23).
 * - Records whose provenance does not verify — a recordId that does not
 *   recompute from the record's own contents (sha256 over the canonical
 *   identity) — are demoted to `claimed` regardless of their `trust`
 *   field (pin #7, GF-23).
 * - Same-entity enforcement (invariant 3): every satisfying record carries
 *   an `entityId` equal to the UI action's entity. Composite identity is a
 *   column-keyed object whose keys are exactly the `primaryKey` columns
 *   (D3); single-column resources require a scalar id.
 * - Internal resources carry no CRUD obligations; their claims are invalid
 *   (ADR 0001, matching the policy engine's claim assessment).
 * - Unclassified resources block as `unclassified` (invariant 1).
 *   Unresolved resources never reach this evaluator: they generate no
 *   obligations — the policy engine emits blocking entries for them.
 * - A waiver matching the exact (resourceId, fingerprint) pair that is
 *   unexpired yields `waived`; an expired waiver yields `invalid` (D4);
 *   a waiver whose owner is stale yields `stale` (GF-17).
 */
import { z } from 'zod';
import { registerContractVerifier, verifierFor } from './registry.js';
import { registerPackVerifiers } from './pack-verifiers.js';
import { canonicalJson } from '../canonical-json.js';
import { fingerprint } from '../fingerprints.js';
import { compareStrings } from '../graph/util.js';
import { isProvenancedRecord } from '../provenance.js';
import { ClassificationSchema } from '../schemas/classification.js';
import { ClaimSchema } from '../schemas/claim.js';
import { ObligationSchema } from '../schemas/obligation.js';
import { WaiverSchema } from '../schemas/waiver.js';
import { CRUD_CONTRACT_PREFIX, PERSISTENCE_CONTRACT_PREFIX } from '../policy/index.js';
/** Evidence kinds the built-in CRUD contract speaks (plan §5.3). */
const UI_ACTION_KIND = 'ui.action';
const UI_VISIBLE_KIND = 'ui.visible-result';
const PERSISTENCE_KIND_PREFIX = 'persistence.';
/** Verdicts that block a run (exit code 1). Clean: satisfied, waived. */
export const BLOCKING_VERDICTS = [
    'missing',
    'invalid',
    'unclassified',
    'unresolved',
    'stale',
];
/**
 * Fail-closed verdict-engine error: raised only for engine-internal
 * contract violations (malformed obligation, invalid `now`) — never for
 * adversary-controlled evidence, which must degrade to a verdict.
 */
export class GateforgeVerdictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GateforgeVerdictError';
    }
}
/**
 * Normalizes the injected clock to a Date. Accepts Date or ISO-8601
 * string; anything else is an engine-internal contract violation.
 *
 * Args:
 *   now: the injected clock instant.
 *
 * Returns:
 *   Date: the parsed instant.
 *
 * Throws:
 *   GateforgeVerdictError: when `now` is not a valid ISO-8601 instant.
 */
export function parseInstant(now) {
    if (now instanceof Date) {
        if (Number.isNaN(now.getTime())) {
            throw new GateforgeVerdictError('now: invalid Date (NaN time)');
        }
        return now;
    }
    const parsed = z.iso.datetime().safeParse(now);
    if (!parsed.success) {
        throw new GateforgeVerdictError(`now: expected an ISO-8601 instant, got ${JSON.stringify(now)}`);
    }
    return new Date(parsed.data);
}
/**
 * Reads one evidence entry into the lenient view; non-objects are
 * ignored (a hostile reporter may emit anything).
 */
function asRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const record = value;
    return {
        recordId: record['recordId'],
        runId: record['runId'],
        trust: record['trust'],
        obligationId: record['obligationId'],
        testId: record['testId'],
        kind: record['kind'],
        origin: record['origin'],
        payload: record['payload'],
    };
}
/**
 * Derives the trust tier of a record (D2 + pin #7): `witnessed` only when
 * the record asserts the witnessed tier AND its provenance verifies —
 * the 64-hex recordId must recompute from the record's own contents
 * (`sha256` over the canonical identity; pin #1). Everything else is
 * claimed-tier: GF-23 fabricated bundles and transplanted-but-never-
 * issued ids demote here. Issuance membership (the recordId appearing
 * in the witness-issued manifest set) is enforced separately by the
 * CLI's provenance gate, which owns the run manifest.
 */
function trustOf(record) {
    return record.trust === 'witnessed' && isProvenancedRecord(record) ? 'witnessed' : 'claimed';
}
/**
 * Stable label for a record in reasons, provenance-aware: unprovenanced
 * records (the interesting adversarial case) label themselves as such.
 * Shared by every record-citing reason so test assertions stay in
 * lockstep with emitted text.
 */
function labelOf(record) {
    return typeof record.recordId === 'string' && record.recordId.length > 0
        ? record.recordId
        : '<unprovenanced>';
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPrimitive(value) {
    if (typeof value === 'number')
        return Number.isFinite(value);
    return typeof value === 'string' || typeof value === 'boolean';
}
function isJsonValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (isPlainObject(value))
        return Object.values(value).every(isJsonValue);
    return false;
}
/**
 * Extracts the operation a persistence-level contract requires
 * (`persistence:update` → `update`); null for anything else.
 *
 * Dispatch (audit round 5):
 * - `persistence:<op>` — UI-independent CRUD, graded on the witness's
 *   own engine-side observations with owner/classification-owned
 *   expectations;
 * - `crud:<op>` — UI-SEMANTIC: satisfaction would require observing the
 *   UI itself, and no witness-controlled UI observation channel exists
 *   (the suite owns the browser), so these FAIL CLOSED;
 * - everything else — no semantic verifier registered, fail closed.
 */
function persistenceOperation(contract) {
    if (!contract.startsWith(PERSISTENCE_CONTRACT_PREFIX))
        return null;
    const operation = contract.slice(PERSISTENCE_CONTRACT_PREFIX.length);
    if (operation === 'create' || operation === 'read' || operation === 'update' || operation === 'delete') {
        return operation;
    }
    return null;
}
/** The payload of a record when it is a plain object, else undefined. */
function payloadOf(record) {
    return isPlainObject(record.payload) ? record.payload : undefined;
}
/**
 * Deduplicates string ids into a sorted array without Set: string-keyed
 * membership uses a Record lookup so the seen-table serializes and
 * diffs like any other literal object.
 */
function sortedUnique(ids) {
    const seen = {};
    const unique = [];
    for (const id of ids) {
        if (id.length === 0 || id in seen)
            continue;
        seen[id] = true;
        unique.push(id);
    }
    return unique.sort(compareStrings);
}
/**
 * Validates an entityId against the classification's primaryKey (D3) and
 * returns its canonical comparable form. Single-column resources require
 * a scalar id; composite resources require a column-keyed object whose
 * key set is exactly the primaryKey columns with primitive values.
 * Missing or unknown key parts are checkable violations (ADR 0001 D3).
 *
 * Args:
 *   entityId: the raw entityId from a record payload.
 *   primaryKey: the ordered primary-key columns of the classification.
 *
 * Returns:
 *   {ok: true, key} when valid — `key` is the canonical JSON used for
 *   equality comparison and reasons; {ok: false, detail} otherwise.
 */
function normalizeEntityId(entityId, primaryKey) {
    if (primaryKey.length === 1) {
        if (!isPrimitive(entityId)) {
            return {
                ok: false,
                detail: isPlainObject(entityId) || Array.isArray(entityId)
                    ? `scalar entityId is required for single-column primary key '${primaryKey[0]}' (composite identity is column-keyed per ADR 0001 D3)`
                    : 'entityId must be a string/number/boolean scalar',
            };
        }
        if (typeof entityId === 'string' && entityId.length === 0) {
            return { ok: false, detail: 'entityId must not be empty' };
        }
        return { ok: true, key: canonicalJson(entityId) };
    }
    if (!isPlainObject(entityId)) {
        return {
            ok: false,
            detail: `composite entityId must be a column-keyed object with keys ` +
                `[${primaryKey.join(', ')}] (ADR 0001 D3)`,
        };
    }
    const keys = Object.keys(entityId);
    const missing = primaryKey.filter((column) => !keys.includes(column));
    if (missing.length > 0) {
        return { ok: false, detail: `entityId is missing key parts: [${missing.join(', ')}]` };
    }
    const unknownKeys = keys.filter((key) => !primaryKey.includes(key));
    if (unknownKeys.length > 0) {
        return {
            ok: false,
            detail: `entityId carries unknown key parts: [${unknownKeys.sort().join(', ')}]`,
        };
    }
    for (const column of primaryKey) {
        if (!isPrimitive(entityId[column])) {
            return {
                ok: false,
                detail: `entityId column '${column}' must be a string/number/boolean primitive`,
            };
        }
    }
    return { ok: true, key: canonicalJson(entityId) };
}
/**
 * When both visible and persisted field maps are present, verifies that
 * every shared key agrees (plan §5.3: visible and persisted fields must
 * agree). Returns the first disagreement description, or null.
 */
function fieldsDisagreement(visible, persisted) {
    if (!isPlainObject(visible) || !isPlainObject(persisted))
        return null;
    const shared = Object.keys(visible).filter((key) => key in persisted);
    for (const key of shared) {
        const a = visible[key];
        const b = persisted[key];
        if (!isJsonValue(a) || !isJsonValue(b))
            continue;
        if (canonicalJson(a) !== canonicalJson(b)) {
            return `'${key}': visible ${canonicalJson(a)} vs persisted ${canonicalJson(b)}`;
        }
    }
    return null;
}
/**
 * Compares owner-declared expected field values against the
 * engine-observed persisted fields: every expected key must exist and
 * agree (canonical-JSON equality). Returns the first mismatch
 * description, or null. The EXPECTATIONS come from the classification
 * (owner-owned) — never from the tested suite (audit round 5).
 */
function declaredFieldsMatchFailure(expected, observed, what) {
    if (!isPlainObject(expected) || Object.keys(expected).length === 0) {
        return `${what} postcondition cannot be evaluated: the classification declares no expected fields`;
    }
    if (!isPlainObject(observed)) {
        return `${what} postcondition violated: the engine observed no persisted fields`;
    }
    for (const key of Object.keys(expected).sort()) {
        const expectedValue = expected[key];
        if (!isJsonValue(expectedValue))
            continue;
        const observedValue = observed[key];
        if (!isJsonValue(observedValue) || canonicalJson(expectedValue) !== canonicalJson(observedValue)) {
            return (`${what} postcondition violated: persisted fields do not match the classification-declared ` +
                `state on '${key}' (expected ${canonicalJson(expectedValue)}, persisted ` +
                `${isJsonValue(observedValue) ? canonicalJson(observedValue) : '<none>'})`);
        }
    }
    return null;
}
/**
 * The operation-specific postcondition a witnessed persistence record
 * must meet for the claim to be satisfiable. Every EXPECTATION is
 * owner-owned (classification) or engine-observed (pre-observation
 * delta) — never suite-supplied (audit round 5):
 * - create: the engine observed the entity ABSENT before (a witness
 *   id-set pre-observation bound to this read) and PRESENT after.
 * - update: a witness entity pre-observation exists, and the engine
 *   observed an actual field delta between it and the post-action read.
 * - read: the entity is present in the engine-observed state.
 * - delete: hard delete ⇒ entity absent; archive ⇒ entity present and
 *   matching the classification's `archiveFields`.
 *
 * Returns:
 *   string | null: the first postcondition failure, or null when met.
 */
function persistencePostconditionFailure(obligation, record, actionEntityKey) {
    const payload = payloadOf(record);
    if (payload === undefined) {
        return `persistence record '${labelOf(record)}' carries no payload to evaluate`;
    }
    if (typeof payload['found'] !== 'boolean') {
        return (`persistence record '${labelOf(record)}' carries no engine-observed presence ` +
            `observation ('found'), so the '${obligation.contract}' postcondition cannot be evaluated`);
    }
    const found = payload['found'];
    const operation = obligation.contract.slice(PERSISTENCE_CONTRACT_PREFIX.length);
    const before = payload['before'];
    if (operation === 'create') {
        if (!isPlainObject(before) || before['entityAbsent'] !== true) {
            return 'create postcondition violated: no engine-observed pre-observation shows the entity absent before the action';
        }
        if (!found) {
            return 'create postcondition violated: entity still absent after the action';
        }
        return null;
    }
    if (operation === 'update') {
        if (!isPlainObject(before) ||
            before['found'] !== true ||
            !isPlainObject(before['fields'])) {
            return 'update postcondition violated: no engine-observed before-state (a witness pre-observation of the entity is required)';
        }
        if (!found) {
            return 'update postcondition violated: entity absent after the action';
        }
        // Owner-owned relevance (audit round 6): the delta must touch at
        // least one classification-declared updateable field. Bookkeeping
        // columns (e.g. `updated_at`) drifting on an untouched entity can
        // never satisfy.
        const updateable = obligation.lifecycle.updateableFields;
        if (!Array.isArray(updateable) || updateable.length === 0) {
            return 'update postcondition cannot be evaluated: the classification declares no updateableFields';
        }
        if (!isPlainObject(payload['fields'])) {
            return 'update postcondition violated: the engine observed no persisted fields';
        }
        const delta = [];
        const after = payload['fields'];
        const beforeFields = before['fields'];
        for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(after)])) {
            const beforeValue = beforeFields[key];
            const afterValue = after[key];
            if (!isJsonValue(beforeValue) || !isJsonValue(afterValue))
                continue;
            if (canonicalJson(beforeValue) !== canonicalJson(afterValue))
                delta.push(key);
        }
        const qualifying = delta.filter((key) => updateable.includes(key));
        if (qualifying.length === 0) {
            return ('update postcondition violated: the engine-observed delta ' +
                `[${[...delta].sort().join(', ')}] touches no classification-declared ` +
                `updateable field (updateableFields: [${[...updateable].sort().join(', ')}])`);
        }
        return null;
    }
    if (operation === 'read') {
        if (!found) {
            return 'read postcondition violated: entity absent';
        }
        return null;
    }
    if (operation === 'delete') {
        if (obligation.lifecycle.deleteSemantics === 'archive') {
            if (!found) {
                return 'archive postcondition violated: entity absent (archived entities stay present)';
            }
            return declaredFieldsMatchFailure(obligation.lifecycle.archiveFields, payload['fields'], 'archive');
        }
        if (found) {
            return 'delete postcondition violated: entity still present after a hard delete';
        }
        return null;
    }
    return null;
}
/**
 * Evaluates one claim's evidence against the obligation's contract:
 * a ui.action (any tier — suite-asserted) matching the operation →
 * entityId extraction and D3 validation → a WITNESSED (engine-observed)
 * persistence.* record for the same entity meeting the operation's
 * postcondition.
 *
 * Dispatch (audit round 5):
 * - `crud:<op>` — UI-SEMANTIC, FAIL-CLOSED: no witness-controlled UI
 *   observation channel exists (the suite owns the browser), so a
 *   claimed UI action can never be verified. These contracts stay
 *   blocking `missing`; persistence-level `persistence:<op>` contracts
 *   are the gradable surface.
 * - `persistence:<op>` — graded on the witness's own observations with
 *   OWNER-owned expectations (classification `archiveFields`) and
 *   engine-observed before/after deltas. The tested suite never supplies
 *   expectations.
 * - everything else — no semantic verifier registered, fail closed.
 */
/**
 * Per-claim dispatch (ADR 0004 D8, plan phase 5): every contract
 * namespace is graded by exactly one registered semantic verifier;
 * unknown namespaces stay fail-closed blocking. The built-in
 * persistence/crud grader keeps its historical behavior verbatim.
 */
function evaluateClaimEvidence(claim, evidence, obligation, primaryKey) {
    const verifier = verifierFor(obligation.contract);
    if (verifier === null) {
        return {
            status: 'missing',
            reason: `no semantic verifier is registered for contract '${obligation.contract}'; the generic ` +
                `CRUD evidence rule does not apply to non-persistence contracts, so '${obligation.id}' stays ` +
                'blocking until its pack-specific verifier grades the evidence',
        };
    }
    return verifier({ claim, obligation, evidence, primaryKey });
}
// Built-in registrations: persistence/crud semantics stay owned by this
// module; pack namespaces register through './pack-verifiers.js'.
registerContractVerifier('crud', (input) => persistenceClaimVerifier(input.claim, input.evidence, input.obligation, input.primaryKey));
registerContractVerifier('persistence', (input) => persistenceClaimVerifier(input.claim, input.evidence, input.obligation, input.primaryKey));
registerPackVerifiers();
/** The built-in persistence/crud grader (behavior kept verbatim). */
function persistenceClaimVerifier(claim, evidence, obligation, primaryKey) {
    // UI-semantic CRUD: fail closed — the suite owns the browser, so a
    // claimed UI action can never be independently observed (round 5).
    if (obligation.contract.startsWith(CRUD_CONTRACT_PREFIX)) {
        return {
            status: 'missing',
            reason: `no witness-controlled UI observation channel exists, so the UI-semantic contract ` +
                `'${obligation.contract}' cannot be verified; use the persistence-level ` +
                `'${PERSISTENCE_CONTRACT_PREFIX}<operation>' contract (graded on engine-observed state)`,
        };
    }
    const requiredOp = persistenceOperation(obligation.contract);
    if (requiredOp === null) {
        return {
            status: 'missing',
            reason: `no semantic verifier is registered for contract '${obligation.contract}'; the generic ` +
                `CRUD evidence rule does not apply to non-persistence contracts, so '${obligation.id}' stays ` +
                'blocking until its pack-specific verifier grades the evidence',
        };
    }
    if (evidence.length === 0) {
        return {
            status: 'missing',
            reason: `claim '${claim.testId}' declares '${obligation.id}' but produced no evidence records`,
        };
    }
    // Requirement 1: a ui.action anchoring the entity. The action itself
    // is SUITE-ASSERTED (submitted through the run token; the witness
    // stamps such records claimed-tier at issuance — GF-23 round 3), so
    // any tier anchors — but ONLY records whose provenance verifies:
    // witness-stamped claimed records carry a consistent hash, fabricated
    // ones do not. Satisfaction weight lives in requirement 2, the
    // engine-observed persistence read.
    const actions = evidence.filter((entry) => entry.record.kind === UI_ACTION_KIND);
    const matchingAction = actions.find((entry) => isProvenancedRecord(entry.record) &&
        payloadOf(entry.record)?.['operation'] === requiredOp);
    if (matchingAction === undefined) {
        if (actions.length === 0) {
            return {
                status: 'missing',
                reason: `no '${UI_ACTION_KIND}' evidence for '${obligation.id}'`,
            };
        }
        const fabricated = actions.find((entry) => !isProvenancedRecord(entry.record));
        if (fabricated !== undefined) {
            return {
                status: 'invalid',
                reason: `claimed-tier '${UI_ACTION_KIND}' record '${labelOf(fabricated.record)}' cannot ` +
                    `satisfy '${obligation.contract}': only service-witnessed evidence satisfies (GF-23)`,
            };
        }
        const wrongOp = actions.find((entry) => payloadOf(entry.record)?.['operation'] !== requiredOp);
        if (wrongOp !== undefined) {
            const got = String(payloadOf(wrongOp.record)?.['operation'] ?? '<none>');
            return {
                status: 'invalid',
                reason: `'${UI_ACTION_KIND}' record '${labelOf(wrongOp.record)}' has operation ` +
                    `'${got}' but '${obligation.contract}' requires '${requiredOp}'`,
            };
        }
        return {
            status: 'missing',
            reason: `no admissible '${UI_ACTION_KIND}' evidence for '${obligation.id}'`,
        };
    }
    const actionPayload = payloadOf(matchingAction.record);
    if (actionPayload?.['entityId'] === undefined) {
        return {
            status: 'invalid',
            reason: `'${UI_ACTION_KIND}' record '${labelOf(matchingAction.record)}' carries no entityId; ` +
                'same-entity enforcement (invariant 3) is impossible without it',
        };
    }
    const actionEntity = normalizeEntityId(actionPayload['entityId'], primaryKey);
    if (!actionEntity.ok) {
        return {
            status: 'invalid',
            reason: `'${UI_ACTION_KIND}' record '${labelOf(matchingAction.record)}': ${actionEntity.detail}; ` +
                'same-entity enforcement (invariant 3) is impossible without it',
        };
    }
    // Requirement 2: a WITNESSED persistence record for the same entity
    // whose contents the witness observed engine-side (origin
    // 'engine-observed'), AND whose observed state satisfies the
    // operation's postcondition (2026-08-31 audit round 4): presence
    // alone proves nothing — a claimed delete of a live entity or a
    // "read" nobody ever saw must not satisfy.
    const persistence = evidence.filter((entry) => typeof entry.record.kind === 'string' &&
        entry.record.kind.startsWith(PERSISTENCE_KIND_PREFIX));
    const witnessedPersistence = persistence.filter((entry) => entry.trust === 'witnessed');
    const sameEntity = witnessedPersistence.filter((entry) => {
        const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
        return entity.ok && entity.key === actionEntity.key;
    });
    if (sameEntity.length === 0) {
        const claimedPersistence = persistence.find((entry) => entry.trust === 'claimed');
        if (claimedPersistence !== undefined) {
            return {
                status: 'invalid',
                reason: `claimed-tier '${String(claimedPersistence.record.kind)}' record ` +
                    `'${labelOf(claimedPersistence.record)}' cannot satisfy '${obligation.contract}': ` +
                    'only service-witnessed evidence satisfies (GF-23)',
            };
        }
        const mismatched = witnessedPersistence.find((entry) => {
            const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
            return !entity.ok || entity.key !== actionEntity.key;
        });
        if (mismatched !== undefined) {
            const entity = normalizeEntityId(payloadOf(mismatched.record)?.['entityId'], primaryKey);
            const target = entity.ok ? entity.key : entity.detail;
            return {
                status: 'invalid',
                reason: `same-entity violation: persistence record '${labelOf(mismatched.record)}' targets ` +
                    `entity ${target} but the '${UI_ACTION_KIND}' targeted ${actionEntity.key}`,
            };
        }
        return {
            status: 'missing',
            reason: `no witnessed '${PERSISTENCE_KIND_PREFIX}*' record for entity ${actionEntity.key} ` +
                `of '${obligation.id}'`,
        };
    }
    // At least one same-entity witnessed record must meet the operation's
    // postcondition; otherwise the first failure explains the block.
    let firstPostconditionFailure = null;
    let matchingPersistence;
    for (const entry of sameEntity) {
        const failure = persistencePostconditionFailure(obligation, entry.record, actionEntity.key);
        if (failure === null) {
            matchingPersistence = entry;
            break;
        }
        if (firstPostconditionFailure === null)
            firstPostconditionFailure = failure;
    }
    if (matchingPersistence === undefined) {
        return {
            status: 'invalid',
            reason: `${firstPostconditionFailure ?? `no witnessed '${PERSISTENCE_KIND_PREFIX}*' record meets ` +
                `the '${obligation.contract}' postcondition`} (obligation '${obligation.id}')`,
        };
    }
    // Consistency hardening: visible vs persisted fields must agree when a
    // visible-result record for the same entity exists (any tier — the
    // visible side is suite-asserted, so disagreement with the
    // engine-observed persisted fields is a fabrication signal).
    const visible = evidence.find((entry) => {
        if (entry.record.kind !== UI_VISIBLE_KIND)
            return false;
        const entity = normalizeEntityId(payloadOf(entry.record)?.['entityId'], primaryKey);
        return entity.ok && entity.key === actionEntity.key;
    });
    if (visible !== undefined) {
        const disagreement = fieldsDisagreement(payloadOf(visible.record)?.['fields'], payloadOf(matchingPersistence.record)?.['fields']);
        if (disagreement !== null) {
            return {
                status: 'invalid',
                reason: `visible and persisted fields disagree on ${disagreement} ` +
                    `(obligation '${obligation.id}')`,
            };
        }
    }
    const used = [
        matchingAction.record,
        matchingPersistence.record,
        ...(visible !== undefined ? [visible.record] : []),
    ]
        .map((record) => (typeof record.recordId === 'string' ? record.recordId : ''));
    return { status: 'satisfied', recordIds: sortedUnique(used) };
}
/**
 * Evaluates ONE obligation against the run's claims, records, waivers,
 * classification, and injected clock (pin #9). Pure and deterministic:
 * identical inputs produce identical outcomes.
 *
 * Args:
 *   obligation: the obligation under evaluation (validated schema shape).
 *   context: claims, records, waivers, classification, and `now`.
 *
 * Returns:
 *   VerdictOutcome: {verdict, reason, recordIds} — reason is null only
 *   for `satisfied`; recordIds is always a sorted array.
 *
 * Throws:
 *   GateforgeVerdictError: when the obligation or `now` violates the
 *   engine-internal contract (evidence problems NEVER throw — they
 *   produce `invalid`/`missing` verdicts).
 */
export function evaluateObligation(obligation, context) {
    const parsedObligation = ObligationSchema.safeParse(obligation);
    if (!parsedObligation.success) {
        throw new GateforgeVerdictError(`obligation failed schema validation: ${parsedObligation.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`);
    }
    const verified = parsedObligation.data;
    const now = parseInstant(context.now);
    // 1. Unclassified resources block (invariant 1); unresolved resources
    //    never reach this evaluator (the policy engine emits blocking
    //    entries because they cannot carry obligations).
    if (context.classification === null || context.classification === undefined) {
        return {
            verdict: 'unclassified',
            reason: `resource '${verified.resourceId}' has no classification; obligations cannot bind ` +
                'evidence until it is classified (invariant 1)',
            recordIds: [],
        };
    }
    const parsedClassification = ClassificationSchema.safeParse(context.classification);
    if (!parsedClassification.success) {
        return {
            verdict: 'unclassified',
            reason: `classification for resource '${verified.resourceId}' failed validation: ` +
                `${parsedClassification.error.issues
                    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                    .join('; ')}`,
            recordIds: [],
        };
    }
    const classification = parsedClassification.data;
    // 2. Internal resources carry no CRUD obligations; their claims are
    //    invalid (ADR 0001, matching the policy engine's convention).
    if (classification.exposure === 'internal') {
        return {
            verdict: 'invalid',
            reason: `resource '${verified.resourceId}' is internal; internal resources carry no CRUD ` +
                'obligations and their claims are invalid (ADR 0001)',
            recordIds: [],
        };
    }
    // 3. Waivers: exact (resourceId, fingerprint) scope only (D4).
    //    Precedence: unexpired non-stale → waived; expired → invalid (D4);
    //    stale owner → stale (GF-17). Sorted for determinism.
    const fp = fingerprint({
        resourceId: verified.resourceId,
        contract: verified.contract,
        policyId: verified.policyId,
        lifecycle: verified.lifecycle,
    });
    const matching = context.waivers
        .map((entry) => {
        // Strip the engine-only flag before strict validation; a waiver
        // entry the schema rejects can never match exactly, so it degrades.
        const { ownerStale, ...plain } = entry;
        const parsed = WaiverSchema.safeParse(plain);
        return parsed.success ? { ownerStale: Boolean(ownerStale), waiver: parsed.data } : null;
    })
        .filter((entry) => entry !== null)
        .filter(({ waiver }) => waiver.scope.kind === 'exact' &&
        waiver.scope.resourceId === verified.resourceId &&
        waiver.scope.fingerprint === fp)
        .sort((a, b) => compareStrings(`${a.waiver.expiresAt}\u0000${a.waiver.owner}`, `${b.waiver.expiresAt}\u0000${b.waiver.owner}`));
    const unexpired = matching.filter((entry) => now.getTime() < Date.parse(entry.waiver.expiresAt) && !entry.ownerStale);
    if (unexpired.length > 0 && unexpired[0] !== undefined) {
        const waiver = unexpired[0].waiver;
        return {
            verdict: 'waived',
            reason: `waived by '${waiver.owner}' until '${waiver.expiresAt}' ` +
                `(approver '${waiver.approver}', ${waiver.justificationUrl})`,
            recordIds: [],
        };
    }
    const expired = matching.filter((entry) => now.getTime() >= Date.parse(entry.waiver.expiresAt) && !entry.ownerStale);
    if (expired.length > 0 && expired[0] !== undefined) {
        const waiver = expired[0].waiver;
        return {
            verdict: 'invalid',
            reason: `waiver by '${waiver.owner}' expired at '${waiver.expiresAt}'; expired waivers block ` +
                `as 'invalid' (ADR 0001 D4), obligation '${verified.id}'`,
            recordIds: [],
        };
    }
    const staleOwner = matching.find((entry) => entry.ownerStale);
    if (staleOwner !== undefined) {
        return {
            verdict: 'stale',
            reason: `waiver owner '${staleOwner.waiver.owner}' is stale (owner check failed); renewal with a new ` +
                `review is required (GF-17), obligation '${verified.id}'`,
            recordIds: [],
        };
    }
    // 4. Claims on this obligation, deterministically ordered.
    const claims = context.claims
        .map((claim) => ClaimSchema.safeParse(claim))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data)
        .filter((claim) => claim.obligationId === verified.id)
        .sort((a, b) => compareStrings(a.testId, b.testId));
    if (claims.length === 0) {
        return {
            verdict: 'missing',
            reason: `no claim declares '${verified.id}'`,
            recordIds: [],
        };
    }
    // 5. Records attributed to this obligation (lenient view). Records are
    //    bound to a claim via the witness-issued testId; unattributable
    //    records cannot satisfy anything.
    const considered = (Array.isArray(context.records) ? context.records : [])
        .map(asRecord)
        .filter((record) => record !== null)
        .filter((record) => record.obligationId === verified.id);
    const consideredIds = sortedUnique(considered.map((record) => (typeof record.recordId === 'string' ? record.recordId : '')));
    // 6. Per-claim evidence evaluation with deterministic aggregation:
    //    satisfied beats invalid beats missing.
    let firstInvalid = null;
    let firstMissing = null;
    for (const claim of claims) {
        const evidence = considered
            .filter((record) => record.testId === claim.testId)
            .map((record) => ({ record, trust: trustOf(record) }));
        const outcome = evaluateClaimEvidence(claim, evidence, verified, classification.primaryKey);
        if (outcome.status === 'satisfied') {
            return { verdict: 'satisfied', reason: null, recordIds: outcome.recordIds };
        }
        if (outcome.status === 'invalid' && firstInvalid === null) {
            firstInvalid = outcome.reason;
        }
        if (outcome.status === 'missing' && firstMissing === null) {
            firstMissing = outcome.reason;
        }
    }
    if (firstInvalid !== null) {
        return { verdict: 'invalid', reason: firstInvalid, recordIds: consideredIds };
    }
    return {
        verdict: 'missing',
        reason: firstMissing ?? `no admissible evidence for '${verified.id}'`,
        recordIds: consideredIds,
    };
}
/**
 * Evaluates a batch of obligations against one context and returns
 * report-ready entries sorted by obligation id, each enriched with the
 * highest trust tier among its records (SARIF properties) and optional
 * detector provenance passthrough.
 *
 * Args:
 *   obligations: obligations to evaluate.
 *   context: the shared pin-#9 evaluation context.
 *
 * Returns:
 *   ObligationVerdict[]: sorted by obligation id; deterministic.
 */
export function evaluateObligations(obligations, context) {
    parseInstant(context.now);
    return obligations
        .map((obligation) => {
        const outcome = evaluateObligation(obligation, context);
        const records = (Array.isArray(context.records) ? context.records : [])
            .map(asRecord)
            .filter((record) => record !== null)
            .filter((record) => record.obligationId === obligation.id);
        const trustTier = records.some((record) => trustOf(record) === 'witnessed')
            ? 'witnessed'
            : records.length > 0
                ? 'claimed'
                : null;
        return { obligation, ...outcome, trustTier };
    })
        .sort((a, b) => compareStrings(a.obligation.id, b.obligation.id));
}
//# sourceMappingURL=evaluate.js.map