/**
 * Run reports (architecture contract 4, invariant 8, pin #10): renders
 * per-obligation verdicts into one of three formats and maps a run to
 * its exit code.
 *
 * - `json`: GF-canonical JSON (recursively key-sorted, no whitespace) of
 *   the full report document — deterministic, snapshot-able.
 * - `sarif`: SARIF 2.1.0 projection (pin #10): ruleId = policyId,
 *   `partialFingerprints.gateforgeFingerprint`, blocking verdicts at
 *   level `error`, `waived` results carry a suppression with the waiver
 *   reason, properties carry resourceId/contract/verdict/trustTier.
 * - `text`: the invariant-8 trace — detector → policy → obligation →
 *   evidence gap — plus waiver counts. Every block names its evidence.
 *
 * Exit codes (contract 4): 0 clean/waived, 1 unresolved obligations
 * (any blocking verdict or blocking entry), 2 config/usage error.
 *
 * Rendering is pure and deterministic: identical inputs serialize
 * byte-for-byte identically.
 */
import { canonicalJson, type JsonValue } from '../canonical-json.js';
import { fingerprintObligation } from '../fingerprints.js';
import { compareStrings } from '../graph/util.js';
import type { ClassificationDecisionTrace, LifecycleDerivation } from '../classifier/schema.js';
import type { BlockingEntry } from '../policy/index.js';
import type { RunManifest } from '../schemas/run-manifest.js';
import type { Verdict } from '../schemas/verdict.js';
import { BLOCKING_VERDICTS, type ObligationVerdict } from '../verdict/index.js';
import { humanMessage } from './human-message.js';

/** The official SARIF 2.1.0 (errata 01) JSON schema location. */
const SARIF_SCHEMA_URI =
  'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

/** Waiver-population counts for report summaries (from the waivers loader). */
export interface WaiverCounts {
  /** All waivers found in the configured directory. */
  total: number;
  /** Valid at the injected `now` (five fields, unexpired, owner checked). */
  active: number;
  /** Expired at the injected `now` (GF-16) — blocking as `invalid`. */
  expired: number;
  /** Failed the owner check (GF-17) — blocking as `stale`. */
  staleOwner: number;
}

/**
 * Effective evaluation scope (plan §12.4): one decision, applied to
 * obligations and blockers alike. Output-only — the input-snapshot
 * digest never covers scope labels or report formats, so evidence reuse
 * for identical inputs is unaffected by scope selection.
 */
export interface ScopeMetadata {
  /** `all` = every obligation evaluated; `changed` = diff-narrowed. */
  mode: 'all' | 'changed';
  /** Sorted gate-defining inputs/reasons that forced expansion. */
  expandedBecause: readonly string[];
}

/** One resource's visible lifecycle derivation for report consumers. */
export interface LifecycleDerivationReportEntry extends LifecycleDerivation {
  /** Plane-qualified resource id when classification resolved it. */
  resourceId: string | null;
  /** Bare resource name remains available when its id is unresolved. */
  resourceName: string;
}

/** Measured work and whole-repository debt; descriptive only, never authorization. */
export interface RunExecutionSummary {
  /**
   * The slice this run graded: `full`, the `changed`-scope slice, or
   * `named`, the hand-picked `--test` selection — which is never
   * authoritative and never grades anything outside its selection.
   */
  scope: 'full' | 'changed' | 'named';
  mode: 'executed' | 'reused';
  testsPerformedThisInvocation: number;
  selectedTests: { selected: number; passed: number; failed: number; skipped: number; expectedFailures: number };
  selectedClaims: { selected: number; satisfied: number; blocking: number; blockingEntries: number; waived: number };
  /**
   * The whole-repository debt, defined once by `repositoryDebtOf`
   * (never recomputed beside it). `blocking` is the FROZEN legacy
   * total — repository blocking verdicts + repository findings, exactly
   * as it has always been computed. `newlyBlocking` is what THIS run's
   * exit code blocks on, which for a slice run is its own surface and
   * not the repository total; `notGradedBlocking` names the difference.
   * `baselined` is how much debt the adopted baseline forgave.
   */
  repositoryDebt: RepositoryDebt;
}

/**
 * The reason prefix the baseline forgiveness stamps on every verdict it
 * re-grades. Shared so the split is read back from what the evaluator
 * actually did, never from a second baseline-loading path.
 */
export const BASELINE_VERDICT_REASON = 'baselined:';

/** Whole-repository debt, one definition, shared by every surface. */
export interface RepositoryDebt {
  /** Every obligation this run graded over the repository. */
  obligations: number;
  /** Frozen legacy total: blocking verdicts + repository findings. */
  blocking: number;
  /** Repository findings (policy, mapping, inventory, coverage). */
  blockingEntries: number;
  /** Registered obligations this run saw no claim row for. */
  unclaimed: number;
  /** Obligations the adopted baseline forgave (claimed or not). */
  baselined: number;
  /**
   * What THIS run's exit code blocks on: the blocking verdicts and
   * findings of the surface it graded. A changed- or named-scope run
   * grades a slice, so out-of-scope debt is not in this number — it is
   * `notGradedBlocking` instead.
   */
  newlyBlocking: number;
  /**
   * Whole-repository debt that blocks but that this run never graded
   * (always 0 in a full-scope run). Reported, never counted as new:
   * a green changed-scope run must not look like a green repository.
   */
  notGradedBlocking: number;
}

/** Whether one graded verdict blocks the run (exit 1). */
function isBlockingVerdict(verdict: ObligationVerdict): boolean {
  return BLOCKING_VERDICTS.includes(verdict.verdict);
}

/**
 * THE repository-debt definition (plan §2, "One blocking number").
 *
 * Every surface that reports debt derives it here, from the GRADED
 * verdicts, so a run can never show two different counts: the split is
 * what the evaluator did, never a recount beside it. `baselined` is
 * read back from the reason the baseline forgiveness stamped on the
 * verdicts it re-graded, and `newlyBlocking` is exactly what THIS
 * run's exit code blocks on — the graded surface, never the whole
 * repository. A changed- or named-scope run that grades nothing
 * blocking therefore reports 0, with the debt it never observed named
 * apart as `notGradedBlocking`; a full-scope run reports 0 only when
 * nothing blocks. Two subtractions are deliberately absent: total minus
 * baselined (which printed `0 new blocking` next to real blockers) and
 * total minus scope (which would call a green slice's untouched debt
 * new).
 *
 * Args:
 *   verdicts: the whole-repository verdicts the report describes.
 *   findings: the whole-repository blocking entries the report describes.
 *   gradedVerdicts: the verdicts this run graded (the graded surface).
 *   gradedFindings: the blocking entries this run graded.
 *   unclaimed: registered obligations with no claim row.
 *
 * Returns:
 *   RepositoryDebt: the debt every surface must report.
 */
export function repositoryDebtOf(input: {
  readonly verdicts: readonly ObligationVerdict[];
  readonly findings: readonly BlockingEntry[];
  readonly gradedVerdicts: readonly ObligationVerdict[];
  readonly gradedFindings: readonly BlockingEntry[];
  readonly unclaimed: number;
}): RepositoryDebt {
  const gradedIds = new Set(input.gradedVerdicts.map((verdict) => verdict.obligation.id));
  const notGradedBlocking = input.verdicts.filter(
    (verdict) => isBlockingVerdict(verdict) && !gradedIds.has(verdict.obligation.id),
  ).length;
  const blockingEntries = input.findings.length;
  return {
    obligations: input.verdicts.length,
    blocking: input.verdicts.filter(isBlockingVerdict).length + blockingEntries,
    blockingEntries,
    unclaimed: input.unclaimed,
    baselined: input.verdicts.filter(
      (verdict) => verdict.verdict === 'waived' && (verdict.reason ?? '').startsWith(BASELINE_VERDICT_REASON),
    ).length,
    newlyBlocking: input.gradedVerdicts.filter(isBlockingVerdict).length + input.gradedFindings.length,
    notGradedBlocking,
  };
}

/** Safe identifiers that let operators compare two gate reports. */
export interface DiagnosticContext {
  scope: 'full' | 'changed' | 'named';
  candidateTreeId: string | null;
  inputDigest: string | null;
  evidenceState: string;
  authority: 'authoritative' | 'non-authoritative';
  /** Owner-approved documentation folders and their reduced trust guarantee. */
  docsExclusions?: {
    folders: readonly string[];
    approvalDigest: string | null;
    approvalStatus: 'matched' | 'mismatch' | 'missing' | 'invalid';
    guarantee: string;
  };
  /** Owner-approved Python bytecode files and their reduced trust guarantee. */
  cacheExclusions?: {
    files: readonly string[];
    approvalDigest: string | null;
    approvalStatus: 'matched' | 'mismatch' | 'missing' | 'invalid';
    guarantee: string;
  };
}

/** What a timing-chaos run did to the app's responses (E63). */
export interface ChaosReport {
  /** The `--chaos <seed>` the owner can replay. */
  seed: number;
  /** Upper bound of every applied delay, in whole milliseconds. */
  maxDelayMs: number;
  /** Whether a later response may be released before an earlier one. */
  reorder: boolean;
  /** Per-response release decisions (method + pathname, k, delay, reorder). */
  schedule?: readonly ChaosScheduleEntryReport[];
}

/** One recorded chaos release decision (never a secret: no query value). */
export interface ChaosScheduleEntryReport {
  /** Supervisor-issued test id the plan released under (never a credential). */
  session: string;
  /** `METHOD /pathname` (query stripped). */
  routeKey: string;
  /** 1-based index of the request under its route key. */
  k: number;
  /** The planned release offset: a pure function of seed/session/route/k. */
  plannedDelayMs: number;
  /** Milliseconds the response was actually held back. */
  delayMs: number;
  /** True when the plan released this response before the previous one. */
  releasedBefore: boolean;
}

/** Engine installation identity shown in human and machine reports. */
export interface EngineMetadata {
  /** Engine package version. */
  version: string;
  /** Registry source or local package path. */
  source: string;
  /** Whether CI must install a published version to use this code. */
  unpublished: boolean;
}
/** Options for {@link renderRun}. */
export interface RenderRunOptions {
  /** Output format. */
  format: 'json' | 'sarif' | 'text';
  /** Blocking entries (unclassified/unresolved/findings/stale references). */
  blocking?: readonly BlockingEntry[];
  /** Non-blocking notices; visible in every report format without changing the exit code. */
  advisories?: readonly BlockingEntry[];
  /** Waiver-population counts; included in json/text when provided. */
  waiverCounts?: WaiverCounts;
  /** Run manifest; included in the json report when provided. */
  run?: RunManifest;
  /** Tool version stamped into SARIF `tool.driver.version`. */
  toolVersion?: string;
  /** Engine installation identity shown in the report. */
  engine?: EngineMetadata;
  /** Marks non-authoritative selected-run output without changing exit codes. */
  outcome?: 'partial-selection';
  /**
   * The hand-picked `--test` selectors and the planned logical keys each
   * one resolved to (additive; present only for a named run). It reports
   * what ran and never grants gate authority.
   */
  selectors?: readonly { selector: string; logicalKeys: readonly string[] }[];
  /**
   * Effective evaluation scope (plan §12.4); included in json/SARIF and
   * summarized in text when the scope expanded. Defaults to the full
   * `all` scope when omitted.
   */
  scope?: ScopeMetadata;
  /** Optional count breakdown for supervised runner work, always descriptive. */
  execution?: RunExecutionSummary;
  /** Candidate identity and evidence state used to explain blocking entries. */
  diagnosticContext?: DiagnosticContext;
  /**
   * Classification decision provenance per resource id (ADR 0003):
   * decision fingerprint + rule trace, included in json/SARIF/text when
   * provided. Report-visible so any signal change (and hence any
   * fingerprint change) is auditable — never authoritative input.
   */
  classificationTraces?: Record<string, ClassificationDecisionTrace>;
  /** Lifecycle decisions derived from detector facts, visible in every report format. */
  lifecycleDerivation?: readonly LifecycleDerivationReportEntry[];
  /**
   * Timing chaos (E63): the seeded release plan this run executed
   * under. Present only for `test-gates --chaos <seed>`, and never
   * authority: a chaos run finds timing bugs, it never seals a
   * receipt. Omitted entirely without the flag, so a normal run's
   * report keeps exactly the keys it always had.
   */
  chaos?: ChaosReport;
  /**
   * Adoption-baseline forgiveness counts (phase 8 C), included in the
   * json summary and the text report when provided. Baselined debt is
   * LOUD on every run — a forgiveness that never announces itself is a
   * silent waiver, and there are none of those in gateforge.
   * `classificationBlocked` (two-layer adoption) counts blocking entries
   * waived via the receipt's adopted classification set.
   */
  baseline?: {
    obligations: number;
    blockingEntries: number;
    classificationBlocked?: number;
    adoptedAt?: string;
    ageDays?: number;
    neverWitnessed?: number;
  };
}

/** A run's exit code (architecture contract 4). */
export type RunExitCode = 0 | 1 | 2;

/**
 * Maps a run outcome to its exit code: 2 for config/usage errors,
 * 1 when any blocking verdict or blocking entry exists, else 0
 * (clean or waived).
 *
 * Args:
 *   input: verdicts, optional blocking entries, optional config-error flag.
 *
 * Returns:
 *   RunExitCode: 0 clean/waived, 1 unresolved, 2 config.
 */
export function runExitCode(input: {
  verdicts: readonly ObligationVerdict[];
  blocking?: readonly BlockingEntry[];
  configError?: boolean;
}): RunExitCode {
  if (input.configError) return 2;
  const hasBlockingEntries = (input.blocking ?? []).length > 0;
  const hasBlockingVerdicts = input.verdicts.some((entry) =>
    BLOCKING_VERDICTS.includes(entry.verdict),
  );
  return hasBlockingEntries || hasBlockingVerdicts ? 1 : 0;
}

/**
 * Renders a run's verdicts in the requested format. Output is canonical
 * JSON for `json`/`sarif` and deterministic text for `text`.
 *
 * Args:
 *   verdicts: per-obligation verdicts (any order; output is sorted).
 *   options: format, blocking entries, waiver counts, run manifest.
 *
 * Returns:
 *   string: the rendered report.
 *
 * Throws:
 *   Error: when `format` is not one of the three supported formats.
 */
export function renderRun(
  verdicts: readonly ObligationVerdict[],
  options: RenderRunOptions,
): string {
  const entries = [...verdicts].sort((a, b) => compareStrings(a.obligation.id, b.obligation.id));
  const blocking = [...(options.blocking ?? [])].sort(
    (a, b) =>
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.resourceId ?? '', b.resourceId ?? '') ||
      compareStrings(a.detail, b.detail),
  );
  // The report documents are JSON-safe by construction; the assertion
  // records that invariant at the canonical-serialization boundary.
  if (options.format === 'json') {
    return canonicalJson(jsonReport(entries, options, blocking) as unknown as JsonValue);
  }
  if (options.format === 'sarif') {
    return canonicalJson(sarifReport(entries, options) as unknown as JsonValue);
  }
  if (options.format === 'text') return textReport(entries, options, blocking);
  throw new Error(`renderRun: unknown format '${String(options.format)}'`);
}

/**
 * Orders lifecycle derivations by resource and canonical operation order.
 *
 * Args:
 *   entries: lifecycle derivation records from classification.
 *
 * Returns:
 *   LifecycleDerivationReportEntry[]: a sorted copy for stable reports.
 */
function orderedLifecycleDerivations(
  entries: readonly LifecycleDerivationReportEntry[],
): LifecycleDerivationReportEntry[] {
  const operationOrder: Record<LifecycleDerivation['operation'], number> = {
    read: 0,
    update: 1,
    delete: 2,
  };
  return [...entries].sort(
    (left, right) =>
      compareStrings(left.resourceId ?? left.resourceName, right.resourceId ?? right.resourceName) ||
      compareStrings(left.resourceName, right.resourceName) ||
      operationOrder[left.operation] - operationOrder[right.operation],
  );
}

/** Per-verdict summary counts keyed by verdict name. */
function summarize(entries: readonly ObligationVerdict[]): Record<Verdict, number> {
  const counts = {
    satisfied: 0,
    missing: 0,
    invalid: 0,
    unclassified: 0,
    unresolved: 0,
    waived: 0,
    stale: 0,
  } satisfies Record<Verdict, number>;
  for (const entry of entries) counts[entry.verdict] += 1;
  return counts;
}

/** Builds the canonical json-format report document. */
function jsonReport(
  entries: readonly ObligationVerdict[],
  options: RenderRunOptions,
  blocking: readonly BlockingEntry[],
): Record<string, unknown> {
  const counts = summarize(entries);
  // The blocking total covers BOTH sources of red: blocking verdicts and
  // policy blocking entries (findings/stale references block the gate
  // too — undercounting them would show "0 blocking" next to exit 1).
  const blockingCount =
    counts.missing +
    counts.invalid +
    counts.unclassified +
    counts.unresolved +
    counts.stale +
    blocking.length;
  const scope = options.scope ?? { mode: 'all' as const, expandedBecause: [] as readonly string[] };
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    summary: {
      obligations: entries.length,
      blocking: blockingCount,
      blockingEntries: blocking.length,
      ...counts,
      ...(options.baseline !== undefined
        ? {
            baselinedObligations: options.baseline.obligations,
            baselinedBlockingEntries: options.baseline.blockingEntries,
            ...(options.baseline.classificationBlocked !== undefined
              ? { baselinedClassificationBlocked: options.baseline.classificationBlocked }
              : {}),
            ...(options.baseline.adoptedAt !== undefined
              ? { adoptedBaselineAt: options.baseline.adoptedAt }
              : {}),
            ...(options.baseline.ageDays !== undefined
              ? { adoptedBaselineAgeDays: options.baseline.ageDays }
              : {}),
            ...(options.baseline.neverWitnessed !== undefined
              ? { neverWitnessedBaselinedObligations: options.baseline.neverWitnessed }
              : {}),
          }
        : {}),
    },
    // Effective scope (§12.4): which obligations were evaluated and why
    // the scope expanded. Output-only — never part of the snapshot digest.
    scope: { mode: scope.mode, expandedBecause: [...scope.expandedBecause] },
    verdicts: entries.map((entry) => {
      const message = humanMessage({
        id: entry.obligation.resourceId,
        cause: entry.cause,
        nextAction: entry.nextAction,
        reason: entry.reason,
        type: entry.verdict,
      });
      const record: Record<string, unknown> = {
        obligationId: entry.obligation.id,
        resourceId: entry.obligation.resourceId,
        contract: entry.obligation.contract,
        policyId: entry.obligation.policyId,
        verdict: entry.verdict,
        reason: entry.reason,
        cause: entry.cause ?? null,
        nextAction: entry.nextAction ?? null,
        recordIds: entry.recordIds,
        fingerprint: fingerprintObligation(entry.obligation),
        trustTier: entry.trustTier,
        message,
      };
      if (entry.inScopeBecause !== undefined) {
        record['inScopeBecause'] = entry.inScopeBecause;
      }
      if (entry.detector !== undefined && entry.detector !== null) {
        record['detector'] = entry.detector;
      }
      return record;
    }),
    blocking: blocking.map((entry) => ({
      ...entry,
      message: humanMessage({
        id: entry.resourceId ?? entry.name ?? undefined,
        cause: entry.cause,
        nextAction: entry.nextAction,
        detail: entry.detail,
        type: entry.kind,
      }),
    })),
  };
  if (options.advisories !== undefined && options.advisories.length > 0) {
    report['advisories'] = options.advisories;
  }
  if (options.run !== undefined) {
    report['run'] = options.run;
  }
  if (options.waiverCounts !== undefined) {
    report['waiverCounts'] = options.waiverCounts;
  }
  if (options.classificationTraces !== undefined) {
    // Canonical JSON sorts keys, so insertion order is irrelevant.
    report['classifications'] = options.classificationTraces;
  }
  if (options.lifecycleDerivation !== undefined && options.lifecycleDerivation.length > 0) {
    report['lifecycleDerivation'] = orderedLifecycleDerivations(options.lifecycleDerivation);
  }
  if (options.execution !== undefined) report['execution'] = options.execution;
  if (options.diagnosticContext !== undefined) report['diagnosticContext'] = options.diagnosticContext;
  if (options.engine !== undefined) report['engine'] = options.engine;
  if (options.outcome !== undefined) report['outcome'] = options.outcome;
  if (options.chaos !== undefined) {
    report['chaos'] = {
      seed: options.chaos.seed,
      maxDelayMs: options.chaos.maxDelayMs,
      reorder: options.chaos.reorder,
      ...(options.chaos.schedule !== undefined ? { schedule: options.chaos.schedule } : {}),
    };
  }
  if (options.selectors !== undefined) report['selectors'] = options.selectors;
  return report;
}

/** Builds the SARIF 2.1.0 projection (pin #10). */
function sarifReport(
  entries: readonly ObligationVerdict[],
  options: RenderRunOptions,
): Record<string, unknown> {
  const ruleIds = [...new Set(entries.map((entry) => entry.obligation.policyId))].sort(compareStrings);
  const scope = options.scope ?? { mode: 'all' as const, expandedBecause: [] as readonly string[] };
  const ruleIndex: Record<string, number> = {};
  ruleIds.forEach((ruleId, index) => {
    ruleIndex[ruleId] = index;
  });
  const results = entries.map((entry) => {
    const blocking = BLOCKING_VERDICTS.includes(entry.verdict);
    const result: Record<string, unknown> = {
      ruleId: entry.obligation.policyId,
      ruleIndex: ruleIndex[entry.obligation.policyId],
      level: blocking ? 'error' : 'none',
      message: {
        text:
          entry.reason ??
          `obligation '${entry.obligation.id}' is ${entry.verdict}`,
      },
      properties: {
        resourceId: entry.obligation.resourceId,
        contract: entry.obligation.contract,
        verdict: entry.verdict,
        trustTier: entry.trustTier,
        // Stable plan §5.4 cause + next action (ADR 0005), carried under
        // properties so SARIF consumers see the same codes as text/JSON.
        cause: entry.cause ?? null,
        nextAction: entry.nextAction ?? null,
        ...(options.classificationTraces?.[entry.obligation.resourceId] !== undefined
          ? {
              classificationFingerprint:
                options.classificationTraces[entry.obligation.resourceId]?.decisionFingerprint,
              classificationRules:
                options.classificationTraces[entry.obligation.resourceId]?.rules,
            }
          : {}),
      },
      partialFingerprints: {
        gateforgeFingerprint: fingerprintObligation(entry.obligation),
      },
    };
    if (entry.verdict === 'waived') {
      result['suppressions'] = [
        {
          kind: 'external',
          status: 'accepted',
          justification: entry.reason ?? 'waived',
        },
      ];
    }
    return result;
  });
  return {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'gateforge',
            version: options.toolVersion ?? '0.1.0',
            rules: ruleIds.map((ruleId) => ({ ruleId })),
          },
        },
        // Effective evaluation scope (§12.4) in the run property bag:
        // which obligations were evaluated and why the scope expanded.
        properties: {
          scope: { mode: scope.mode, expandedBecause: [...scope.expandedBecause] },
          ...(options.execution === undefined ? {} : { execution: options.execution }),
          ...(options.diagnosticContext === undefined ? {} : { diagnosticContext: options.diagnosticContext }),
          ...(options.lifecycleDerivation === undefined || options.lifecycleDerivation.length === 0
            ? {}
            : { lifecycleDerivation: orderedLifecycleDerivations(options.lifecycleDerivation) }),
        },
        // Blocking policy entries (unclassified/unresolved resources,
        // detector findings, stale references) are not obligation
        // verdicts, so they surface as tool-execution notifications
        // (SARIF 2.1.0 §3.20) instead of results — visible, error-level,
        // never silently omitted from the projection.
        invocations: [
          {
            toolExecutionNotifications: [
              ...(options.blocking ?? []).map((entry) => ({
                level: 'error' as const,
                message: {
                  text: `[${entry.kind}] ${entry.resourceId ?? entry.name ?? '<unnamed>'} — ${entry.detail}`,
                },
                properties: {
                  kind: entry.kind,
                  ...(entry.cause !== undefined && entry.cause !== null
                    ? { cause: entry.cause, nextAction: entry.nextAction ?? null }
                    : {}),
                  ...(entry.location !== null ? { location: entry.location } : {}),
                },
              })),
              ...(options.advisories ?? []).map((entry) => ({
                level: 'warning' as const,
                message: {
                  text: `[${entry.cause ?? entry.name ?? 'advisory'}] ${entry.detail}`,
                },
                properties: {
                  kind: entry.kind,
                  ...(entry.cause !== undefined && entry.cause !== null
                    ? { cause: entry.cause, nextAction: entry.nextAction ?? null }
                    : {}),
                  ...(entry.location !== null ? { location: entry.location } : {}),
                },
              })),
            ],
          },
        ],
        results,
      },
    ],
  };
}

/** One text-format trace block per non-satisfied verdict (invariant 8). */
function textReport(
  entries: readonly ObligationVerdict[],
  options: RenderRunOptions,
  blocking: readonly BlockingEntry[],
): string {
  const lines: string[] = [];
  const counts = summarize(entries);
  const blockingCount =
    counts.missing +
    counts.invalid +
    counts.unclassified +
    counts.unresolved +
    counts.stale +
    blocking.length;
  lines.push(
    `gateforge run: ${entries.length} obligation(s) — ` +
      `${counts.satisfied} satisfied, ${counts.waived} waived, ${blockingCount} blocking`,
  );
  if (options.engine !== undefined) {
    lines.push(`engine: ${options.engine.version} from ${options.engine.source}`);
    if (options.engine.unpublished) lines.push('unpublished engine: CI will not have this code');
  }
  if (options.chaos !== undefined) {
    // The one line that makes a red chaos run explainable and
    // replayable: the seed IS the schedule, and the owner never has to
    // guess which run produced the failure they are looking at.
    lines.push(
      `timing chaos: seed ${String(options.chaos.seed)} (max delay ${String(options.chaos.maxDelayMs)} ms, ` +
        `reorder ${options.chaos.reorder ? 'on' : 'off'}) — replay with --chaos ${String(options.chaos.seed)}`,
    );
  }
  const scope = options.scope;
  if (scope !== undefined && scope.expandedBecause.length > 0) {
    lines.push(
      `scope: all obligations; expanded because ${[...scope.expandedBecause].join(', ')}`,
    );
  }
  if (options.execution !== undefined) {
    const execution = options.execution;
    lines.push(
      `execution: ${execution.scope} scope, ${execution.mode}; ` +
        `${execution.testsPerformedThisInvocation} test(s) run in this invocation`,
    );
    lines.push(
      `selected tests: ${execution.selectedTests.passed} passed, ${execution.selectedTests.failed} failed ` +
        `(selected ${execution.selectedTests.selected}; ${execution.selectedTests.skipped} skipped; ` +
        `${execution.selectedTests.expectedFailures} expected failures)`,
    );
    lines.push(
      `selected claims: ${execution.selectedClaims.satisfied} satisfied, ${execution.selectedClaims.blocking} blocking ` +
        `(selected ${execution.selectedClaims.selected}; ${execution.selectedClaims.blockingEntries} blocking entries; ` +
        `${execution.selectedClaims.waived} waived)`,
    );
    // The line never prints a bare "blocking" count that differs from
    // the gate line: the baselined and the new debt are named apart,
    // and "new blocking" is what THIS run's exit code blocks on.
    lines.push(
      `repository debt: ${execution.repositoryDebt.baselined} known (baselined), ` +
        `${execution.repositoryDebt.newlyBlocking} new blocking / ${execution.repositoryDebt.obligations} obligations ` +
        `(${execution.repositoryDebt.unclaimed} unclaimed; ${execution.repositoryDebt.blockingEntries} blocking entries)`,
    );
    // A slice run grades only its own surface. Debt outside it is real
    // and reported, but it is not what this run blocks on — say so with
    // its own words instead of counting it as new.
    if (execution.repositoryDebt.notGradedBlocking > 0) {
      lines.push(
        `not graded by this ${execution.scope}-scope run: ${execution.repositoryDebt.notGradedBlocking} blocking obligation(s) — ` +
          'this run never observed them; a full run grades them',
      );
    }
    // A named run grades ONLY the selection it executed. Say the
    // remainder out loud, so a green named run is never misread as a
    // whole-repository verdict.
    if (execution.scope === 'named') {
      lines.push(
        `not graded in a named run: ${Math.max(0, execution.repositoryDebt.obligations - execution.selectedClaims.selected)} obligation(s) — ` +
          'a hand-picked selection never observed them; run the full suite for repository-wide verdicts',
      );
    }
  }
  if (options.diagnosticContext !== undefined) {
    const context = options.diagnosticContext;
    lines.push(
      `diagnostic context: scope=${context.scope} candidateTreeId=${context.candidateTreeId ?? '<unavailable>'} ` +
        `inputDigest=${context.inputDigest ?? '<unavailable>'} evidence=${context.evidenceState} authority=${context.authority}`,
    );
    if (context.docsExclusions !== undefined) {
      lines.push(
        `documentation exclusions: folders=${context.docsExclusions.folders.join(',')} ` +
          `approvalStatus=${context.docsExclusions.approvalStatus} ` +
          `approvalDigest=${context.docsExclusions.approvalDigest ?? '<missing>'} ` +
          `guarantee="${context.docsExclusions.guarantee}"`,
      );
    }
    if (context.cacheExclusions !== undefined) {
      lines.push(
        `Python cache exclusions: files=${context.cacheExclusions.files.join(',')} ` +
          `approvalStatus=${context.cacheExclusions.approvalStatus} ` +
          `approvalDigest=${context.cacheExclusions.approvalDigest ?? '<missing>'} ` +
          `guarantee=\"${context.cacheExclusions.guarantee}\"`,
      );
    }
  }
  if (options.lifecycleDerivation !== undefined && options.lifecycleDerivation.length > 0) {
    const grouped = new Map<string, LifecycleDerivationReportEntry[]>();
    for (const entry of orderedLifecycleDerivations(options.lifecycleDerivation)) {
      const key = `${entry.resourceId ?? ''}\u0000${entry.resourceName}`;
      const records = grouped.get(key);
      if (records === undefined) grouped.set(key, [entry]);
      else records.push(entry);
    }
    lines.push('', 'lifecycle derivation (detector facts):');
    for (const records of grouped.values()) {
      const first = records[0];
      if (first === undefined) continue;
      const detail = records
        .map(
          (entry) =>
            `${entry.operation}: ${entry.disposition} (${entry.reason}) — ${entry.detail}`,
        )
        .join('; ');
      lines.push(`  ${first.resourceId ?? first.resourceName}: ${detail}`);
    }
  }
  if (options.waiverCounts !== undefined) {
    const wc = options.waiverCounts;
    lines.push(
      `waivers: ${wc.total} total, ${wc.active} active, ${wc.expired} expired, ` +
        `${wc.staleOwner} stale-owner`,
    );
  }
  if (options.baseline !== undefined) {
    lines.push(
      `adopted baseline: ${options.baseline.obligations} obligation(s) + ` +
        `${options.baseline.blockingEntries} blocking entry(ies)` +
        (options.baseline.classificationBlocked !== undefined
          ? ` + ${options.baseline.classificationBlocked} classification-blocked resource(s)`
          : '') +
        (options.baseline.ageDays !== undefined
          ? `; age: ${options.baseline.ageDays} day(s); never witnessed: ${options.baseline.neverWitnessed ?? 0}`
          : '') +
        ` forgiven — shrink-only: resolve debt, then 'gateforge baseline update'`,
    );
  }
  for (const entry of entries) {
    if (entry.verdict === 'satisfied') continue;
    lines.push('');
    lines.push(`[${entry.verdict}] ${entry.obligation.id}`);
    if (entry.detector !== undefined && entry.detector !== null) {
      lines.push(`  detector: ${entry.detector.id}@${entry.detector.version}`);
    }
    lines.push(`  policy: ${entry.obligation.policyId}`);
    lines.push(`  obligation: ${entry.obligation.id}`);
    lines.push(`  fingerprint: ${fingerprintObligation(entry.obligation)}`);
    lines.push(`  message: ${humanMessage({
      id: entry.obligation.resourceId,
      cause: entry.cause,
      nextAction: entry.nextAction,
      reason: entry.reason,
      type: entry.verdict,
    })}`);
    if (entry.inScopeBecause !== undefined) {
      lines.push(`  in scope because: ${entry.inScopeBecause.join(', ') || '<no changed source path>'}`);
    }
    lines.push(`  evidence gap: ${entry.reason ?? '<none>'}`);
    if (entry.cause !== undefined && entry.cause !== null) {
      lines.push(`  cause: ${entry.cause}`);
      lines.push(`  next action: ${entry.nextAction ?? '<none>'}`);
    }
    lines.push(
      `  records: ${entry.recordIds.length > 0 ? entry.recordIds.join(', ') : '<none consulted>'}`,
    );
  }
  if (options.advisories !== undefined && options.advisories.length > 0) {
    lines.push('');
    lines.push('advisories (non-blocking):');
    for (const entry of options.advisories) {
      const where = entry.location !== null ? ` at ${entry.location.file}:${entry.location.line}` : '';
      lines.push(
        `  ${humanMessage({
          id: entry.resourceId ?? entry.name ?? undefined,
          cause: entry.cause,
          nextAction: entry.nextAction,
          detail: entry.detail,
          type: entry.kind,
        })}${where}`,
      );
    }
  }
  if (blocking.length > 0) {
    lines.push('');
    lines.push('blocking entries (unclassified/unresolved/findings/stale references):');
    for (const entry of blocking) {
      const where = entry.location !== null ? ` at ${entry.location.file}:${entry.location.line}` : '';
      const cause =
        entry.cause !== undefined && entry.cause !== null
          ? ` (cause: ${entry.cause} → ${entry.nextAction ?? 'no action available'})`
          : '';
      lines.push(
        `  ${humanMessage({
          id: entry.resourceId ?? entry.name ?? undefined,
          cause: entry.cause,
          nextAction: entry.nextAction,
          detail: entry.detail,
          type: entry.kind,
        })}${where}`,
      );
    }
  }
  if (options.classificationTraces !== undefined) {
    const ids = Object.keys(options.classificationTraces).sort(compareStrings);
    if (ids.length > 0) {
      lines.push('');
      lines.push('classification decisions (automatic, conservative — ADR 0003):');
      for (const id of ids) {
        const trace = options.classificationTraces[id];
        if (trace === undefined) continue;
        lines.push(`  ${id}`);
        lines.push(`    decision fingerprint: ${trace.decisionFingerprint}`);
        lines.push(`    rules: ${trace.rules.join(', ')}`);
        if (trace.defaultsApplied.length > 0) {
          lines.push(`    defaults applied: ${trace.defaultsApplied.join(', ')}`);
        }
        lines.push(`    contributing signals: ${trace.contributingSignalIds.length}`);
        if (trace.contradictions.length > 0) {
          for (const contradiction of trace.contradictions) {
            lines.push(`    contradiction [${contradiction.dimension}]: ${contradiction.detail}`);
          }
        }
      }
    }
  }
  lines.push('');
  lines.push(`exit code: ${runExitCode({ verdicts: entries, blocking })}`);
  if (options.outcome === 'partial-selection' && options.execution !== undefined) {
    lines.push(`Tests: ${options.execution.selectedTests.passed} passed.`);
    lines.push(`Claims: ${options.execution.selectedClaims.satisfied} satisfied.`);
    lines.push('Receipt: not sealed — partial selection (expected)');
  }
  return `${lines.join('\n')}\n`;
}
