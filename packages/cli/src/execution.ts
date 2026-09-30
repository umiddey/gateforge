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
  compareStrings,
  executionResultDigestOf,
  gateReceiptMac,
  selectionDigestOf,
  sha256Canonical,
  superviseExecution,
  trustedPolicyDigest,
  verifyGateReceipt,
  RunRecordSchema,
  runRecordMac,
  verifyRunRecord,
  type RunRecord,
  type BlockingEntry,
  type CauseCode,
  type Claim,
  type ExecutionResult,
  type ExecutedOutcome,
  type GateReceipt,
  type BehaviorCatalog,
  type Obligation,
  type PlannedInstance,
  type ResolvedMappings,
  type ResourceGraph,
  type RunnerExecutionEnvelope,
  type RunnerInstanceOutcome,
  type SupervisionFinding,
  type TestCatalog,
  type TracedTestInput,
} from '@gate-forge/core';
import { QUARANTINE_DIR } from '@gate-forge/core';
import { obligationFingerprint } from './evaluate.js';
import { TEST_MAP_RELATIVE } from './mapping.js';
import { sourcesByResourceId } from './pipeline.js';
import { normalizeRepoModule } from './input-snapshot.js';
import { DOCS_EXCLUSIONS_PATH } from './docs-exclusions.js';
import { CACHE_EXCLUSIONS_PATH } from './cache-exclusions.js';
import type { GateforgeConfig } from '@gate-forge/core';
import type { ProjectScope, RunnerOutcomesDocument } from '@gate-forge/pack-playwright';
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
    behaviorPolicy?: string | null;
    runtimePolicy?: string | null;
    sidecar: string;
    adaptersDir: string;
    waiverFiles: readonly string[];
    quarantineFiles?: readonly string[];
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
  // Flaky-test quarantines remove tests from
  // the REQUIRED set, so their bytes belong to the pinned revision exactly
  // like waiver bytes do: an agent-authored quarantine is a policy change
  // and cannot authorize its own weaker run. A repository with no
  // quarantine directory contributes NO entries, so the digest of a repo
  // that never adopted quarantine is byte-identical to before.
  const quarantineEntries = (configPaths.quarantineFiles ?? [])
    .map((path) => entry(path, path, true))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pluginEntries = configPaths.pluginModules.map((module) => entry(module, module, true));
  const behaviorEntry =
    configPaths.behaviorPolicy === undefined || configPaths.behaviorPolicy === null
      ? { name: '.gateforge/behavior.yml (absent)', bytes: '' }
      : entry(configPaths.behaviorPolicy, configPaths.behaviorPolicy, true);
  // The staged-runtime document is security-sensitive (plan 2026-09-21):
  // its commands start processes and its reuse list sanctions the only
  // dependency bridge into the candidate — a candidate that edits its
  // own runtime commands is a policy-revision change.
  const runtimeEntry =
    configPaths.runtimePolicy === undefined || configPaths.runtimePolicy === null
      ? { name: '.gateforge/runtime.yml (absent)', bytes: '' }
      : entry(configPaths.runtimePolicy, configPaths.runtimePolicy, true);
  const docsExclusionsEntry = existsSync(join(cwd, ...DOCS_EXCLUSIONS_PATH.split('/')))
    ? [entry(DOCS_EXCLUSIONS_PATH, DOCS_EXCLUSIONS_PATH, true)]
    : [];
  const cacheExclusionsEntry = existsSync(join(cwd, ...CACHE_EXCLUSIONS_PATH.split('/')))
    ? [entry(CACHE_EXCLUSIONS_PATH, CACHE_EXCLUSIONS_PATH, true)]
    : [];
  return trustedPolicyDigest([
    entry('.gateforge.yml', configPaths.config, true),
    entry(configPaths.policies, configPaths.policies, true),
    entry(configPaths.classificationPolicy, configPaths.classificationPolicy, true),
    behaviorEntry,
    runtimeEntry,
    ...docsExclusionsEntry,
    ...cacheExclusionsEntry,
    entry('.gateforge/test-map.yml', configPaths.sidecar, false),
    ...adapterEntries,
    ...waiverEntries,
    ...quarantineEntries,
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
  const quarantineFiles: string[] = [];
  const quarantineDir = join(cwd, ...QUARANTINE_DIR.split('/'));
  try {
    for (const item of readdirSync(quarantineDir, { withFileTypes: true })) {
      if (item.isFile() && item.name.endsWith('.yml')) {
        quarantineFiles.push(`${QUARANTINE_DIR}/${item.name}`);
      }
    }
  } catch {
    // Absent quarantine dir: no quarantine inputs (deterministic absence).
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
    behaviorPolicy: config.behaviorPolicy ?? null,
    runtimePolicy: config.runtime ?? null,
    sidecar: TEST_MAP_RELATIVE,
    adaptersDir: config.adapters,
    waiverFiles: [...new Set(waiverFiles)].sort(),
    quarantineFiles: [...new Set(quarantineFiles)].sort(),
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
 * Groups the plan's test files by the project each row belongs to, so the
 * supervised run can scope files per project instead of collecting every
 * selected file under every project.
 *
 * Project identity is the join key the whole pipeline speaks: catalog rows,
 * the registered expected set, session opens, and the execution trace all
 * key on `(project, file, titlePath)`. A project-scoped config — most
 * importantly the standard Playwright auth pattern, a `setup` project with
 * `testMatch: /.*\.setup\.ts/` plus a dependent project — therefore needs the
 * RUN to select files per project too, or the runner executes identities the
 * expected set never bound (their sessions are refused, so they produce no
 * evidence) and the executed count outruns the planned total.
 *
 * A project-less row contributes to no scope: its file stays in the global
 * selection so the row still executes.
 *
 * Args:
 *   rows: the planned expected set (fixed before the run).
 *
 * Returns:
 *   ProjectScope[]: one entry per project that owns at least one file,
 *   sorted by project name.
 */
export function plannedProjectScopes(rows: readonly PlannedRow[]): ProjectScope[] {
  const filesByProject = new Map<string, Set<string>>();
  for (const row of rows) {
    const project = row.planned.project;
    if (project === null || project.length === 0) continue;
    const files = filesByProject.get(project) ?? new Set<string>();
    files.add(row.planned.file);
    filesByProject.set(project, files);
  }
  return [...filesByProject.entries()]
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * The obligation slice a `--scope changed` run must certify (plan Goal 2,
 * opt-in scoped sealing): the changed files joined to resources through
 * the SAME join-aware source map the diff scoping grades by
 * ({@link sourcesByResourceId} — backend source AND every joined
 * frontend-call source), then resources joined to obligations, then
 * obligations joined to tests through the ONE mapping resolver.
 *
 * Selection granularity is deliberately FILE-grained: the supervised
 * adapter executes whole spec files (trusted-config `testMatch`), so a
 * file that claims one affected obligation plans ALL its catalog rows.
 * Over-selection inside a claimed file is safe — every planned row must
 * still pass — while under-selection (a claiming test left unplanned)
 * would seal coverage over an unrun test, the one direction that can
 * never be allowed.
 *
 * Testable claims are DECLARED bindings only (`sidecar` or `native`
 * origin, unlike {@link claimInjectionsFor} which injects sidecar-only —
 * selection is not evidence attribution, and a native annotation lives in
 * the test file itself, so running the file re-claims it in THIS run).
 * Inferred/prior-run bindings are suggestion data and never count: a
 * claimed obligation whose only candidates are inferred rows would run
 * tests that produce no evidence for it, so it is reported UNCLAIMED
 * instead — the caller turns that into a typed blocking entry (no
 * guessing a narrower gate).
 *
 * Args:
 *   input: the discovered catalog, the resolved mappings, the run's
 *     obligations and graph, and the resolved changed-file set.
 *
 * Returns:
 *   ScopedPlan: the sliced planned rows (whole claimed files), the
 *   affected obligations with their pin-#2 fingerprints (the receipt's
 *   covered set), and the affected obligations no testable claim covers.
 */
export function planScopedExpectedSet(input: {
  catalog: TestCatalog;
  resolution: ResolvedMappings;
  obligations: readonly Obligation[];
  graph: ResourceGraph;
  changedFiles: readonly string[];
  behaviorCatalog?: BehaviorCatalog | null;
  /**
   * The pin-#2 fingerprints this run's grading forgives — the ADOPTED
   * baseline, supplied only when `evaluateRun` would really waive them
   * (strict E2E supplies none: there a waiver is not proof). An affected
   * obligation in this set stays uncovered instead of blocking.
   */
  forgivenFingerprints?: ReadonlySet<string>;
}): {
  plannedRows: PlannedRow[];
  affected: Obligation[];
  coveredFingerprints: string[];
  unclaimed: Array<{ obligationId: string; detail: string }>;
  /**
   * The distinct test files the testable claimed instances live in
   * (additive, plan 2026-09-25 runner-agnostic evidence): the runner
   * slice a NON-Playwright runner plans from, since its expected set
   * comes from its adapter enumeration rather than the Playwright
   * catalog rows {@link planExpectedSet} filters.
   */
  requiredFiles: string[];
  /**
   * Affected obligations with no testable claim that the run's own
   * grading forgives through the ADOPTED baseline (additive, E62): they
   * are NOT blockers, and they stay in the sealed covered set so a
   * consumer's own `check --require-e2e` still demands exactly what the
   * full path grades.
   */
  adopted: Array<{ obligationId: string; detail: string }>;
} {
  const changed = new Set(input.changedFiles);
  const sources = sourcesByResourceId(input.graph, input.behaviorCatalog);
  const affected = input.obligations
    .filter((obligation) => (sources.get(obligation.resourceId) ?? []).some((file) => changed.has(file)));
  // New-claim certification: a changed TEST file that declares claims for an
  // obligation re-opens that obligation even when its sources are untouched —
  // newly mapped evidence demands a fresh witnessed seal (the mapping-file
  // workflow: "I added a test for X" must be certifiable as a slice).
  const affectedIds = new Set(affected.map((obligation) => obligation.id));
  for (const group of input.resolution.obligations) {
    if (affectedIds.has(group.obligationId)) continue;
    const declaresChangedClaim = group.bindings.some(
      (binding) =>
        (binding.origin === 'sidecar' || binding.origin === 'native') &&
        binding.instances.some((instance) => changed.has(instance.file)),
    );
    if (declaresChangedClaim) {
      const obligation = input.obligations.find((candidate) => candidate.id === group.obligationId);
      if (obligation !== undefined) {
        affected.push(obligation);
        affectedIds.add(obligation.id);
      }
    }
  }
  affected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Catalog joins, exactly as {@link claimInjectionsFor} builds them: a
  // binding counts only when the CURRENT catalog still enumerates its
  // instance (stale bindings are the resolver's typed problems).
  const logicalKeyByCatalogKey = new Map(
    input.catalog.entries.map((entry) => [
      `${entry.file}#${entry.titlePath.join('>')}`,
      entry.logicalKey,
    ]),
  );
  const entryByLogicalKey = new Map(input.catalog.entries.map((entry) => [entry.logicalKey, entry]));
  const bindingsByObligation = new Map(
    input.resolution.obligations.map((group) => [group.obligationId, group.bindings]),
  );
  const requiredFiles = new Set<string>();
  const claimedObligations = new Set<string>();
  const unclaimed: Array<{ obligationId: string; detail: string }> = [];
  const adopted: Array<{ obligationId: string; detail: string }> = [];
  const forgiven = input.forgivenFingerprints;
  for (const obligation of affected) {
    const bindings = bindingsByObligation.get(obligation.id) ?? [];
    let testable = false;
    for (const binding of bindings) {
      if (binding.origin !== 'sidecar' && binding.origin !== 'native') continue;
      for (const instance of binding.instances) {
        const logicalKey = logicalKeyByCatalogKey.get(`${instance.file}#${instance.titlePath.join('>')}`);
        if (logicalKey === undefined) continue;
        const entry = entryByLogicalKey.get(logicalKey);
        if (entry === undefined) continue;
        testable = true;
        requiredFiles.add(entry.file);
      }
    }
    if (testable) {
      claimedObligations.add(obligation.id);
      continue;
    }
    // Adopted debt (E62): an affected obligation with no testable claim
    // whose fingerprint the ADOPTED baseline forgives is not a blocker.
    // The same run's grading waives exactly these obligations
    // (`applyBaseline`), so the full path runs green over the very debt
    // that used to block the narrow one — the two paths must agree. A
    // fingerprint the baseline never adopted still blocks (shrink-only,
    // fail closed), and strict E2E passes no set at all: there a waiver
    // is not proof and the blocker must stand.
    if (forgiven !== undefined && forgiven.has(obligationFingerprint(obligation))) {
      adopted.push({
        obligationId: obligation.id,
        detail:
          `changed-scope planning: obligation '${obligation.id}' is affected by the changed files, has no ` +
          'declared mapping, and is forgiven by the adopted baseline — it stays uncovered by this slice',
      });
      continue;
    }
    unclaimed.push({
      obligationId: obligation.id,
      detail:
        `changed-scope planning: obligation '${obligation.id}' is affected by the changed files but ` +
        'no declared mapping (sidecar entry or native annotation) resolves to a test the current ' +
        'catalog still enumerates — narrower selection is never guessed; map a test or run full scope',
    });
  }
  const plannedRows = planExpectedSet(input.catalog).filter((row) => requiredFiles.has(row.planned.file));
  const coveredFingerprints = [
    ...new Set(affected.map((obligation) => obligationFingerprint(obligation))),
  ].sort(compareStrings);
  return {
    plannedRows,
    affected,
    coveredFingerprints,
    unclaimed,
    adopted,
    requiredFiles: [...requiredFiles].sort(compareStrings),
  };
}

/**
 * Resolves executed outcome rows (reporter data, input only) into
 * schema-shaped outcomes: logical keys join through the planned set's
 * instance identity; rows outside the plan keep their framework-side
 * identity string so the supervision mismatch names them.
 *
 * Runner-agnostic read path (plan 2026-09-25, runner-agnostic
 * evidence): adapters behind the `RunnerAdapter` contract (pytest,
 * vitest, cypress) return their structured outcomes IN the execution
 * envelope and write no Playwright runner-outcomes document. When the
 * document is absent, the envelope's rows are joined through the SAME
 * identity (their logical key is `<file>#<title path>`), so every
 * runner grades planned-versus-executed identically. An empty envelope
 * outcome list still resolves to no rows — the Playwright
 * missing-document case is byte-identical to before.
 *
 * Args:
 *   outcomesDoc: the parsed runner-outcomes document (or null).
 *   plannedRows: the planned rows (identity join).
 *   envelopeOutcomes: the adapter envelope's own outcome rows (used
 *     only when the outcomes document is absent).
 *
 * Returns:
 *   ExecutedOutcome[]: supervision-normalized executed outcomes.
 */
export function executedOutcomesOf(
  outcomesDoc: RunnerOutcomesDocument | null,
  plannedRows: readonly PlannedRow[],
  envelopeOutcomes: readonly RunnerInstanceOutcome[] = [],
): ExecutedOutcome[] {
  const logicalKeyByKey = new Map(
    plannedRows.map((row) => [
      `${row.planned.project ?? '-'}\u0000${row.planned.file}\u0000${row.planned.titlePath.join('>')}`,
      row.planned.logicalKey,
    ]),
  );
  if (outcomesDoc === null) {
    return envelopeOutcomes.map((outcome) => {
      const hash = outcome.logicalKey.indexOf('#');
      const file = hash > 0 ? outcome.logicalKey.slice(0, hash) : outcome.logicalKey;
      const titlePath = hash > 0 ? outcome.logicalKey.slice(hash + 1).split('>') : [];
      const key = `${outcome.project ?? '-'}\u0000${file}\u0000${titlePath.join('>')}`;
      return {
        logicalKey: logicalKeyByKey.get(key) ?? outcome.logicalKey,
        project: outcome.project,
        file,
        titlePath,
        status: outcome.status,
        attempt: outcome.attempt >= 1 ? outcome.attempt : 1,
        expectedFailure: outcome.expectedFailure === true,
      };
    });
  }
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
      ...(typeof row.testId === 'string' && row.testId.length > 0 ? { runnerTestId: row.testId } : {}),
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
  /**
   * Selection mode (additive, default `full-relevant-suite`): a
   * `--scope changed` run seals `mapped-selection` and a hand-picked
   * `--test` run reports `named-selection` — the execution result, its
   * digest, and every receipt binding it then name the SLICE that
   * actually ran, so a slice can never be mistaken for a whole-suite
   * seal.
   */
  mode?: 'full-relevant-suite' | 'mapped-selection' | 'named-selection';
  /** Logical keys selected. */
  logicalKeys: readonly string[];
  /** The catalog the selection was planned from. */
  catalog: TestCatalog;
  /** Planned rows (from {@link planExpectedSet}). */
  plannedRows: readonly PlannedRow[];
  /** Current native annotation claims sealed for later check inventory. */
  claimInventory?: readonly Claim[];
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
  /**
   * The timing-chaos plan this run executed under (E63), plus the
   * schedule the witness proxy used. Additive and optional: without
   * `--chaos` the sealed result has no `chaos` key at all.
   */
  chaos?: {
    /** The `--chaos <seed>` the owner replayed. */
    seed: number;
    /** Upper bound of every applied delay, in whole milliseconds. */
    maxDelayMs: number;
    /** Whether a later response may be released before an earlier one. */
    reorder: boolean;
    /** Per-response release decisions (method + pathname, k, delay). */
    schedule: readonly ExecutionResultChaosEntry[];
  };
  /** Run start/end instants (ISO-8601). */
  startedAt: string;
  finishedAt: string;
}

/** One recorded chaos release decision (method + pathname, k, delay). */
export interface ExecutionResultChaosEntry {
  /** `METHOD /pathname` (query stripped) — never a secret. */
  routeKey: string;
  /** 1-based index of the request under its route key. */
  k: number;
  /** Milliseconds the response was actually held back. */
  delayMs: number;
  /** True when the plan released this response before the previous one. */
  releasedBefore: boolean;
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
 *   input: run identity, digests, planned rows, native claim inventory,
 *     envelope, and outcomes document.
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
    mode: input.mode ?? ('full-relevant-suite' as const),
    logicalKeys: [...new Set(input.logicalKeys)].sort(),
  };
  const executed = executedOutcomesOf(input.outcomesDoc, input.plannedRows, input.envelope.outcomes);
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
    ...(input.claimInventory !== undefined ? { claimInventory: input.claimInventory } : {}),
    planned: input.plannedRows.map((row) => row.planned),
    outcomes: executed,
    ...(input.enumerationDigest !== undefined ? { enumerationDigest: input.enumerationDigest } : {}),
    ...(input.sessionTrace !== undefined && input.sessionTrace !== null
      ? { sessionTrace: input.sessionTrace }
      : {}),
    ...(input.chaos !== undefined ? { chaos: input.chaos } : {}),
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
  /** Non-secret id of the key that signs this receipt. */
  verifierKeyId?: string;
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
  /** CLI identity that sealed the receipt (optional for legacy receipts). */
  engine?: { version: string; source: string; unpublished: boolean };
  /** Configured stage for receipt enforcement, omitted for legacy configs. */
  receiptStage?: 'pre-push' | 'pre-commit' | 'ci';
  /** Parent full-receipt commit carried into this receipt, when applicable. */
  carriedFrom?: string;
  /** Digest of the authenticated parent receipt carried forward. */
  parentReceiptDigest?: string;
  /** Digest of the parent document this run re-sealed from (test-only). */
  resealedFrom?: string;
  /**
   * Which kind of parent `resealedFrom` names: a verified gate receipt
   * or a whole-suite run record. Omitted for a receipt parent (absence
   * reads as `receipt`, so re-seals sealed before the field existed stay
   * byte-identical).
   */
  resealedFromKind?: 'receipt' | 'run-record';
  /** How many parent outcomes this run carried unchanged (re-seal). */
  carriedTests?: number;
  /** How many tests this run re-executed (re-seal). */
  rerunTests?: number;
  /** The class Gateforge itself computed for the sealed change set. */
  changeClass?: 'test-only';
  /** The changed paths Gateforge itself diffed between the sealed trees. */
  changedPaths?: readonly string[];
  /**
   * The changed paths the owner declaration `enforcement.resealRuntimeFiles`
   * kept out of the classification: runtime state the run itself rewrites,
   * which no sealed commit tracks (re-seal).
   */
  resealDisregarded?: readonly string[];
  /**
   * Canonical digest of the evidence union this re-seal sealed: the
   * carried parent records and claims together with the re-run's own.
   */
  carriedEvidenceDigest?: string;
  /** Normalized invocation. */
  invocation: string;
  /** Selection digest. */
  selectionDigest: string;
  /** Catalog digest. */
  catalogDigest: string;
  /**
   * Sealed evaluation scope (additive; default `full`). `changed` seals a
   * SLICE receipt: the covered set below names exactly the obligations
   * the run certifies, and the MAC binds both.
   */
  scope?: 'full' | 'changed';
  /**
   * Pin-#2 fingerprints of the obligations a `changed`-scope receipt
   * covers (sorted, duplicate-free — normalized here). REQUIRED when
   * `scope` is `changed`, refused otherwise (a full receipt covers
   * everything by definition and stays byte-compatible with v1).
   */
  coveredObligationFingerprints?: readonly string[];
  /** Sealed execution-result digest. */
  executionResultDigest: string;
  /** Evidence attestation digest, or null when the run carried none. */
  evidenceAttestationDigest: string | null;
  /**
   * Immutable Git tree actually tested (or null outside a Git checkout).
   * The broker recomputes this from raw candidate bytes and demands
   * equality with the sealed value.
   */
  candidateTreeId: string | null;
  /** Compiled behavior catalog digest (canonical empty digest when absent). */
  behaviorCatalogDigest: string;
  /** Digest over the sorted full required case specifications. */
  requiredCaseSetDigest: string;
  /** Digest over the executed case set (empty digest when none executed). */
  caseExecutionDigest: string;
  /** Digest binding the approved engine/policy bundle version. */
  engineBundleDigest: string;
  /** Digest binding the controller-issued execution-profile record. */
  executionBoundaryDigest: string;
  /** Digest identifying the controlled app build derived from the tree. */
  targetArtifactDigest: string;
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
  // Scope normalization (fail closed): a `changed` receipt MUST name its
  // covered set (sorted, duplicate-free — the schema re-checks), and a
  // `full`/unscoped receipt must NOT carry one. An unnamed slice would
  // claim unbounded authority; a covered full receipt would be dead weight
  // pretending to bound it.
  const scoped = input.scope === 'changed';
  const covered: string[] | undefined = scoped
    ? [...new Set(input.coveredObligationFingerprints ?? [])].sort(compareStrings)
    : undefined;
  if (scoped && (covered === undefined || covered.length === 0)) {
    throw new UsageError(
      'refusing to issue a changed-scope gate receipt without coveredObligationFingerprints (fail closed)',
    );
  }
  if (!scoped && input.coveredObligationFingerprints !== undefined) {
    throw new UsageError(
      'refusing to issue a full-scope gate receipt with a coveredObligationFingerprints slice (fail closed)',
    );
  }
  // Structural validation first: parse the draft under the strict schema
  // with a placeholder mac (the real MAC is computed over the VALIDATED
  // body so the signed bytes are exactly the schema-checked bytes).
  const parsed = GateReceiptSchema.parse({
    schemaVersion: 1,
    receiptVersion: 2,
    receiptId: randomUUID(),
    ...(input.verifierKeyId !== undefined ? { verifierKeyId: input.verifierKeyId } : {}),
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
    // Receipt engine identity is additive; legacy receipts remain valid.
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
    ...(input.receiptStage !== undefined ? { receiptStage: input.receiptStage } : {}),
    ...(input.carriedFrom !== undefined ? { carriedFrom: input.carriedFrom } : {}),
    ...(input.parentReceiptDigest !== undefined ? { parentReceiptDigest: input.parentReceiptDigest } : {}),
    ...(scoped ? { scope: 'changed' as const, coveredObligationFingerprints: covered } : {}),
    // Additive test-only re-seal bindings: present ONLY when this run
    // re-sealed from a verified parent, and MAC-covered like every other
    // field. CI recomputes all of them from the two sealed trees.
    ...(input.resealedFrom !== undefined
      ? {
          resealedFrom: input.resealedFrom,
          ...(input.resealedFromKind !== undefined ? { resealedFromKind: input.resealedFromKind } : {}),
          carriedTests: input.carriedTests,
          rerunTests: input.rerunTests,
          changeClass: input.changeClass,
          ...(input.changedPaths !== undefined ? { changedPaths: [...input.changedPaths] } : {}),
          ...(input.resealDisregarded !== undefined ? { resealDisregarded: [...input.resealDisregarded] } : {}),
          ...(input.carriedEvidenceDigest !== undefined
            ? { carriedEvidenceDigest: input.carriedEvidenceDigest }
            : {}),
        }
      : {}),
    // Additive scope binding (opt-in scoped supervised runs): present
    // ONLY for changed-scope seals, so every earlier receipt stays
    // byte-compatible with v1 (absence reads as `full`).
    invocation: input.invocation,
    selectionDigest: input.selectionDigest,
    catalogDigest: input.catalogDigest,
    executionResultDigest: input.executionResultDigest,
    evidenceAttestationDigest: input.evidenceAttestationDigest,
    candidateTreeId: input.candidateTreeId,
    behaviorCatalogDigest: input.behaviorCatalogDigest,
    requiredCaseSetDigest: input.requiredCaseSetDigest,
    caseExecutionDigest: input.caseExecutionDigest,
    engineBundleDigest: input.engineBundleDigest,
    executionBoundaryDigest: input.executionBoundaryDigest,
    targetArtifactDigest: input.targetArtifactDigest,
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

/** The full binding set of a run record (everything but the MAC). */
export interface IssueRunRecordInput {
  /** Witness verifier secret that authenticates the record. */
  verifierKey: string;
  /** Non-secret key id, when the active keyring publishes one. */
  verifierKeyId?: string;
  /** Run manifest identity of the run that produced the record. */
  runId: string;
  /** Fresh trusted invocation identity of that run. */
  invocationId: string;
  /** 64-hex digest of the canonical input snapshot the run tested. */
  inputDigest: string;
  /** Candidate HEAD sha, or null when unavailable. */
  gitSha: string | null;
  /** Parent commit sha, or null when unavailable. */
  parentSha: string | null;
  /** Trusted policy/config revision digest. */
  trustedPolicyDigest: string;
  /** Owner-approved policy revision the run was pinned to. */
  approvedPolicyDigest: string;
  /** Normalized invocation. */
  invocation: string;
  /** Selection digest (the expected test set, fixed pre-run). */
  selectionDigest: string;
  /** Catalog digest (the enumeration the selection was planned from). */
  catalogDigest: string;
  /** Digest of the sealed execution result. */
  executionResultDigest: string;
  /** Digest over the run's per-test outcomes. */
  testOutcomesDigest: string;
  /** How many tests the whole-suite run planned. */
  plannedTests: number;
  /** How many of them the run reported as passed. */
  passedTests: number;
  /** Evidence attestation digest, or null when the run carried none. */
  evidenceAttestationDigest: string | null;
  /** Immutable Git tree actually tested (or null outside a Git checkout). */
  candidateTreeId: string | null;
  /** Digest binding the approved engine/policy bundle version. */
  engineBundleDigest: string;
  /** Digest binding the controller-issued execution-profile record. */
  executionBoundaryDigest: string;
  /** Issuance instant (ISO-8601). */
  issuedAt: string;
}

/**
 * Issues the authenticated run record: the evidence a whole-suite run
 * leaves behind when it sealed NO gate receipt because a test failed.
 *
 * A record is not a receipt. It carries every binding a receipt binds —
 * execution result, attestation, candidate tree, input snapshot,
 * approved policy, engine bundle, execution boundary, catalog, per-test
 * outcomes — and no verdict, so nothing downstream can mistake it for
 * proof. Its own domain tag (`gateforge.run-record.v1`) means no
 * receipt verifier can ever accept it.
 *
 * Args:
 *   input: the full binding set + verifier key.
 *
 * Returns:
 *   RunRecord: the signed record.
 *
 * Throws:
 *   UsageError: when the signed record fails its own schema or its own
 *     verification (fail closed).
 */
export function issueRunRecord(input: IssueRunRecordInput): RunRecord {
  const parsed = RunRecordSchema.parse({
    schemaVersion: 1,
    recordVersion: 1,
    recordId: randomUUID(),
    ...(input.verifierKeyId !== undefined ? { verifierKeyId: input.verifierKeyId } : {}),
    runId: input.runId,
    invocationId: input.invocationId,
    inputDigest: input.inputDigest,
    gitSha: input.gitSha,
    parentSha: input.parentSha,
    trustedPolicyDigest: input.trustedPolicyDigest,
    approvedPolicyDigest: input.approvedPolicyDigest,
    invocation: input.invocation,
    selectionDigest: input.selectionDigest,
    catalogDigest: input.catalogDigest,
    executionResultDigest: input.executionResultDigest,
    testOutcomesDigest: input.testOutcomesDigest,
    plannedTests: input.plannedTests,
    passedTests: input.passedTests,
    evidenceAttestationDigest: input.evidenceAttestationDigest,
    candidateTreeId: input.candidateTreeId,
    engineBundleDigest: input.engineBundleDigest,
    executionBoundaryDigest: input.executionBoundaryDigest,
    issuedAt: input.issuedAt,
    mac: RECEIPT_MAC_PLACEHOLDER,
  });
  const { mac: placeholder, ...body } = parsed;
  void placeholder;
  const signed: RunRecord = { ...parsed, mac: runRecordMac(input.verifierKey, body) };
  // Self-check: the issued record must verify under its own authority.
  const verified = verifyRunRecord(input.verifierKey, signed);
  if (!verified.ok) {
    throw new UsageError(`issued run record failed self-verification (${verified.detail}) — fail closed`);
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
