/**
 * `gateforge tests`: seven subcommands for test inventory, annotation sync,
 * mapping, and diagnostic workflows.
 * - `discover` — inventory the repository's tests into the derived
 *   run-state catalog (Phase 2).
 * - `suggest` — resolve mappings for the run's obligations and produce
 *   reuse-ordered suggestions with typed causes (TEST_MAPPING_MISSING /
 *   TEST_KIND_UNKNOWN / TEST_MAPPING_AMBIGUOUS / TEST_MAPPING_STALE).
 *   An inspection surface, NOT a gate: exit 0 even with blocking mapping
 *   problems.
 * - `mark` — validate a declaration against the CURRENT catalog and
 *   obligation registry, then write/update `.gateforge/test-map.yml`
 *   ATOMICALLY and idempotently, printing the exact diff. Never edits
 *   test files, never adds waivers, refuses contradictions.
 * - `sync` — regenerate only annotation-sourced entries from an AST-only
 *   scan; hand-written sidecar entries are never modified.
 * - `explain` — the per-test §4 report: requirements, existing-test
 *   identity, mapping origin, honest execution status, next action, and
 *   `New test needed`. Exit 2 for an unknown key.
 * - `diagnose` — the §3.5 advisory alarm (Phase 4): runs the CONFIGURED
 *   pytest diagnostic suites once per suite, isolated (own process,
 *   GATEFORGE_* stripped, finite timeout, junit XML in excluded run
 *   state), and prints/serializes a SEPARATE diagnostic report. Exit
 *   codes: 0 completed run with ≥1 passing test and no unexpected
 *   failures; 1 test failures; 2 unavailable/incomplete (collection
 *   error, timeout, missing interpreter, interruption, zero tests, or
 *   only skipped/xfail). Diagnostic results are never fed into claims,
 *   witness records, baselines, waivers, or E2E satisfaction.
 *
 * All subcommands accept `--json` for machine-readable output and print
 * deterministic human text otherwise. Exit codes follow the repo
 * contract: 0 ok, 2 config/usage errors (including unknown keys/ids and
 * failed native enumeration).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  compareStrings,
  mappingSuggestions,
  TestKindSchema,
  TestMapSchema,
  type Claim,
  type GateforgeConfig,
  type JsonValue,
  type Obligation,
  type ResourceGraph,
  type ResolvedMappings,
  type TestCatalog,
  type TestCatalogEntry,
  type TestKind,
  type TestMap,
  type TestMapEntry,
} from '@gate-forge/core';
import {
  discoverTestCatalog,
  TestDiscoveryError,
  scanTestFiles,
  type DiscoverResult,
  type StaticRegistrationWarning,
} from '@gate-forge/pack-playwright';
import { parseArgs, stringFlag } from '../args.js';
import { diagnosticsJson, renderDiagnosticsText, runDiagnosticSuites } from '../diagnostics.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
} from '../input-snapshot.js';
import {
  diffLines,
  loadOptionalTestMap,
  relativeToRepo,
  resolveRepositoryMappings,
  nativeInventoryBlocking,
  serializeTestMap,
  TEST_MAP_RELATIVE,
  annotationTestMapEntries,
  writeTestMapAtomic,
} from '../mapping.js';
import { runPipeline, sourcesByResourceId } from '../pipeline.js';
import { resolveProvider } from '../providers.js';
import { httpRoutesView, resolveStateDir } from '../state.js';
import { engineGeneratedStateFileFilter } from '../state-artifacts.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { installedPlaywrightCompatibilityError } from '../package-compatibility.js';
import { loadCacheExclusions } from '../cache-exclusions.js';

export const TESTS_USAGE = `\
usage: gateforge tests discover [--json] [--pytest]
       gateforge tests catalog [--json]
       gateforge tests surface-doctor [--json]
       gateforge tests suggest [--changed] [--json]
       gateforge tests mark --test <key> --kind <kind> [--category <c>]... \\
         --obligation <id>... --reason "<text>"
       gateforge tests sync [--json]
       gateforge tests explain --test <key> [--json]
       gateforge tests diagnose [--suite <name>] [--json]`;

/** The derived catalog file under the run-state directory. */
export const CATALOG_FILE_NAME = 'test-catalog.json';

/** How many ranked candidates the text surface prints per obligation. */
const SUGGESTED_CANDIDATE_LIMIT = 5;

/**
 * Runs the `tests` command family (discover/suggest/mark/explain).
 *
 * Args:
 *   io: process context.
 *   argv: flags + positionals after the `tests` subcommand.
 *
 * Returns:
 *   number: exit code — 0 on success (unresolved catalog rows and
 *     blocking mapping problems are DATA on the inspection surfaces),
 *     2 for config/usage errors.
 * @throws UsageError for unknown subcommands/flags, unknown test keys or
 *   obligation ids, contradictory declarations, and failed native
 *   enumeration; config errors propagate from core (all exit 2).
 */
export async function testsCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  const subcommand = positionals[0];
  if (subcommand === undefined || options['help'] === true) {
    writeLine(io.stdout, TESTS_USAGE);
    return subcommand === undefined && options['help'] !== true ? 2 : 0;
  }
  switch (subcommand) {
    case 'discover':
      return discoverSubcommand(io, options);
    case 'catalog':
      return catalogSubcommand(io, options);
    case 'surface-doctor':
      return surfaceDoctorSubcommand(io, options);
    case 'suggest':
      return suggestSubcommand(io, options);
    case 'mark':
      return markSubcommand(io, options);
    case 'sync':
      return syncSubcommand(io, options);
    case 'explain':
      return explainSubcommand(io, options);
    case 'diagnose':
      return diagnoseSubcommand(io, options);
    default:
      throw new UsageError(`unknown tests subcommand '${subcommand}' (${TESTS_USAGE.split('\n')[0] ?? TESTS_USAGE})`);
  }
}

/** Prints a static list of UI test cases that lack a surface descriptor.
 *
 * Args:
 *   io: process context.
 *   options: parsed command flags.
 *
 * Returns:
 *   number: 0 when the diagnostic completes, including when it finds rows.
 */
async function surfaceDoctorSubcommand(io: Io, options: Record<string, string | boolean | string[]>): Promise<number> {
  rejectUnknownFlags(options, ['json'], TESTS_USAGE);
  const compatibilityError = installedPlaywrightCompatibilityError();
  if (compatibilityError !== null) {
    writeLine(io.stderr, compatibilityError);
    return 2;
  }
  const { diagnoseMissingUiSurfaces } = await import('@gate-forge/pack-playwright');
  const report = diagnoseMissingUiSurfaces(io.cwd);
  if (options['json'] === true) {
    writeLine(io.stdout, canonicalJson(report as unknown as JsonValue));
    return 0;
  }
  writeLine(io.stdout, `UI surface diagnostic: ${String(report.missingSurface.length)} test(s) need a surface descriptor`);
  for (const entry of report.missingSurface) writeLine(io.stdout, `  ${entry.file}: ${entry.title}`);
  for (const warning of report.warnings) writeLine(io.stdout, `scan warning: ${warning}`);
  writeLine(io.stdout, `action: ${report.action}`);
  return 0;
}

/** Runs one discovery pass and persists the derived catalog artifact. */
async function runDiscovery(
  cwd: string,
  config: GateforgeConfig,
  stateDir: string,
  collectPytest: boolean,
): Promise<DiscoverResult> {
  let discovered: DiscoverResult;
  try {
    discovered = await discoverTestCatalog({
      cwd,
      config,
      collectPytest,
      excludeFile: engineGeneratedStateFileFilter(cwd, stateDir),
    });
  } catch (error) {
    // A failed native enumeration is a config/environment problem
    // (exit 2), never an empty catalog.
    if (error instanceof TestDiscoveryError) throw new UsageError(error.message);
    throw error;
  }
  // The catalog is a DERIVED artifact: it lives under the run-state dir
  // (excluded from tracked inputs), never beside the tests it inventories.
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, CATALOG_FILE_NAME), `${discovered.json}\n`, 'utf8');
  return discovered;
}
/**
 * Builds a derived test catalog with mapped claims and related HTTP routes.
 *
 * Args:
 *   io: repository context and output streams.
 *   options: parsed catalog flags.
 *
 * Returns:
 *   Promise<number>: zero when discovery completes, two for usage or discovery errors.
 */
async function catalogSubcommand(
  io: Io,
  options: Record<string, string | boolean | string[]>,
): Promise<number> {
  rejectUnknownFlags(options, ['json', 'help'], TESTS_USAGE);
  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd);
  const discovered = await runDiscovery(io.cwd, config, stateDir, false);
  const sidecar = loadOptionalTestMap(io.cwd);
  const entries = discovered.catalog.entries.map((entry) => {
    const claims = new Set<string>(
      sidecar?.tests.find((declaration) => declaration.key === entry.logicalKey)?.claims ?? [],
    );
    for (const claim of discovered.nativeClaims) {
      if (claim.testFile === entry.file && (claim.testId === entry.logicalKey || claim.testId === entry.title)) {
        claims.add(claim.obligationId);
      }
    }
    const sortedClaims = [...claims].sort(compareStrings);
    const source = readFileSync(join(io.cwd, entry.file), 'utf8');
    const routePattern = /(?:goto|route|url|path)\s*\(\s*(['"`])(\/[^'"`]*?)\1/g;
    const routeMatches: string[] = [];
    for (const match of source.matchAll(routePattern)) {
      const route = match[2];
      if (route !== undefined) routeMatches.push(route);
    }
    const routes = [...new Set(routeMatches)].sort(compareStrings);
    return { file: entry.file, title: entry.title, claims: sortedClaims, routes };
  });
  if (options['json'] === true) {
    writeLine(io.stdout, canonicalJson({ schemaVersion: 1, entries } as unknown as JsonValue));
  } else {
    writeLine(io.stdout, `tests catalog: ${entries.length} test(s)`);
    for (const entry of entries) {
      writeLine(io.stdout, `  ${entry.file}: ${entry.title}`);
      if (entry.claims.length > 0) writeLine(io.stdout, `    claims: ${entry.claims.join(', ')}`);
      if (entry.routes.length > 0) writeLine(io.stdout, `    routes: ${entry.routes.join(', ')}`);
    }
  }
  writeRegistrationWarnings(io, discovered.registrationWarnings, 'tests catalog');
  return 0;
}

/**
 * Prints static warnings for test registrations controlled by Gateforge
 * environment state without changing the machine-readable catalog.
 *
 * Args:
 *   io: command output streams.
 *   warnings: registration warnings from static discovery.
 *   command: command label used to identify the advisory.
 *
 * Returns:
 *   void.
 */
function writeRegistrationWarnings(
  io: Io,
  warnings: readonly StaticRegistrationWarning[],
  command: string,
): void {
  for (const warning of warnings) {
    writeLine(
      io.stderr,
      `${command}: registration warning ${warning.file}:${String(warning.location.line)}: ` +
        `${warning.titlePath.join(' > ')} is conditional on ${warning.environmentVariable}; ` +
        'keep test registration independent of Gateforge run variables',
    );
  }
}

// ---------------------------------------------------------------------------
// tests discover (Phase 2 surface, unchanged behavior)
// ---------------------------------------------------------------------------

/** Implements `tests discover`. */
async function discoverSubcommand(
  io: Io,
  options: Record<string, string | boolean | string[]>,
): Promise<number> {
  rejectUnknownFlags(options, ['json', 'pytest', 'help'], TESTS_USAGE);
  const asJson = options['json'] === true;
  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd);
  const discovered = await runDiscovery(io.cwd, config, stateDir, options['pytest'] === true);
  const { catalog, json } = discovered;

  // Config problems the native enumeration PROVED (e.g. a playwright
  // config that declares no named project): stderr, never stdout —
  // the catalog document stays parseable — and never a non-zero
  // exit: discovery itself succeeded (behaviour-neutral).
  for (const warning of discovered.configWarnings) {
    writeLine(io.stderr, `error: ${warning}`);
  }

  if (asJson) {
    writeLine(io.stdout, json);
    writeRegistrationWarnings(io, discovered.registrationWarnings, 'tests discover');
    return 0;
  }
  const discoveredCount = catalog.entries.filter((entry) => entry.discoveryStatus === 'discovered').length;
  writeLine(
    io.stdout,
    `test catalog: discovered=${String(discoveredCount)}` +
      ` unresolved=${String(catalog.unresolved.length)}` +
      ` parseErrors=${String(catalog.parseErrors.length)}` +
      ` inventoryComplete=${catalog.inventoryComplete ? 'true' : 'false'}`,
  );
  const histogram = new Map<string, number>();
  for (const entry of catalog.entries) {
    histogram.set(entry.inferredKind, (histogram.get(entry.inferredKind) ?? 0) + 1);
  }
  const kinds = [...histogram.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  writeLine(io.stdout, `kinds: ${kinds.map(([kind, count]) => `${kind}=${String(count)}`).join(', ') || '(none)'}`);
  for (const summary of catalog.runnerSummaries) {
    writeLine(io.stdout, `runner ${summary.runner}/${summary.name}: ${summary.status} — ${summary.detail}`);
  }
  const edges = Object.entries(discovered.projectDependencies ?? {})
    .filter(([, dependencies]) => dependencies.length > 0)
    .map(([name, dependencies]) => `${name} → ${dependencies.join(', ')}`)
    .sort();
  if (edges.length > 0) {
    // The runner's OWN resolved graph, not a reading of the consumer
    // config: a supervised run orders its projects by exactly these edges.
    writeLine(io.stdout, `project dependencies: ${edges.join('; ')}`);
  }
  writeRegistrationWarnings(io, discovered.registrationWarnings, 'tests discover');
  if (catalog.unresolved.length > 0) {
    writeLine(io.stdout, `unresolved (${String(catalog.unresolved.length)}):`);
    for (const gap of catalog.unresolved) {
      writeLine(
        io.stdout,
        `  [${gap.code}] ${gap.location.file}:${String(gap.location.line)} — ${gap.detail}`,
      );
    }
  }
  if (catalog.parseErrors.length > 0) {
    writeLine(io.stdout, `parse errors (${String(catalog.parseErrors.length)}):`);
    for (const parseError of catalog.parseErrors) {
      writeLine(
        io.stdout,
        `  ${parseError.location.file}:${String(parseError.location.line)} — ${parseError.message}`,
      );
    }
  }
  writeLine(io.stdout, `catalog written: ${join(stateDir, CATALOG_FILE_NAME)}`);
  return 0;
}

// ---------------------------------------------------------------------------
// tests suggest (Phase 3)
// ---------------------------------------------------------------------------

/** One JSON-serializable suggestion row (canonical output shape). */
interface SuggestionJson {
  obligationId: string;
  cause: string;
  candidates: Array<{
    logicalKey: string;
    file: string;
    why: string[];
    overlaps: string[];
    /** Evidence score behind the rank (higher is a stronger match). */
    score: number;
    /** 1-based position in the ranked list. */
    rank: number;
  }>;
  missingEvidence: string;
  nextAction: string;
  /**
   * The reuse verdict: `no` (reuse proven), `yes` (nothing reusable),
   * or `unverified` (a candidate exists but ONE signal carries it —
   * confirm the request before marking).
   */
  newTestNeeded: 'no' | 'yes' | 'unverified';
  /** Required behavior case slugs with no declared test mapping (empty without a behavior catalog). */
  unmappedCases: string[];
}

/**
 * Route hints per obligation (`GET /api/v1/accounts`, …) — the SAME
 * evidence for every surface that reports a reuse verdict. They rank
 * candidates by route evidence AND decide whether the top candidate is
 * `no` or `unverified`, so building them once keeps `tests suggest` and
 * `tests explain` from disagreeing about the same test.
 *
 * Args:
 *   graph: the classified resource graph.
 *   obligations: the run's obligations.
 *
 * Returns:
 *   Map<string, string[]>: obligation id → its routes; absent when the
 *   run knows no route for that resource (never a different rule).
 */
function routeHintsByObligation(
  graph: ResourceGraph,
  obligations: readonly Obligation[],
): Map<string, string[]> {
  const routesByResource = new Map<string, string[]>();
  for (const route of httpRoutesView(graph)) {
    const hints = routesByResource.get(route.resourceId) ?? [];
    hints.push(`${route.method} ${route.canonicalPath}`);
    routesByResource.set(route.resourceId, hints);
  }
  const byObligation = new Map<string, string[]>();
  for (const obligation of obligations) {
    const routes = routesByResource.get(obligation.resourceId);
    if (routes !== undefined) byObligation.set(obligation.id, [...routes]);
  }
  return byObligation;
}

/** Implements `tests suggest [--changed]`. */
async function suggestSubcommand(
  io: Io,
  options: Record<string, string | boolean | string[]>,
): Promise<number> {
  rejectUnknownFlags(options, ['changed', 'json', 'help'], TESTS_USAGE);
  const asJson = options['json'] === true;
  const diffScoped = options['changed'] === true;
  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd);

  // The same pipeline every gate command runs: obligations come from the
  // policy engine (the registry the resolver validates against), and the
  // join-aware source map powers the `--changed` obligation filter.
  const provider = diffScoped ? resolveProvider(config.changed.provider, io.cwd, io.env).provider : 'all-files';
  const pipeline = await runPipeline({ cwd: io.cwd, env: io.env, config, provider, stateDir });
  const discovered = await runDiscovery(io.cwd, config, stateDir, true);
  writeRegistrationWarnings(io, discovered.registrationWarnings, 'tests suggest');
  const mapped = await resolveRepositoryMappings({
    cwd: io.cwd,
    config,
    obligations: pipeline.policy.obligations,
    catalog: discovered.catalog,
    nativeClaims: discovered.nativeClaims,
    nativeErrors: discovered.nativeErrors,
    nativeInstances: discovered.nativeInstances,
    behaviorCatalog: pipeline.behaviorCatalog,
  });

  // `--changed` narrows the SUGGESTED obligations to the changed scope
  // with the existing join-aware rule (resource source + call sources).
  // It never hides resolution problems for out-of-scope obligations at
  // the gate (that is check's job); this surface only orders work.
  let scoped = pipeline.policy.obligations;
  let scopeMode: 'all' | 'changed' = 'all';
  if (diffScoped) {
    scopeMode = 'changed';
    const changedSet = new Set(pipeline.changedFiles);
    const sources = sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog);
    scoped = pipeline.policy.obligations.filter((obligation) =>
      (sources.get(obligation.resourceId) ?? []).some((source) => changedSet.has(source)),
    );
  }

  const routeHints = routeHintsByObligation(pipeline.graph, pipeline.policy.obligations);

  // A COMPLETE enumeration failure of the CONFIGURED runner hides the
  // suggestions (an empty inventory would read as "no candidates"
  // instead of "the runner could not enumerate"). The runner is
  // `config.runner` — absent means playwright, the historical behavior.
  const enumerationFailedCompletely =
    mapped.nativeErrors.length > 0 &&
    !discovered.catalog.entries.some((entry) => entry.runner === config.runner);
  const suggestions = enumerationFailedCompletely
    ? []
    : mappingSuggestions({
        catalog: discovered.catalog,
        obligationIds: scoped.map((obligation) => obligation.id),
        resolution: mapped.resolution,
        routeHints,
      });
  const mappingProblems = [
    ...mapped.resolution.problems,
    ...(mapped.nativeLoadProblem === null
      ? []
      : [
          {
            ...mapped.nativeLoadProblem,
            nextAction: nativeInventoryBlocking(mapped.nativeLoadProblem)[0]?.nextAction ?? '',
          },
        ]),
  ];
  // Required-case hints (plan 2026-09-19 Phase 6 item 6): candidates
  // come from the current inventory (resolver suggestions above); the
  // unmapped required cases name what final approval still needs —
  // witnessed case execution, never the suggestion itself.
  const behaviorRequirements = pipeline.behaviorCatalog?.requirements ?? {};
  const mappedCasesByObligation = new Map<string, Set<string>>();
  for (const group of mapped.resolution.obligations) {
    const mapped = new Set<string>();
    for (const binding of group.bindings) {
      if (binding.origin !== 'sidecar') continue;
      for (const caseId of binding.caseIds ?? []) mapped.add(caseId);
    }
    mappedCasesByObligation.set(group.obligationId, mapped);
  }
  const unmappedCaseSlugs = (obligationId: string): string[] => {
    const required = behaviorRequirements[obligationId] ?? [];
    const mapped = mappedCasesByObligation.get(obligationId) ?? new Set<string>();
    return required
      .filter((caseId) => !mapped.has(caseId))
      .map(
        (caseId) =>
          pipeline.behaviorCatalog?.cases.find((item) => item.caseId === caseId)?.definition.id ?? caseId,
      );
  };
  // "already declared for" is about DECLARATIONS: a `test-map.yml` entry
  // or an `@gateforge` annotation. An inferred or prior-run binding is a
  // suggestion and never a declaration.
  const obligationsByTestKey = new Map<string, string[]>();
  for (const group of mapped.resolution.obligations) {
    for (const binding of group.bindings) {
      if (binding.origin !== 'native' && binding.origin !== 'sidecar') continue;
      const obligations = obligationsByTestKey.get(binding.logicalKey) ?? [];
      obligations.push(group.obligationId);
      obligationsByTestKey.set(binding.logicalKey, obligations);
    }
  }
  const suggestionJson: SuggestionJson[] = suggestions.map((suggestion) => ({
    obligationId: suggestion.obligationId,
    cause: suggestion.cause,
    candidates: suggestion.candidates.map((candidate) => ({
      logicalKey: candidate.logicalKey,
      file: candidate.file,
      why: [...candidate.why],
      overlaps: [...new Set(obligationsByTestKey.get(candidate.logicalKey) ?? [])]
        .filter((obligationId) => obligationId !== suggestion.obligationId)
        .sort(compareStrings),
      score: candidate.score,
      rank: candidate.rank,
    })),
    missingEvidence: suggestion.missingEvidence,
    nextAction: suggestion.nextAction,
    newTestNeeded: suggestion.newTestNeeded,
    unmappedCases: unmappedCaseSlugs(suggestion.obligationId),
  }));

  if (asJson) {
    writeLine(
      io.stdout,
      canonicalJson({
        schemaVersion: 1,
        scope: {
          mode: scopeMode,
          changedFiles: [...pipeline.changedFiles].sort(compareStrings),
          obligationsInScope: scoped.length,
        },
        problems: mappingProblems as unknown as JsonValue,
        suggestions: suggestionJson,
      } as unknown as JsonValue),
    );
    return 0;
  }

  writeLine(
    io.stdout,
    `suggest: ${String(pipeline.policy.obligations.length)} obligation(s) considered` +
      ` (${String(scoped.length)} in ${scopeMode} scope),` +
      ` ${String(mappingProblems.length)} mapping problem(s),` +
      ` ${String(suggestions.length)} suggestion(s)`,
  );
  for (const problem of mappingProblems) {
    const where = problem.obligationId === null ? '' : ` for '${problem.obligationId}'`;
    writeLine(io.stdout, `problem [${problem.cause}]${where}: ${problem.detail}`);
    if ('nextAction' in problem) writeLine(io.stdout, `  next action: ${problem.nextAction}`);
  }
  for (const suggestion of suggestions) {
    writeLine(io.stdout, `[${suggestion.cause}] ${suggestion.obligationId}`);
    writeLine(io.stdout, `  missing evidence: ${suggestion.missingEvidence}`);
    writeLine(io.stdout, `  next action: ${suggestion.nextAction}`);
    // The third state names the CHECK, not a verdict: `unverified` means a
    // candidate exists but one signal carries it, so the owner must
    // confirm the request before marking it.
    const routeHint = routeHints.get(suggestion.obligationId)?.[0] ?? 'the request this obligation describes';
    writeLine(
      io.stdout,
      suggestion.newTestNeeded === 'unverified'
        ? `  new test needed: unverified — check that a candidate really sends ${routeHint} before marking ` +
            `(gateforge explain ${suggestion.obligationId})`
        : `  new test needed: ${suggestion.newTestNeeded}`,
    );
    const unmapped = unmappedCaseSlugs(suggestion.obligationId);
    if (unmapped.length > 0) {
      writeLine(io.stdout, `  unmapped cases: ${unmapped.join(', ')} (map with tests mark --case, then prove with witnessed execution)`);
    }
    if (suggestion.candidates.length > 0) {
      writeLine(io.stdout, '  candidates (ranked by evidence):');
      // The printed list is capped so one weakly-matching repository
      // cannot bury the answer; `--json` keeps every ranked candidate.
      const printed = suggestion.candidates.slice(0, SUGGESTED_CANDIDATE_LIMIT);
      for (const candidate of printed) {
        writeLine(io.stdout, `  - #${String(candidate.rank)} ${candidate.logicalKey} (${candidate.file})`);
        for (const why of candidate.why) {
          writeLine(io.stdout, `    why: ${why}`);
        }
        const overlaps = obligationsByTestKey.get(candidate.logicalKey) ?? [];
        const otherObligations = [...new Set(overlaps)]
          .filter((obligationId) => obligationId !== suggestion.obligationId)
          .sort(compareStrings);
        if (otherObligations.length > 0) {
          writeLine(io.stdout, `    already declared for: ${otherObligations.join(', ')}`);
        }
      }
      const hidden = suggestion.candidates.length - printed.length;
      if (hidden > 0) {
        writeLine(
          io.stdout,
          `    ... and ${String(hidden)} more candidate(s) — run \`gateforge tests suggest --json\` for the full ranked list`,
        );
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// tests mark (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Resolves the `--test <key>` argument against the CURRENT catalog.
 *
 * Two forms are accepted, because BOTH are what the surfaces hand the
 * owner: the catalog `logicalKey` (`tests discover`, `tests suggest`,
 * `check`) and the reconciliation key `<file>#<titlePath joined by ''>`
 * (REFERENCE.md, `execution.ts` sidecar bindings, the runner's own test
 * events). Rejecting the documented form made a test that IS in the
 * catalog read as unknown, and the "run `gateforge tests discover`"
 * next action useless — the catalog was never the problem.
 *
 * Args:
 *   catalog: the freshly discovered catalog.
 *   requested: the raw `--test` value.
 *
 * Returns:
 *   TestCatalogEntry: the ONE entry the key names.
 * @throws UsageError naming the form, and for an ambiguous reconciliation
 *   key every matching logical key (a file+title can run under several
 *   runner projects, and only the logical key tells them apart).
 */
function resolveTestKey(catalog: TestCatalog, requested: string): TestCatalogEntry {
  const byLogicalKey = catalog.entries.find((candidate) => candidate.logicalKey === requested);
  if (byLogicalKey !== undefined) return byLogicalKey;
  const byReconciliation = catalog.entries.filter(
    (candidate) => `${candidate.file}#${candidate.titlePath.join('>')}` === requested,
  );
  if (byReconciliation.length === 1) {
    const [only] = byReconciliation;
    if (only !== undefined) return only;
  }
  if (byReconciliation.length > 1) {
    throw new UsageError(
      `test key '${requested}' matches ${String(byReconciliation.length)} tests ` +
        `(the same file and title run under several runner projects) — pass the full logical key of the one you mean: ` +
        `${byReconciliation.map((candidate) => candidate.logicalKey).sort(compareStrings).join(', ')}`,
    );
  }
  throw new UsageError(unknownTestKeyMessage(catalog, requested));
}

/**
 * The not-found diagnostic for `--test`: it names BOTH accepted forms
 * (so the reader can see their own key was well-formed) and, when the
 * file part of a reconciliation key does exist in the catalog, up to five
 * of that file's real keys — the closest useful answer to "which one did
 * I mean?".
 */
function unknownTestKeyMessage(catalog: TestCatalog, requested: string): string {
  const base =
    `unknown test key '${requested}' — not in the discovered catalog ` +
    `(${String(catalog.entries.length)} entries; run gateforge tests discover --json). ` +
    'Accepted forms: the catalog logicalKey (`playwright:chromium:e2e/accounts.spec.js:Accounts>creates an account`) ' +
    "or the reconciliation key `<file>#<titlePath joined by '>'>` (`e2e/accounts.spec.js#Accounts>creates an account`)";
  const separator = requested.indexOf('#');
  if (separator <= 0) return base;
  const file = requested.slice(0, separator);
  const inFile = catalog.entries.filter((candidate) => candidate.file === file);
  if (inFile.length === 0) return `${base}; no catalog entry is in '${file}'`;
  const keys = inFile.map((candidate) => candidate.logicalKey).sort(compareStrings);
  const shown = keys.slice(0, 5).join(', ');
  return `${base}. Keys in '${file}': ${shown}${keys.length > 5 ? ` and ${String(keys.length - 5)} more` : ''}`;
}

/** Implements `tests mark --test … --kind … --obligation … --reason …`. */
async function markSubcommand(
  io: Io,
  options: Record<string, string | boolean | string[]>,
): Promise<number> {
  rejectUnknownFlags(options, ['test', 'kind', 'category', 'obligation', 'reason', 'case', 'json', 'help'], TESTS_USAGE);
  const asJson = options['json'] === true;
  const testKey = stringFlag(options, 'test');
  const kind = stringFlag(options, 'kind');
  const reason = stringFlag(options, 'reason');
  const categories = flagArray(options, 'category');
  const obligationIds = flagArray(options, 'obligation');
  const caseFlags = flagArray(options, 'case');
  if (
    testKey === undefined ||
    kind === undefined ||
    reason === undefined ||
    obligationIds.length === 0
  ) {
    writeLine(io.stderr, MARK_USAGE_LINE);
    throw new UsageError(
      'tests mark requires --test <key>, --kind <kind>, at least one --obligation <id>, and --reason "<text>"',
    );
  }

  const validatedKind = validateKind(kind);
  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd);

  // Validate against the CURRENT catalog and obligation registry (plan
  // §5.3): a declaration pointing outside either fails with a precise
  // error before any byte is written.
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });
  const registry = new Set(pipeline.policy.obligations.map((obligation) => obligation.id));
  const unknownObligations = obligationIds.filter((id) => !registry.has(id));
  if (unknownObligations.length > 0) {
    throw new UsageError(
      `unknown obligation id '${unknownObligations[0]}' — not generated by the current policies ` +
        `(run gateforge obligations --json for the registry)`,
    );
  }
  const discovered = await runDiscovery(io.cwd, config, stateDir, true);
  const entry = resolveTestKey(discovered.catalog, testKey);
  // The sidecar stores the stable logicalKey whichever accepted form the
  // owner typed, so a mapping's identity never depends on the input form.
  const declaredKey = entry.logicalKey;
  assertKindDeclarationAllowed(entry, validatedKind, declaredKey);

  const resolvedCaseIds: string[] = [];
  if (caseFlags.length > 0) {
    const catalog = pipeline.behaviorCatalog;
    if (catalog === null) {
      throw new UsageError('tests mark --case requires a compiled behavior catalog (set behaviorPolicy)');
    }
    const seenCases = new Set<string>();
    for (const rawId of caseFlags) {
      const compiled = catalog.cases.find((item) => item.caseId === rawId || item.definition.id === rawId);
      if (compiled === undefined) {
        throw new UsageError(
          `unknown case id '${rawId}' — not in the current behavior catalog`,
        );
      }
      if (seenCases.has(compiled.caseId)) {
        throw new UsageError(
          `duplicate case id '${rawId}' — each required case is declared once`,
        );
      }
      seenCases.add(compiled.caseId);
      if (!compiled.obligationIds.some((id) => obligationIds.includes(id))) {
        throw new UsageError(
          `case '${rawId}' does not belong to any of the claimed obligations`,
        );
      }
      resolvedCaseIds.push(compiled.caseId);
    }
    if (entry.titlePath.length === 0) {
      throw new UsageError(
        `cannot attach --case to whole-file test '${declaredKey}': case mapping requires a titlePath-scoped test, not a file wildcard`,
      );
    }
  }
  const newEntry: TestMapEntry = {
    key: declaredKey,
    selector: {
      runner: entry.runner,
      ...(entry.project !== null ? { project: entry.project } : {}),
      file: entry.file,
      titlePath: [...entry.titlePath],
    },
    kind: validatedKind,
    ...(categories.length > 0 ? { categories: [...new Set(categories)].sort(compareStrings) } : {}),
    claims: [...new Set(obligationIds)].sort(compareStrings),
    ...(resolvedCaseIds.length > 0 ? { caseIds: [...new Set(resolvedCaseIds)].sort(compareStrings) } : {}),
    reason,
  };
  const previousMap = loadOptionalTestMap(io.cwd) ?? { schemaVersion: 1 as const, tests: [] };
  const tests = previousMap.tests.filter((existing) => existing.key !== declaredKey);
  tests.push(newEntry);
  tests.sort((a, b) => compareStrings(a.key, b.key));
  const nextMap: TestMap = { schemaVersion: 1, tests };

  const previousContent = serializeTestMap(previousMap);
  const nextContent = serializeTestMap(nextMap);
  const path = relativeToRepo(io.cwd, join(io.cwd, TEST_MAP_RELATIVE));
  if (previousContent === nextContent) {
    // Idempotency (plan §5.3): re-running mark produces NO change — not
    // even a rewritten file.
    if (asJson) {
      writeLine(
        io.stdout,
        canonicalJson({ schemaVersion: 1, path, changed: false, entry: newEntry } as unknown as JsonValue),
      );
    } else {
      writeLine(io.stdout, `mark: no changes — '${declaredKey}' is already declared exactly so in ${path}`);
    }
    return 0;
  }
  writeTestMapAtomic(io.cwd, nextMap);
  const diff = diffLines(previousContent, nextContent);
  if (asJson) {
    writeLine(
      io.stdout,
      canonicalJson({
        schemaVersion: 1,
        path,
        changed: true,
        diff,
        entry: newEntry,
      } as unknown as JsonValue),
    );
  } else {
    writeLine(io.stdout, `mark: wrote ${path} (existing tests untouched; a declaration is intent, not proof)`);
    writeLine(io.stdout, `--- ${previousMap.tests.length === 0 ? '/dev/null' : path}`);
    writeLine(io.stdout, `+++ ${path}`);
    for (const line of diff) {
      writeLine(io.stdout, line);
    }
  }
  return 0;
}

const MARK_USAGE_LINE = 'usage: gateforge tests mark --test <key> --kind <kind> [--category <c>]... --obligation <id>... [--case <caseId>]... --reason "<text>"';

/** Reads a repeated flag as a string array (single value → one element). */
function flagArray(options: Record<string, string | boolean | string[]>, name: string): string[] {
  const value = options[name];
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

/** Validates `--kind` against the supported TestKind vocabulary. */
function validateKind(kind: string): TestKind {
  const parsed = TestKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw new UsageError(
      `--kind must be one of: ${TestKindSchema.options.join(', ')} (got '${kind}')`,
    );
  }
  return parsed.data as TestKind;
}

/**
 * Whether a kind declaration refines (rather than contradicts) the
 * catalog inference (Observe channel): declaring `observed-e2e` over an
 * inferred `browser-e2e` keeps the browser journey and only weakens the
 * proof channel. Mirrors `isKindRefinement` in `@gate-forge/core`'s
 * mapping resolver (kept in lockstep; this layer refuses BEFORE writing
 * the sidecar).
 */
function isKindRefinement(declared: TestKind, inferred: TestKind): boolean {
  return declared === 'observed-e2e' && inferred === 'browser-e2e';
}

/**
 * Refuses declarations that contradict the CURRENT catalog evidence
 * (plan §5.3): an explicit kind may resolve `unknown` (or refine
 * `browser-e2e` into `observed-e2e` for the Observe channel), but cannot
 * override observed mocking or a strong code-signal classification.
 * Both locations land in the error (exit 2, nothing written).
 */
function assertKindDeclarationAllowed(entry: TestCatalogEntry, kind: TestKind, key: string): void {
  const mock = entry.suppressionSignals.find((signal) => signal.kind === 'mock');
  if (mock !== undefined && (kind === 'browser-e2e' || kind === 'api-e2e' || kind === 'observed-e2e')) {
    throw new UsageError(
      `cannot mark '${key}' as '${kind}': the catalog observed mocking (${mock.detail}) at ` +
        `${mock.location.file}:${String(mock.location.line)} — an explicit kind cannot override observed mocking (§5.3)`,
    );
  }
  const strong = entry.kindSignals[0];
  if (
    entry.inferredKind !== 'unknown' &&
    entry.kindSignals.length > 0 &&
    kind !== entry.inferredKind &&
    !isKindRefinement(kind, entry.inferredKind)
  ) {
    throw new UsageError(
      `cannot mark '${key}' as '${kind}': inference resolved '${entry.inferredKind}' from strong code ` +
        `signals (${strong?.ruleId ?? 'unknown'} at ${strong?.location.file ?? entry.file}:` +
        `${String(strong?.location.line ?? entry.sourceLocation.line)}) — correct the declaration or the classification`,
    );
  }
}

// ---------------------------------------------------------------------------
// tests explain (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Synchronizes generated test-map declarations without changing handwritten entries.
 *
 * Args:
 *   io: process context.
 *   options: parsed command flags.
 *
 * Returns:
 *   number: 0 when the static scan is complete, 1 when unresolved rows
 *   need owner review, or 2 for invalid configuration or sidecar data.
 */
async function syncSubcommand(
  io: Io,
  options: Record<string, string | boolean | string[]>,
): Promise<number> {
  rejectUnknownFlags(options, ['json'], TESTS_USAGE);
  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd);
  const scan = scanTestFiles({
    cwd: io.cwd,
    include: config.project.paths.include,
    exclude: config.project.paths.exclude,
    excludeFile: engineGeneratedStateFileFilter(io.cwd, stateDir),
  });
  const generated = annotationTestMapEntries(scan);
  const previous = loadOptionalTestMap(io.cwd);
  const handwritten = (previous?.tests ?? []).filter((entry) => entry.source !== 'annotation');
  const candidate = { schemaVersion: 1 as const, tests: [...handwritten, ...generated] };
  const parsed = TestMapSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined ? '' : ` at '${issue.path.map(String).join('.')}':`;
    throw new UsageError(`annotation sync produced an invalid test map${path} ${issue?.message ?? 'unknown schema error'}`);
  }
  const previousContent = serializeTestMap(previous ?? { schemaVersion: 1, tests: [] });
  const nextContent = serializeTestMap(parsed.data as TestMap);
  const changed = previousContent !== nextContent;
  if (changed) writeTestMapAtomic(io.cwd, parsed.data as TestMap);

  const unresolved = [
    ...scan.parseErrors.map(
      (entry) =>
        `UNRESOLVED ${entry.file}:${entry.location.line}:${entry.location.col}: ${entry.message}`,
    ),
    ...scan.unresolved.map(
      (entry) =>
        `UNRESOLVED ${entry.file}:${entry.location.line}:${entry.location.col}: ` +
        `${entry.titlePath.join(' > ')} — ${entry.code}: ${entry.detail}`,
    ),
    ...scan.entries
      .filter((entry) => entry.annotationIssue !== undefined)
      .map(
        (entry) =>
          `UNRESOLVED ${entry.file}:${entry.location.line}:${entry.location.col}: ` +
          `${entry.titlePath.join(' > ')} — ${entry.annotationIssue}`,
      ),
  ].sort(compareStrings);
  const asJson = options['json'] === true;
  if (asJson) {
    writeLine(
      io.stdout,
      canonicalJson({
        schemaVersion: 1,
        generatedEntries: generated.length,
        changed,
        unresolved,
        nextAction: unresolved.length > 0 ? 'Review unresolved static test annotations.' : null,
      }),
    );
  } else {
    writeLine(
      io.stdout,
      `tests sync: ${generated.length} annotation mapping(s) ${changed ? 'updated' : 'unchanged'}`,
    );
    for (const row of unresolved) writeLine(io.stdout, row);
  }
  return unresolved.length > 0 ? 1 : 0;
}
/** Implements `tests explain --test <key>`. */
async function explainSubcommand(
  io: Io,
  options: Record<string, string | boolean | string[]>,
): Promise<number> {
  rejectUnknownFlags(options, ['test', 'json', 'help'], TESTS_USAGE);
  const asJson = options['json'] === true;
  const testKey = stringFlag(options, 'test');
  if (testKey === undefined) {
    writeLine(io.stderr, 'usage: gateforge tests explain --test <key> [--json]');
    throw new UsageError('tests explain requires --test <key>');
  }

  const config = loadConfigAt(io.cwd);
  const stateDir = resolveStateDir(io.cwd);
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });
  const discovered = await runDiscovery(io.cwd, config, stateDir, true);
  const mapped = await resolveRepositoryMappings({
    cwd: io.cwd,
    config,
    obligations: pipeline.policy.obligations,
    catalog: discovered.catalog,
    nativeClaims: discovered.nativeClaims,
    nativeErrors: discovered.nativeErrors,
    nativeInstances: discovered.nativeInstances,
  });
  // Exit 2 for an unknown or ambiguous key (usage/config error, not a gate
  // result), through the SAME resolver `tests mark` uses.
  const entry = resolveTestKey(discovered.catalog, testKey);

  const report = explainReport(
    entry.logicalKey,
    entry,
    mapped,
    pipeline.policy.obligations,
    routeHintsByObligation(pipeline.graph, pipeline.policy.obligations),
    pipeline.behaviorCatalog,
  );
  if (asJson) {
    writeLine(io.stdout, canonicalJson(report as unknown as JsonValue));
    return 0;
  }
  for (const block of report.blocks) {
    writeLine(io.stdout, `Requirement: ${block.requirement}`);
    writeLine(io.stdout, `Existing test: ${report.existingTest.key} (${report.existingTest.file})`);
    writeLine(io.stdout, `Mapping: ${block.mapping}`);
    writeLine(io.stdout, `Execution: ${report.execution}`);
    writeLine(io.stdout, `Next action: ${block.nextAction}`);
    writeLine(io.stdout, `New test needed: ${block.newTestNeeded}`);
    if (block !== report.blocks[report.blocks.length - 1]) writeLine(io.stdout, '');
  }
  return 0;
}

/** One §4-shaped requirement block. */
interface ExplainBlock {
  /** The obligation id (or an honest placeholder). */
  requirement: string;
  /** Mapping origin sentence. */
  mapping: string;
  /** The §5.4-aligned next action. */
  nextAction: string;
  /** `yes`/`no` (+ reason when unknowable). */
  newTestNeeded: string;
}

/** The structured explain report (text blocks + machine fields). */
interface ExplainReport {
  schemaVersion: 1;
  existingTest: { key: string; file: string; titlePath: string[]; inferredKind: TestKind };
  execution: string;
  blocks: ExplainBlock[];
}

/**
 * Assembles the explain report for one test (pure; deterministic).
 * Joins: sidecar entries by key, native annotations by test file (the
 * reporter's testId is runner-internal), resolution bindings by key.
 */
function explainReport(
  testKey: string,
  entry: TestCatalogEntry,
  mapped: {
    catalog: TestCatalog;
    resolution: ResolvedMappings;
    sidecar: TestMap | null;
    nativeClaims: Claim[];
  },
  obligations: readonly Obligation[],
  routeHints: ReadonlyMap<string, readonly string[]>,
  behaviorCatalog?: import('@gate-forge/core').BehaviorCatalog | null,
): ExplainReport {
  const registry = new Set(obligations.map((obligation) => obligation.id));
  const sidecarEntry = mapped.sidecar?.tests.find((candidate) => candidate.key === testKey) ?? null;
  const nativeClaims = mapped.nativeClaims.filter((claim) => claim.testFile === entry.file);
  const bindings = mapped.resolution.obligations.flatMap((obligation) =>
    obligation.bindings
      .filter((binding) => binding.logicalKey === testKey)
      .map((binding) => ({ obligationId: obligation.obligationId, binding })),
  );

  const obligationIds = [
    ...new Set([
      ...(sidecarEntry?.claims ?? []),
      ...nativeClaims.map((claim) => claim.obligationId),
      ...bindings.map((entry_) => entry_.obligationId),
    ]),
  ].sort(compareStrings);
  // `new test needed` is the resolver's own three-state REUSE verdict for
  // each obligation. It needs the SAME route evidence `tests suggest`
  // uses, or a candidate would read `unverified` here and `no` there.
  const suggestions = new Map(
    mappingSuggestions({
      catalog: mapped.catalog,
      obligationIds: obligationIds.filter((id) => registry.has(id)),
      resolution: mapped.resolution,
      routeHints,
    }).map((suggestion) => [suggestion.obligationId, suggestion]),
  );

  const blocks: ExplainBlock[] = obligationIds.map((obligationId) => {
    const sidecarDeclares = sidecarEntry?.claims.includes(obligationId) === true;
    const nativeDeclares = nativeClaims.some((claim) => claim.obligationId === obligationId);
    const binding = bindings.find((candidate) => candidate.obligationId === obligationId)?.binding ?? null;
    const inRegistry = registry.has(obligationId);
    const requiredCases = behaviorCatalog?.requirements[obligationId] ?? [];
    const mappedCases = new Set<string>();
    for (const group of mapped.resolution.obligations) {
      if (group.obligationId !== obligationId) continue;
      for (const candidate of group.bindings) {
        if (candidate.origin !== 'sidecar') continue;
        for (const caseId of candidate.caseIds ?? []) mappedCases.add(caseId);
      }
    }
    const missingCases = requiredCases.filter((caseId) => !mappedCases.has(caseId));
    const caseSuffix =
      requiredCases.length === 0
        ? ''
        : missingCases.length === 0
          ? `; cases ${requiredCases.length}/${requiredCases.length} mapped`
          : `; cases ${String(requiredCases.length - missingCases.length)}/${String(requiredCases.length)} mapped, missing: ${missingCases
              .map((caseId) => {
                const compiled = behaviorCatalog?.cases.find((item) => item.caseId === caseId);
                return compiled?.definition.id ?? caseId;
              })
              .join(', ')}`;
    let mapping: string;
    let nextAction: string;
    if (sidecarDeclares) {
      mapping = `declared in test-map.yml${caseSuffix}`;
      nextAction =
        missingCases.length > 0
          ? `map the missing cases (${missingCases
              .map((caseId) => behaviorCatalog?.cases.find((item) => item.caseId === caseId)?.definition.id ?? caseId)
              .join(', ')}) with tests mark --case; then run the test with the required channel`
          : 'run the existing test with the witness: `gateforge test-gates --changed` executes the suite and collects the witnessed evidence that must cover this change';
    } else if (nativeDeclares) {
      mapping = `declared by native annotation${caseSuffix}`;
      nextAction =
        missingCases.length > 0
          ? `native annotations never implicitly claim behavior cases — add an explicit sidecar entry with tests mark --case for: ${missingCases
              .map((caseId) => behaviorCatalog?.cases.find((item) => item.caseId === caseId)?.definition.id ?? caseId)
              .join(', ')}`
          : 'run the existing test with the witness: `gateforge test-gates --changed` executes the suite and collects the witnessed evidence that must cover this change';
    } else if (binding?.origin === 'prior-run') {
      mapping = 'prior run (suggestion only — never satisfies a new run)';
      nextAction = 'confirm the link with tests mark if correct; then run the test with the browser observer';
    } else if (binding?.origin === 'inferred') {
      mapping = 'inferred (suggestion only — never auto-declared)';
      nextAction = 'confirm the inference with tests mark if correct; then run the test with the browser observer';
    } else {
      mapping = 'unmapped';
      nextAction = inRegistry
        ? 'run tests suggest to find candidate existing tests; mark the test if it covers this obligation'
        : 'correct the claim — the obligation id is not in the current registry';
    }
    const verdict = suggestions.get(obligationId)?.newTestNeeded;
    const newTestNeeded = !inRegistry
      ? 'unknown (the obligation id is not in the current registry)'
      : sidecarDeclares || nativeDeclares
        ? 'no'
        : (verdict ?? 'unverified');
    return {
      requirement: inRegistry ? obligationId : `${obligationId} (not in the current registry)`,
      mapping,
      nextAction,
      newTestNeeded,
    };
  });
  if (blocks.length === 0) {
    blocks.push({
      requirement: '(none — no obligation involves this test)',
      mapping: 'unmapped',
      nextAction: 'run tests suggest to see which obligations need coverage and which existing tests could provide it',
      newTestNeeded: 'unknown (no obligation involves this test)',
    });
  }
  return {
    schemaVersion: 1,
    existingTest: {
      key: testKey,
      file: entry.file,
      titlePath: [...entry.titlePath],
      inferredKind: entry.inferredKind,
    },
    execution:
      'not run for this change (`tests explain` is inspection only — run `gateforge test-gates --changed` to execute the suite with the witness)',
    blocks,
  };
}

// ---------------------------------------------------------------------------
// tests diagnose (Phase 4, §3.5)
// ---------------------------------------------------------------------------

/** Implements `tests diagnose [--suite <name>] [--json]`. */
async function diagnoseSubcommand(
  io: Io,
  options: Record<string, string | boolean | string[]>,
): Promise<number> {
  rejectUnknownFlags(options, ['suite', 'json', 'help'], TESTS_USAGE);
  const asJson = options['json'] === true;
  const suiteName = stringFlag(options, 'suite');
  const config = loadConfigAt(io.cwd);
  const cacheExclusions = loadCacheExclusions(io.cwd, config);
  const stateDir = resolveStateDir(io.cwd);

  // The alarm runs WITHOUT a browser or witness (§3.5), but it still
  // binds results to the current input identity: the same pipeline +
  // snapshot every gate command runs, with the same drift discipline.
  let preFiles: ReturnType<typeof collectInputFiles> | null = null;
  let snapshotUnavailable = false;
  try {
    preFiles = collectInputFiles(io.cwd, config, stateDir, [], [], cacheExclusions);
  } catch (error) {
    if (error instanceof SnapshotUnavailableError) {
      snapshotUnavailable = true;
    } else if (error instanceof UnsupportedSnapshotError) {
      throw new UsageError(`unsupported input snapshot: ${error.message}`);
    } else {
      throw error;
    }
  }
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });
  let inputDigest: string | null = null;
  if (!snapshotUnavailable) {
    const postDiscovery = collectInputFiles(io.cwd, config, stateDir, [], [], cacheExclusions);
    const drift = preFiles === null ? [] : diffInputFiles(preFiles, postDiscovery);
    if (drift.length > 0) {
      throw new UsageError(
        `input tree changed around discovery (${drift.slice(0, 3).join('; ')}); no reliable input identity — refusing the diagnostic run`,
      );
    }
    inputDigest = computeInputSnapshot({
      cwd: io.cwd,
      config,
      stateDir,
      classifications: pipeline.classificationsView.resources,
      obligations: pipeline.policy.obligations,
      httpRoutes: httpRoutesView(pipeline.graph),
      plugins: pipeline.manifest.plugins.map((plugin) => ({ id: plugin.id, version: plugin.version })),
      cacheExclusions,
    }).inputDigest;
  }

  const run = await runDiagnosticSuites({
    config,
    cwd: io.cwd,
    stateDir,
    inputDigest,
    ...(suiteName !== undefined ? { suiteName } : {}),
    now: pipeline.now,
  });

  if (asJson) {
    writeLine(io.stdout, diagnosticsJson(run, inputDigest));
  } else {
    renderDiagnosticsText(io, run, inputDigest);
  }
  return run.exitCode;
}
