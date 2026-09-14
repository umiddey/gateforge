/**
 * Supervised execution orchestration (plan 2026-09-13 Phase 4, ADR 0005
 * D2/D3): the CLI-side half of trusted runner supervision — planning the
 * expected test set from the resolved catalog/mappings, computing the
 * trusted policy digest and claim injections, sealing the execution
 * result, and issuing the authenticated gate receipt.
 *
 * Trust boundaries honored here:
 * - the expected set is fixed BEFORE the run, from discovery + the ONE
 *   mapping resolver — never from suite-side data;
 * - runner/reporter data is INPUT (parsed outcomes documents feed the
 *   core supervision module; nothing suite-writable is signature
 *   authority);
 * - receipts are issued ONLY after complete supervision success and
 *   evidence grading, signed with the same verifier-key authority as
 *   witness records (domain `gateforge.receipt.v1`).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CAUSE_NEXT_ACTIONS,
  ExecutionResultSchema,
  GateReceiptSchema,
  canonicalJson,
  executionResultDigestOf,
  gateReceiptMac,
  selectionDigestOf,
  sha256Canonical,
  superviseExecution,
  trustedPolicyDigest,
  verifyGateReceipt,
  type BlockingEntry,
  type CauseCode,
  type ExecutionResult,
  type ExecutedOutcome,
  type GateReceipt,
  type PlannedInstance,
  type ResolvedMappings,
  type RunnerExecutionEnvelope,
  type SupervisionFinding,
  type TestCatalog,
  type TracedTestInput,
} from '@gateforge/core';
import { TEST_MAP_RELATIVE } from './mapping.js';
import { normalizeRepoModule } from './input-snapshot.js';
import type { GateforgeConfig } from '@gateforge/core';
import type { RunnerOutcomesDocument } from '@gateforge/pack-playwright';
import { UsageError } from './errors.js';
import { environmentIdentity } from './input-snapshot.js';

/** The normalized invocation stamped into supervised receipts. */
export const SUPERVISED_INVOCATION = 'test-gates --changed';

/** Schema-valid placeholder mac used only to validate the draft body before signing. */
const RECEIPT_MAC_PLACEHOLDER = '0'.repeat(64);

/**
 * Computes the trusted policy/config revision digest (ADR 0005 D6) over
 * the trusted-revision-owned documents of the repository: `.gateforge.yml`,
 * the policies and classification-policy documents, the mapping
 * sidecar when present, the EXECUTABLE evidence adapters (`.mjs` modules
 * the witness loads engine-side), and the local in-process plugin
 * modules (review recheck 2026-09-14: executable adapters and plugins
 * can weaken the gate — detectors, evidence reads, scope — so a
 * candidate that edits them is a policy-revision change and cannot
 * approve its own weaker checks; a provisioned approved digest pins
 * their bytes too). Absent optional files contribute fixed
 * empty-bytes entries so the set is deterministic.
 *
 * Args:
 *   cwd: absolute repo root.
 *   configPaths: the resolved repo-relative config paths (policies,
 *     classificationPolicy) plus the optional sidecar path, the adapters
 *     dir, waivers dir, and the repo-relative plugin module specifiers.
 *
 * Returns:
 *   string: 64-char lowercase hex trusted policy digest.
 *
 * Throws:
 *   UsageError: when a REQUIRED trusted document exists but cannot be
 *     read (fail closed — an unreadable trusted revision is never
 *     hashed as empty).
 */
export function computeTrustedPolicyDigest(
  cwd: string,
  configPaths: {
    config: string;
    policies: string;
    classificationPolicy: string;
    sidecar: string;
    adaptersDir: string;
    waiverFiles: readonly string[];
    pluginModules: readonly string[];
  },
): string {
  const entry = (name: string, path: string, required: boolean): { name: string; bytes: string } => {
    const absolute = join(cwd, ...path.split('/'));
    if (!existsSync(absolute)) {
      if (required) {
        throw new UsageError(`trusted policy document '${path}' vanished mid-run — refusing to seal (fail closed)`);
      }
      return { name, bytes: '' };
    }
    try {
      return { name, bytes: readFileSync(absolute, 'utf8') };
    } catch (error) {
      throw new UsageError(`cannot read trusted policy document '${path}': ${(error as Error).message}`);
    }
  };
  // Executable inputs that can weaken the gate (review recheck
  // 2026-09-14): every adapter module the witness loads engine-side, and
  // every local in-process plugin module the pipeline imports. Their
  // BYTES belong to the trusted revision: a candidate that swaps a
  // hostile adapter or detection-suppressing plugin changes the digest
  // and cannot approve itself under a provisioned pin. Adapter absence
  // is an explicit marker (same convention as the input snapshot), and
  // every waiver file is hashed (waiver edits are gate-defining).
  const adapterDir = join(cwd, ...configPaths.adaptersDir.split('/'));
  const adapterEntries: Array<{ name: string; bytes: string }> = [];
  try {
    const names = readdirSync(adapterDir)
      .filter((name) => name.endsWith('.mjs'))
      .sort();
    if (names.length === 0) {
      adapterEntries.push({ name: `${configPaths.adaptersDir}/(no .mjs adapters)`, bytes: '' });
    }
    for (const name of names) {
      const relative = `${configPaths.adaptersDir}/${name}`;
      adapterEntries.push(entry(relative, relative, true));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new UsageError(
        `trusted policy digest cannot read the adapters dir '${configPaths.adaptersDir}': ${(error as Error).message}`,
      );
    }
    adapterEntries.push({ name: `${configPaths.adaptersDir}/(missing adapters dir)`, bytes: '' });
  }
  const waiverEntries = configPaths.waiverFiles
    .map((path) => entry(path, path, true))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pluginEntries = configPaths.pluginModules.map((module) => entry(module, module, true));
  return trustedPolicyDigest([
    entry('.gateforge.yml', configPaths.config, true),
    entry(configPaths.policies, configPaths.policies, true),
    entry(configPaths.classificationPolicy, configPaths.classificationPolicy, true),
    entry('.gateforge/test-map.yml', configPaths.sidecar, false),
    ...adapterEntries,
    ...waiverEntries,
    ...pluginEntries,
  ]);
}


/**
 * Builds the trusted-policy digest directly from a loaded config (the
 * common CLI shape): resolves the executable-input paths (adapters dir,
 * waiver files, local in-process plugin modules) and delegates to
 * {@link computeTrustedPolicyDigest}. All gate surfaces call this so the
 * digest is identical everywhere (check, broker, test-gates, doctor).
 *
 * Args:
 *   cwd: absolute repo root.
 *   config: the loaded gateforge config (paths + plugin declarations).
 *
 * Returns:
 *   string: 64-char lowercase hex trusted policy digest.
 */
export function trustedPolicyDigestForConfig(cwd: string, config: GateforgeConfig): string {
  const waiverFiles: string[] = [];
  const waiversDir = join(cwd, ...config.waivers.split('/'));
  try {
    const walk = (dir: string, prefix: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const item of entries) {
        const rel = `${prefix}/${item.name}`;
        if (item.isFile()) waiverFiles.push(rel);
        else if (item.isDirectory()) walk(join(dir, item.name), rel);
      }
    };
    walk(waiversDir, config.waivers);
  } catch {
    // Absent waivers dir: no waiver inputs (deterministic absence).
  }
  const pluginModules: string[] = [];
  for (const plugin of config.plugins) {
    const module = plugin.module;
    if (typeof module !== 'string') continue;
    if (!module.startsWith('./') && !module.startsWith('../')) continue;
    const normalized = normalizeRepoModule(module);
    if (normalized !== null) pluginModules.push(normalized);
  }
  return computeTrustedPolicyDigest(cwd, {
    config: '.gateforge.yml',
    policies: config.policies,
    classificationPolicy: config.classificationPolicy,
    sidecar: TEST_MAP_RELATIVE,
    adaptersDir: config.adapters,
    waiverFiles: [...new Set(waiverFiles)].sort(),
    pluginModules: [...new Set(pluginModules)].sort(),
  });
}

/**
 * The mapped obligation claims per reconciliation key (plan Phase 4
 * claim injection): SIDECAR bindings join the catalog so a mapped test's
 * runtime evidence lands on the right claims. Keys are
 * `<file>#<titlePath.join('>')>` — the same reconciliation key the
 * reporter computes from the runner's own test events. Claims are
 * DECLARATIONS; they never satisfy anything by themselves.
 *
 * Native annotations never inject: the trusted reporter reads them
 * directly from the CURRENT run's test cases, so injection would add
 * nothing — and the resolver's native origin is the PRIOR run's
 * run-state claims.json, which must never be re-attached to this run's
 * tests (a stale or file-wide native row would re-attribute another
 * test's claims onto this run's evidence). The sidecar is exactly the
 * claim source the runner cannot see on its own (plan E02).
 *
 * Args:
 *   resolution: the resolved-mappings surface (Phase 3 resolver output).
 *   catalog: the current catalog (instance identities).
 *
 * Returns:
 *   Record<string, string[]>: reconciliation key → sorted obligation ids.
 */
export function claimInjectionsFor(
  resolution: ResolvedMappings,
  catalog: TestCatalog,
): Record<string, string[]> {
  const catalogByKey = new Map(
    catalog.entries.map((entry) => [
      `${entry.file}#${entry.titlePath.join('>')}`,
      entry.logicalKey,
    ]),
  );
  const byKey = new Map<string, Set<string>>();
  for (const obligation of resolution.obligations) {
    for (const binding of obligation.bindings) {
      // Sidecar only: annotations ride the native reporter path; native/
      // inferred/prior-run binding rows derive from run state or heuristics
      // and never route this run's evidence.
      if (binding.origin !== 'sidecar') continue;
      for (const instance of binding.instances) {
        const key = `${instance.file}#${instance.titlePath.join('>')}`;
        // Only inject when the CURRENT catalog still enumerates the
        // instance — a stale binding injects nothing (stale mappings are
        // the resolver's typed problems, not silent injections).
        if (!catalogByKey.has(key)) continue;
        const set = byKey.get(key) ?? new Set<string>();
        set.add(obligation.obligationId);
        byKey.set(key, set);
      }
    }
  }
  const out: Record<string, string[]> = {};
  for (const [key, set] of [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    out[key] = [...set].sort();
  }
  return out;
}

/** The planned expected set fixed BEFORE the run (per catalog row). */
export interface PlannedRow {
  /** The planned instance (schema shape). */
  planned: PlannedInstance;
  /** The supervision input (blocking annotations, unenumerated reason). */
  input: {
    logicalKey: string;
    project: string | null;
    file: string;
    titlePath: string[];
    blockingAnnotations: string[];
    unenumeratedReason?: string;
  };
}

/**
 * Plans the expected test set from the catalog (plan Phase 4 item 2, §3.3
 * rule 5): the complete configured relevant playwright suite. Narrower
 * selection is never guessed — until dependency/journey mapping is
 * proven (Phase 5+), the conservative full relevant suite always runs.
 * Catalog rows carry the pre-run honesty signals: `.only`/`.skip`/
 * `.fixme` annotations and cases the runner never enumerated.
 *
 * Args:
 *   catalog: the freshly discovered catalog.
 *
 * Returns:
 *   PlannedRow[]: one row per planned playwright instance, sorted by
 *   logical key.
 */
export function planExpectedSet(catalog: TestCatalog): PlannedRow[] {
  const rows: PlannedRow[] = [];
  for (const entry of catalog.entries) {
    if (entry.runner !== 'playwright') continue;
    const blockingAnnotations = [
      ...new Set(
        entry.suppressionSignals
          .filter((signal) => signal.kind === 'only' || signal.kind === 'skip' || signal.kind === 'fixme')
          .map((signal) => signal.kind),
      ),
    ].sort();
    const unenumerated =
      entry.discoveryStatus === 'unresolved' && entry.unresolvedReason !== undefined
        ? `${entry.unresolvedReason.code}: ${entry.unresolvedReason.detail}`
        : undefined;
    const planned: PlannedInstance = {
      logicalKey: entry.logicalKey,
      project: entry.project,
      file: entry.file,
      titlePath: [...entry.titlePath],
      frameworkId: entry.parameterIdentity,
    };
    rows.push({
      planned,
      input: {
        logicalKey: entry.logicalKey,
        project: entry.project,
        file: entry.file,
        titlePath: [...entry.titlePath],
        blockingAnnotations,
        ...(unenumerated !== undefined ? { unenumeratedReason: unenumerated } : {}),
      },
    });
  }
  rows.sort((a, b) => (a.planned.logicalKey < b.planned.logicalKey ? -1 : 1));
  return rows;
}

/**
 * Resolves executed outcome rows (reporter data, input only) into
 * schema-shaped outcomes: logical keys join through the planned set's
 * instance identity; rows outside the plan keep their framework-side
 * identity string so the supervision mismatch names them.
 *
 * Args:
 *   outcomesDoc: the parsed runner-outcomes document (or null).
 *   plannedRows: the planned rows (identity join).
 *
 * Returns:
 *   ExecutedOutcome[]: supervision-normalized executed outcomes.
 */
export function executedOutcomesOf(
  outcomesDoc: RunnerOutcomesDocument | null,
  plannedRows: readonly PlannedRow[],
): ExecutedOutcome[] {
  if (outcomesDoc === null) return [];
  const logicalKeyByKey = new Map(
    plannedRows.map((row) => [
      `${row.planned.project ?? '-'}\u0000${row.planned.file}\u0000${row.planned.titlePath.join('>')}`,
      row.planned.logicalKey,
    ]),
  );
  return outcomesDoc.outcomes.map((row) => {
    const key = `${row.project ?? '-'}\u0000${row.file}\u0000${row.titlePath.join('>')}`;
    return {
      logicalKey: logicalKeyByKey.get(key) ?? `${row.file}#${row.titlePath.join('>')}`,
      project: row.project,
      file: row.file,
      titlePath: [...row.titlePath],
      status: normalizeOutcomeStatus(row.status),
      attempt: row.attempt >= 1 ? row.attempt : 1,
      expectedFailure: row.expectedFailure === true,
    };
  });
}

/** Maps runner status strings onto the outcome vocabulary (unknown = failed). */
function normalizeOutcomeStatus(status: string): ExecutedOutcome['status'] {
  if (status === 'passed' || status === 'failed' || status === 'skipped' || status === 'fixme' || status === 'not-run') {
    return status;
  }
  return 'failed';
}

/** Shard-completeness projection (undefined envelope shards = unsharded). */
function shardCompletenessOf(shards: RunnerExecutionEnvelope['shards']): {
  complete: boolean;
  detail: string;
} {
  if (shards === null || shards === undefined) return { complete: true, detail: '' };
  return { complete: shards.complete, detail: shards.detail };
}

/** Everything {@link sealExecutionResult} needs. */
export interface SealExecutionResultInput {
  /** Run manifest identity. */
  runId: string;
  /** Fresh trusted invocation id. */
  invocationId: string;
  /** Tested input digest. */
  inputDigest: string;
  /** Trusted policy/config revision digest. */
  trustedPolicyDigest: string;
  /** Runner the selection executes under. */
  runner: string;
  /** Logical keys selected. */
  logicalKeys: readonly string[];
  /** The catalog the selection was planned from. */
  catalog: TestCatalog;
  /** Planned rows (from {@link planExpectedSet}). */
  plannedRows: readonly PlannedRow[];
  /** The adapter's structured envelope. */
  envelope: RunnerExecutionEnvelope;
  /** Parsed runner-outcomes document (input; may be null when missing). */
  outcomesDoc: RunnerOutcomesDocument | null;
  /**
   * The witness-side session trace (enforcement-review fix 2b; additive
   * optional input): the EXECUTION AUTHORITY. An array is graded by the
   * core supervision module (every expected test must have sealed
   * passing session(s)); `null` blocks the run (trace unavailable);
   * `undefined` keeps the legacy outcomes-based grading (test seam).
   */
  sessionTrace?: readonly TracedTestInput[] | null;
  /**
   * 64-hex digest over the expected set the witness registered before
   * the run (enforcement-review fix 2d; additive optional) — sealed into
   * the execution result so receipts bind the enforced expected set.
   */
  enumerationDigest?: string;
  /** Run start/end instants (ISO-8601). */
  startedAt: string;
  finishedAt: string;
}

/** The sealed execution result plus its digest. */
export interface SealedExecutionResult {
  /** The schema-valid execution result. */
  result: ExecutionResult;
  /** Its domain-separated digest (the receipt binds this). */
  digest: string;
}

/**
 * Seals the supervision execution result (plan §5.1, Phase 4 item 3):
 * runs the core expected-set enforcement over (planned, executed) and
 * assembles the strict-schema record. `complete` is true only when
 * supervision found nothing — the receipt is issued only from a sealed
 * result with `complete: true` and a clean gate.
 *
 * Args:
 *   input: run identity, digests, planned rows, envelope, and outcomes
 *     document.
 *
 * Returns:
 *   SealedExecutionResult: the validated record + digest.
 *
 * Throws:
 *   UsageError: when the assembled record fails the strict schema (a
 *     supervision/assembly bug — fail closed, never seal a malformed
 *     record).
 */
export function sealExecutionResult(input: SealExecutionResultInput): SealedExecutionResult {
  const selection = {
    runner: input.runner,
    mode: 'full-relevant-suite' as const,
    logicalKeys: [...new Set(input.logicalKeys)].sort(),
  };
  const executed = executedOutcomesOf(input.outcomesDoc, input.plannedRows);
  const supervision = superviseExecution(
    input.plannedRows.map((row) => row.input),
    {
      processExit: input.envelope.processExit,
      complete: input.envelope.complete,
      ...(input.envelope.incompleteDetail !== undefined ? { incompleteDetail: input.envelope.incompleteDetail } : {}),
      outcomes: executed,
      fixtureOutcome: input.envelope.fixtureOutcome ?? 'unknown',
      shards: input.envelope.shards ?? null,
      retriesDetected: input.envelope.retriesDetected === true,
      ...(input.envelope.retriesDetail !== undefined ? { retriesDetail: input.envelope.retriesDetail } : {}),
      ...(input.sessionTrace !== undefined ? { sessionTrace: input.sessionTrace } : {}),
    },
  );
  const environmentIdentityDigest = environmentIdentity({
    ...(input.envelope.engines ?? {}),
    ...(input.envelope.browsers ?? {}),
  });
  const attempts = executed.map((outcome) => outcome.attempt);
  const draft: ExecutionResult = ExecutionResultSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    invocationId: input.invocationId,
    inputDigest: input.inputDigest,
    trustedPolicyDigest: input.trustedPolicyDigest,
    selection,
    selectionDigest: selectionDigestOf(selection),
    catalogDigest: sha256Canonical(input.catalog as unknown as Record<string, never>),
    planned: input.plannedRows.map((row) => row.planned),
    outcomes: executed,
    ...(input.enumerationDigest !== undefined ? { enumerationDigest: input.enumerationDigest } : {}),
    ...(input.sessionTrace !== undefined && input.sessionTrace !== null
      ? { sessionTrace: input.sessionTrace }
      : {}),
    runnerExit: input.envelope.processExit,
    complete: supervision.complete,
    causes: supervision.findings.map((finding) => ({
      cause: finding.cause,
      detail: finding.detail,
      logicalKey: finding.logicalKey,
    })),
    fixtureOutcome: input.envelope.fixtureOutcome ?? 'unknown',
    shardCompleteness: shardCompletenessOf(input.envelope.shards),
    maxAttemptObserved: attempts.reduce((max, attempt) => Math.max(max, attempt), 1),
    engines: input.envelope.engines ?? {},
    browsers: input.envelope.browsers ?? {},
    environmentIdentity: environmentIdentityDigest,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });
  return { result: draft, digest: executionResultDigestOf(draft) };
}

/** Everything {@link issueGateReceipt} needs. */
export interface IssueGateReceiptInput {
  /** Witness verifier key (the SAME authority as witness records). */
  verifierKey: string;
  /** Run manifest identity. */
  runId: string;
  /** Fresh trusted invocation id. */
  invocationId: string;
  /** Tested input digest. */
  inputDigest: string;
  /** Candidate HEAD sha (or null). */
  gitSha: string | null;
  /** Parent commit sha (or null). */
  parentSha: string | null;
  /** Trusted policy/config revision digest. */
  trustedPolicyDigest: string;
  /**
   * Owner-approved policy revision digest the run was pinned to
   * (review 2026-09-13 P1 #5), when strict enforcement provisioned one
   * (GATEFORGE_APPROVED_POLICY_DIGEST / --approved-policy-digest /
   * trusted config outside the candidate). OPTIONAL and additive: when
   * absent the receipt omits the field (v1 backward compatibility); when
   * present it is covered by the receipt MAC and demanded again at
   * verification under a provisioned pin.
   */
  approvedPolicyDigest?: string | null;
  /** Normalized invocation. */
  invocation: string;
  /** Selection digest. */
  selectionDigest: string;
  /** Catalog digest. */
  catalogDigest: string;
  /** Sealed execution-result digest. */
  executionResultDigest: string;
  /** Evidence attestation digest, or null when the run carried none. */
  evidenceAttestationDigest: string | null;
  /** Final verdict summary (blocking must be 0). */
  verdictSummary: { total: number; satisfied: number; waived: number; blocking: number };
  /** Issuance instant (ISO-8601). */
  issuedAt: string;
}

/**
 * Issues the authenticated gate receipt (plan Phase 4 item 5, ADR 0005
 * D3): a versioned, domain-separated envelope signed with the witness
 * verifier key — the same authority as witness records, never a second
 * weaker system. Callers must ONLY invoke this after complete
 * supervision success and clean evidence grading (blocking 0).
 *
 * Args:
 *   input: the full binding set + verdict summary + verifier key.
 *
 * Returns:
 *   GateReceipt: the signed receipt.
 *
 * Throws:
 *   UsageError: when blocking > 0 (a receipt is never issued for a
 *     blocking run) or the signed record fails its own schema.
 */
export function issueGateReceipt(input: IssueGateReceiptInput): GateReceipt {
  if (input.verdictSummary.blocking !== 0) {
    throw new UsageError('refusing to issue a gate receipt for a blocking run (fail closed)');
  }
  // Structural validation first: parse the draft under the strict schema
  // with a placeholder mac (the real MAC is computed over the VALIDATED
  // body so the signed bytes are exactly the schema-checked bytes).
  const parsed = GateReceiptSchema.parse({
    schemaVersion: 1,
    receiptVersion: 1,
    receiptId: randomUUID(),
    runId: input.runId,
    invocationId: input.invocationId,
    inputDigest: input.inputDigest,
    gitSha: input.gitSha,
    parentSha: input.parentSha,
    trustedPolicyDigest: input.trustedPolicyDigest,
    // Additive approved-policy binding (review 2026-09-13 P1 #5):
    // included ONLY when strict enforcement provisioned a pin, so
    // receipts sealed without one stay byte-compatible with v1.
    ...(input.approvedPolicyDigest ? { approvedPolicyDigest: input.approvedPolicyDigest } : {}),
    invocation: input.invocation,
    selectionDigest: input.selectionDigest,
    catalogDigest: input.catalogDigest,
    executionResultDigest: input.executionResultDigest,
    evidenceAttestationDigest: input.evidenceAttestationDigest,
    verdictSummary: input.verdictSummary,
    issuedAt: input.issuedAt,
    mac: RECEIPT_MAC_PLACEHOLDER,
  });
  const { mac: placeholder, ...body } = parsed;
  void placeholder;
  const signed: GateReceipt = { ...parsed, mac: gateReceiptMac(input.verifierKey, body) };
  // Self-check: the issued receipt must verify under its own authority.
  const verified = verifyGateReceipt(input.verifierKey, signed);
  if (!verified.ok) {
    throw new UsageError(`issued gate receipt failed self-verification (${verified.rejection}) — fail closed`);
  }
  return signed;
}

/**
 * Reads the parent commit sha (HEAD~1-equivalent) for the receipt's
 * base/parent identity, or null when unavailable (initial commit, non-Git).
 *
 * Args:
 *   cwd: repo root.
 *
 * Returns:
 *   string | null: 40-char sha or null.
 */
export function parentSha(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD^'], { cwd, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return null;
  const sha = (result.stdout ?? '').trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Projects supervision findings into gate blocking entries (typed, plan
 * §5.4 run causes) — never diff-scoped away, never waived.
 *
 * Args:
 *   findings: supervision findings.
 *
 * Returns:
 *   BlockingEntry[]: one blocking entry per finding, sorted.
 */
export function supervisionBlocking(findings: readonly SupervisionFinding[]): BlockingEntry[] {
  return findings.map((finding): BlockingEntry => {
    const cause: CauseCode = finding.cause;
    return {
      kind: 'finding',
      resourceId: null,
      name: finding.logicalKey,
      detail: finding.detail,
      location: null,
      cause,
      nextAction: CAUSE_NEXT_ACTIONS[cause],
    };
  });
}

/** Serializes a receipt for the run-state file (canonical JSON + newline). */
export function serializeReceipt(receipt: GateReceipt): string {
  return `${canonicalJson(receipt as unknown as Record<string, never>)}\n`;
}
