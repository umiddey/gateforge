/**
 * The CLI test-mapping seam: loads and atomically writes the
 * `.gateforge/test-map.yml` sidecar, resolves it with the current native
 * test catalog, and produces a source-located claim inventory for grading.
 *
 * The inventory uses declarations from the current native annotations and
 * current sidecar bindings. Prior-run `claims.json` records are never an
 * input to declaration completeness, so stale state cannot hide a missing
 * current test mapping. Declarations are not evidence: an unmapped claim
 * cannot satisfy an obligation or weaken strict-mode authority.
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
  type BehaviorCatalog,
  type BusinessRule,
  compareStrings,
  resolveTestMappings,
  TestMapSchema,
  type BlockingEntry,
  type Claim,
  type GateforgeConfig,
  type Location,
  type Obligation,
  type ResolvedMappings,
  type MappingProblem,
  type ResourceGraph,
  type TestCatalog,
  type TestMap,
  type TestMapEntry,
} from '@gate-forge/core';
import type { MappedCoverage, CoverageOperation } from '@gate-forge/core';
import {
  discoverTestCatalog,
  findPlaywrightConfig,
  scanTestFiles,
  TestDiscoveryError,
  type DiscoverOptions,
  type DiscoveryTimings,
  type NativeInstance,
  type StaticScanResult,
} from '@gate-forge/pack-playwright';
import { UsageError } from './errors.js';
import { engineGeneratedStateFileFilter } from './state-artifacts.js';
import { resolveStateDir } from './state.js';
import { businessRuleClaimIds } from './business-rules.js';

/** The tracked sidecar path, repo-root-relative (plan §5.1 row 2). */
export const TEST_MAP_RELATIVE = '.gateforge/test-map.yml';

/** Candidate config file names per non-Playwright runner (probe order). */
const RUNNER_CONFIG_CANDIDATES: Record<string, readonly string[]> = {
  vitest: [
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.js',
    'vitest.config.mjs',
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.js',
  ],
  cypress: [
    'cypress.config.ts',
    'cypress.config.mts',
    'cypress.config.js',
    'cypress.config.cjs',
    'cypress.config.mjs',
  ],
};

/**
 * The configured runner's own configuration file — the scope-expansion
 * signal `check --changed`, `next`, and the supervised run use instead
 * of probing the Playwright config unconditionally (plan 2026-09-25,
 * runner-agnostic evidence). `playwright` resolves through the exact
 * existing probe; pytest keeps its configuration inside `.gateforge.yml`
 * (the diagnostics suites), so it reports null and never widens.
 *
 * Args:
 *   cwd: absolute repo root.
 *   runner: the configured runner name (`config.runner`).
 *
 * Returns:
 *   string | null: the repo-relative config file name, or null.
 */
export function findRunnerConfigPath(cwd: string, runner: string): string | null {
  if (runner === 'playwright') return findPlaywrightConfig(cwd);
  for (const name of RUNNER_CONFIG_CANDIDATES[runner] ?? []) {
    if (existsSync(join(cwd, name))) return name;
  }
  return null;
}

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

interface AnnotationMapGroup {
  file: string;
  titlePath: string[];
  claims: Set<string>;
  keys: Set<string>;
  location: Location | null;
}

/**
 * Builds deterministic sidecar entries from statically resolved test annotations.
 *
 * Args:
 *   scan: static test scan for the configured source files.
 *
 * Returns:
 *   TestMapEntry[]: one generated mapping per file/title path, with claims
 *   deduplicated and sorted.
 */
export function annotationTestMapEntries(scan: StaticScanResult): TestMapEntry[] {
  const groups = new Map<string, AnnotationMapGroup>();
  for (const entry of scan.entries) {
    if (entry.annotationClaims === undefined || entry.annotationClaims.length === 0) continue;
    const identity = `${entry.file}\u0000${entry.titlePath.join('\u0000')}`;
    const group = groups.get(identity) ?? {
      file: entry.file,
      titlePath: [...entry.titlePath],
      claims: new Set<string>(),
      keys: new Set<string>(),
      location: entry.location,
    };
    for (const claim of entry.annotationClaims) group.claims.add(claim);
    groups.set(identity, group);
  }
  return [...groups.values()]
    .map((group): TestMapEntry => ({
      key: `playwright:annotation:${group.file}:${group.titlePath.join('>')}`,
      selector: { runner: 'playwright', file: group.file, titlePath: [...group.titlePath] },
      source: 'annotation',
      claims: [...group.claims].sort(compareStrings),
      reason: 'Generated from Gateforge test annotations.',
    }))
    .sort((a, b) => compareStrings(a.key, b.key));
}

/**
 * Compares current static annotations with generated sidecar entries.
 *
 * Args:
 *   scan: current AST-only test scan.
 *   sidecar: validated sidecar, or null when none exists.
 *
 * Returns:
 *   BlockingEntry[]: non-blocking report advisories naming every
 *   missing/extra generated claim and unresolved annotation.
 */
export function annotationMapSyncAdvisories(
  scan: StaticScanResult,
  sidecar: TestMap | null,
): BlockingEntry[] {
  const expectedEntries = annotationTestMapEntries(scan);
  const expectedByIdentity = new Map<string, AnnotationMapGroup>();
  const actualByIdentity = new Map<string, AnnotationMapGroup>();
  const unresolvedByIdentity = new Map<string, StaticScanResult['entries'][number][]>();
  for (const entry of expectedEntries) {
    const titlePath = entry.selector.titlePath ?? [];
    const identity = `${entry.selector.file}\u0000${titlePath.join('\u0000')}`;
    const group = expectedByIdentity.get(identity) ?? {
      file: entry.selector.file,
      titlePath: [...titlePath],
      claims: new Set<string>(),
      keys: new Set<string>(),
      location: scan.entries.find(
        (row) => row.file === entry.selector.file && row.titlePath.join('\u0000') === titlePath.join('\u0000'),
      )?.location ?? null,
    };
    for (const claim of entry.claims) group.claims.add(claim);
    group.keys.add(entry.key);
    expectedByIdentity.set(identity, group);
  }
  for (const entry of sidecar?.tests ?? []) {
    if (entry.source !== 'annotation') continue;
    const titlePath = entry.selector.titlePath ?? [];
    const identity = `${entry.selector.file}\u0000${titlePath.join('\u0000')}`;
    const group = actualByIdentity.get(identity) ?? {
      file: entry.selector.file,
      titlePath: [...titlePath],
      claims: new Set<string>(),
      keys: new Set<string>(),
      location: null,
    };
    for (const claim of entry.claims) group.claims.add(claim);
    group.keys.add(entry.key);
    actualByIdentity.set(identity, group);
  }
  for (const entry of scan.entries) {
    if (entry.annotationIssue === undefined) continue;
    const identity = `${entry.file}\u0000${entry.titlePath.join('\u0000')}`;
    const rows = unresolvedByIdentity.get(identity) ?? [];
    rows.push(entry);
    unresolvedByIdentity.set(identity, rows);
  }
  const identities = new Set([
    ...expectedByIdentity.keys(),
    ...actualByIdentity.keys(),
    ...unresolvedByIdentity.keys(),
  ]);
  const advisories: BlockingEntry[] = [];
  for (const identity of [...identities].sort(compareStrings)) {
    const expected = expectedByIdentity.get(identity);
    const actual = actualByIdentity.get(identity);
    const unresolved = unresolvedByIdentity.get(identity) ?? [];
    const expectedClaims = expected?.claims ?? new Set<string>();
    const actualClaims = actual?.claims ?? new Set<string>();
    const missing = [...expectedClaims].filter((claim) => !actualClaims.has(claim)).sort(compareStrings);
    const extra = [...actualClaims].filter((claim) => !expectedClaims.has(claim)).sort(compareStrings);
    const expectedKeys = expected?.keys ?? new Set<string>();
    const actualKeys = actual?.keys ?? new Set<string>();
    const keyMismatch =
      expectedKeys.size !== actualKeys.size ||
      [...expectedKeys].some((key) => !actualKeys.has(key));
    if (missing.length === 0 && extra.length === 0 && !keyMismatch && unresolved.length === 0) continue;
    const group = expected ?? actual;
    const file = group?.file ?? unresolved[0]?.file ?? '<unknown>';
    const titlePath = group?.titlePath ?? unresolved[0]?.titlePath ?? [];
    const detailParts = [`test '${titlePath.join(' > ')}' in '${file}'`];
    if (missing.length > 0) detailParts.push(`missing claim(s): ${missing.join(', ')}`);
    if (extra.length > 0) detailParts.push(`extra claim(s): ${extra.join(', ')}`);
    if (keyMismatch) detailParts.push('generated entry key differs from the current annotation identity');
    for (const entry of unresolved) {
      detailParts.push(`UNRESOLVED: ${entry.annotationIssue ?? 'annotation could not be resolved statically'}`);
    }
    advisories.push({
      kind: 'finding',
      resourceId: null,
      name: 'TEST_MAP_OUT_OF_SYNC',
      detail: `${detailParts.join('; ')}. Run \`gateforge tests sync\`.`,
      location: group?.location ?? unresolved[0]?.location ?? null,
      cause: 'TEST_MAP_OUT_OF_SYNC',
      nextAction: CAUSE_NEXT_ACTIONS['TEST_MAP_OUT_OF_SYNC'],
    });
  }
  return advisories;
}
/** Everything one mapping resolution over a real repository needs. */
export interface MappingResolutionOptions {
  /** Absolute repo root. */
  cwd: string;
  /** Validated `.gateforge.yml` (drives discovery). */
  config: GateforgeConfig;
  /**
   * The run's resolved run-state directory (absolute). The fresh
   * discovery below uses it to keep the engine's OWN generated state
   * files out of the static candidate seed; absent means the default
   * state directory, resolved from `cwd` exactly like every CLI entry
   * point.
   */
  stateDir?: string;
  /** The run's obligations (the registry the resolver validates against). */
  obligations: readonly Obligation[];
  /**
   * The owner's declared business rules (`rules:` of the owner-answers
   * document). They are resolved in the SAME pass, as their own claim
   * namespace: a `business-rule:<ruleId>/<caseId>` claim is validated
   * against these cases and lands in `ruleBindings`, never in
   * `obligations`. Absent or empty means the feature is off and the
   * resolution is byte-identical to a release without it.
   */
  businessRules?: readonly BusinessRule[];
  /** Pre-discovered catalog; when absent the module discovers fresh. */
  catalog?: TestCatalog;
  /** Current native annotations from the same discovery pass as catalog. */
  nativeClaims?: readonly Claim[];
  /** Native Playwright reporter load errors from the same discovery pass. */
  nativeErrors?: readonly string[];
  /** Native Playwright instances from the same discovery pass. */
  nativeInstances?: readonly NativeInstance[];
  /**
   * Authenticated claim declarations used instead of live annotations.
   * `check` supplies these only from a verified receipt; the sidecar is
   * still resolved against the current catalog.
   */
  claimBindings?: readonly Claim[];
  /** Optional prior-run hints (suggestions only, never grading). */
  priorRunHints?: readonly { logicalKey: string; obligationId: string }[];
  /** Compiled behavior catalog when complete-behavior is enabled. */
  behaviorCatalog?: BehaviorCatalog | null;
  /** Optional collection wrapper used by the commit-check cache. */
  pytestCollection?: DiscoverOptions['pytestCollection'];
}

/** One resolution over a real repository. */
export interface MappingResolutionResult {
  /** The fresh catalog discovery produced (same run — never a stale read). */
  catalog: TestCatalog;
  /** The validated sidecar, or null when the repository declares none. */
  sidecar: TestMap | null;
  /** The resolved bindings + typed problems. */
  resolution: ResolvedMappings;
  /** Current or receipt-authenticated claims supplied to the resolver. */
  nativeClaims: Claim[];
  /** Sidecar and resolver claim declarations with current source locations. */
  claimInventory: Claim[];
  /** Native Playwright reporter load errors from the discovery pass. */
  nativeErrors: string[];
  /** Inventory blocker details, or null when Playwright enumeration succeeded. */
  nativeLoadProblem: MappingProblem | null;
  /**
   * Discovery step timings from the pass this module ran itself (absent
   * when the caller supplied a pre-computed catalog).
   */
  discoveryTimings?: DiscoveryTimings;
}

/**
 * Runs discovery + sidecar load and the ONE core resolver over current
 * catalog annotations and declarations. Run-state claims are evidence
 * from an earlier execution, never the source of current declarations.
 *
 * Args:
 *   options: cwd, config, obligations, optional catalog and its native
 *     claims, optional authenticated claim bindings, plus hints.
 *
 * Returns:
 *   Promise<MappingResolutionResult>: current catalog, declarations,
 *   resolved mappings, and current native or authenticated claim inventory.
 *
 * Throws:
 *   UsageError: when native enumeration could not run at all (exit 2 —
 *     a failed scan is never an empty catalog) or the sidecar is invalid.
 */
export async function resolveRepositoryMappings(
  options: MappingResolutionOptions,
): Promise<MappingResolutionResult> {
  let catalog: TestCatalog;
  let discoveredClaims: Claim[];
  let nativeErrors = [...(options.nativeErrors ?? [])];
  let nativeInstances = [...(options.nativeInstances ?? [])];
  let nativeInstancesKnown = options.nativeInstances !== undefined;
  let discoveryTimings: DiscoveryTimings | undefined;
  if (options.catalog !== undefined) {
    catalog = options.catalog;
    discoveredClaims = [...(options.nativeClaims ?? [])];
  } else {
    try {
      // collectPytest is REQUIRED here (GAP 1 fix, server-witnessed
      // channel): the resolver judges staleness against the catalog, so a
      // sidecar selector pointing at a configured pytest suite MUST find
      // the suite's collected rows — without collection every pytest
      // selector reads TEST_MAPPING_STALE and blocks the gate over a test
      // that exists. Collection failure stays honest data (the pytest
      // runner summary turns `unavailable`); `tests discover` alone keeps
      // its explicit `--pytest` opt-in.
      const discovered = await discoverTestCatalog({
        cwd: options.cwd,
        config: options.config,
        collectPytest: true,
        pytestCollection: options.pytestCollection,
        excludeFile: engineGeneratedStateFileFilter(
          options.cwd,
          options.stateDir ?? resolveStateDir(options.cwd),
        ),
      });
      catalog = discovered.catalog;
      discoveredClaims = discovered.nativeClaims;
      nativeErrors = [...discovered.nativeErrors];
      nativeInstances = [...discovered.nativeInstances];
      nativeInstancesKnown = true;
      discoveryTimings = discovered.timings;
    } catch (error) {
      if (error instanceof TestDiscoveryError) throw new UsageError(error.message);
      throw error;
    }
  }
  const nativeClaims = [...(options.claimBindings ?? discoveredClaims)];
  const sidecar = loadOptionalTestMap(options.cwd);
  const sidecarEntries = sidecar?.tests ?? [];
  const normalizedNativeErrors = nativeErrors.map((error) => error.replaceAll('\\', '/'));
  const nativeErrorFiles = [
    ...new Set(
      sidecarEntries
        .filter(
          (entry) =>
            entry.selector.runner === 'playwright' &&
            normalizedNativeErrors.some((error) =>
              error.includes(`/${entry.selector.file.replaceAll('\\', '/')}`),
            ),
        )
        .map((entry) => entry.selector.file),
    ),
  ];
  const nativeEnumerationFailed =
    nativeErrors.length > 0 &&
    (nativeInstancesKnown
      ? nativeInstances.length === 0
      : !catalog.entries.some(
          (entry) =>
            entry.runner === 'playwright' &&
            (entry.reconciliation === 'matched' || entry.reconciliation === 'list-only'),
        ));
  const resolved = resolveTestMappings({
    catalog,
    nativeClaims,
    sidecar: sidecar ?? { schemaVersion: 1, tests: [] },
    obligationIds: options.obligations.map((obligation) => obligation.id),
    // A rules registry of ZERO ids is exactly what an absent `rules:`
    // section means, and passing it changes nothing — the resolver's
    // `ruleBindings` stays empty.
    businessRuleClaimIds: businessRuleClaimIds(options.businessRules ?? []),
    ...(options.priorRunHints !== undefined ? { priorRunHints: options.priorRunHints } : {}),
    ...(options.behaviorCatalog !== undefined ? { behaviorCatalog: options.behaviorCatalog } : {}),
    ...(nativeErrors.length > 0 ? { nativeErrorFiles, nativeEnumerationFailed } : {}),
  });
  const claimInventory = currentClaimInventory(catalog, resolved, nativeClaims);
  const nativeLoadProblem = nativeInventoryProblem(nativeErrors);
  return {
    catalog,
    sidecar,
    resolution: resolved,
    nativeClaims,
    claimInventory,
    nativeErrors,
    nativeLoadProblem,
    ...(discoveryTimings !== undefined ? { discoveryTimings } : {}),
  };
}
/**
 * Combines claim declarations used by the resolver with sidecar
 * declarations joined to the current catalog. Source locations let
 * verdict evaluation ignore stale rows left by earlier runs.
 *
 * Args:
 *   catalog: current runner catalog.
 *   resolution: mappings resolved against this catalog and registry.
 *   nativeClaims: current or authenticated claims supplied to resolution.
 *
 * Returns:
 *   Claim[]: deterministic, source-located current declarations.
 */
function currentClaimInventory(
  catalog: TestCatalog,
  resolution: ResolvedMappings,
  nativeClaims: readonly Claim[],
): Claim[] {
  const entryByInstance = new Map(
    catalog.entries.map((entry) => [`${entry.file}#${entry.titlePath.join('>')}`, entry]),
  );
  const claims = [...nativeClaims];
  for (const group of resolution.obligations) {
    for (const binding of group.bindings) {
      if (binding.origin !== 'sidecar') continue;
      for (const instance of binding.instances) {
        const entry = entryByInstance.get(`${instance.file}#${instance.titlePath.join('>')}`);
        if (entry === undefined) continue;
        claims.push(
          ClaimSchema.parse({
            schemaVersion: 1,
            obligationId: group.obligationId,
            testId: binding.logicalKey,
            testFile: entry.file,
            location: entry.sourceLocation,
          }),
        );
      }
    }
  }
  const unique = new Map<string, Claim>();
  for (const claim of claims) {
    // The declaring test is part of the identity: two tests in ONE file
    // that declare the same obligation share a source location whenever
    // the catalog carries no precise one, and collapsing them would
    // attribute the declaration to whichever sorted first — grading the
    // wrong test's evidence (and, in a named run, grading a selection
    // whose own declaration had been dropped).
    const key = [
      claim.obligationId,
      claim.testId,
      claim.testFile ?? '',
      claim.location?.line ?? '',
      claim.location?.col ?? '',
    ].join('\u0000');
    if (!unique.has(key)) unique.set(key, claim);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, claim]) => claim);
}
/**
 * Builds the single typed problem for native Playwright reporter load errors.
 *
 * Args:
 *   errors: verbatim errors returned by Playwright's JSON reporter.
 *
 * Returns:
 *   MappingProblem | null: inventory failure details, or null when enumeration succeeded.
 */
export function nativeInventoryProblem(errors: readonly string[]): MappingProblem | null {
  if (errors.length === 0) return null;
  return {
    cause: 'TEST_INVENTORY_INCOMPLETE',
    obligationId: null,
    detail: `Playwright enumeration reported ${errors.length} load error(s); first error: ${errors[0] ?? ''}`,
    locations: [],
  };
}

/**
 * Projects native reporter load errors into one actionable gate blocker.
 *
 * Args:
 *   problem: the typed inventory problem, or null when there are no native errors.
 *
 * Returns:
 *   BlockingEntry[]: one blocker for an incomplete native inventory, otherwise empty.
 */
export function nativeInventoryBlocking(problem: MappingProblem | null): BlockingEntry[] {
  if (problem === null) return [];
  return [
    {
      kind: 'finding',
      resourceId: null,
      name: null,
      detail: problem.detail,
      location: null,
      cause: 'TEST_INVENTORY_INCOMPLETE',
      nextAction: 'Install the missing test dependency, then rerun Gateforge.',
    },
  ];
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
 * the resolved test mappings: every real-UI-declared binding
 * (`browser-e2e` engine-driven, `observed-e2e` suite-driven over the
 * session proxy) for an obligation whose contract carries a CRUD
 * operation contributes one (table, operation) coverage fact for the
 * obligation's inventory table. All other kinds contribute nothing
 * (closed-world coverage requires REAL-UI journeys), obligations whose
 * contract has no CRUD operation suffix and bindings for resources
 * absent from the graph contribute nothing. Pure and deterministic:
 * the output is sorted and the same inputs always produce the same
 * facts.
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
      if (binding.origin !== 'sidecar') continue;
      if (binding.declaredKind !== 'browser-e2e' && binding.declaredKind !== 'observed-e2e') continue;
      const key = `${resource.name}\u0000${operation}`;
      if (key in seen) continue;
      seen[key] = true;
      coverage.push({ table: resource.name, operation, testKind: binding.declaredKind });
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
 * Collects the obligation ids whose resolved bindings declare the
 * Observe kind (`observed-e2e`). Same authority pattern as
 * {@link serverE2eObligationIds}: mapping kinds resolve in this trusted
 * CLI layer only, and the witness stamps `channel: 'observe'` records
 * solely for obligations the supervisor registered from this set — a
 * suite-driven test can never steer observe evidence onto an
 * unregistered obligation. Sorted and deduplicated.
 *
 * Args:
 *   resolution: the resolver output (per-obligation bindings).
 *
 * Returns:
 *   string[]: sorted obligation ids with at least one observed-e2e binding.
 */
export function observeObligationIds(resolution: ResolvedMappings): string[] {
  const ids = new Set<string>();
  for (const group of resolution.obligations) {
    if (group.bindings.some((binding) => binding.declaredKind === 'observed-e2e')) {
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
