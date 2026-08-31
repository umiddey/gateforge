/**
 * Gate-runner helper (fixture harness, G7): runs the full
 * discover → obligations → evaluate pipeline over a temporary repository
 * with injected clock, environment, and changed-file provider.
 *
 * The evaluator is injected (pin #9: `evaluateObligation(obligation,
 * {claims, records, waivers, classification, now})`); fixtures in this
 * package use a local test double. When G3's verdict engine lands, the
 * real `evaluateObligation` satisfies {@link ObligationEvaluator}
 * structurally — no harness change needed.
 *
 * The GF-19 rule is applied to every detector contribution carrying a
 * parse audit before the graph is built, so malformed source can never
 * enter the pipeline as a silent resource.
 */
import { randomUUID } from 'node:crypto';
import { buildResourceGraph, compareStrings } from '../graph/index.js';
import { fingerprint } from '../fingerprints.js';
import { evaluatePolicies } from '../policy/index.js';
import { RunManifestSchema } from '../schemas/run-manifest.js';
import { applyParseErrorRule } from './gf19.js';
/**
 * Runs the discover → obligations → evaluate pipeline over a fixture
 * repository. Deterministic given fixed inputs: detectors run in order,
 * the graph and policy engine sort their outputs, and the clock is
 * injected.
 *
 * Args:
 *   input: repository, detector contributions (+ parse audits), the
 *     classification/policy documents, injected clock, evaluator double
 *     or real, and optional claims/records/waivers/provider/runId.
 *
 * Returns:
 *   GateRunResult: manifest, graph, policy result, per-obligation
 *   verdicts, findings, audit violations, changed files, clean flag.
 * @throws TypeError when no detector contributions are supplied.
 */
export function runGates(input) {
    if (input.detectors.length === 0) {
        throw new TypeError('runGates requires at least one detector contribution');
    }
    const contributions = [];
    const auditViolations = [];
    for (const contribution of input.detectors) {
        if (contribution.audit === undefined) {
            contributions.push(contribution);
            continue;
        }
        const ruled = applyParseErrorRule({
            detectorId: contribution.detectorId,
            detectorVersion: contribution.detectorVersion,
            audit: contribution.audit,
            output: contribution,
        });
        auditViolations.push(...ruled.violations.map((violation) => `${contribution.detectorId}: ${violation}`));
        contributions.push({
            detectorId: contribution.detectorId,
            detectorVersion: contribution.detectorVersion,
            resources: ruled.resources,
            unresolved: contribution.unresolved,
            // The rule's guaranteed findings carry provenance; feed them back
            // through the pinned discovery shape so the graph owns them.
            findings: ruled.findings.map(({ code, detail, locations }) => ({ code, detail, locations })),
        });
    }
    const graph = buildResourceGraph({
        detectors: contributions,
        classifications: input.classifications,
        claims: input.claims,
        adapters: input.adapters,
        waivers: input.waivers,
    });
    const policy = evaluatePolicies({ graph, policies: input.policies, claims: input.claims });
    const now = input.clock.now();
    const verdicts = policy.obligations
        .map((obligation) => {
        const resource = graph.resources.find((candidate) => candidate.id === obligation.resourceId);
        const outcome = input.evaluate(obligation, {
            claims: input.claims ?? [],
            records: input.records ?? [],
            waivers: input.waivers ?? [],
            classification: resource?.classification ?? null,
            now,
        });
        return {
            obligationId: obligation.id,
            resourceId: obligation.resourceId,
            contract: obligation.contract,
            policyId: obligation.policyId,
            fingerprint: fingerprint({
                resourceId: obligation.resourceId,
                contract: obligation.contract,
                policyId: obligation.policyId,
                lifecycle: obligation.lifecycle,
            }),
            verdict: outcome.verdict,
            reason: outcome.reason,
            recordIds: [...outcome.recordIds].sort(compareStrings),
        };
    })
        .sort((a, b) => compareStrings(a.obligationId, b.obligationId));
    const manifest = RunManifestSchema.parse({
        schemaVersion: 1,
        runId: input.runId ?? randomUUID(),
        startedAt: now,
        gitSha: input.repo.headSha(),
        provider: input.changedProvider?.provider ?? 'all-files',
        plugins: contributions.map((contribution) => ({
            id: contribution.detectorId,
            version: contribution.detectorVersion,
            transport: 'in-process',
        })),
        attestationScope: null,
    });
    const blockingVerdicts = verdicts.filter((verdict) => verdict.verdict !== 'satisfied' && verdict.verdict !== 'waived');
    return {
        manifest,
        graph,
        policy,
        verdicts,
        findings: graph.findings,
        auditViolations,
        changedFiles: input.changedProvider?.changedFiles() ?? [],
        clean: blockingVerdicts.length === 0 &&
            policy.blocking.length === 0 &&
            graph.findings.length === 0 &&
            auditViolations.length === 0,
    };
}
//# sourceMappingURL=gate-runner.js.map