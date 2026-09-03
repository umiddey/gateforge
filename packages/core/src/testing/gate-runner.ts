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

import type { DetectorOutput, GraphFinding, ResourceGraph } from '../graph/index.js';
import { buildResourceGraph, compareStrings } from '../graph/index.js';
import { fingerprint } from '../fingerprints.js';
import type { PolicyEvaluationResult } from '../policy/index.js';
import { evaluatePolicies } from '../policy/index.js';
import { runClassification } from '../classifier/bind.js';
import type { ClassificationSignal } from '../schemas/classification-signal.js';
import type { Claim } from '../schemas/claim.js';
import type { Classification } from '../schemas/classification.js';
import type { ClassificationPolicy } from '../schemas/classification-policy.js';
import type { PolicyFile } from '../schemas/policy.js';
import type { EvidenceRecord } from '../schemas/evidence.js';
import type { Obligation } from '../schemas/obligation.js';
import type { Waiver } from '../schemas/waiver.js';
import type { RunManifest } from '../schemas/run-manifest.js';
import { RunManifestSchema } from '../schemas/run-manifest.js';
import type { Verdict } from '../schemas/verdict.js';
import type { TestClock } from './clock.js';
import type { ChangedFileProvider } from './env.js';
import type { ParseAudit } from './gf19.js';
import { applyParseErrorRule } from './gf19.js';
import type { TempRepo } from './temp-repo.js';

/**
 * The context one obligation is evaluated against (pin #9). `now` accepts
 * ISO-8601 string or Date; the evaluator normalizes internally.
 */
export interface ObligationEvaluatorInput {
  /** Claims assessed for this run. */
  claims: Claim[];
  /** Witness-issued evidence records for this run. */
  records: EvidenceRecord[];
  /** Waivers in scope for this run. */
  waivers: Waiver[];
  /** The obligation resource's classification, or null while unclassified. */
  classification: Classification | null;
  /** The injected instant the verdict is decided at. */
  now: string | Date;
}

/** The pinned evaluator result shape (pin #9): all keys always present. */
export interface EvaluatorVerdict {
  /** One of the seven verdicts. */
  verdict: Verdict;
  /** Single-cause reason; null only for `satisfied`. */
  reason: string | null;
  /** Evidence record ids backing the verdict; empty when none consulted. */
  recordIds: string[];
}

/**
 * A pin-#9 obligation evaluator. G3's `evaluateObligation` conforms
 * structurally; fixtures inject doubles.
 */
export type ObligationEvaluator = (
  obligation: Obligation,
  input: ObligationEvaluatorInput,
) => EvaluatorVerdict;

/** One detector contribution, optionally carrying its parse audit. */
export interface DetectorContribution extends DetectorOutput {
  /** Per-file parse audit; when present the GF-19 rule is applied. */
  audit?: ParseAudit;
}

/** Everything one gate run needs. Detectors, artifacts, clock, evaluator. */
export interface RunGatesInput {
  /** The fixture repository under test. */
  repo: TempRepo;
  /** Detector contributions; at least one. */
  detectors: DetectorContribution[];
  /**
   * The classification policy (`.gateforge/classification-policy.yml`
   * content, plan phase 5). Effective classifications are computed
   * deterministically from detector signals on every run — there is no
   * manual classifications document.
   */
  classificationPolicy: ClassificationPolicy;
  /** Policies document (`.gateforge/policies.yml` content). */
  policies: PolicyFile;
  /** The obligation evaluator (pin #9). */
  evaluate: ObligationEvaluator;
  /** The injected clock; stamps the run manifest and every verdict. */
  clock: TestClock;
  /** Claims to assess and watch for stale references. */
  claims?: Claim[];
  /** Witness-issued records backing verdicts. */
  records?: EvidenceRecord[];
  /** Waivers in scope. */
  waivers?: Waiver[];
  /** Adapter names watched for stale references. */
  adapters?: string[];
  /** Changed-file provider; when omitted the run records no changed files. */
  changedProvider?: ChangedFileProvider;
  /** Fixed run id; default is a fresh random UUID. */
  runId?: string;
}

/** One obligation's verdict plus the identity fields a report needs. */
export interface GateRunVerdict {
  /** `<resourceId>:<contract>`. */
  obligationId: string;
  resourceId: string;
  /** Contract required by the policy. */
  contract: string;
  /** Policy that generated the obligation. */
  policyId: string;
  /** Obligation fingerprint (pin #2) — the identity baselines store. */
  fingerprint: string;
  /** Decided verdict. */
  verdict: Verdict;
  /** Single-cause reason; null only for `satisfied`. */
  reason: string | null;
  /** Backing evidence record ids. */
  recordIds: string[];
}

/** The complete, typed result of one gate run. */
export interface GateRunResult {
  /** Run manifest (pin #4), validated against its schema. */
  manifest: RunManifest;
  /** The built resource graph (includes all findings). */
  graph: ResourceGraph;
  /** Policy-engine output: obligations, blocking entries, claim assessments. */
  policy: PolicyEvaluationResult;
  /** Per-obligation verdicts, sorted by obligation id. */
  verdicts: GateRunVerdict[];
  /** Graph findings (detector + graph-issued), including `PARSE_ERROR`. */
  findings: GraphFinding[];
  /** GF-19 rule violations: detector misbehavior the rule had to correct. */
  auditViolations: string[];
  /** Changed files reported by the injected provider (sorted). */
  changedFiles: string[];
  /**
   * True when nothing blocks: no blocking verdicts, no blocking entries,
   * no findings, no audit violations. Conservative by design — a fixture
   * asserting a specific sub-outcome should assert on the fields above.
   */
  clean: boolean;
}

/**
 * Runs the discover → obligations → evaluate pipeline over a fixture
 * repository. Deterministic given fixed inputs: detectors run in order,
 * the graph and policy engine sort their outputs, and the clock is
 * injected.
 *
 * Args:
 *   input: repository, detector contributions (+ parse audits), the
 *     classification-policy/policy documents, injected clock, evaluator
 *     double or real, and optional claims/records/waivers/provider/runId.
 *
 * Returns:
 *   GateRunResult: manifest, graph, policy result, per-obligation
 *   verdicts, findings, audit violations, changed files, clean flag.
 * @throws TypeError when no detector contributions are supplied.
 */
export function runGates(input: RunGatesInput): GateRunResult {
  if (input.detectors.length === 0) {
    throw new TypeError('runGates requires at least one detector contribution');
  }

  const contributions: DetectorOutput[] = [];
  const auditViolations: string[] = [];
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
      classificationSignals: contribution.classificationSignals,
      ...(contribution.scannedPaths !== undefined
        ? { scannedPaths: contribution.scannedPaths }
        : {}),
    });
  }

  const built = buildResourceGraph({
    detectors: contributions,
    claims: input.claims,
    adapters: input.adapters,
    waivers: input.waivers,
  });
  const signals = contributions.flatMap((contribution) => contribution.classificationSignals);
  // Channel routing (ADR 0003 D2): the harness stands in the HOST, so
  // suppressive-shaped signals in the fixture contributions are minted
  // onto the authority channel exactly as the real pipeline would.
  const suppressive = (signal: ClassificationSignal): boolean =>
    (signal.dimension === 'internality' &&
      (signal.basis === 'declaration' || signal.basis === 'organization-policy')) ||
    (signal.dimension.startsWith('lifecycle.') && signal.basis === 'code-negative-closed-world');
  // Per-detector coverage (red-team round 3): synthesize the coverage
  // reports from contributions that reported scannedPaths, exactly as
  // the real pipeline does — the attestation judges THESE, never a union.
  const coverage = contributions
    .filter((contribution) => contribution.scannedPaths !== undefined)
    .map((contribution) => ({
      detector: contribution.detectorId,
      scannedPaths: contribution.scannedPaths as string[],
    }));
  const { graph, blocking } = runClassification({
    graph: built,
    signals: signals.filter((signal) => !suppressive(signal)),
    authority: signals.filter(suppressive),
    policy: input.classificationPolicy,
    adapters: input.adapters ?? [],
    scan: {
      // The harness's requested scope is the union of reported coverage
      // (fixture-level self-consistency); the policy's coverage rules
      // still judge each detector individually below.
      requestedPaths: [...new Set(coverage.flatMap((entry) => entry.scannedPaths))],
      scannedPaths: [...new Set(coverage.flatMap((entry) => entry.scannedPaths))],
      coverage,
      configuredDetectors: contributions.length,
      successfulDetectors: contributions.length,
    },
  });
  const policy = evaluatePolicies({
    graph,
    policies: input.policies,
    claims: input.claims,
    extraBlocking: blocking,
  });

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

  const blockingVerdicts = verdicts.filter(
    (verdict) => verdict.verdict !== 'satisfied' && verdict.verdict !== 'waived',
  );
  return {
    manifest,
    graph,
    policy,
    verdicts,
    findings: graph.findings,
    auditViolations,
    changedFiles: input.changedProvider?.changedFiles() ?? [],
    clean:
      blockingVerdicts.length === 0 &&
      policy.blocking.length === 0 &&
      graph.findings.length === 0 &&
      graph.stale.length === 0 &&
      auditViolations.length === 0,
  };
}
