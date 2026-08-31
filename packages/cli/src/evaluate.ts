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
  BLOCKING_VERDICTS,
  evaluateObligations,
  loadWaivers,
  type BlockingEntry,
  type GateforgeConfig,
  type Obligation,
  type ObligationVerdict,
  type ResourceGraph,
  type WaiverCounts,
} from '@gateforge/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoPath, sourceByResourceId } from './pipeline.js';
import { readJsonArray } from './state.js';



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
  /** Blocking entries (unclassified/unresolved) from the policy result. */
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
  sources: Map<string, string>,
): BlockingEntry[] {
  const kept: BlockingEntry[] = [];
  for (const entry of blocking) {
    if (entry.kind === 'unclassified' && entry.resourceId !== null) {
      const source = sources.get(entry.resourceId);
      if (source !== undefined && changed.has(source)) kept.push(entry);
      continue;
    }
    if (entry.kind === 'unresolved' && entry.location !== null) {
      if (changed.has(entry.location.file)) kept.push(entry);
      continue;
    }
    // Unattributable entries stay visible: never hide a block we cannot
    // prove belongs to an unchanged file.
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
  for (const resource of graph.resources) {
    if (resource.id === null) continue;
    classifications.set(resource.id, resource.classification);
    detectors.set(resource.id, resource.detector);
  }

  const waiverLoad = loadWaivers(resolveRepoPath(cwd, config.waivers), { now });

  const claims = readJsonArray(stateDir, 'claims.json');
  const records = demoteUnprovenRecords(readJsonArray(stateDir, 'records.json'), stateDir);

  const scoped = scopeObligations(input);
  const verdicts: ObligationVerdict[] = [];
  for (const obligation of scoped) {
    const entries = evaluateObligations([obligation], {
      claims,
      records,
      waivers: waiverLoad.waivers,
      classification: classifications.get(obligation.resourceId) ?? null,
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

  const sources = sourceByResourceId(graph);
  const blocking =
    input.changedFiles === null || input.changedFiles === undefined
      ? [...input.blocking]
      : scopeBlocking(input.blocking, new Set(input.changedFiles), sources);

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
  const sources = sourceByResourceId(input.graph);
  return input.obligations.filter((obligation) => {
    const source = sources.get(obligation.resourceId);
    return source !== undefined && changed.has(source);
  });
}

/**
 * GF-23 provenance gate (ADR 0001 D2c): only records carrying
 * service-issued provenance — a sha256-hex recordId bound to THIS run
 * manifest — keep their `witnessed` tier. Anything else is demoted to
 * claimed-tier, which the engine grades invalid for evidence
 * contracts (never satisfied). Fail-closed: a missing/unreadable run
 * manifest demotes every witnessed record.
 */
function demoteUnprovenRecords(records: readonly unknown[], stateDir: string): unknown[] {
  let manifestRunId: string | null = null;
  try {
    const manifest = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')) as {
      runId?: unknown;
    };
    if (typeof manifest.runId === 'string') manifestRunId = manifest.runId;
  } catch {
    manifestRunId = null;
  }
  const issuedRecordId = /^[0-9a-f]{64}$/;
  return records.map((record) => {
    if (typeof record !== 'object' || record === null) return record;
    const candidate = record as { trust?: unknown; recordId?: unknown; runId?: unknown };
    if (candidate['trust'] !== 'witnessed') return record;
    const proven =
      typeof candidate['recordId'] === 'string' &&
      issuedRecordId.test(candidate['recordId']) &&
      candidate['runId'] === manifestRunId;
    return proven ? record : { ...record, trust: 'claimed' };
  });
}