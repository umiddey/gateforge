import type { DetectorOutput, GraphFinding, ResourceGraph } from '../graph/index.js';
import type { PolicyEvaluationResult } from '../policy/index.js';
import type { Claim } from '../schemas/claim.js';
import type { Classification, ClassificationFile } from '../schemas/classification.js';
import type { PolicyFile } from '../schemas/policy.js';
import type { EvidenceRecord } from '../schemas/evidence.js';
import type { Obligation } from '../schemas/obligation.js';
import type { Waiver } from '../schemas/waiver.js';
import type { RunManifest } from '../schemas/run-manifest.js';
import type { Verdict } from '../schemas/verdict.js';
import type { TestClock } from './clock.js';
import type { ChangedFileProvider } from './env.js';
import type { ParseAudit } from './gf19.js';
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
export type ObligationEvaluator = (obligation: Obligation, input: ObligationEvaluatorInput) => EvaluatorVerdict;
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
    /** Classifications document (`.gateforge/classifications.yml` content). */
    classifications: ClassificationFile;
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
 *     classification/policy documents, injected clock, evaluator double
 *     or real, and optional claims/records/waivers/provider/runId.
 *
 * Returns:
 *   GateRunResult: manifest, graph, policy result, per-obligation
 *   verdicts, findings, audit violations, changed files, clean flag.
 * @throws TypeError when no detector contributions are supplied.
 */
export declare function runGates(input: RunGatesInput): GateRunResult;
//# sourceMappingURL=gate-runner.d.ts.map