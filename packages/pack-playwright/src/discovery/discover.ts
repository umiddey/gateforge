/**
 * Catalog orchestration (plan 2026-09-13 phase 2 item 1): builds the
 * validated {@link TestCatalog} from the static scan, the native
 * playwright reconciliation, kind/category inference, and the configured
 * pytest diagnostic suites.
 *
 * Invariants enforced here (fail closed as DATA, never silence):
 * - every statically detected call, unresolved gap, and parse error is a
 *   catalog row — a failed scan never reads as "no tests";
 * - reconciliation is STATIC-FIRST with a native fallback: a case the
 *   static scan derived (and the native list confirmed) is `matched`
 *   with origin `'static'`; a case ONLY the native runner enumerated is
 *   still a DISCOVERED row (origin `'native-list'`, reconciliation
 *   `list-only`) — the runner proved it exists and will execute it —
 *   while a case ONLY the static scan found stays `static-only` and
 *   unresolved (the runner cannot execute what it never enumerated);
 * - `inventoryComplete` is true only when every enabled enumeration
 *   step ran clean (parse errors, budget cuts, unresolved static-only
 *   rows, native reporter errors, and failed pytest collection all make
 *   it false);
 * - the final document passes the strict core schema (duplicate logical
 *   keys are typed errors listing both sources).
 *
 * Output ordering is deterministic: entries sort by (file, titlePath,
 * project); unresolved/parse errors sort by location.
 */
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  canonicalJson,
  ClaimSchema,
  type Claim,
  type DiagnosticSuite,
  type JsonValue,
  deriveLogicalKey,
  TestCatalogSchema,
  type CatalogParseError,
  type GateforgeConfig,
  type CatalogUnresolved,
  type Location,
  type RunnerSummary,
  type TestCatalog,
  type TestCatalogEntry,
  type WeakSignal,
} from '@gate-forge/core';
import { inferTestKind, isMockedFolderPath } from './inference.js';
import {
  collectPytestSuite,
  pytestCollectArgv,
  repoRelative,
} from './pytest-adapter.js';
import type { PytestCollectionResult } from './pytest-adapter.js';
import { CypressRunnerAdapter } from './cypress-runner-adapter.js';
import { VitestRunnerAdapter } from './vitest-runner-adapter.js';
import type { RunnerTestIdentity } from '@gate-forge/witness/adapter';
import {
  declaresNoNamedProject,
  fileDigest,
  findPlaywrightConfig,
  listNativePlaywrightTests,
  reconciliationKey,
  type NativeInstance,
  type NativeListResult,
} from './reconcile.js';
import type { InferenceResult } from './inference.js';
import { runnerConfigPaths } from './runner-config-paths.js';
import {
  namedPathGraph,
  scanTestFiles,
  UNRESOLVED_TITLE_PLACEHOLDER,
  type RepoRelativeFileFilter,
  type StaticRegistrationWarning,
  type StaticScanResult,
  type StaticUnresolved,
  type StaticTestFacts,
} from './static-discovery.js';
import {
  playwrightFileScopes,
  runnerFileVerdict,
  runnerForFile,
  scopeSelectsFile,
  vitestFileScopes,
  type RunnerFileScope,
  type RunnerFileVerdict,
} from './runner-file-scope.js';

/** Options for one discovery run. */
export interface DiscoverOptions {
  /** Absolute repo root. */
  cwd: string;
  /** The validated gateforge config. */
  config: GateforgeConfig;
  /**
   * Collect configured pytest suites (default: list them only). The
   * `tests discover` command keeps its explicit `--pytest` opt-in, but
   * every MAPPING/GATE consumer passes true: staleness and sealing are
   * judged against the catalog, so a pytest selector must resolve (GAP 1
   * fix, server-witnessed channel).
   */
  collectPytest?: boolean;
  /**
   * Optional wrapper around pytest collection. Gateforge's CLI uses this
   * boundary to cache the exact collected result without coupling this
   * discovery package to CLI run-state storage.
   */
  pytestCollection?: (
    suite: DiagnosticSuite,
    cwd: string,
    argv: readonly string[],
    collect: () => Promise<PytestCollectionResult>,
  ) => Promise<PytestCollectionResult>;
  /** Native playwright `--list` timeout (default 60s). */
  playwrightTimeoutMs?: number;
  /**
   * Optional veto over statically seeded candidates, forwarded to
   * {@link scanTestFiles} unchanged. It filters the seed only: the
   * native `--list` enumeration below stays authoritative, so a caller
   * can hide the ENGINE's own generated run-state files from catalog
   * construction without touching a single enumerated case.
   */
  excludeFile?: RepoRelativeFileFilter;
}

/** The discovery result: validated catalog, canonical JSON, and live native claims. */
export interface DiscoverResult {
  catalog: TestCatalog;
  /** Canonical JSON of the catalog (deterministic, snapshot-able). */
  json: string;
  /** Gateforge annotations on tests the current native list enumerated. */
  nativeClaims: Claim[];
  /** Playwright JSON reporter errors from native enumeration, verbatim. */
  nativeErrors: string[];
  nativeInstances: NativeInstance[];
  /**
   * Playwright project name → the names it depends on, as the RUNNER
   * resolved them (see `projectGraphReporterEntry`). Absent when the
   * enumeration could not read the graph.
   */
  projectDependencies?: Record<string, string[]>;
  /**
   * Playwright project name → the `use.storageState` STRING the runner
   * resolved for it. Absent when no project declares one, and absent
   * together with {@link projectDependencies} whenever the graph itself
   * was unreadable.
   */
  projectStorageStates?: Record<string, string>;
  /**
   * Playwright project name → the per-test timeout (ms) the runner
   * resolved for it (see `NativeListResult.projectTimeouts`). Absent when
   * no project reported a usable one.
   */
  projectTimeouts?: Record<string, number>;
  /** Static registration sites guarded by Gateforge environment state. */
  registrationWarnings: StaticRegistrationWarning[];
  /**
   * Playwright config problems the native enumeration PROVED
   * (never guessed): today, a config that declares no named
   * project — test-gates join catalog rows to planned
   * projects by name, so an unnamed config breaks the join.
   * Each entry is a complete diagnostic line.
   */
  configWarnings: string[];
  /**
   * What the runners' own configuration says about any repo-relative
   * file — the same three-state answer this run used to decide the
   * catalog. Consumers ask it about files the catalog no longer holds
   * (a deleted spec, a changed helper), so the answer stays available
   * without re-running discovery.
   */
  fileVerdict: (file: string) => RunnerFileVerdict;
  /**
   * The repository's own test infrastructure, as the import graph proves
   * it: files reachable from a CONFIGURED-runner catalog test file by
   * relative import (transitively, bounded by the scan's traversal
   * budget) — the helper/fixture modules the suite's own tests load —
   * PLUS the files every resolved runner configuration NAMES by a
   * relative path string (its reporter, `globalSetup`/`globalTeardown`, a
   * project `storageState`, a `require.resolve('./…')`) and their own
   * import closure. No test imports those, so a graph rooted at the
   * catalog's test files can never reach them; both halves are read by
   * the same parser and the same import resolution. Empty when a budget
   * cut resolution short: an incomplete graph must attribute nothing,
   * never guess.
   */
  testInfrastructureFiles: string[];
  /**
   * Coarse per-step wall-clock timings (`check --timing`): static scan,
   * native list, pytest collection, and
   * the whole discovery in milliseconds. Observability only.
   */
  timings: DiscoveryTimings;
}

/** Coarse discovery step durations in milliseconds (`check --timing`). */
export interface DiscoveryTimings {
  /** Static test-file scan duration. */
  scanMs: number;
  /** Native Playwright `--list` enumeration duration. */
  nativeListMs: number;
  /** All configured pytest suites' collection duration. */
  pytestCollectMs: number;
  /** Total `discoverTestCatalog` duration including all steps above. */
  totalMs: number;
}

/**
 * The diagnostic for a playwright config that declares no
 * named project: test-gates join catalog rows to planned
 * projects by name, so an unnamed config breaks the join.
 * Behaviour-neutral — discovery still works; the gates
 * cannot attribute rows to projects.
 *
 * Args:
 *   configPath: repo-relative path of the config discovery used.
 *
 * Returns:
 *   string: the complete diagnostic line.
 */
export function unnamedProjectConfigWarning(configPath: string): string {
  return (
    `playwright config ${configPath} declares no named project; test-gates ` +
    "need one — add projects: [{ name: 'chromium' }] (behaviour-neutral)"
  );
}

/**
 * Runs discovery + reconciliation and returns the validated catalog.
 *
 * Pytest suites (plan §3.5) are registered-but-diagnostic-only by
 * default: they appear in `runnerSummaries` with status `registered`
 * (their configured identities, no execution, no collection). With
 * `collectPytest: true` (CLI `--pytest`), the adapter runs the
 * configured argv with `--collect-only -q` and adds one entry per
 * collected node id; diagnostic EXECUTION remains Phase 4 work.
 *
 * Args:
 *   options: cwd, config, optional pytest collection + timeouts.
 *
 * Returns:
 *   Promise<DiscoverResult>: validated catalog, canonical JSON, and current native annotation claims.
 *
 * Throws:
 *   TestDiscoveryError: when an enabled native enumeration could not
 *   run at all (spawn failure, timeout, unparseable output) — the CLI
 *   maps this to exit 2. Scanner-detectable problems are rows, not
 *   throws.
 */
export async function discoverTestCatalog(options: DiscoverOptions): Promise<DiscoverResult> {
  const { cwd, config } = options;
  const discoveryStartedAtMs = performance.now();
  // The repository's own runner file scopes, read BEFORE the static scan:
  // a file a runner would never collect must not become one of the
  // configured runner's tests, and a file whose runner injects the test
  // GLOBALS (`globals: true`) registers tests without importing them.
  const vitestScopes = vitestFileScopes(cwd);
  const nativeStartedAtMs = performance.now();
  const native = await listNativePlaywrightTests({
    cwd,
    timeoutMs: options.playwrightTimeoutMs,
  });
  const nativeListMs = performance.now() - nativeStartedAtMs;
  // Every file Playwright lists is a test it will run, so its code is read
  // even outside the configured source globs: an unread test could carry
  // an E2E claim nobody checked. Owner exclusions still apply.
  const scanStartedAtMs = performance.now();
  const scan = scanTestFiles({
    cwd,
    include: [
      ...config.project.paths.include,
      ...new Set(native.instances.map((instance) => instance.file)),
    ],
    exclude: config.project.paths.exclude,
    excludeFile: options.excludeFile,
    testGlobals: (file) =>
      vitestScopes.some((scope) => scope.globals && scopeSelectsFile(scope, cwd, file)),
  });
  const scanMs = performance.now() - scanStartedAtMs;
  // A playwright config with no named project breaks the
  // per-project identity join test-gates depend on. This is
  // the enumeration's own answer — the config is untrusted
  // code, so only the runner can say which projects it
  // declares — surfaced as a config warning, never a guess.
  const configWarnings: string[] = [];
  if (declaresNoNamedProject(native.projectNames)) {
    const configPath = findPlaywrightConfig(cwd);
    if (configPath !== null) configWarnings.push(unnamedProjectConfigWarning(configPath));
  }

  // The CONFIGURED runner's own selection, and every other runner's, so a
  // static-only file can be attributed to the runner that actually collects
  // it. Both sides fail open: an unreadable selection narrows nothing.
  const playwrightScopes = playwrightFileScopes(native.testFileScope ?? []);
  const scopes: RunnerScopes =
    config.runner === 'playwright'
      ? { configured: playwrightScopes, other: vitestScopes }
      : config.runner === 'vitest'
        ? { configured: vitestScopes, other: playwrightScopes }
        : { configured: [], other: [...vitestScopes, ...playwrightScopes] };
  const builder = new CatalogBuilder(cwd, scan, native, config.runner, scopes);
  const entries: TestCatalogEntry[] = builder.buildEntries();
  const runnerSummaries: RunnerSummary[] = [builder.playwrightSummary()];

    // Registered pytest suites: diagnostic-only identities (§3.5).
    const suites = config.diagnostics?.suites ?? [];
    const pytestCollectStartedAtMs = performance.now();
    for (const suite of suites) {
      if (options.collectPytest === true) {
        const suiteCwd = join(cwd, suite.cwd);
        const collect = () => collectPytestSuite(suite, suiteCwd);
        const collection =
          options.pytestCollection === undefined
            ? await collect()
            : await options.pytestCollection(suite, suiteCwd, pytestCollectArgv(suite), collect);
        runnerSummaries.push({
          runner: 'pytest',
          name: suite.name,
          status: collection.status === 'discovered' ? 'discovered' : 'unavailable',
          detail: collection.detail,
        });
        if (collection.status !== 'discovered') continue;
        for (const testCase of collection.cases) {
          // Collected files are suite-cwd-relative; the catalog rows and
          // digests use repo-relative posix paths.
          const repoFile = repoRelative(cwd, join(cwd, suite.cwd, testCase.file));
          const row = builder.pytestEntry(suite.name, testCase.nodeId, repoFile, testCase.titlePath);
          if (row !== null) entries.push(row);
        }
      } else {
        runnerSummaries.push({
          runner: 'pytest',
          name: suite.name,
          status: 'registered',
          detail: 'registered for diagnostics; collection not requested (run tests discover --pytest); execution is Phase 4',
        });
      }
    }

    // The CONFIGURED runner (plan 2026-09-25, runner-agnostic evidence):
    // when `runner:` names vitest or cypress, its adapter enumerates the
    // expected set into catalog rows (discoveryStatus 'discovered' — the
    // runner itself proved the case) so mappings, scope expansion, and
    // the supervised plan resolve against it. `playwright` (the default)
    // never runs this: the catalog above is byte-identical to before.
    // pytest rows come from the diagnostics collection above.
    if (config.runner === 'vitest' || config.runner === 'cypress') {
      const adapter = config.runner === 'vitest' ? new VitestRunnerAdapter() : new CypressRunnerAdapter();
      const enumeration = await adapter.enumerate(cwd);
      runnerSummaries.push({
        runner: config.runner,
        name: config.runner,
        status: enumeration.status === 'discovered' ? 'discovered' : 'unavailable',
        detail: enumeration.detail,
      });
      if (enumeration.status === 'discovered') {
        for (const test of enumeration.tests) {
          const row = builder.adapterRunnerEntry(config.runner, test);
          if (row !== null) entries.push(row);
        }
      }
    }

    const catalog = builder.finalize(entries, runnerSummaries);
    const nativeClaims = native.instances.flatMap((instance) =>
      instance.claims.flatMap((obligationId) => {
        const parsed = ClaimSchema.safeParse({
          schemaVersion: 1,
          obligationId,
          testId: instance.frameworkId,
          testFile: instance.file,
          location: instance.location,
        });
        return parsed.success ? [parsed.data] : [];
      }),
    );
    return {
      catalog,
      json: canonicalJson(catalog as unknown as JsonValue),
      nativeClaims,
      nativeInstances: native.instances,
      nativeErrors: [...native.errors],

      ...(native.projectDependencies !== undefined
        ? { projectDependencies: native.projectDependencies }
        : {}),
      ...(native.projectStorageStates !== undefined
        ? { projectStorageStates: native.projectStorageStates }
        : {}),
      ...(native.projectTimeouts !== undefined ? { projectTimeouts: native.projectTimeouts } : {}),
      registrationWarnings: scan.registrationWarnings,
      configWarnings,
      fileVerdict: (file: string): RunnerFileVerdict =>
        runnerFileVerdict(scopes.configured, scopes.other, cwd, file),
      testInfrastructureFiles: [
        ...importReachableFrom(
          scan,
          new Set(entries.filter((row) => row.runner === config.runner).map((row) => row.file)),
        ),
        ...namedPathGraph(cwd, runnerConfigPaths(cwd, config.runner)).files,
      ].sort(),
      timings: {
        scanMs,
        nativeListMs,
        pytestCollectMs: performance.now() - pytestCollectStartedAtMs,
        totalMs: performance.now() - discoveryStartedAtMs,
      },
    };
}

/**
 * The runners' own test-file selections, as this discovery read them.
 * Both sides fail open: an unknown selection collects everything, so an
 * unreadable scope reproduces the pre-existing catalog rather than a
 * narrower guess.
 */
interface RunnerScopes {
  /** The CONFIGURED runner's own scopes (empty ⇒ selection unknown). */
  configured: readonly RunnerFileScope[];
  /** The other runners' own scopes (empty ⇒ no other runner claims). */
  other: readonly RunnerFileScope[];
}

/**
 * Every file the given roots reach by relative import, transitively,
 * minus the roots themselves.
 *
 * FAIL-OPEN for attribution: when the scan's import traversal hit its
 * budget the graph is incomplete, so the answer is the EMPTY set — a
 * partial graph must attribute nothing rather than attribute most of a
 * suite's helpers and guess at the rest.
 *
 * Args:
 *   scan: the static scan whose import edges are read.
 *   roots: the files to start from (the suite's own test files).
 *
 * Returns:
 *   Set<string>: the reachable files, roots excluded.
 */
function importReachableFrom(scan: StaticScanResult, roots: ReadonlySet<string>): Set<string> {
  if (scan.budgetExceeded) return new Set<string>();
  const edges = new Map<string, readonly string[]>();
  for (const row of scan.importsByFile) edges.set(row.file, row.imports);
  const reached = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    for (const target of edges.get(file) ?? []) {
      if (reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  for (const root of roots) reached.delete(root);
  return reached;
}

/** Assembles catalog rows from the scan + native enumeration. */
class CatalogBuilder {
  /** Static entries keyed by file#titlePath for matching. */
  private readonly staticByKey = new Map<string, StaticScanResult['entries'][number]>();
  /** Files attributed to another runner's own selection, by runner name. */
  private readonly attributed = new Map<string, Set<string>>();
  /** Files no runner's own selection claims (kept as blocking rows). */
  private readonly unclaimed = new Set<string>();
  /** Memoized file → owning runner (`''` ⇒ claimed by no runner). */
  private readonly owners = new Map<string, string>();
  /** Memoized file → what the runners' own configuration says about it. */
  private readonly verdicts = new Map<string, RunnerFileVerdict>();
  /**
   * The runner a static-only row carries when no other runner's own
   * selection claims its file: the CONFIGURED runner, whose enumeration
   * did not produce it. `pytest` is the exception — it selects no files by
   * glob at all (its rows come from collection), so such rows keep the
   * playwright label they have always carried.
   */
  private readonly staticRowRunner: string;
  /**
   * Project name → the browser the runner resolved for it (0.13.10 F7).
   * A project absent here has an UNDETERMINED browser: its rows keep
   * every static tamper signal (fail closed).
   */
  private readonly projectBrowsers: Map<string, string>;

  constructor(
    private readonly cwd: string,
    private readonly scan: StaticScanResult,
    private readonly native: NativeListResult,
    private readonly runner: string,
    private readonly scopes: RunnerScopes,
  ) {
    this.staticRowRunner = runner === 'pytest' ? 'playwright' : runner;
    this.projectBrowsers = new Map(Object.entries(native.projectBrowsers ?? {}));
    for (const entry of scan.entries) {
      this.staticByKey.set(reconciliationKey(entry.file, entry.titlePath), entry);
    }
  }

  /**
   * The facts one catalog row reads (0.13.10 F7): in a project the runner
   * resolved to CHROMIUM, an evaluate-family tamper is no static refusal
   * — the runtime initiator rule refuses every request evaluated test
   * code starts — so the row reads the blocking-family location instead.
   * Every other project (non-chromium, undetermined, absent) reads the
   * facts as scanned: fail closed.
   */
  private rowFacts(facts: StaticTestFacts | undefined, project: string | null): StaticTestFacts | undefined {
    if (facts === undefined || project === null) return facts;
    if (this.projectBrowsers.get(project) !== 'chromium') return facts;
    if (facts.fileRouteInterceptionNonEvaluate === undefined) return facts;
    return { ...facts, fileRouteInterception: facts.fileRouteInterceptionNonEvaluate };
  }

  /**
   * Which runner's own selection collects this statically found file.
   *
   * Args:
   *   file: repo-relative posix path.
   *
   * Returns:
   *   string: the owning runner, or `''` when no runner claims the file
   *   (the caller keeps it a blocking row instead of inventing a runner).
   */
  private ownerOf(file: string): string {
    const known = this.owners.get(file);
    if (known !== undefined) return known;
    const owner =
      runnerForFile(this.runner, this.scopes.configured, this.scopes.other, this.cwd, file) ?? '';
    this.owners.set(file, owner);
    return owner;
  }

  /**
   * What the runners' own configuration says about this file, beyond
   * which runner owns it: a file no runner collects AND that the
   * configured runner's configuration disclaims (an explicit
   * `testIgnore`, or a path outside every authoritative project's
   * `testDir`) is not a member of any suite, so it never becomes a
   * catalog row and never makes the inventory incomplete. A file nothing
   * claimed and nothing disclaimed is still a gap — a possibly misplaced
   * test stays visible.
   */
  private verdictOf(file: string): RunnerFileVerdict {
    const known = this.verdicts.get(file);
    if (known !== undefined) return known;
    const verdict = runnerFileVerdict(this.scopes.configured, this.scopes.other, this.cwd, file);
    this.verdicts.set(file, verdict);
    return verdict;
  }

  /** Records one file's attribution for the runner summary line. */
  private recordAttribution(owner: string, file: string): void {
    if (owner === '') {
      this.unclaimed.add(file);
      return;
    }
    if (owner === this.runner) return;
    const files = this.attributed.get(owner) ?? new Set<string>();
    files.add(file);
    this.attributed.set(owner, files);
  }

  /** The attribution clause appended to the playwright summary detail. */
  private attributionDetail(): string {
    const parts: string[] = [];
    for (const [owner, files] of [...this.attributed].sort()) {
      parts.push(`${String(files.size)} file(s) attributed to ${owner} by its own test-file selection`);
    }
    if (this.unclaimed.size > 0) {
      parts.push(
        `${String(this.unclaimed.size)} file(s) outside the configured selection are claimed by no runner`,
      );
    }
    for (const scope of [...this.scopes.configured, ...this.scopes.other]) {
      if (scope.note !== undefined) parts.push(scope.note);
    }
    return parts.length > 0 ? `; ${parts.join('; ')}` : '';
  }

  /** The playwright runner summary line for this run. */
  playwrightSummary(): RunnerSummary {
    if (this.native.status === 'unavailable') {
      return {
        runner: 'playwright',
        name: 'playwright',
        status: 'unavailable',
        detail: `${this.native.detail}${this.attributionDetail()}`,
      };
    }
    // Native reporter errors (e.g. a spec that fails to load) are DATA:
    // surfaced on the summary and reflected in inventoryComplete.
    const errors = this.native.errors.length > 0 ? `; native errors: ${this.native.errors.join(' | ').slice(0, 500)}` : '';
    return {
      runner: 'playwright',
      name: 'playwright',
      status: 'discovered',
      detail: `${this.native.detail}${errors}${this.attributionDetail()}`,
    };
  }

  /** Builds every playwright row: matched, list-only, static-only, gaps. */
  buildEntries(): TestCatalogEntry[] {
    const rows: TestCatalogEntry[] = [];
    const matchedStaticKeys = new Set<string>();

    // Parameterized static templates (`for (const x of ITEMS)
    // test(\`...${x}...\`)`): the template title is not itself runnable —
    // its concrete instances are. A template whose enumerated instances
    // all share its file + describe ancestry merges its static facts
    // into each instance row (origin 'static' + a template-expansion
    // weak signal) instead of leaving a blocking static-only gap beside
    // fact-less list-only rows (consumer migration, E22). Templates with
    // ZERO enumerated instances stay static-only and blocking (a
    // parameterized case no configuration executes — the owner wires it
    // into a project or removes it). An instance matching two templates,
    // or exactly matching a static entry, merges into no template
    // (ambiguity and exact identity win). Only the LAST titlePath segment
    // may carry `${}` slots; a template slot in a describe segment stays
    // static-only (documented limit).
    const templateConsumed = new Set<string>();
    const instanceTemplate = new Map<string, StaticScanResult['entries'][number]>();
    if (this.native.status === 'discovered') {
      const enumeratedKeys = new Set(this.native.instances.map((instance) => reconciliationKey(instance.file, instance.titlePath)));
      const templates = [...this.staticByKey.values()].filter(
        (entry) =>
          !enumeratedKeys.has(reconciliationKey(entry.file, entry.titlePath)) &&
          templateTitlePattern(entry.title) !== null,
      );
      const claimsByInstance = new Map<string, string[]>();
      for (const template of templates) {
        const pattern = templateTitlePattern(template.title);
        if (pattern === null) continue;
        const templateKey = reconciliationKey(template.file, template.titlePath);
        const describes = template.titlePath.slice(0, -1);
        for (const instance of this.native.instances) {
          const instanceKey = reconciliationKey(instance.file, instance.titlePath);
          // Exact static identity wins over template expansion.
          if (this.staticByKey.has(instanceKey)) continue;
          if (instance.file !== template.file) continue;
          if (instance.titlePath.length !== template.titlePath.length) continue;
          if (!describes.every((segment, index) => segment === instance.titlePath[index])) continue;
          if (!pattern.test(instance.titlePath[instance.titlePath.length - 1] ?? '')) continue;
          const claims = claimsByInstance.get(instanceKey) ?? [];
          claims.push(templateKey);
          claimsByInstance.set(instanceKey, claims);
        }
      }
      // An instance claimed by two templates merges into neither.
      for (const [instanceKey, templateKeys] of claimsByInstance) {
        if (templateKeys.length !== 1 || templateKeys[0] === undefined) continue;
        const template = this.staticByKey.get(templateKeys[0]);
        if (template === undefined) continue;
        templateConsumed.add(templateKeys[0]);
        instanceTemplate.set(instanceKey, template);
      }
    }

    // Static unresolved gaps, keyed by reconciliation identity, with
    // duplicates merged (§5.2: line numbers are never identity — two
    // unprovable calls sharing a title path collapse into one gap).
    const gapsByKey = new Map<string, StaticScanResult['unresolved'][number]>();
    const gapExtras = new Map<string, string[]>();
    for (const gap of this.scan.unresolved) {
      const key = reconciliationKey(gap.file, gap.titlePath);
      const existing = gapsByKey.get(key);
      if (existing === undefined) {
        gapsByKey.set(key, gap);
        continue;
      }
      const extras = gapExtras.get(key) ?? [];
      extras.push(`${gap.location.file}:${String(gap.location.line)}`);
      gapExtras.set(key, extras);
    }
    const dynamicGapsByLocation = new Map<string, StaticScanResult['unresolved'][number][]>();
    for (const gap of this.scan.unresolved) {
      if (gap.code !== 'dynamic-title' || gap.facts === undefined) continue;
      const locationKey = `${gap.file}\u0000${gap.location.line}`;
      const entries = dynamicGapsByLocation.get(locationKey) ?? [];
      entries.push(gap);
      dynamicGapsByLocation.set(locationKey, entries);
    }
    const consumedDynamicGaps = new Set<StaticScanResult['unresolved'][number]>();
    // A gap the native runner ALSO enumerated is RESOLVED BY THE RUNNER:
    // the --list run loaded the file and will execute that exact case, so
    // the discovered row stands and the gap merges into it as a weak
    // signal — a second row over the same identity would duplicate the
    // logical key (the strict schema correctly rejects that).
    const enumeratedKeys = new Set<string>();

    if (this.native.status === 'discovered') {
      for (const instance of this.native.instances) {
        const key = reconciliationKey(instance.file, instance.titlePath);
        enumeratedKeys.add(key);
        const template = instanceTemplate.get(key);
        const staticEntry = this.staticByKey.get(key) ?? template;
        if (staticEntry !== undefined) matchedStaticKeys.add(key);
        const dynamicCandidates =
          staticEntry === undefined
            ? dynamicGapsByLocation.get(`${instance.file}\u0000${instance.location.line}`)
            : undefined;
        const locationGap = dynamicCandidates?.length === 1 ? dynamicCandidates[0] : undefined;
        if (locationGap !== undefined) consumedDynamicGaps.add(locationGap);
        const gap = gapsByKey.get(key) ?? locationGap;
        rows.push(this.playwrightRow(instance, staticEntry, gap, template, locationGap));
      }
    }

    // A file the runners' own configuration disclaims is not a member of
    // any suite: the owner excluded it (or it sits outside every
    // project's testDir), so it becomes no row at all — neither a case
    // nor an unresolved gap. It stays visible in the runner summary.
    const isMember = (file: string): boolean => this.verdictOf(file) !== 'disclaimed';

    for (const [key, staticEntry] of this.staticByKey) {
      if (matchedStaticKeys.has(key) || templateConsumed.has(key)) continue;
      if (!isMember(staticEntry.file)) continue;
      rows.push(this.staticOnlyRow(staticEntry));
    }

    // Remaining unresolved static gaps become visible rows (never
    // omitted): unprovable shapes the runner did NOT enumerate (they
    // cannot execute) stay typed unresolved entries and block the
    // inventory honestly — unless the runner's own configuration
    // disclaims their file, in which case they are not this suite's
    // cases at all.
    for (const [key, gap] of [...gapsByKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (enumeratedKeys.has(key)) continue;
      if (!isMember(gap.file)) continue;
      if (gap.code === 'dynamic-title' && gap.facts !== undefined) {
        const unresolvedCallSites = this.scan.unresolved.filter(
          (candidate) =>
            candidate.code === 'dynamic-title' &&
            candidate.facts !== undefined &&
            reconciliationKey(candidate.file, candidate.titlePath) === key &&
            !consumedDynamicGaps.has(candidate),
        );
        if (unresolvedCallSites.length === 0) continue;
        const row = this.unresolvedRow(unresolvedCallSites[0] as StaticScanResult['unresolved'][number]);
        if (unresolvedCallSites.length > 1 && row.unresolvedReason !== undefined) {
          row.unresolvedReason = {
            ...row.unresolvedReason,
            detail: `${row.unresolvedReason.detail} (further call sites: ${unresolvedCallSites
              .slice(1)
              .map((candidate) => `${candidate.file}:${String(candidate.location.line)}`)
              .join(', ')})`,
          };
        }
        rows.push(row);
        continue;
      }
      const row = this.unresolvedRow(gap);
      const extras = gapExtras.get(key);
      if (extras !== undefined && row.unresolvedReason !== undefined) {
        row.unresolvedReason = {
          ...row.unresolvedReason,
          detail: `${row.unresolvedReason.detail} (further call sites: ${extras.join(', ')})`,
        };
      }
      rows.push(row);
    }
    return rows;
  }

  /** One matched/native-list playwright instance row. */
  private playwrightRow(
    instance: NativeListResult['instances'][number],
    staticEntry: StaticScanResult['entries'][number] | undefined,
    staticGap?: StaticScanResult['unresolved'][number],
    template?: StaticScanResult['entries'][number],
    locationGap?: StaticScanResult['unresolved'][number],
  ): TestCatalogEntry {
    const digest = fileDigest(this.cwd, instance.file);
    // The native list reports '' when the run has no projects; the
    // catalog identity uses null for that (same as static-only rows) —
    // an empty-string project is a schema violation, never an identity.
    const project = instance.project === '' ? null : instance.project;
    const callSiteFacts = this.rowFacts(staticEntry?.facts ?? locationGap?.facts, project);
    const callSiteSignals = staticEntry?.signals ?? locationGap?.signals ?? [];
    const callSiteFile = staticEntry?.file ?? locationGap?.file ?? instance.file;
    const matched = callSiteFacts !== undefined;
    const inference =
      callSiteFacts === undefined
        ? nativeOnlyInference(instance)
        : inferTestKind({
            file: callSiteFile,
            title: instance.title,
            titlePath: instance.titlePath,
            facts: callSiteFacts,
          });
    const suppression =
      callSiteFacts === undefined
        ? { mocks: nativeSuppression(instance.annotations, instance.location), flags: [] }
        : suppressionOf(callSiteFile, callSiteFacts, callSiteSignals, instance.annotations, instance.location);
    const weakSignals = [...inference.weakSignals];
    if (template !== undefined) {
      // The identity is a concrete enumerated instance; the static facts
      // came from its parameterized template (same loop body, same
      // fixtures — sound per-instance). Recorded, never silent.
      weakSignals.push({
        ruleId: 'template-expansion',
        evidence: `static parameterized title '${template.title}' expanded over the enumerated instance (same file, same describe ancestry)`,
        location: template.location,
      });
    }
    if (staticGap !== undefined) {
      // The static scan could not PROVE this call a test (wrapper/
      // dynamic title), yet the runner enumerated it: the runner wins
      // for identity, and the unprovability stays visible as a weak
      // signal (never silently dropped, never blocking twice).
      weakSignals.push({
        ruleId: staticGap.code,
        evidence: `${staticGap.detail} (resolved by native enumeration)`,
        location: staticGap.location,
      });
    }
    return {
      logicalKey: deriveLogicalKey({ runner: 'playwright', project, file: instance.file, titlePath: instance.titlePath }),
      runner: 'playwright',
      project,
      file: instance.file,
      titlePath: [...instance.titlePath],
      title: instance.title,
      sourceLocation: instance.location,
      parameterIdentity: instance.frameworkId,
      sourceDigest: digest ?? EMPTY_SHA256,
      discoveryStatus: 'discovered',
      reconciliation: matched ? 'matched' : 'list-only',
      resolutionOrigin: matched ? 'static' : 'native-list',
      inferredKind: inference.inferredKind,
      kindSignals: inference.kindSignals,
      weakSignals,
      rulesFired: inference.rulesFired,
      categorySignals: inference.categorySignals,
      suppressionSignals: suppression.mocks,
    };
  }

  /**
   * One static-only row: the static scan found the case and the CONFIGURED
   * runner did not enumerate it.
   *
   * The runner whose OWN selection collects the file decides the row's
   * runner: a vitest suite inside a playwright-configured repository is a
   * vitest row, not a phantom playwright test that will never execute. That
   * runner was never enumerated either (Gateforge runs the configured
   * runner), so the row records `reconciliation: 'unavailable'` plus the
   * attribution evidence instead of a reconciliation verdict it cannot
   * support. A file NO runner's selection claims keeps the configured
   * runner and stays the blocking gap it is — ownership is never invented.
   */
  private staticOnlyRow(staticEntry: StaticScanResult['entries'][number]): TestCatalogEntry {
    const inference = inferTestKind({
      file: staticEntry.file,
      title: staticEntry.title,
      titlePath: staticEntry.titlePath,
      facts: staticEntry.facts,
    });
    const digest = fileDigest(this.cwd, staticEntry.file);
    const suppression = suppressionOf(staticEntry.file, staticEntry.facts, staticEntry.signals, [], staticEntry.location);
    const owner = this.ownerOf(staticEntry.file);
    this.recordAttribution(owner, staticEntry.file);
    const foreign = owner !== '' && owner !== this.runner;
    const runner = foreign ? owner : this.staticRowRunner;
    return {
      logicalKey: deriveLogicalKey({ runner, project: null, file: staticEntry.file, titlePath: staticEntry.titlePath }),
      runner,
      project: null,
      file: staticEntry.file,
      titlePath: [...staticEntry.titlePath],
      title: staticEntry.title,
      sourceLocation: staticEntry.location,
      parameterIdentity: staticEntry.parameterIdentity,
      sourceDigest: digest ?? EMPTY_SHA256,
      discoveryStatus: foreign ? 'discovered' : 'unresolved',
      reconciliation:
        foreign || this.native.status === 'unavailable' ? 'unavailable' : 'static-only',
      resolutionOrigin: 'static',
      inferredKind: inference.inferredKind,
      kindSignals: inference.kindSignals,
      weakSignals: [
        ...inference.weakSignals,
        ...(foreign
          ? [
              {
                ruleId: 'runner-file-scope',
                evidence:
                  `this file is outside the configured runner (${this.runner})'s own test-file selection; ` +
                  `the ${owner} configuration claims it, so it is ${owner}'s test (no ${owner} enumeration ran in this run)`,
                location: staticEntry.location,
              },
            ]
          : []),
        // A file no runner's selection claims stays the configured
        // runner's blocking gap; the typed code stays the one every
        // consumer already matches, and THIS weak signal carries the
        // sharper fact.
        ...(owner === ''
          ? [
              {
                ruleId: 'no-runner-claims-file',
                evidence: `no configured runner's own test-file selection claims this file — the ${this.runner} runner will never collect it`,
                location: staticEntry.location,
              },
            ]
          : []),
      ],
      rulesFired: inference.rulesFired,
      categorySignals: inference.categorySignals,
      suppressionSignals: [...suppression.mocks, ...suppression.flags],
      ...(foreign
        ? {}
        : {
            unresolvedReason: {
              code:
                this.native.status === 'unavailable'
                  ? 'reconciliation-unavailable'
                  : 'reconciliation-static-only',
              detail:
                this.native.status === 'unavailable'
                  ? 'no native playwright enumeration ran (no playwright config) — the case is statically visible only'
                  : owner === ''
                    ? `the static scan found this case but no configured runner's own test-file selection claims its file — the ${this.runner} runner will never collect it (check the configured globs, dynamic titles, or filters)`
                    : 'the static scan found this case but the runner did not enumerate it (check configured globs, dynamic titles, or filters)',
            },
          }),
    };
  }

  /**
   * One unresolved-gap row (unresolvable wrapper, budget, dynamic title).
   *
   * The gap keeps its own code and stays unresolved — an unprovable call
   * is unprovable wherever it lives — but it is filed under the runner
   * whose own selection collects the file, so a foreign-runner gap never
   * masquerades as a gap in the configured runner's inventory.
   */
  private unresolvedRow(gap: StaticUnresolved): TestCatalogEntry {
    const owner = this.ownerOf(gap.file);
    this.recordAttribution(owner, gap.file);
    const foreign = owner !== '' && owner !== this.runner;
    const runner = foreign ? owner : this.staticRowRunner;
    const titlePath = gap.titlePath.length > 0 ? gap.titlePath : [UNRESOLVED_TITLE_PLACEHOLDER];
    return {
      logicalKey: deriveLogicalKey({
        runner,
        project: null,
        file: gap.file,
        titlePath,
      }),
      runner,
      project: null,
      file: gap.file,
      titlePath: [...titlePath],
      title: gap.titlePath[gap.titlePath.length - 1] ?? UNRESOLVED_TITLE_PLACEHOLDER,
      sourceLocation: gap.location,
      parameterIdentity: null,
      sourceDigest: fileDigest(this.cwd, gap.file) ?? EMPTY_SHA256,
      discoveryStatus: 'unresolved',
      reconciliation: foreign || this.native.status === 'unavailable' ? 'unavailable' : 'static-only',
      resolutionOrigin: 'static',
      inferredKind: 'unknown',
      kindSignals: [],
      weakSignals: foreign
        ? [
            {
              ruleId: 'runner-file-scope',
              evidence:
                `this file is outside the configured runner (${this.runner})'s own test-file selection; ` +
                `the ${owner} configuration claims it, so it is ${owner}'s test`,
              location: gap.location,
            },
          ]
        : [],
      rulesFired: [],
      categorySignals: [],
      suppressionSignals: [],
      unresolvedReason: { code: gap.code, detail: gap.detail },
    };
  }

  /** One pytest collected-case row (diagnostic identity only, §3.5). */
  pytestEntry(suiteName: string, nodeId: string, file: string, titlePath: string[]): TestCatalogEntry | null {
    // Suite-cwd-relative file → repo-relative for the digest lookup.
    const repoFile = file;
    const digest = fileDigest(this.cwd, repoFile);
    if (digest === null) return null; // unreadable file: no fabricated row
    return {
      logicalKey: deriveLogicalKey({ runner: 'pytest', project: suiteName, file: repoFile, titlePath }),
      runner: 'pytest',
      project: suiteName,
      file: repoFile,
      titlePath,
      title: titlePath[titlePath.length - 1] ?? nodeId,
      sourceLocation: { file: repoFile, line: 1, col: 0 },
      parameterIdentity: nodeId,
      sourceDigest: digest,
      discoveryStatus: 'discovered',
      reconciliation: 'unavailable',
      inferredKind: 'unknown',
      kindSignals: [],
      weakSignals: [],
      rulesFired: [],
      categorySignals: [],
      suppressionSignals: nodeId.includes('[xfail]') || nodeId.includes('[xpass]') ? [{ kind: 'fixme', detail: 'pytest xfail/xpass parameter', location: { file: repoFile, line: 1, col: 0 } }] : [],
    };
  }

  /**
   * One configured-runner row from the adapter enumeration (plan
   * 2026-09-25, runner-agnostic evidence): the runner itself proved the
   * case, so the row is DISCOVERED with the runner's own framework id —
   * the same honest shape the pytest rows use (no Playwright
   * reconciliation applies to it).
   *
   * Args:
   *   runner: the configured runner name (`vitest` or `cypress`).
   *   test: the enumerated test identity.
   *
   * Returns:
   *   TestCatalogEntry | null: the catalog row, or null when the file is
   *   unreadable (never a fabricated row).
   */
  adapterRunnerEntry(runner: 'vitest' | 'cypress', test: RunnerTestIdentity): TestCatalogEntry | null {
    const digest = fileDigest(this.cwd, test.file);
    if (digest === null) return null; // unreadable file: no fabricated row
    const title = test.titlePath[test.titlePath.length - 1] ?? test.logicalKey;
    return {
      logicalKey: deriveLogicalKey({ runner, project: test.project, file: test.file, titlePath: [...test.titlePath] }),
      runner,
      project: test.project,
      file: test.file,
      titlePath: [...test.titlePath],
      title,
      sourceLocation: { file: test.file, line: 1, col: 0 },
      parameterIdentity: test.frameworkId ?? test.logicalKey,
      sourceDigest: digest,
      discoveryStatus: 'discovered',
      reconciliation: 'unavailable',
      inferredKind: 'unknown',
      kindSignals: [],
      weakSignals: [],
      rulesFired: [],
      categorySignals: [],
      suppressionSignals: [],
    };
  }

  /** Validates + orders everything into the final catalog. */
  finalize(entries: TestCatalogEntry[], runnerSummaries: RunnerSummary[]): TestCatalog {
    const sorted = [...entries].sort((a, b) => compareRows(a, b));
    const unresolved: CatalogUnresolved[] = sorted
      .filter((row) => row.discoveryStatus === 'unresolved' && row.unresolvedReason !== undefined)
      .map((row) => ({
        logicalKey: row.logicalKey,
        code: row.unresolvedReason?.code ?? 'unknown',
        detail: row.unresolvedReason?.detail ?? '',
        location: row.sourceLocation,
      }))
      .sort((a, b) => compareLocations(a.location, b.location) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const parseErrors: CatalogParseError[] = this.scan.parseErrors
      .map((error) => ({ file: error.file, message: error.message, location: error.location }))
      .sort((a, b) => compareLocations(a.location, b.location));

    // Completeness is about ENUMERATION, never classification
    // uncertainty (plan phase 2 item 7): unknown KINDS stay complete;
    // failed parses, budget cuts, native reporter errors, unresolved
    // static-only rows (cases the runner never enumerated — they cannot
    // execute), and failed configured diagnostic suites do not. Rows
    // discovered only through the native list (origin 'native-list')
    // ARE complete enumeration: the runner itself proved the case.
    // A repo with no playwright rows at all is vacuously complete even
    // when native reconciliation reported unavailable (non-playwright
    // repos).
    const diagnosticUnavailable = runnerSummaries.some(
      (summary) => summary.runner !== 'playwright' && summary.status === 'unavailable',
    );
    // The CONFIGURED runner's unresolved rows are this run's own gap (its
    // enumeration never produced those cases), and so are playwright's:
    // the union is never weaker than the playwright-only rule, and it is
    // what makes a vitest-configured repository judge its OWN inventory.
    const complete =
      parseErrors.length === 0 &&
      !this.scan.budgetExceeded &&
      this.native.errors.length === 0 &&
      !sorted.some(
        (row) =>
          (row.runner === 'playwright' || row.runner === this.runner) &&
          row.discoveryStatus === 'unresolved',
      ) &&
      !diagnosticUnavailable;

    // Validate through the strict schema: duplicate logical keys and
    // inconsistent roll-ups fail closed here, at construction time.
    return TestCatalogSchema.parse({
      schemaVersion: 1,
      entries: sorted,
      unresolved,
      parseErrors,
      inventoryComplete: complete,
      runnerSummaries: [...runnerSummaries].sort(
        (a, b) => (a.runner < b.runner ? -1 : a.runner > b.runner ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      ),
    });
  }
}

/** sha256 of empty bytes — placeholder ONLY when a digest is unreadable. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Builds the instance-title matcher for a parameterized static title, or
 * null when the title carries no `${}` template slots. Literal parts
 * match exactly (regex-escaped); each slot matches any (possibly empty)
 * text — the same expansion the runner performs over the loop values.
 *
 * Args:
 *   title: the static title (may contain `${}` slots).
 *
 * Returns:
 *   Anchored RegExp, or null for non-parameterized titles.
 */
export function templateTitlePattern(title: string): RegExp | null {
  if (!title.includes('${}')) return null;
  const escaped = title.split('${}').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`);
}

/** Stable key for location dedupe. */
function locationKey(location: Location): string {
  return `${location.file}:${String(location.line)}:${String(location.col)}`;
}

/** Row order: file, then titlePath, then project (deterministic). */
function compareRows(a: TestCatalogEntry, b: TestCatalogEntry): number {
  const projectA = a.project ?? '';
  const projectB = b.project ?? '';
  return (
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    (a.titlePath.join('>') < b.titlePath.join('>') ? -1 : a.titlePath.join('>') > b.titlePath.join('>') ? 1 : 0) ||
    (projectA < projectB ? -1 : projectA > projectB ? 1 : 0)
  );
}

/** Location order: file, line, col. */
function compareLocations(a: Location, b: Location): number {
  return (
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.line - b.line ||
    a.col - b.col
  );
}

/**
 * Inference for rows whose ONLY enumeration source is the native runner
 * list (resolution origin `'native-list'`): no static facts were read,
 * so NO strong kind rule may fire (running the rules over empty facts
 * would fabricate a `unit` proposal from absence). The kind stays
 * `unknown` and the native-only identity is recorded as a weak signal.
 */
function nativeOnlyInference(instance: NativeListResult['instances'][number]): InferenceResult {
  const weak: WeakSignal = {
    ruleId: 'native-list-only',
    evidence:
      'identity resolved by the native runner enumeration alone; the static scan did not derive this case ' +
      '(outside configured globs or not statically followable) — no call-site facts were read',
    location: instance.location,
  };
  return { inferredKind: 'unknown', kindSignals: [], weakSignals: [weak], rulesFired: [], categorySignals: [], mockSignals: [] };
}

/** Splits static signals into mock vs skip/only/fixme rows. */
function suppressionOf(
  file: string,
  facts: StaticTestFacts,
  signals: StaticScanResult['entries'][number]['signals'],
  annotations: readonly string[],
  annotationLocation: Location,
) {
  const mocks = mockSignalsOf(file, facts);
  const flags = signals.map((signal) => ({
    kind: signal.kind,
    detail: signal.detail,
    location: signal.location,
  }));
  for (const annotation of annotations) {
    if (annotation === 'skip' || annotation === 'fixme') {
      flags.push({
        kind: annotation,
        detail: `native ${annotation} annotation`,
        location: annotationLocation,
      });
    }
  }
  return { mocks, flags };
}

/** Suppression rows derived from native annotations alone. */
function nativeSuppression(annotations: readonly string[], location: Location) {
  return annotations
    .filter((annotation) => annotation === 'skip' || annotation === 'fixme')
    .map((annotation) => ({
      kind: annotation as 'skip' | 'fixme',
      detail: `native ${annotation} annotation`,
      location,
    }));
}

/** Mock suppression signals from call-site facts. */
function mockSignalsOf(file: string, facts: StaticTestFacts) {
  const signals: Array<{ kind: 'mock'; detail: string; location: Location }> = [];
  if (facts.pageRoute !== null) {
    signals.push({ kind: 'mock', detail: 'page.route interception inside the test body', location: facts.pageRoute });
  }
  if (facts.fileRouteInterception !== null) {
    signals.push({
      kind: 'mock',
      detail: `PAGE_OBSERVATION_TAMPER_RISK: browser API mutation at ${facts.fileRouteInterception.file}:${facts.fileRouteInterception.line}`,
      location: facts.fileRouteInterception,
    });
  }
  if (isMockedFolderPath(file)) {
    signals.push({ kind: 'mock', detail: "the spec lives in a 'mocked' folder", location: { file, line: 1, col: 0 } });
  }
  if (facts.fileMockImport !== null) {
    signals.push({ kind: 'mock', detail: 'vi.mock/jest.mock module mock in the test file', location: facts.fileMockImport });
  }
  return signals;
}

// Re-exports kept minimal: the CLI needs repoRelative nowhere else today.
export { repoRelative };
