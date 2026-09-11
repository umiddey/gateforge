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
import { fingerprint } from '../fingerprints.js';
import { compareStrings } from '../graph/util.js';
import type { ClassificationDecisionTrace } from '../classifier/schema.js';
import type { BlockingEntry } from '../policy/index.js';
import type { RunManifest } from '../schemas/run-manifest.js';
import type { Verdict } from '../schemas/verdict.js';
import { BLOCKING_VERDICTS, type ObligationVerdict } from '../verdict/index.js';

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

/** Options for {@link renderRun}. */
export interface RenderRunOptions {
  /** Output format. */
  format: 'json' | 'sarif' | 'text';
  /** Blocking entries (unclassified/unresolved/findings/stale references). */
  blocking?: readonly BlockingEntry[];
  /** Waiver-population counts; included in json/text when provided. */
  waiverCounts?: WaiverCounts;
  /** Run manifest; included in the json report when provided. */
  run?: RunManifest;
  /** Tool version stamped into SARIF `tool.driver.version`. */
  toolVersion?: string;
  /**
   * Classification decision provenance per resource id (ADR 0003):
   * decision fingerprint + rule trace, included in json/SARIF/text when
   * provided. Report-visible so any signal change (and hence any
   * fingerprint change) is auditable — never authoritative input.
   */
  classificationTraces?: Record<string, ClassificationDecisionTrace>;
  /**
   * Adoption-baseline forgiveness counts (phase 8 C), included in the
   * json summary and the text report when provided. Baselined debt is
   * LOUD on every run — a forgiveness that never announces itself is a
   * silent waiver, and there are none of those in gateforge.
   */
  baseline?: { obligations: number; blockingEntries: number };
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
          }
        : {}),
    },
    verdicts: entries.map((entry) => {
      const record: Record<string, unknown> = {
        obligationId: entry.obligation.id,
        resourceId: entry.obligation.resourceId,
        contract: entry.obligation.contract,
        policyId: entry.obligation.policyId,
        verdict: entry.verdict,
        reason: entry.reason,
        recordIds: entry.recordIds,
        fingerprint: fingerprint({
          resourceId: entry.obligation.resourceId,
          contract: entry.obligation.contract,
          policyId: entry.obligation.policyId,
          lifecycle: entry.obligation.lifecycle,
        }),
        trustTier: entry.trustTier,
      };
      if (entry.detector !== undefined && entry.detector !== null) {
        record['detector'] = entry.detector;
      }
      return record;
    }),
    blocking,
  };
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
  return report;
}

/** Builds the SARIF 2.1.0 projection (pin #10). */
function sarifReport(
  entries: readonly ObligationVerdict[],
  options: RenderRunOptions,
): Record<string, unknown> {
  const ruleIds = [...new Set(entries.map((entry) => entry.obligation.policyId))].sort(compareStrings);
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
        gateforgeFingerprint: fingerprint({
          resourceId: entry.obligation.resourceId,
          contract: entry.obligation.contract,
          policyId: entry.obligation.policyId,
          lifecycle: entry.obligation.lifecycle,
        }),
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
        // Blocking policy entries (unclassified/unresolved resources,
        // detector findings, stale references) are not obligation
        // verdicts, so they surface as tool-execution notifications
        // (SARIF 2.1.0 §3.20) instead of results — visible, error-level,
        // never silently omitted from the projection.
        invocations: [
          {
            toolExecutionNotifications: (options.blocking ?? []).map((entry) => ({
              level: 'error' as const,
              message: {
                text: `[${entry.kind}] ${entry.resourceId ?? entry.name ?? '<unnamed>'} — ${entry.detail}`,
              },
              properties: {
                kind: entry.kind,
                ...(entry.location !== null ? { location: entry.location } : {}),
              },
            })),
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
  if (options.waiverCounts !== undefined) {
    const wc = options.waiverCounts;
    lines.push(
      `waivers: ${wc.total} total, ${wc.active} active, ${wc.expired} expired, ` +
        `${wc.staleOwner} stale-owner`,
    );
  }
  if (options.baseline !== undefined) {
    lines.push(
      `baseline (adopted): ${options.baseline.obligations} obligation(s) + ` +
        `${options.baseline.blockingEntries} blocking entry(ies) forgiven — ` +
        `shrink-only: resolve debt, then 'gateforge baseline update'`,
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
    lines.push(
      `  fingerprint: ${fingerprint({
        resourceId: entry.obligation.resourceId,
        contract: entry.obligation.contract,
        policyId: entry.obligation.policyId,
        lifecycle: entry.obligation.lifecycle,
      })}`,
    );
    lines.push(`  evidence gap: ${entry.reason ?? '<none>'}`);
    lines.push(
      `  records: ${entry.recordIds.length > 0 ? entry.recordIds.join(', ') : '<none consulted>'}`,
    );
  }
  if (blocking.length > 0) {
    lines.push('');
    lines.push('blocking entries (unclassified/unresolved/findings/stale references):');
    for (const entry of blocking) {
      const where = entry.location !== null ? ` at ${entry.location.file}:${entry.location.line}` : '';
      lines.push(`  [${entry.kind}] ${entry.resourceId ?? entry.name ?? '<unnamed>'} — ${entry.detail}${where}`);
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
  return `${lines.join('\n')}\n`;
}
