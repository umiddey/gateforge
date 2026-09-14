/**
 * The ONE mapping resolver (plan 2026-09-13 §5.3, Phase 3 item 1):
 * normalizes native annotation claims, sidecar declarations, prior-run
 * hints, and inference into a single resolved-mappings surface that the
 * grading seam and the suggestion surface both read.
 *
 * Hard rules encoded here (§5.2/§5.3):
 * - many-to-many mappings are valid; exact duplicates (native + sidecar
 *   declaring the same test/obligation) deduplicate idempotently;
 * - contradictions (conflicting kinds across entries, a declared kind
 *   against strong observed signals or observed mocking) are typed
 *   TEST_MAPPING_AMBIGUOUS problems naming BOTH locations — never
 *   "whichever ran last";
 * - stale declarations (deleted/renamed tests, changed title paths,
 *   unknown obligation ids) are typed TEST_MAPPING_STALE problems that
 *   name what vanished; a rename yields a migration suggestion, never a
 *   silent transfer;
 * - wildcards are prohibited in strict mode: a file-level selector (no
 *   titlePath) is an unsafe declaration and binds nothing;
 * - inference NEVER auto-writes a mapping: inferred bindings are marked
 *   `origin: 'inferred'`, are excluded from grading claims, and only
 *   feed suggestions;
 * - a mapping DECLARES INTENT and supplies no test result — grading
 *   claims produced here still require witnessed evidence (the CLI seam
 *   injects them as declared claims, so a mapped-but-unexecuted
 *   obligation grades EVIDENCE_NOT_COLLECTED, never satisfied).
 *
 * Deterministic: identical inputs produce identical outputs; every array
 * is sorted (compareStrings order) and no SHA-256-style Set iteration
 * leaks into ordering.
 */
import { compareStrings } from '../graph/util.js';
import { ClaimSchema } from '../schemas/claim.js';
import { CAUSE_NEXT_ACTIONS } from '../schemas/verdict.js';
/** Sort rank of binding origins (declared first, hints last). */
const ORIGIN_RANK = Object.freeze({
    native: 0,
    sidecar: 1,
    'prior-run': 2,
    inferred: 3,
});
/** Sort rank of problem causes (deterministic output order). */
const PROBLEM_RANK = Object.freeze({
    TEST_MAPPING_AMBIGUOUS: 0,
    TEST_MAPPING_STALE: 1,
    TEST_KIND_UNKNOWN: 2,
});
/** Test kinds that claim end-to-end proof (mocking disqualifies them, §3.2). */
const E2E_KINDS = new Set(['browser-e2e', 'api-e2e']);
/**
 * Whether a catalog row matches a sidecar selector exactly (§5.2: line
 * numbers and digests are never identity inputs).
 */
function matchesSelector(row, selector) {
    if (row.runner !== selector.runner || row.file !== selector.file)
        return false;
    if (selector.project !== undefined && row.project !== selector.project)
        return false;
    if (selector.titlePath !== undefined && selector.titlePath.join('>') !== row.titlePath.join('>')) {
        return false;
    }
    return true;
}
/** Projects a catalog row to its instance identity. */
function instanceOf(row) {
    return {
        runner: row.runner,
        project: row.project,
        file: row.file,
        titlePath: [...row.titlePath],
        parameterIdentity: row.parameterIdentity,
    };
}
/**
 * Resolves native claims, sidecar declarations, prior-run hints, and
 * inference into the one resolved-mappings surface.
 *
 * Args:
 *   input: catalog, native claims, validated sidecar, obligation ids,
 *     and optional prior-run hints.
 *
 * Returns:
 *   ResolvedMappings: per-obligation bindings plus typed problems, all
 *   deterministically sorted.
 */
export function resolveTestMappings(input) {
    const registry = new Set(input.obligationIds);
    const rowsByKey = new Map(input.catalog.entries.map((row) => [row.logicalKey, row]));
    const problems = [];
    const seenProblems = new Set();
    /** obligationId → logicalKey → binding. */
    const byObligation = new Map();
    const pushProblem = (problem) => {
        const dedupeKey = `${problem.cause}\u0000${problem.obligationId ?? ''}\u0000${problem.detail}`;
        if (seenProblems.has(dedupeKey))
            return;
        seenProblems.add(dedupeKey);
        problems.push(problem);
    };
    const bindingsFor = (obligationId) => {
        let existing = byObligation.get(obligationId);
        if (existing === undefined) {
            existing = new Map();
            byObligation.set(obligationId, existing);
        }
        return existing;
    };
    // --- sidecar declarations ------------------------------------------------
    const sidecarEntries = [...input.sidecar.tests].sort((a, b) => compareStrings(a.key, b.key));
    for (const entry of sidecarEntries) {
        const claims = [...new Set(entry.claims)].sort(compareStrings);
        const matched = input.catalog.entries
            .filter((row) => matchesSelector(row, entry.selector))
            .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
        // Wildcard prohibition (§5.2): a file-level selector covers a whole
        // file — an unsafe declaration that binds NOTHING (fail closed).
        if (entry.selector.titlePath === undefined) {
            for (const obligationId of claims) {
                pushProblem({
                    cause: 'TEST_MAPPING_AMBIGUOUS',
                    obligationId,
                    detail: `sidecar entry '${entry.key}' uses a file-level selector (no titlePath) for ` +
                        `'${entry.selector.file}' — wildcard declarations are prohibited in strict mode; ` +
                        'declare the exact test title path',
                    locations: [{ file: entry.selector.file, line: 1, col: 0 }],
                });
            }
            continue;
        }
        // Stale declaration (§5.2): the selector no longer matches the
        // catalog. Name what vanished; suggest a migration on a rename.
        if (matched.length === 0) {
            const renameTarget = input.catalog.entries.find((row) => row.file === entry.selector.file &&
                row.titlePath.join('>') === (entry.selector.titlePath ?? []).join('>'));
            const sameFile = input.catalog.entries.filter((row) => row.file === entry.selector.file);
            const vanished = renameTarget !== undefined
                ? `the test now appears as key '${renameTarget.logicalKey}' — migrate the declaration to ` +
                    'the new key (never silently transfer the old declaration or its proof)'
                : sameFile.length > 0
                    ? `the file still exists but its title path changed (current: ${sameFile
                        .slice(0, 3)
                        .map((row) => `'${row.titlePath.join('>')}'`)
                        .join(', ')})`
                    : `the file '${entry.selector.file}' has no catalog rows anymore`;
            for (const obligationId of claims) {
                if (!registry.has(obligationId))
                    continue;
                pushProblem({
                    cause: 'TEST_MAPPING_STALE',
                    obligationId,
                    detail: `sidecar key '${entry.key}' no longer matches the catalog ` +
                        `(selector ${entry.selector.runner}/${entry.selector.project ?? '*'}:` +
                        `${entry.selector.file}:${(entry.selector.titlePath ?? []).join('>')}): ${vanished}`,
                    locations: renameTarget !== undefined ? [renameTarget.sourceLocation] : [],
                });
            }
            continue;
        }
        // Unknown obligation ids (§5.4 TEST_MAPPING_STALE): the declaration
        // points outside the registry — the obligation vanished or the id is
        // misspelled. Other claims of the same entry still bind.
        for (const obligationId of claims) {
            if (!registry.has(obligationId)) {
                pushProblem({
                    cause: 'TEST_MAPPING_STALE',
                    obligationId,
                    detail: `sidecar entry '${entry.key}' claims '${obligationId}', which is not in the current ` +
                        'obligation registry (the obligation vanished or the id is misspelled); correct the mapping',
                    locations: [matched[0]?.sourceLocation ?? { file: entry.selector.file, line: 1, col: 0 }],
                });
            }
        }
        // Kind contradictions (§5.3: an explicit kind may resolve `unknown`,
        // but cannot override strong observed signals or observed mocking).
        for (const row of matched) {
            if (entry.kind === undefined) {
                if (row.inferredKind === 'unknown') {
                    for (const obligationId of claims) {
                        if (!registry.has(obligationId))
                            continue;
                        pushProblem({
                            cause: 'TEST_KIND_UNKNOWN',
                            obligationId,
                            detail: `test '${entry.key}' (${row.file}:${row.titlePath.join('>')}) is relevant but ` +
                                'code analysis could not classify its kind — inspect and declare its kind',
                            locations: [row.sourceLocation],
                        });
                    }
                }
                continue;
            }
            const mock = row.suppressionSignals.find((signal) => signal.kind === 'mock');
            if (E2E_KINDS.has(entry.kind) && mock !== undefined) {
                for (const obligationId of claims) {
                    pushProblem({
                        cause: 'TEST_MAPPING_AMBIGUOUS',
                        obligationId,
                        detail: `sidecar entry '${entry.key}' declares kind '${entry.kind}' but the catalog observed ` +
                            `mocking (${mock.detail}) — an explicit kind cannot override observed mocking (§5.3)`,
                        locations: [mock.location],
                    });
                }
                continue;
            }
            const strong = row.kindSignals[0];
            if (row.inferredKind !== 'unknown' && row.kindSignals.length > 0 && entry.kind !== row.inferredKind) {
                for (const obligationId of claims) {
                    pushProblem({
                        cause: 'TEST_MAPPING_AMBIGUOUS',
                        obligationId,
                        detail: `sidecar entry '${entry.key}' declares kind '${entry.kind}' but inference resolved ` +
                            `'${row.inferredKind}' from strong code signals (${strong?.ruleId ?? 'unknown'} at ` +
                            `${strong?.location.file ?? row.file}:${String(strong?.location.line ?? row.sourceLocation.line)}) — ` +
                            'correct the declaration or the classification',
                        locations: [row.sourceLocation, ...(strong !== undefined ? [strong.location] : [])],
                    });
                }
            }
        }
        // Bind the declaration (many-to-many allowed). Ambiguity problems
        // above stay visible; the binding itself is data for suggestions.
        for (const obligationId of claims) {
            if (!registry.has(obligationId))
                continue;
            bindingsFor(obligationId).set(entry.key, {
                logicalKey: entry.key,
                instances: matched.map(instanceOf),
                origin: 'sidecar',
                sourceDigest: matched[0]?.sourceDigest ?? null,
                declaredKind: entry.kind ?? null,
                categories: [...new Set(entry.categories ?? [])].sort(compareStrings),
                reason: entry.reason,
                sourceLocation: matched[0]?.sourceLocation ?? null,
            });
        }
    }
    // Cross-entry ambiguity: two entries claiming the same obligation with
    // conflicting declared kinds (§5.4 "a declaration is unsafe").
    const obligationIdsSorted = [...registry].sort(compareStrings);
    for (const obligationId of obligationIdsSorted) {
        const declared = [...(byObligation.get(obligationId)?.values() ?? [])]
            .filter((binding) => binding.origin === 'sidecar' && binding.declaredKind !== null)
            .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
        const kinds = new Set(declared.map((binding) => binding.declaredKind));
        if (declared.length > 1 && kinds.size > 1) {
            const first = declared[0];
            const second = declared.find((binding) => binding.declaredKind !== first?.declaredKind);
            pushProblem({
                cause: 'TEST_MAPPING_AMBIGUOUS',
                obligationId,
                detail: `obligation '${obligationId}' is claimed with conflicting kinds: '${String(first?.declaredKind)}' by '${first?.logicalKey}' and '${String(second?.declaredKind)}' by '${second?.logicalKey}' — ` +
                    'correct the exact mapping',
                locations: [
                    ...(first?.sourceLocation !== undefined && first.sourceLocation !== null ? [first.sourceLocation] : []),
                    ...(second?.sourceLocation !== undefined && second.sourceLocation !== null ? [second.sourceLocation] : []),
                ],
            });
        }
    }
    // --- native annotation claims -------------------------------------------
    const nativeClaims = [...input.nativeClaims].sort((a, b) => compareStrings(a.obligationId, b.obligationId) || compareStrings(a.testId, b.testId));
    for (const claim of nativeClaims) {
        if (!registry.has(claim.obligationId)) {
            pushProblem({
                cause: 'TEST_MAPPING_STALE',
                obligationId: claim.obligationId,
                detail: `native annotation on test '${claim.testId}'` +
                    `${claim.testFile !== undefined ? ` (${claim.testFile})` : ''} claims ` +
                    `'${claim.obligationId}', which is not in the current obligation registry ` +
                    '(the obligation vanished or the policy changed); correct the annotation or the mapping',
                locations: claim.location !== undefined ? [claim.location] : [],
            });
            continue;
        }
        // Exact duplicate of a sidecar declaration (same obligation, same
        // test file) → dedupe idempotently: the sidecar binding (a superset:
        // reason/kind/categories) stands, the native row adds nothing.
        const instances = input.catalog.entries
            .filter((row) => row.file === claim.testFile)
            .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
        const existingBindings = byObligation.get(claim.obligationId);
        const duplicate = existingBindings !== undefined &&
            [...existingBindings.values()].some((binding) => binding.origin === 'sidecar' && binding.instances.some((inst) => inst.file === claim.testFile));
        if (duplicate)
            continue;
        bindingsFor(claim.obligationId).set(claim.testId, {
            logicalKey: claim.testId,
            instances: instances.map(instanceOf),
            origin: 'native',
            sourceDigest: instances[0]?.sourceDigest ?? null,
            declaredKind: null,
            categories: [],
            reason: null,
            sourceLocation: claim.location ?? null,
        });
    }
    // --- prior-run hints (suggestions only, never grading) -------------------
    const hints = [...(input.priorRunHints ?? [])].sort((a, b) => compareStrings(a.obligationId, b.obligationId) || compareStrings(a.logicalKey, b.logicalKey));
    for (const hint of hints) {
        const row = rowsByKey.get(hint.logicalKey);
        if (row === undefined || !registry.has(hint.obligationId))
            continue;
        const bindings = bindingsFor(hint.obligationId);
        if (bindings.has(hint.logicalKey))
            continue;
        bindings.set(hint.logicalKey, {
            logicalKey: hint.logicalKey,
            instances: [instanceOf(row)],
            origin: 'prior-run',
            sourceDigest: row.sourceDigest,
            declaredKind: null,
            categories: [],
            reason: 'a prior run bound this test to the obligation (a hint only — it never satisfies a new run)',
            sourceLocation: row.sourceLocation,
        });
    }
    // --- inference (NEVER auto-writes a mapping; suggestions only) -----------
    for (const obligationId of obligationIdsSorted) {
        const bindings = byObligation.get(obligationId);
        if (bindings !== undefined && [...bindings.values()].some((b) => b.origin === 'native' || b.origin === 'sidecar')) {
            continue; // a declared mapping exists — inference adds nothing
        }
        const map = bindings ?? bindingsFor(obligationId);
        for (const candidate of inferredCandidates(obligationId, input.catalog)) {
            if (map.has(candidate.row.logicalKey))
                continue;
            map.set(candidate.row.logicalKey, {
                logicalKey: candidate.row.logicalKey,
                instances: [instanceOf(candidate.row)],
                origin: 'inferred',
                sourceDigest: candidate.row.sourceDigest,
                declaredKind: candidate.row.inferredKind,
                categories: candidate.row.categorySignals.map((signal) => signal.label).sort(compareStrings),
                reason: `inferred, never auto-declared: ${candidate.why.join('; ')}`,
                sourceLocation: candidate.row.sourceLocation,
            });
        }
    }
    const obligations = obligationIdsSorted.map((obligationId) => ({
        obligationId,
        bindings: [...(byObligation.get(obligationId)?.values() ?? [])].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || compareStrings(a.logicalKey, b.logicalKey)),
    }));
    problems.sort((a, b) => PROBLEM_RANK[a.cause] - PROBLEM_RANK[b.cause] ||
        compareStrings(a.obligationId ?? '', b.obligationId ?? '') ||
        compareStrings(a.detail, b.detail));
    return { obligations, problems: problems.map((problem) => ({ ...problem, locations: [...problem.locations] })) };
}
/**
 * Deterministic token inference (plan Phase 3 item 2): obligation
 * resource-id tokens (`tenant.accounts` → `tenant`, `accounts`) matched
 * against catalog rows' files, title paths, and category labels. Signals
 * feed SUGGESTIONS only — an inference never writes a mapping (§5.3).
 */
function inferredCandidates(obligationId, catalog) {
    const resourceId = obligationId.slice(0, Math.max(0, obligationId.indexOf(':')));
    const tokens = resourceId
        .split(/[.\-_]/)
        .map((token) => token.toLowerCase())
        .filter((token) => token.length > 2);
    if (tokens.length === 0)
        return [];
    const candidates = [];
    for (const row of catalog.entries) {
        const why = [];
        const title = row.titlePath.join('>').toLowerCase();
        for (const token of tokens) {
            if (row.file.toLowerCase().includes(token)) {
                why.push(`resource token '${token}' matches the test file '${row.file}'`);
            }
            else if (title.includes(token)) {
                why.push(`resource token '${token}' matches the test title path`);
            }
            else if (row.categorySignals.some((signal) => signal.label.toLowerCase().includes(token))) {
                why.push(`resource token '${token}' matches a category label`);
            }
        }
        if (why.length > 0)
            candidates.push({ row, why });
    }
    return candidates.sort((a, b) => compareStrings(a.row.logicalKey, b.row.logicalKey));
}
/** Suggestion order = reuse order (connect → declare kind → repair stale → repair conflict). */
const SUGGESTION_RANK = Object.freeze({
    TEST_MAPPING_MISSING: 0,
    TEST_KIND_UNKNOWN: 1,
    TEST_MAPPING_STALE: 2,
    TEST_MAPPING_AMBIGUOUS: 3,
});
/**
 * Produces per-obligation reuse suggestions ordered by reuse (plan
 * Phase 3 item 6). Obligations with a clean DECLARED mapping produce no
 * suggestion (their remaining gap is executed proof, not mapping).
 * `newTestNeeded` is true only when no candidate exists after resolution.
 *
 * Args:
 *   input: catalog, scoped obligation ids, and the resolution.
 *
 * Returns:
 *   MappingSuggestion[]: sorted by reuse rank, then obligation id.
 */
export function mappingSuggestions(input) {
    const byId = new Map(input.resolution.obligations.map((entry) => [entry.obligationId, entry.bindings]));
    const suggestions = [];
    for (const obligationId of [...input.obligationIds].sort(compareStrings)) {
        const bindings = byId.get(obligationId) ?? [];
        const problems = input.resolution.problems.filter((problem) => problem.obligationId === obligationId);
        const ambiguous = problems.find((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
        if (ambiguous !== undefined) {
            suggestions.push({
                obligationId,
                cause: 'TEST_MAPPING_AMBIGUOUS',
                candidates: [],
                missingEvidence: 'a safe, unambiguous declaration (the current declaration conflicts with itself or the catalog)',
                nextAction: CAUSE_NEXT_ACTIONS['TEST_MAPPING_AMBIGUOUS'],
                newTestNeeded: false,
            });
            continue;
        }
        const stale = problems.find((problem) => problem.cause === 'TEST_MAPPING_STALE');
        if (stale !== undefined) {
            const candidates = inferredCandidates(obligationId, input.catalog).map((candidate) => ({
                logicalKey: candidate.row.logicalKey,
                file: candidate.row.file,
                why: candidate.why,
            }));
            suggestions.push({
                obligationId,
                cause: 'TEST_MAPPING_STALE',
                candidates,
                missingEvidence: `an up-to-date declaration (the current one is stale: ${stale.detail})`,
                nextAction: CAUSE_NEXT_ACTIONS['TEST_MAPPING_STALE'],
                newTestNeeded: candidates.length === 0,
            });
            continue;
        }
        const declared = bindings.filter((binding) => binding.origin === 'native' || binding.origin === 'sidecar');
        const kindUnknown = problems.find((problem) => problem.cause === 'TEST_KIND_UNKNOWN');
        if (kindUnknown !== undefined) {
            suggestions.push({
                obligationId,
                cause: 'TEST_KIND_UNKNOWN',
                candidates: declared
                    .map((binding) => ({
                    logicalKey: binding.logicalKey,
                    file: binding.instances[0]?.file ?? '',
                    why: ['mapped by declaration, but its kind is unknown'],
                }))
                    .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey)),
                missingEvidence: 'a declared kind for the connected test (code analysis could not classify it)',
                nextAction: CAUSE_NEXT_ACTIONS['TEST_KIND_UNKNOWN'],
                newTestNeeded: false,
            });
            continue;
        }
        if (declared.length > 0)
            continue; // declared + clean: the gap is execution, not mapping
        const candidates = bindings
            .map((binding) => ({
            logicalKey: binding.logicalKey,
            file: binding.instances[0]?.file ?? '',
            why: binding.origin === 'inferred' || binding.origin === 'prior-run'
                ? [binding.reason ?? binding.origin]
                : [`bound by native annotation (${binding.logicalKey})`],
        }))
            .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
        suggestions.push({
            obligationId,
            cause: 'TEST_MAPPING_MISSING',
            candidates,
            missingEvidence: candidates.length > 0
                ? 'a DECLARED mapping and witnessed evidence for this change (a mapping declares intent; it supplies no test result)'
                : 'a declared mapping to any existing test — no candidate survived resolution',
            nextAction: CAUSE_NEXT_ACTIONS['TEST_MAPPING_MISSING'],
            newTestNeeded: candidates.length === 0,
        });
    }
    return suggestions.sort((a, b) => SUGGESTION_RANK[a.cause] - SUGGESTION_RANK[b.cause] ||
        compareStrings(a.obligationId, b.obligationId));
}
/**
 * Projects resolved bindings into declared grading claims (plan §5.3:
 * both declaration paths normalize into existing claims). ONLY `native`
 * and `sidecar` bindings project — inferred and prior-run bindings are
 * suggestions and never grade. Exact duplicates of claims the run state
 * already carries are dropped idempotently. The claims declare INTENT:
 * they contain no evidence, so a mapped obligation with no witnessed
 * records still grades EVIDENCE_NOT_COLLECTED (blocking), never satisfied.
 *
 * Phase 4 note (runtime selection): the suite fixture submits evidence
 * per native annotations using the reporter's own testIds, so sidecar
 * claims (whose testId is the logical key) cannot receive runtime
 * evidence until Phase 4 wires claim injection through session open.
 *
 * Args:
 *   resolution: the resolved-mappings surface.
 *   existingClaims: the run-state claims (native annotations).
 *
 * Returns:
 *   Claim[]: validated declared claims, sorted by (obligationId, testId).
 */
export function mappingGradingClaims(resolution, existingClaims) {
    const existing = new Set(existingClaims.map((claim) => `${claim.obligationId}\u0000${claim.testId}`));
    const claims = [];
    for (const entry of resolution.obligations) {
        for (const binding of entry.bindings) {
            if (binding.origin !== 'native' && binding.origin !== 'sidecar')
                continue;
            const dedupeKey = `${entry.obligationId}\u0000${binding.logicalKey}`;
            if (existing.has(dedupeKey))
                continue;
            existing.add(dedupeKey);
            const file = binding.instances[0]?.file;
            claims.push(ClaimSchema.parse({
                schemaVersion: 1,
                obligationId: entry.obligationId,
                testId: binding.logicalKey,
                ...(file !== undefined ? { testFile: file } : {}),
            }));
        }
    }
    return claims.sort((a, b) => compareStrings(a.obligationId, b.obligationId) || compareStrings(a.testId, b.testId));
}
//# sourceMappingURL=resolve.js.map