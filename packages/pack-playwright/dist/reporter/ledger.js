/**
 * Reporter ledger computation (pure helpers).
 *
 * Per-claim verdicts are computed with the REAL verdict engine
 * (`evaluateObligation`, G3 pin #9) — the reporter never trusts a test's
 * own conclusion. Per-claim isolation: each row evaluates exactly that
 * test's claim against the run's witness ledger; the engine attributes
 * records by (obligationId, testId), so a claim cannot borrow another
 * test's evidence.
 *
 * The ledger needs the run's obligations (from `GATEFORGE_OBLIGATIONS`)
 * and each resource's classification (primaryKey etc.) from the witness
 * (`GET /classifications`). When either is unavailable the row carries
 * `verdict: null` and the reason says exactly what is missing.
 */
import { evaluateObligation, isWitnessedRecord, } from '@gateforge/core';
/** Load a valid claim-shaped object from the annotation source. */
export function claimOf(obligationId, test) {
    const location = test.location === undefined || test.location === null
        ? null
        : { file: test.location.file, line: test.location.line, col: test.location.column };
    return {
        obligationId,
        testId: test.id,
        testFile: location === null ? '' : location.file,
        location,
    };
}
/** Plain-object guard for lenient state parsing. */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Reads a lifecycle object leniently (absent booleans → false). */
function lifecycleOf(value) {
    if (typeof value !== 'object' || value === null) {
        return { create: false, read: false, update: false, delete: false };
    }
    const entry = value;
    return {
        create: entry['create'] === true,
        read: entry['read'] === true,
        update: entry['update'] === true,
        delete: entry['delete'] === true,
        ...(entry['deleteSemantics'] === 'hard' || entry['deleteSemantics'] === 'archive'
            ? { deleteSemantics: entry['deleteSemantics'] }
            : {}),
        ...(isPlainObject(entry['archiveFields'])
            ? { archiveFields: entry['archiveFields'] }
            : {}),
        ...(Array.isArray(entry['updateableFields'])
            ? { updateableFields: entry['updateableFields'].filter((f) => typeof f === 'string') }
            : {}),
    };
}
/** Parses the obligations document (fail-lenient: missing → null). */
export function parseObligationsDocument(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const entry = parsed;
        if (!Array.isArray(entry['obligations']))
            return null;
        const obligations = entry['obligations'].flatMap((item) => {
            if (typeof item !== 'object' || item === null)
                return [];
            const candidate = item;
            if (typeof candidate['id'] !== 'string' || typeof candidate['contract'] !== 'string') {
                return [];
            }
            return [
                {
                    id: candidate['id'],
                    resourceId: typeof candidate['resourceId'] === 'string' ? candidate['resourceId'] : '',
                    contract: candidate['contract'],
                    policyId: typeof candidate['policyId'] === 'string' ? candidate['policyId'] : '',
                    lifecycle: lifecycleOf(candidate['lifecycle']),
                    fingerprint: typeof candidate['fingerprint'] === 'string' ? candidate['fingerprint'] : '',
                    source: typeof candidate['source'] === 'string' ? candidate['source'] : '',
                    location: typeof candidate['location'] === 'object' && candidate['location'] !== null
                        ? candidate['location']
                        : null,
                },
            ];
        });
        return { schemaVersion: 1, obligations };
    }
    catch {
        return null;
    }
}
/**
 * Computes one ledger row for a claim.
 *
 * Args:
 *   claim: the claim under judgment.
 *   obligations: the run's obligations (state doc).
 *   classifications: per-resource classification map (witness surface).
 *   records: the full run ledger.
 *   now: injected instant for the verdict engine.
 *
 * Returns:
 *   LedgerRow: verdict + reason + considered record ids. `verdict:
 *   null` (with reason) when required context is missing.
 */
export function ledgerRowFor(claim, obligations, classifications, records, now) {
    if (obligations === null) {
        return {
            claim: claim.obligationId,
            testId: claim.testId,
            testFile: claim.testFile,
            verdict: null,
            reason: 'obligations document unavailable; per-claim verdicts need the run obligations',
            recordIds: [],
            trustTier: null,
        };
    }
    const obligation = obligations.obligations.find((entry) => entry.id === claim.obligationId);
    if (obligation === undefined) {
        return {
            claim: claim.obligationId,
            testId: claim.testId,
            testFile: claim.testFile,
            verdict: null,
            reason: `claim references '${claim.obligationId}' which is not in the run's obligations`,
            recordIds: [],
            trustTier: null,
        };
    }
    const classification = classifications[obligation.resourceId] ?? null;
    const engineObligation = {
        schemaVersion: 1,
        id: obligation.id,
        resourceId: obligation.resourceId,
        contract: obligation.contract,
        policyId: obligation.policyId,
        lifecycle: obligation.lifecycle,
    };
    const outcome = evaluateObligation(engineObligation, {
        claims: [
            {
                schemaVersion: 1,
                obligationId: claim.obligationId,
                testId: claim.testId,
                // ClaimSchema requires a non-empty optional testFile: an absent
                // location must omit the field entirely (an emitted '' made the
                // strict schema drop the whole claim — honest evidence then
                // graded `missing`).
                ...(claim.testFile === '' ? {} : { testFile: claim.testFile }),
                ...(claim.location === null ? {} : { location: claim.location }),
            },
        ],
        records: records,
        waivers: [],
        classification,
        now,
    });
    const mine = records.filter((record) => record.testId === claim.testId);
    // Provenance-aware (GF-23): a record counts as witnessed only when its
    // recordId recomputes from its contents — the same predicate the
    // engine applies, so the display can never disagree with the verdict.
    const trustTier = mine.some((record) => isWitnessedRecord(record))
        ? 'witnessed'
        : mine.length > 0
            ? 'claimed'
            : null;
    return {
        claim: claim.obligationId,
        testId: claim.testId,
        testFile: claim.testFile,
        verdict: outcome.verdict,
        reason: outcome.reason,
        recordIds: outcome.recordIds,
        trustTier,
    };
}
/** Blocks the run? (satisfied/waived are clean.) */
export function isBlocking(verdict) {
    return (verdict !== null &&
        verdict !== 'satisfied' &&
        verdict !== 'waived');
}
//# sourceMappingURL=ledger.js.map