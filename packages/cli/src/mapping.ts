/**
 * The CLI test-mapping seam (plan 2026-09-13 §5.3, Phase 3): loads and
 * atomically writes the `.gateforge/test-map.yml` sidecar, runs the ONE
 * core resolver over (catalog, native claims, sidecar, obligations), and
 * projects the result into the two grading-surface inputs:
 *
 * - declared claims (`mappingGradingClaims`): mapping bindings become
 *   Claim-shaped declared claims so a mapped existing test reaches the
 *   SAME authoritative grading path as natively annotated ones. A mapping
 *   declares intent and supplies no test result — with no witnessed
 *   evidence the obligation grades EVIDENCE_NOT_COLLECTED (blocking),
 *   never satisfied, and strict mode is unaffected (claims cannot waive).
 *   PHASE 4 GAP: the runtime fixture submits evidence per native
 *   annotations using the reporter's own testIds; sidecar claims (whose
 *   testId is the logical key) cannot receive runtime evidence until
 *   Phase 4 wires claim injection through session open — do NOT treat
 *   this projection as runtime selection.
 * - typed blocking entries: resolver problems (ambiguous/stale) block
 *   the gate with their plan §5.4 causes — an unsafe or out-of-date
 *   declaration is never silently dropped (and never weakens anything).
 *
 * YAML parsing uses the repository's `yaml` dependency (the same one
 * `.gateforge.yml` uses); core stays YAML-free and speaks validated data.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  CAUSE_NEXT_ACTIONS,
  ClaimSchema,
  mappingGradingClaims,
  resolveTestMappings,
  TestMapSchema,
  type BlockingEntry,
  type Claim,
  type GateforgeConfig,
  type Location,
  type Obligation,
  type ResolvedMappings,
  type ResourceGraph,
  type TestCatalog,
  type TestMap,
} from '@gate-forge/core';
import type { MappedCoverage, CoverageOperation } from '@gate-forge/core';
import { discoverTestCatalog, TestDiscoveryError } from '@gate-forge/pack-playwright';
import { UsageError } from './errors.js';
import { readJsonArray } from './state.js';

/** The tracked sidecar path, repo-root-relative (plan §5.1 row 2). */
export const TEST_MAP_RELATIVE = '.gateforge/test-map.yml';

/**
 * Loads and validates the sidecar, or returns null when the repository
 * declares none (the common case — mapping stays fully opt-in).
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   TestMap | null: the validated document, or null when absent.
 *
 * Throws:
 *   UsageError: when the file exists but is not valid YAML or fails the
 *     strict schema (exit 2 — a broken declaration is never ignored).
 */
export function loadOptionalTestMap(cwd: string): TestMap | null {
  const path = join(cwd, TEST_MAP_RELATIVE);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read '${TEST_MAP_RELATIVE}': ${(error as Error).message}`);
  }
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    throw new UsageError(
      `${TEST_MAP_RELATIVE} is not valid YAML: ${(error as Error).message.split('\n')[0] ?? 'parse error'}`,
    );
  }
  const parsed = TestMapSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path_ = issue === undefined ? '' : ` at '${issue.path.map(String).join('.')}':`;
    throw new UsageError(
      `${TEST_MAP_RELATIVE} is invalid${path_} ${issue?.message ?? 'unknown schema error'}`,
    );
  }
  return parsed.data as TestMap;
}

/**
 * Serializes the sidecar deterministically (entries are pre-sorted by the
 * caller): fixed block style, no line wrapping, trailing newline — the
 * byte-stable form `tests mark` idempotency relies on.
 *
 * Args:
 *   testMap: the validated document.
 *
 * Returns:
 *   string: deterministic YAML text.
 */
export function serializeTestMap(testMap: TestMap): string {
  return `${stringifyYaml(testMap as unknown as Record<string, unknown>, { lineWidth: 0 })}`;
}

/**
 * Atomically writes the sidecar: a temp file on the same filesystem,
 * fsync-free rename into place (a crash never leaves a half-written
 * tracked declaration).
 *
 * Args:
 *   cwd: absolute repo root.
 *   testMap: the validated document to write.
 */
export function writeTestMapAtomic(cwd: string, testMap: TestMap): void {
  const target = join(cwd, TEST_MAP_RELATIVE);
  // The temp file MUST live on the target's own filesystem: rename(2) is
  // atomic only within one device, and /tmp is frequently a different mount.
  const tempFile = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tempFile, serializeTestMap(testMap), 'utf8');
    renameSync(tempFile, target);
  } finally {
    rmSync(tempFile, { force: true });
  }
}

/** Everything one mapping resolution over a real repository needs. */
export interface MappingResolutionOptions {
  /** Absolute repo root. */
  cwd: string;
  /** Validated `.gateforge.yml` (drives discovery). */
  config: GateforgeConfig;
  /** Absolute run-state directory (native claims source). */
  stateDir: string;
  /** The run's obligations (the registry the resolver validates against). */
  obligations: readonly Obligation[];
  /**
   * Pre-discovered catalog; when absent the module discovers fresh.
   * Callers that ALREADY ran discovery (tests suggest/mark/explain) pass
   * it here so one command never scans the tree twice.
   */
  catalog?: TestCatalog;
  /** Optional prior-run hints (suggestions only, never grading). */
  priorRunHints?: readonly { logicalKey: string; obligationId: string }[];
}

/** One resolution over a real repository. */
export interface MappingResolutionResult {
  /** The fresh catalog discovery produced (same run — never a stale read). */
  catalog: TestCatalog;
  /** The validated sidecar, or null when the repository declares none. */
  sidecar: TestMap | null;
  /** The resolved bindings + typed problems. */
  resolution: ResolvedMappings;
  /** Native claims read from the run state (already registry-filtered). */
  nativeClaims: Claim[];
}

/**
 * Runs discovery + sidecar load + native-claim read and the ONE core
 * resolver over them. The catalog is always freshly discovered (never
 * read back from the derived state file) so staleness judgments reflect
 * the current tree.
 *
 * Args:
 *   options: cwd, config, state dir, obligations, optional hints.
 *
 * Returns:
 *   Promise<MappingResolutionResult>: catalog, sidecar, resolution, claims.
 *
 * Throws:
 *   UsageError: when native enumeration could not run at all (exit 2 —
 *     a failed scan is never an empty catalog) or the sidecar is invalid.
 */
export async function resolveRepositoryMappings(
  options: MappingResolutionOptions,
): Promise<MappingResolutionResult> {
  let catalog: TestCatalog;
  if (options.catalog !== undefined) {
    catalog = options.catalog;
  } else {
    try {
      ({ catalog } = await discoverTestCatalog({ cwd: options.cwd, config: options.config }));
    } catch (error) {
      if (error instanceof TestDiscoveryError) throw new UsageError(error.message);
      throw error;
    }
  }
  const sidecar = loadOptionalTestMap(options.cwd);
  const nativeClaims = readJsonArray(options.stateDir, 'claims.json')
    .map((entry) => ClaimSchema.safeParse(entry))
    .filter((parsed): parsed is { success: true; data: Claim } => parsed.success)
    .map((parsed) => parsed.data);
  const resolution = resolveTestMappings({
    catalog,
    nativeClaims,
    sidecar: sidecar ?? { schemaVersion: 1, tests: [] },
    obligationIds: options.obligations.map((obligation) => obligation.id),
    ...(options.priorRunHints !== undefined ? { priorRunHints: options.priorRunHints } : {}),
  });
  return { catalog, sidecar, resolution, nativeClaims };
}

/**
 * Projects resolver problems into gate blocking entries (fail closed):
 * an ambiguous or stale declaration blocks with its plan §5.4 cause and
 * next action instead of being silently dropped. TEST_KIND_UNKNOWN is
 * NOT projected here — an unclassified relevant test is a suggestion
 * surface concern (plan phase 2 item 7: uncertainty blocks only the
 * affected gate through suggestions), while unsafe/out-of-date
 * declarations block outright.
 *
 * Args:
 *   problems: the resolver's typed problems.
 *
 * Returns:
 *   BlockingEntry[]: one entry per projected problem, sorted.
 */
export function mappingBlocking(problems: ResolvedMappings['problems']): BlockingEntry[] {
  return problems
    .filter((problem) => problem.cause !== 'TEST_KIND_UNKNOWN')
    .map((problem): BlockingEntry => {
      const location: Location | null = problem.locations[0] ?? null;
      return {
        kind: 'finding',
        resourceId: null,
        name: problem.obligationId,
        detail: `test mapping: ${problem.detail}`,
        location,
        cause: problem.cause,
        nextAction: CAUSE_NEXT_ACTIONS[problem.cause],
      };
    })
    .sort((a, b) => (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
}

/**
 * Computes the DECLARED grading claims for a run (the check seam):
 * resolved native/sidecar bindings become Claim-shaped declared claims,
 * deduplicated against the run state's own claims (exact duplicates
 * disappear idempotently). Mapping claims NEVER waive or weaken: they
 * only move an obligation from `no claim declares` to
 * `declared but produced no evidence records` until witnessed evidence
 * exists. See the module doc for the Phase 4 runtime-injection gap.
 *
 * Args:
 *   resolution: the resolved-mappings surface.
 *   nativeClaims: the run-state claims (already schema-validated).
 *
 * Returns:
 *   Claim[]: the additional declared claims, sorted by (obligationId, testId).
 */
export function gradingClaimsFor(resolution: ResolvedMappings, nativeClaims: readonly Claim[]): Claim[] {
  return mappingGradingClaims(resolution, nativeClaims);
}

/**
 * Line-level diff (LCS) between the previous and next sidecar bytes —
 * the exact diff `tests mark` prints (plan §5.3: "reports the exact
 * diff"). Pure and deterministic.
 *
 * Args:
 *   before: previous file content (empty string when the file is new).
 *   after: next file content.
 *
 * Returns:
 *   string[]: lines prefixed `- `, `+ `, or `  ` (context, capped runs).
 */
export function diffLines(before: string, after: string): string[] {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.split('\n');
  // LCS table (sidecar files are small; O(n*m) is fine and deterministic).
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    if (row === undefined) continue;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j]
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i] ?? ''}`);
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      lines.push(`- ${a[i] ?? ''}`);
      i += 1;
    } else {
      lines.push(`+ ${b[j] ?? ''}`);
      j += 1;
    }
  }
  while (i < a.length) {
    lines.push(`- ${a[i] ?? ''}`);
    i += 1;
  }
  while (j < b.length) {
    lines.push(`+ ${b[j] ?? ''}`);
    j += 1;
  }
  return lines;
}

/**
 * Repo-relative display path for diagnostics (posix, stable ordering).
 *
 * Args:
 *   cwd: absolute repo root.
 *   absolute: an absolute path inside the repo.
 *
 * Returns:
 *   string: repo-relative posix path.
 */
export function relativeToRepo(cwd: string, absolute: string): string {
  return relative(cwd, absolute).split('\\').join('/');
}

/**
 * Derives the coverage-policy `mappedCoverage` input (plan §3.6) from
 * the resolved test mappings: every browser-e2e-declared binding for an
 * obligation whose contract carries a CRUD operation contributes one
 * (table, operation) coverage fact for the obligation's inventory
 * table. Non-browser-e2e kinds contribute nothing (closed-world coverage
 * requires REAL-UI journeys), obligations whose contract has no CRUD
 * operation suffix and bindings for resources absent from the graph
 * contribute nothing. Pure and deterministic: the output is sorted and
 * the same inputs always produce the same facts.
 *
 * Args:
 *   resolution: the resolver output (per-obligation bindings).
 *   obligations: the run's obligations (contract + resource join).
 *   graph: the built resource graph (resourceId → inventory table name).
 *
 * Returns:
 *   MappedCoverage[]: sorted, deduplicated coverage facts.
 */
export function mappedCoverageFrom(
  resolution: ResolvedMappings,
  obligations: readonly Obligation[],
  graph: ResourceGraph,
): MappedCoverage[] {
  const obligationById = new Map(obligations.map((obligation) => [obligation.id, obligation]));
  const resourceById = new Map(
    graph.resources.filter((resource) => resource.id !== null).map((resource) => [resource.id as string, resource]),
  );
  const seen: Record<string, true> = {};
  const coverage: MappedCoverage[] = [];
  for (const group of resolution.obligations) {
    const obligation = obligationById.get(group.obligationId);
    if (obligation === undefined) continue;
    const resource = resourceById.get(obligation.resourceId);
    if (resource === undefined) continue;
    const operation = coverageOperationOfContract(obligation.contract);
    if (operation === null) continue;
    for (const binding of group.bindings) {
      if (binding.declaredKind !== 'browser-e2e') continue;
      const key = `${resource.name}\u0000${operation}`;
      if (key in seen) continue;
      seen[key] = true;
      coverage.push({ table: resource.name, operation, testKind: 'browser-e2e' });
    }
  }
  return coverage.sort(
    (a, b) =>
      a.table < b.table ? -1 : a.table > b.table ? 1 : a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0,
  );
}

/**
 * Collects the obligation ids whose resolved bindings declare the
 * server-e2e kind. Mapping kinds are resolved in this trusted CLI layer
 * only; the witness honors a server-e2e persistence stamp solely for
 * obligations the supervisor registered from this set, so it is the
 * authority for which obligations may produce `channel: 'server'`
 * evidence during the supervised drain. Sorted and deduplicated: the
 * registration is a set, not a list.
 *
 * Args:
 *   resolution: the resolver output (per-obligation bindings).
 *
 * Returns:
 *   string[]: sorted obligation ids with at least one server-e2e binding.
 */
export function serverE2eObligationIds(resolution: ResolvedMappings): string[] {
  const ids = new Set<string>();
  for (const group of resolution.obligations) {
    if (group.bindings.some((binding) => binding.declaredKind === 'server-e2e')) {
      ids.add(group.obligationId);
    }
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Extracts the CRUD coverage operation an obligation's contract ends
 * with (`persistence:read` → `read`, `crud:update` → `update`), or null
 * when the contract does not end in a coverage operation (e.g. http
 * transport contracts). The split is at the LAST colon: interior colons
 * are namespace structure, the trailing segment is the operation.
 *
 * Args:
 *   contract: the obligation's contract name.
 *
 * Returns:
 *   CoverageOperation | null: the coverage operation, or null.
 */
function coverageOperationOfContract(contract: string): CoverageOperation | null {
  const lastColon = contract.lastIndexOf(':');
  const suffix = lastColon === -1 ? '' : contract.slice(lastColon + 1);
  return suffix === 'create' || suffix === 'read' || suffix === 'update' || suffix === 'delete'
    ? (suffix as CoverageOperation)
    : null;
}
