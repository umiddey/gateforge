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
  evaluateObligations,
  loadWaivers,
  verifyAttestationMac,
  type Attestation,
  type BlockingEntry,
  type GateforgeConfig,
  type Obligation,
  type ObligationVerdict,
  type ResourceGraph,
  type WaiverCounts,
} from '@gateforge/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoPath, sourcesByResourceId } from './pipeline.js';
import { httpRoutesView, readJsonArray } from './state.js';



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

  const claims = readJsonArray(stateDir, 'claims.json');
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
  const verdicts: ObligationVerdict[] = [];
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
    if (entry === undefined) continue;
    verdicts.push({
      ...entry,
      detector: detectors.get(obligation.resourceId) ?? null,
    });
  }
  verdicts.sort((a, b) => (a.obligation.id < b.obligation.id ? -1 : a.obligation.id > b.obligation.id ? 1 : 0));

  const sources = sourcesByResourceId(graph);
  const scopedBlocking =
    input.changedFiles === null || input.changedFiles === undefined
      ? [...input.blocking]
      : scopeBlocking(input.blocking, new Set(input.changedFiles), sources);
  // Evidence-context blockers are never diff-scoped away and never
  // waived: a changed-input or unauthenticated-evidence run must stay
  // visible even when every obligation is waived or unchanged.
  const blocking = [...scopedBlocking, ...authorized.evidenceBlocking];

  const blockingRun =
    blocking.length > 0 || verdicts.some((entry) => BLOCKING_VERDICTS.includes(entry.verdict));

  return {
    verdicts,
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
function scopeObligations(input: EvaluateInput): Obligation[] {
  if (input.changedFiles === null || input.changedFiles === undefined) {
    return [...input.obligations];
  }
  const changed = new Set(input.changedFiles);
  const sources = sourcesByResourceId(input.graph);
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