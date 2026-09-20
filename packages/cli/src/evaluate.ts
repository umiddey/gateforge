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
import {
  AttestationSchema,
  BLOCKING_VERDICTS,
  blockingEntryFingerprint,
  CAUSE_NEXT_ACTIONS,
  classificationBlockedIdentity,
  HTTP_ENDPOINT_RESOURCE_KIND,
  evaluateCoveragePolicy,
  type MappedCoverage,
  evaluateObligations,
  fingerprintObligation,
  loadWaivers,
  strictCapabilityGaps,
  verifyAttestationMac,
  type Attestation,
  type BlockingEntry,
  type CauseCode,
  type Claim,
  type CoverageOperation,
  type GateforgeConfig,
  type Obligation,
  type ObligationVerdict,
  type ResourceGraph,
  type WaiverCounts,
} from '@gate-forge/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './errors.js';
import { resolveRepoPath, sourcesByResourceId } from './pipeline.js';
import { httpRoutesView, readJsonArray } from './state.js';

/**
 * Pin-#2 fingerprint of an obligation — the identity the baseline
 * stores. Shared by `check` (baseline application) and `adopt` (red-set
 * capture) so both sides hash exactly the same way.
 */
export function obligationFingerprint(obligation: Obligation): string {
  return fingerprintObligation(obligation);
}



/** Everything verdict evaluation needs. */
export interface EvaluateInput {
  /** Repo root; repo-relative config paths resolve against it. */
  cwd: string;
  /** Validated `.gateforge.yml`. */
  config: GateforgeConfig;
  /** Built graph (classifications + detector provenance per resource). */
  graph: ResourceGraph;
  /** Generated obligations (policy result). */
  obligations: readonly Obligation[];
  /**
   * Blocking entries (unclassified/unresolved resources, detector or
   * graph findings, stale references) from the policy result.
   */
  blocking: readonly BlockingEntry[];
  /** Absolute run-state directory holding claims.json / records.json. */
  stateDir: string;
  /** Injected run instant — the only time source (pin #9). */
  now: string;
  /**
   * Diff scope: when non-null, only obligations/blocking entries tied to
   * these changed files are evaluated/reported (check --changed).
   */
  changedFiles?: readonly string[] | null;
  /** Compiled behavior catalog used to expand changed-file selection. */
  behaviorCatalog?: import('@gate-forge/core').BehaviorCatalog | null;
  /**
   * Expected authority profile digest bound into behavior grading (the
   * engine bundle binding). Provisioned by callers that know the
   * trusted policy digest; absent skips the check (documented).
   */
  behaviorAuthorityProfileDigest?: string | null;
  /**
   * Declared claims derived from resolved test mappings (plan
   * 2026-09-13 §5.3, Phase 3): sidecar/native mapping bindings join the
   * natively annotated claims so an existing mapped test reaches the SAME
   * authoritative grading path. A mapping declares intent and supplies no
   * test result — with no witnessed evidence the obligation grades
   * EVIDENCE_NOT_COLLECTED (blocking), never satisfied. Claims cannot
   * waive or weaken anything, so strict mode is unaffected. Phase 4 gap:
   * the runtime fixture submits evidence per annotations with the
   * reporter's own testIds, so sidecar claims (testId = logical key)
   * receive no runtime evidence until Phase 4 wires claim injection
   * through session open.
   */
  mappingClaims?: readonly Claim[];
  /**
   * Coverage facts derived from resolved test mappings (plan §3.6,
   * Phase 3): browser-e2e-declared bindings for CRUD-contract
   * obligations, joined to their inventory tables. Feeds the coverage
   * policy so a mapped journey clears its table/operation exactly like
   * an owner disposition; declarations remain inputs, never proof.
   */
  mappedCoverage?: readonly MappedCoverage[];
  /**
   * Verifier key for the witness attestation surface — a secret the
   * orchestrator shares with the witness and this CLI, never with the
   * tested suite. When absent (or when neither authenticated set
   * verifies) the provenance gate fails closed and demotes every
   * witnessed record: suite-writable artifacts alone cannot prove
   * issuance.
   */
  witnessVerifierKey?: string | null;
  /**
   * Live v2 attestation envelope fetched by `test-gates` while a wired
   * witness was still serving (plan §11.3: the same signed object the
   * shutdown append writes). Verified again here before it contributes
   * trust. Legacy v1 `{runId, recordIds, mac}` shapes never verify here.
   */
  witnessAttestation?: unknown;
  /**
   * Evidence authorization context (plan §11.5–§11.6).
   *
   * `test-gates` holds its mint (`invocationId`) and digest in trusted
   * process memory and passes them here — never by rereading state
   * files after the suite ran. `check` recomputes the current digest
   * itself and requires no invocation match (D3: a completed signed run
   * for identical inputs is reusable).
   */
  evidenceContext?: {
    /** Trusted current input digest, or null when the snapshot is unavailable. */
    expectedInputDigest: string | null;
    /** True when no usable Git inventory exists (non-Git checkout). */
    snapshotUnavailable?: boolean;
    /** Trusted invocation id (test-gates memory; null for check). */
    expectedInvocationId?: string | null;
    /** True for test-gates: the invocation identity must match. */
    requireInvocationId?: boolean;
    /** True when the test-gates run mutated its own inputs post-suite. */
    changedInputs?: boolean;
  };
  /**
   * Adoption-baseline forgiveness (phase 8 C): the fingerprint set of
   * the ADOPTED baseline. Deliberately caller-provided, never loaded
   * here: `check` honors a baseline only when its sibling adoption
   * record exists (an unrecorded bulk-add forgives nothing — fail
   * closed), and that gate lives with the config, not the evaluator.
   * Callers that pass nothing (test-gates) never forgive.
   */
  baseline?: {
    fingerprints: ReadonlySet<string>;
    /**
     * The classification layer (two-layer adoption): resource ids adopted
     * as classification-blocked in the receipt. A classification-kind
     * blocking entry whose resource id is in this set is waived (loudly
     * counted, not exit-counted); every other classification entry —
     * above all a NEW blocked resource — still blocks. Absent/empty = the
     * receipt carries no classification layer (or none left): nothing is
     * waived here, fail closed.
     */
    classificationBlocked?: ReadonlySet<string>;
  } | null;
}

/** The evaluated run. */
export interface EvaluateResult {
  /** Per-obligation verdicts, sorted by obligation id. */
  verdicts: ObligationVerdict[];
  /** Blocking entries (unclassified/unresolved), diff-scoped. */
  blocking: BlockingEntry[];
  /** Waiver-population counts for report summaries. */
  waiverCounts: WaiverCounts;
  /** Whether any blocking verdict or blocking entry exists. */
  blockingRun: boolean;
  /**
   * Adoption-baseline forgiveness counts (phase 8 C) — kept LOUD: the
   * report prints them on every run so baselined debt is never silently
   * green. Null when no baseline was applied.
   */
  baselined: {
    obligations: number;
    blockingEntries: number;
    /**
     * Blocking entries waived via the adopted classification set.
     * Undefined when the receipt carries NO classification layer at all
     * (pre-layer receipt): not-adopted must stay distinguishable from
     * adopted-with-zero-left — both forgive nothing differently.
     */
    classificationBlocked: number | undefined;
  } | null;
}

/** Keeps only blocking entries plausibly tied to a changed file. */
function scopeBlocking(
  blocking: readonly BlockingEntry[],
  changed: ReadonlySet<string>,
  multiSources: Map<string, string[]>,
): BlockingEntry[] {
  const kept: BlockingEntry[] = [];
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
      if (sources.some((source) => changed.has(source))) kept.push(entry);
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
export function coverageInventory(graph: ResourceGraph): Array<{
  name: string;
  operations: readonly CoverageOperation[];
}> {
  const ALL: readonly CoverageOperation[] = ['create', 'read', 'update', 'delete'];
  const inventory: Array<{ name: string; operations: readonly CoverageOperation[] }> = [];
  for (const resource of graph.resources) {
    if (resource.id === null || resource.exposure !== 'user-facing') continue;
    if (resource.kind === HTTP_ENDPOINT_RESOURCE_KIND) continue;
    if (resource.classification === null) continue;
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
export function coveragePolicyBlocking(
  config: GateforgeConfig,
  graph: ResourceGraph,
  mappedCoverage: readonly MappedCoverage[] = [],
): BlockingEntry[] {
  const policy = config.coveragePolicy;
  if (policy === undefined || policy.tables.length === 0) return [];
  const result = evaluateCoveragePolicy(policy.tables, coverageInventory(graph), mappedCoverage);
  if (result.configErrors.length > 0) {
    const first = result.configErrors[0];
    throw new UsageError(
      `${first?.detail}${result.configErrors.length > 1 ? ` (and ${result.configErrors.length - 1} more coverage-policy configuration error(s))` : ''}`,
    );
  }
  return result.blocking.map(
    (finding): BlockingEntry => ({
      kind: 'finding',
      resourceId: null,
      name: finding.table,
      detail: finding.detail,
      location: null,
      cause: finding.cause,
      nextAction: finding.nextAction,
    }),
  );
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
export function strictPreflightBlocking(obligations: readonly Obligation[]): BlockingEntry[] {
  return strictCapabilityGaps(
    obligations.map((obligation) => ({ id: obligation.id, contract: obligation.contract })),
  ).map(
    (gap): BlockingEntry => ({
      kind: 'finding',
      resourceId: null,
      name: gap.contract,
      detail: `${gap.detail} Required observer: ${gap.observer}`,
      location: null,
      cause: gap.cause,
      nextAction: gap.nextAction,
    }),
  );
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
export function applyStrictE2E(verdicts: readonly ObligationVerdict[]): ObligationVerdict[] {
  return verdicts.map((entry) => {
    if (entry.verdict !== 'waived') return entry;
    const cause: CauseCode = 'ENFORCEMENT_UNTRUSTED';
    return {
      ...entry,
      verdict: 'missing' as const,
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
export function evaluateRun(input: EvaluateInput): EvaluateResult {
  const { cwd, config, graph, obligations, stateDir, now } = input;

  const classifications = new Map<string, unknown>();
  const detectors = new Map<string, { id: string; version: string }>();
  const resourceById = new Map<string, { kind: string; attributes: Record<string, unknown> }>();
  for (const resource of graph.resources) {
    if (resource.id === null) continue;
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
  // Trusted behavior context (plan 2026-09-19 §4.7): the compiled
  // catalog + requirements travel from the controller-bound pipeline
  // output — never CLI configuration, never record payloads. Absent
  // without a behavior document (legacy semantics unchanged).
  const behaviorContext =
    input.behaviorCatalog === undefined || input.behaviorCatalog === null
      ? undefined
      : {
          catalog: input.behaviorCatalog,
          requirements: input.behaviorCatalog.requirements,
          ...(input.behaviorAuthorityProfileDigest === undefined ||
          input.behaviorAuthorityProfileDigest === null
            ? {}
            : { authorityProfileDigest: input.behaviorAuthorityProfileDigest }),
        };
  const verdicts: ObligationVerdict[] = [];
  for (const obligation of scoped) {
    const entries = evaluateObligations([obligation], {
      claims,
      records,
      waivers: waiverLoad.waivers,
      classification: classifications.get(obligation.resourceId) ?? null,
      resource: resourceById.get(obligation.resourceId) ?? null,
      httpRoutes,
      ...(behaviorContext === undefined ? {} : { behavior: behaviorContext }),
      now,
    });
    const entry = entries[0];
    if (entry === undefined) continue;
    verdicts.push({
      ...entry,
      detector: detectors.get(obligation.resourceId) ?? null,
    });
  }
  const sources = sourcesByResourceId(graph, input.behaviorCatalog);
  const scopedBlocking =
    input.changedFiles === null || input.changedFiles === undefined
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
  // Adoption-baseline forgiveness (phase 8 C) runs after diff scoping
  // but BEFORE strict E2E grading: in strict mode a baselined obligation
  // is still not proof (plan §3.3) — applyStrictE2E re-grades every
  // waived verdict, baselined ones included, back to blocking. Non-strict
  // repos keep the loud, counted baseline forgiveness.
  const applied = applyBaseline(input.baseline ?? null, { verdicts, blocking });
  const gradedVerdicts = strictE2E ? applyStrictE2E(applied.verdicts) : applied.verdicts;

  const blockingRun =
    applied.blocking.length > 0 ||
    gradedVerdicts.some((entry) => BLOCKING_VERDICTS.includes(entry.verdict));

  return {
    verdicts: gradedVerdicts,
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
 *
 * The classification layer (two-layer adoption) waives by RESOURCE
 * IDENTITY (`classificationBlockedIdentity`), which is merge-stable where
 * whole-entry fingerprints are not (they bake in detail text and line
 * numbers, so an upstream merge would otherwise un-forgive the same
 * resource): a `classification` or `unclassified` entry whose adopted
 * identity is in the receipt's set is waived — loudly counted (as
 * DISTINCT resources), not exit-counted, not in the blocking list. The
 * layer runs FIRST; entries it waives are never double-counted under the
 * fingerprint pass. Fail-closed edges: entries without an identity
 * (document-level classifier blocks — stale targets, invalid signals) are
 * never waived here; a NEW blocked resource is by definition not in the
 * shrink-only set and still blocks.
 */
function applyBaseline(
  baseline: {
    fingerprints: ReadonlySet<string>;
    classificationBlocked?: ReadonlySet<string>;
  } | null,
  run: { verdicts: ObligationVerdict[]; blocking: BlockingEntry[] },
): {
  verdicts: ObligationVerdict[];
  blocking: BlockingEntry[];
  baselined: {
    obligations: number;
    blockingEntries: number;
    classificationBlocked: number | undefined;
  } | null;
} {
  if (baseline === null) {
    return { verdicts: run.verdicts, blocking: run.blocking, baselined: null };
  }
  const fingerprints = baseline.fingerprints;
  const classificationIds = baseline.classificationBlocked;
  const classificationProvided = classificationIds !== undefined;
  const classification =
    classificationIds !== undefined && classificationIds.size > 0 ? classificationIds : null;
  if (fingerprints.size === 0 && classification === null) {
    return { verdicts: run.verdicts, blocking: run.blocking, baselined: null };
  }
  let obligations = 0;
  const verdicts = run.verdicts.map((entry) => {
    if (!BLOCKING_VERDICTS.includes(entry.verdict)) return entry;
    if (!fingerprints.has(obligationFingerprint(entry.obligation))) return entry;
    obligations += 1;
    return {
      ...entry,
      verdict: 'waived' as const,
      reason: `baselined: adopted as forgiven (was ${entry.verdict}); baseline is shrink-only`,
    };
  });
  const blocking: BlockingEntry[] = [];
  let blockingEntries = 0;
  const waivedClassifications = new Set<string>();
  for (const entry of run.blocking) {
    const identity = classificationBlockedIdentity(entry);
    if (identity !== null && classification !== null && classification.has(identity)) {
      waivedClassifications.add(identity);
      continue;
    }
    if (fingerprints.has(blockingEntryFingerprint(entry))) {
      blockingEntries += 1;
      continue;
    }
    blocking.push(entry);
  }
  return {
    verdicts,
    blocking,
    baselined: {
      obligations,
      blockingEntries,
      classificationBlocked: classificationProvided ? waivedClassifications.size : undefined,
    },
  };
}

/** Diff-scopes the obligation list itself (check --changed). */
function scopeObligations(input: EvaluateInput): Obligation[] {
  if (input.changedFiles === null || input.changedFiles === undefined) {
    return [...input.obligations];
  }
  const changed = new Set(input.changedFiles);
  const sources = sourcesByResourceId(input.graph, input.behaviorCatalog);
  return input.obligations.filter((obligation) => {
    const resourceSources = sources.get(obligation.resourceId);
    if (resourceSources === undefined) return false;
    return resourceSources.some((source: string) => changed.has(source));
  });
}

/** One validated v2 envelope that may authorize records. */
interface ValidEnvelope {
  runId: string;
  invocationId: string;
  inputDigest: string;
  recordIds: Set<string>;
}

/** Why an envelope candidate failed, for explicit diagnostics. */
type EnvelopeRejection =
  | 'missing'
  | 'malformed'
  | 'mac-fail'
  | 'digest-mismatch'
  | 'invocation-mismatch'
  | 'manifest-run-mismatch';

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
function authorizeRecords(
  records: readonly unknown[],
  stateDir: string,
  auth: {
    verifierKey?: string | null;
    live?: unknown;
    expectedInputDigest?: string | null;
    snapshotUnavailable?: boolean;
    expectedInvocationId?: string | null;
    requireInvocationId?: boolean;
    changedInputs?: boolean;
  } = {},
): { records: unknown[]; evidenceBlocking: BlockingEntry[] } {
  const issuedRecordId = /^[0-9a-f]{64}$/;
  const verifierKey =
    typeof auth.verifierKey === 'string' && auth.verifierKey.length > 0 ? auth.verifierKey : null;
  const expectedDigest =
    typeof auth.expectedInputDigest === 'string' && auth.expectedInputDigest.length > 0
      ? auth.expectedInputDigest
      : null;
  const requireInvocation = auth.requireInvocationId === true;
  const expectedInvocation =
    typeof auth.expectedInvocationId === 'string' && auth.expectedInvocationId.length > 0
      ? auth.expectedInvocationId
      : null;

  const evidenceBlocking: BlockingEntry[] = [];
  const block = (detail: string): void => {
    evidenceBlocking.push({
      kind: 'finding',
      resourceId: null,
      name: null,
      detail,
      location: null,
    });
  };

  const witnessedCount = records.filter(
    (record) =>
      typeof record === 'object' &&
      record !== null &&
      (record as { trust?: unknown })['trust'] === 'witnessed',
  ).length;

  // The run changed its own inputs around/after the suite (test-gates
  // post-suite check): the whole evidence run blocks, and active
  // waivers must not hide it — hence a dedicated blocker, always.
  if (auth.changedInputs === true) {
    block(
      'evidence-context: the test-gates run changed its own source or configuration inputs ' +
        'after the suite ran; pre-change evidence cannot certify the changed tree (fail closed)',
    );
  }
  if (auth.snapshotUnavailable === true && (witnessedCount > 0 || auth.changedInputs === true)) {
    block(
      'evidence-context: input snapshot unavailable (no usable Git inventory); ' +
        'evidence authorization is unavailable (snapshot-unavailable) — fail closed',
    );
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
  const validateEnvelope = (
    candidate: unknown,
    manifestRunId: string | null,
    label: 'durable' | 'live',
  ): { envelope: ValidEnvelope } | { rejection: EnvelopeRejection; detail: string } => {
    if (candidate === undefined || candidate === null) {
      return { rejection: 'missing', detail: `${label} attestation envelope is missing` };
    }
    // No trusted digest (snapshot unavailable, or the run changed its
    // own inputs): no envelope can validate — authorizing against an
    // unknown digest would reintroduce the F2 hole.
    if (expectedDigest === null || auth.changedInputs === true) {
      return {
        rejection: 'digest-mismatch',
        detail:
          auth.changedInputs === true
            ? `${label} attestation cannot authorize: the run changed its own inputs (fail closed)`
            : `${label} attestation cannot authorize: input snapshot unavailable (fail closed)`,
      };
    }
    const parsed = AttestationSchema.safeParse(candidate);
    if (!parsed.success) {
      const legacy =
        typeof candidate === 'object' &&
        candidate !== null &&
        'recordIdsMac' in candidate;
      return {
        rejection: 'malformed',
        detail:
          `${label} attestation envelope is malformed (expected attestationVersion 2 with ` +
          `runId, invocationId, inputDigest, sorted unique recordIds, and mac)` +
          (legacy ? '; legacy v1 recordIdsMac never authorizes evidence — run a fresh test-gates run' : ''),
      };
    }
    const envelope = parsed.data as Attestation;
    if (verifierKey === null) {
      return {
        rejection: 'mac-fail',
        detail: `${label} attestation cannot verify without a witness verifier key (fail closed)`,
      };
    }
    const macOk = verifyAttestationMac(
      verifierKey,
      {
        runId: envelope.runId,
        invocationId: envelope.invocationId,
        inputDigest: envelope.inputDigest,
        recordIds: envelope.recordIds,
      },
      envelope.mac,
    );
    if (!macOk) {
      return {
        rejection: 'mac-fail',
        detail: `${label} attestation signature fails; the envelope was forged or tampered (fail closed)`,
      };
    }
    if (expectedDigest !== null && envelope.inputDigest !== expectedDigest) {
      return {
        rejection: 'digest-mismatch',
        detail:
          `${label} attestation inputDigest does not match the current input snapshot; ` +
          'old evidence cannot certify changed source or configuration (fail closed)',
      };
    }
    if (requireInvocation && expectedInvocation !== null && envelope.invocationId !== expectedInvocation) {
      return {
        rejection: 'invocation-mismatch',
        detail:
          `${label} attestation invocationId does not match this test-gates invocation; ` +
          'a restored old bundle cannot satisfy a new invocation (fail closed)',
      };
    }
    if (manifestRunId !== null && manifestRunId !== envelope.runId) {
      return {
        rejection: 'manifest-run-mismatch',
        detail:
          `${label} attestation runId does not match the manifest runId; ` +
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

  const validEnvelopes: ValidEnvelope[] = [];
  let durablePresent = false;
  let durableRejection: EnvelopeRejection | null = null;
  let durableDetail: string | null = null;
  let legacyOnly = false;

  // Durable channel: the manifest's v2 attestation envelope.
  let manifestValue: Record<string, unknown> | null = null;
  try {
    manifestValue = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    manifestValue = null; // missing/unreadable manifest: durable channel unavailable
  }
  if (manifestValue !== null && typeof manifestValue === 'object') {
    const manifestRunId =
      typeof manifestValue['runId'] === 'string' && manifestValue['runId'].length > 0
        ? (manifestValue['runId'] as string)
        : null;
    const durable = (manifestValue as { attestation?: unknown })['attestation'];
    if (durable !== undefined) {
      durablePresent = true;
      const result = validateEnvelope(durable, manifestRunId, 'durable');
      if ('envelope' in result) {
        validEnvelopes.push(result.envelope);
      } else {
        durableRejection = result.rejection;
        durableDetail = result.detail;
      }
    } else if (
      Array.isArray((manifestValue as { recordIds?: unknown })['recordIds']) &&
      typeof (manifestValue as { recordIdsMac?: unknown })['recordIdsMac'] === 'string'
    ) {
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
  let liveRejection: EnvelopeRejection | null = null;
  let liveDetail: string | null = null;
  if (auth.live !== undefined && auth.live !== null) {
    const result = validateEnvelope(auth.live, null, 'live');
    if ('envelope' in result) {
      validEnvelopes.push(result.envelope);
    } else {
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
      block(
        'evidence-context: no witness verifier key; suite-writable artifacts alone cannot ' +
          'prove issuance and witnessed records demote (fail closed)',
      );
    } else if (!legacyOnly) {
      block(
        'evidence-context: no evidence attestation envelope found (missing); ' +
          'witnessed records demote (fail closed)',
      );
    }
  }

  const demoted = records.map((record) => {
    if (typeof record !== 'object' || record === null) return record;
    const candidate = record as { trust?: unknown; recordId?: unknown; runId?: unknown };
    if (candidate['trust'] !== 'witnessed') return record;
    const proven =
      typeof candidate['recordId'] === 'string' &&
      issuedRecordId.test(candidate['recordId']) &&
      validEnvelopes.some(
        (envelope) =>
          candidate['runId'] === envelope.runId && envelope.recordIds.has(candidate['recordId'] as string),
      );
    return proven ? record : { ...record, trust: 'claimed' };
  });

  return { records: demoted, evidenceBlocking: evidenceBlocking };
}