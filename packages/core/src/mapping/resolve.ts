/**
 * The ONE mapping resolver (plan 2026-09-13 §5.3, Phase 3 item 1):
 * normalizes native annotation claims, sidecar declarations, prior-run
 * hints, and inference into a single resolved-mappings surface that the
 * grading seam and the suggestion surface both read.
 *
 * Hard rules encoded here (§5.2/§5.3):
 * - many-to-many mappings are valid; exact duplicates (native + sidecar
 *   declaring the same test/obligation) deduplicate idempotently;
 * - contradictions (conflicting kinds across entries, a declared kind
 *   against strong observed signals or observed mocking) are typed
 *   TEST_MAPPING_AMBIGUOUS problems naming BOTH locations — never
 *   "whichever ran last";
 * - stale declarations (deleted/renamed tests, changed title paths,
 *   unknown obligation ids) are typed TEST_MAPPING_STALE problems that
 *   name what vanished; a rename yields a migration suggestion, never a
 *   silent transfer;
 * - wildcards are prohibited in strict mode: a file-level selector (no
 *   titlePath) is an unsafe declaration and binds nothing;
 * - inference NEVER auto-writes a mapping: inferred bindings are marked
 *   `origin: 'inferred'`, are excluded from grading claims, and only
 *   feed suggestions;
 * - a mapping DECLARES INTENT and supplies no test result — grading
 *   claims produced here still require witnessed evidence (the CLI seam
 *   injects them as declared claims, so a mapped-but-unexecuted
 *   obligation grades EVIDENCE_NOT_COLLECTED, never satisfied).
 *
 * Deterministic: identical inputs produce identical outputs; every array
 * is sorted (compareStrings order) and no SHA-256-style Set iteration
 * leaks into ordering.
 */
import { compareStrings } from '../graph/util.js';
import type { Location } from '../schemas/common.js';
import { ClaimSchema, type Claim } from '../schemas/claim.js';
import type { TestCatalog, TestCatalogEntry, TestKind } from '../schemas/test-catalog.js';
import type { TestMap } from '../schemas/test-map.js';
import { CAUSE_NEXT_ACTIONS } from '../schemas/verdict.js';

/** Why a mapping problem exists (plan §5.4 rows TEST_MAPPING_* + TEST_KIND_UNKNOWN). */
export type MappingProblemCause =
  | 'TEST_MAPPING_AMBIGUOUS'
  | 'TEST_MAPPING_STALE'
  | 'TEST_KIND_UNKNOWN';

/** Where a resolved binding's declaration came from. `inferred` bindings never grade (§5.3). */
export type MappingOrigin = 'native' | 'sidecar' | 'inferred' | 'prior-run';

/**
 * One prior-run observation (plan Phase 3 item 2): an earlier run bound
 * this logical test to this obligation. A hint can SUGGEST a link but
 * never satisfies new inputs, so hint bindings never grade.
 */
export interface PriorRunHint {
  /** The catalog logical key the prior run observed. */
  logicalKey: string;
  /** The obligation the prior run bound it to. */
  obligationId: string;
}

/** One runtime instance a resolved binding covers (from the catalog). */
export interface TestInstanceRef {
  /** Runner the instance executes under. */
  runner: string;
  /** Runner project, or null when no enumeration bound one. */
  project: string | null;
  /** Repo-root-relative posix file path. */
  file: string;
  /** Full title path (describe stack, then the test title). */
  titlePath: string[];
  /** Framework repeat/parameter identity, or null when not parameterized. */
  parameterIdentity: string | null;
}

/** One resolved declaration binding an existing test to an obligation. */
export interface ResolvedClaimBinding {
  /** The logical test key the declaration resolves to. */
  logicalKey: string;
  /** Current catalog instances the binding covers (empty when stale). */
  instances: TestInstanceRef[];
  /** Declaration origin; only `native`/`sidecar` bindings grade. */
  origin: MappingOrigin;
  /** Catalog source digest of the bound test (stale-proof input, §5.2). */
  sourceDigest: string | null;
  /** Declared kind, when a sidecar entry declared one. */
  declaredKind: TestKind | null;
  /** Declared category labels (sorted, deduplicated). */
  categories: string[];
  /** The sidecar declaration's required reason, when present. */
  reason: string | null;
  /** Best known source location of the test (native claim or catalog row). */
  sourceLocation: Location | null;
}

/** Every resolved binding for one obligation (sorted by origin, then key). */
export interface ObligationBindings {
  /** The obligation the bindings claim to cover. */
  obligationId: string;
  /** The resolved declarations (possibly empty — an unmapped obligation). */
  bindings: ResolvedClaimBinding[];
}

/** One typed mapping problem (plan §5.4: actionable, both locations). */
export interface MappingProblem {
  /** Stable cause code. */
  cause: MappingProblemCause;
  /** The affected obligation id, when the problem is obligation-scoped. */
  obligationId: string | null;
  /** Single-cause human explanation naming both sides of a conflict. */
  detail: string;
  /** Known source locations (sorted) — both sides for conflicts. */
  locations: Location[];
}

/** The resolved-mappings surface (plan §5.1 row 3): bindings + problems. */
export interface ResolvedMappings {
  /** One entry per known obligation id, sorted by id. */
  obligations: ObligationBindings[];
  /** Typed problems, sorted by (cause, obligationId, detail). */
  problems: MappingProblem[];
}

/** Inputs of {@link resolveTestMappings}. */
export interface ResolveMappingsInput {
  /** The current derived test catalog (discovery output). */
  catalog: TestCatalog;
  /**
   * Native per-test annotation claims exactly as the pipeline reports
   * them today (validated Claim documents from the run-state
   * claims.json).
   */
  nativeClaims: readonly Claim[];
  /** The validated sidecar document (empty when no sidecar exists). */
  sidecar: TestMap;
  /** The obligation registry's ids (the obligations dump path). */
  obligationIds: readonly string[];
  /** Optional prior-run observations (suggestions only, never grading). */
  priorRunHints?: readonly PriorRunHint[];
}

/** Sort rank of binding origins (declared first, hints last). */
const ORIGIN_RANK: Readonly<Record<MappingOrigin, number>> = Object.freeze({
  native: 0,
  sidecar: 1,
  'prior-run': 2,
  inferred: 3,
});

/** Sort rank of problem causes (deterministic output order). */
const PROBLEM_RANK: Readonly<Record<MappingProblemCause, number>> = Object.freeze({
  TEST_MAPPING_AMBIGUOUS: 0,
  TEST_MAPPING_STALE: 1,
  TEST_KIND_UNKNOWN: 2,
});

/** Test kinds that claim end-to-end proof (mocking disqualifies them, §3.2). */
const E2E_KINDS: ReadonlySet<string> = new Set(['browser-e2e', 'observed-e2e', 'api-e2e']);

/**
 * Whether a sidecar kind declaration is a refinement of the inferred
 * kind rather than a contradiction (§5.3, Observe channel): declaring
 * `observed-e2e` over an inferred `browser-e2e` keeps the browser
 * journey and only weakens the proof channel (suite-driven instead of
 * engine-driven) — allowed. Every other kind mismatch (including
 * `observed-e2e` over `api-e2e`, whose Node-side traffic never transits
 * the session proxy) stays contradictory.
 */
function isKindRefinement(declared: string, inferred: string): boolean {
  return declared === 'observed-e2e' && inferred === 'browser-e2e';
}

/**
 * Whether a catalog row matches a sidecar selector exactly (§5.2: line
 * numbers and digests are never identity inputs).
 */
function matchesSelector(row: TestCatalogEntry, selector: TestMap['tests'][number]['selector']): boolean {
  if (row.runner !== selector.runner || row.file !== selector.file) return false;
  if (selector.project !== undefined && row.project !== selector.project) return false;
  if (selector.titlePath !== undefined && selector.titlePath.join('>') !== row.titlePath.join('>')) {
    return false;
  }
  return true;
}

/** Projects a catalog row to its instance identity. */
function instanceOf(row: TestCatalogEntry): TestInstanceRef {
  return {
    runner: row.runner,
    project: row.project,
    file: row.file,
    titlePath: [...row.titlePath],
    parameterIdentity: row.parameterIdentity,
  };
}

/**
 * Resolves native claims, sidecar declarations, prior-run hints, and
 * inference into the one resolved-mappings surface.
 *
 * Args:
 *   input: catalog, native claims, validated sidecar, obligation ids,
 *     and optional prior-run hints.
 *
 * Returns:
 *   ResolvedMappings: per-obligation bindings plus typed problems, all
 *   deterministically sorted.
 */
export function resolveTestMappings(input: ResolveMappingsInput): ResolvedMappings {
  const registry = new Set(input.obligationIds);
  const rowsByKey = new Map(input.catalog.entries.map((row) => [row.logicalKey, row]));
  const problems: MappingProblem[] = [];
  const seenProblems = new Set<string>();
  /** obligationId → logicalKey → binding. */
  const byObligation = new Map<string, Map<string, ResolvedClaimBinding>>();

  const pushProblem = (problem: MappingProblem): void => {
    const dedupeKey = `${problem.cause}\u0000${problem.obligationId ?? ''}\u0000${problem.detail}`;
    if (seenProblems.has(dedupeKey)) return;
    seenProblems.add(dedupeKey);
    problems.push(problem);
  };

  const bindingsFor = (obligationId: string): Map<string, ResolvedClaimBinding> => {
    let existing = byObligation.get(obligationId);
    if (existing === undefined) {
      existing = new Map();
      byObligation.set(obligationId, existing);
    }
    return existing;
  };

  // --- sidecar declarations ------------------------------------------------
  const sidecarEntries = [...input.sidecar.tests].sort((a, b) => compareStrings(a.key, b.key));
  for (const entry of sidecarEntries) {
    const claims = [...new Set(entry.claims)].sort(compareStrings);
    const matched = input.catalog.entries
      .filter((row) => matchesSelector(row, entry.selector))
      .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));

    // Wildcard prohibition (§5.2): a file-level selector covers a whole
    // file — an unsafe declaration that binds NOTHING (fail closed).
    if (entry.selector.titlePath === undefined) {
      for (const obligationId of claims) {
        pushProblem({
          cause: 'TEST_MAPPING_AMBIGUOUS',
          obligationId,
          detail:
            `sidecar entry '${entry.key}' uses a file-level selector (no titlePath) for ` +
            `'${entry.selector.file}' — wildcard declarations are prohibited in strict mode; ` +
            'declare the exact test title path',
          locations: [{ file: entry.selector.file, line: 1, col: 0 }],
        });
      }
      continue;
    }

    // Stale declaration (§5.2): the selector no longer matches the
    // catalog. Name what vanished; suggest a migration on a rename.
    if (matched.length === 0) {
      const renameTarget = input.catalog.entries.find(
        (row) =>
          row.file === entry.selector.file &&
          row.titlePath.join('>') === (entry.selector.titlePath ?? []).join('>'),
      );
      const sameFile = input.catalog.entries.filter((row) => row.file === entry.selector.file);
      const vanished = renameTarget !== undefined
        ? `the test now appears as key '${renameTarget.logicalKey}' — migrate the declaration to ` +
          'the new key (never silently transfer the old declaration or its proof)'
        : sameFile.length > 0
          ? `the file still exists but its title path changed (current: ${sameFile
              .slice(0, 3)
              .map((row) => `'${row.titlePath.join('>')}'`)
              .join(', ')})`
          : `the file '${entry.selector.file}' has no catalog rows anymore`;
      for (const obligationId of claims) {
        if (!registry.has(obligationId)) continue;
        pushProblem({
          cause: 'TEST_MAPPING_STALE',
          obligationId,
          detail:
            `sidecar key '${entry.key}' no longer matches the catalog ` +
            `(selector ${entry.selector.runner}/${entry.selector.project ?? '*'}:` +
            `${entry.selector.file}:${(entry.selector.titlePath ?? []).join('>')}): ${vanished}`,
          locations: renameTarget !== undefined ? [renameTarget.sourceLocation] : [],
        });
      }
      continue;
    }

    // Unknown obligation ids (§5.4 TEST_MAPPING_STALE): the declaration
    // points outside the registry — the obligation vanished or the id is
    // misspelled. Other claims of the same entry still bind.
    for (const obligationId of claims) {
      if (!registry.has(obligationId)) {
        pushProblem({
          cause: 'TEST_MAPPING_STALE',
          obligationId,
          detail:
            `sidecar entry '${entry.key}' claims '${obligationId}', which is not in the current ` +
            'obligation registry (the obligation vanished or the id is misspelled); correct the mapping',
          locations: [matched[0]?.sourceLocation ?? { file: entry.selector.file, line: 1, col: 0 }],
        });
      }
    }

    // Kind contradictions (§5.3: an explicit kind may resolve `unknown`,
    // but cannot override strong observed signals or observed mocking).
    for (const row of matched) {
      if (entry.kind === undefined) {
        if (row.inferredKind === 'unknown') {
          for (const obligationId of claims) {
            if (!registry.has(obligationId)) continue;
            pushProblem({
              cause: 'TEST_KIND_UNKNOWN',
              obligationId,
              detail:
                `test '${entry.key}' (${row.file}:${row.titlePath.join('>')}) is relevant but ` +
                'code analysis could not classify its kind — inspect and declare its kind',
              locations: [row.sourceLocation],
            });
          }
        }
        continue;
      }
      const mock = row.suppressionSignals.find((signal) => signal.kind === 'mock');
      if (E2E_KINDS.has(entry.kind) && mock !== undefined) {
        for (const obligationId of claims) {
          pushProblem({
            cause: 'TEST_MAPPING_AMBIGUOUS',
            obligationId,
            detail:
              `sidecar entry '${entry.key}' declares kind '${entry.kind}' but the catalog observed ` +
              `mocking (${mock.detail}) — an explicit kind cannot override observed mocking (§5.3)`,
            locations: [mock.location],
          });
        }
        continue;
      }
      const strong = row.kindSignals[0];
      if (
        row.inferredKind !== 'unknown' &&
        row.kindSignals.length > 0 &&
        entry.kind !== row.inferredKind &&
        !isKindRefinement(entry.kind, row.inferredKind)
      ) {
        for (const obligationId of claims) {
          pushProblem({
            cause: 'TEST_MAPPING_AMBIGUOUS',
            obligationId,
            detail:
              `sidecar entry '${entry.key}' declares kind '${entry.kind}' but inference resolved ` +
              `'${row.inferredKind}' from strong code signals (${strong?.ruleId ?? 'unknown'} at ` +
              `${strong?.location.file ?? row.file}:${String(strong?.location.line ?? row.sourceLocation.line)}) — ` +
              'correct the declaration or the classification',
            locations: [row.sourceLocation, ...(strong !== undefined ? [strong.location] : [])],
          });
        }
      }
    }

    // Bind the declaration (many-to-many allowed). Ambiguity problems
    // above stay visible; the binding itself is data for suggestions.
    for (const obligationId of claims) {
      if (!registry.has(obligationId)) continue;
      bindingsFor(obligationId).set(entry.key, {
        logicalKey: entry.key,
        instances: matched.map(instanceOf),
        origin: 'sidecar',
        sourceDigest: matched[0]?.sourceDigest ?? null,
        declaredKind: entry.kind ?? null,
        categories: [...new Set(entry.categories ?? [])].sort(compareStrings),
        reason: entry.reason,
        sourceLocation: matched[0]?.sourceLocation ?? null,
      });
    }
  }

  // Cross-entry ambiguity: two entries claiming the same obligation with
  // conflicting declared kinds (§5.4 "a declaration is unsafe").
  const obligationIdsSorted = [...registry].sort(compareStrings);
  for (const obligationId of obligationIdsSorted) {
    const declared = [...(byObligation.get(obligationId)?.values() ?? [])]
      .filter((binding) => binding.origin === 'sidecar' && binding.declaredKind !== null)
      .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
    const kinds = new Set(declared.map((binding) => binding.declaredKind));
    if (declared.length > 1 && kinds.size > 1) {
      const first = declared[0];
      const second = declared.find((binding) => binding.declaredKind !== first?.declaredKind);
      pushProblem({
        cause: 'TEST_MAPPING_AMBIGUOUS',
        obligationId,
        detail:
          `obligation '${obligationId}' is claimed with conflicting kinds: '${String(
            first?.declaredKind,
          )}' by '${first?.logicalKey}' and '${String(second?.declaredKind)}' by '${second?.logicalKey}' — ` +
          'correct the exact mapping',
        locations: [
          ...(first?.sourceLocation !== undefined && first.sourceLocation !== null ? [first.sourceLocation] : []),
          ...(second?.sourceLocation !== undefined && second.sourceLocation !== null ? [second.sourceLocation] : []),
        ],
      });
    }
  }

  // --- native annotation claims -------------------------------------------
  const nativeClaims = [...input.nativeClaims].sort(
    (a, b) => compareStrings(a.obligationId, b.obligationId) || compareStrings(a.testId, b.testId),
  );
  for (const claim of nativeClaims) {
    if (!registry.has(claim.obligationId)) {
      pushProblem({
        cause: 'TEST_MAPPING_STALE',
        obligationId: claim.obligationId,
        detail:
          `native annotation on test '${claim.testId}'` +
          `${claim.testFile !== undefined ? ` (${claim.testFile})` : ''} claims ` +
          `'${claim.obligationId}', which is not in the current obligation registry ` +
          '(the obligation vanished or the policy changed); correct the annotation or the mapping',
        locations: claim.location !== undefined ? [claim.location] : [],
      });
      continue;
    }
    // Exact duplicate of a sidecar declaration (same obligation, same
    // test file) → dedupe idempotently: the sidecar binding (a superset:
    // reason/kind/categories) stands, the native row adds nothing.
    const instances = input.catalog.entries
      .filter((row) => row.file === claim.testFile)
      .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
    const existingBindings = byObligation.get(claim.obligationId);
    const duplicate =
      existingBindings !== undefined &&
      [...existingBindings.values()].some(
        (binding) =>
          binding.origin === 'sidecar' && binding.instances.some((inst) => inst.file === claim.testFile),
      );
    if (duplicate) continue;
    bindingsFor(claim.obligationId).set(claim.testId, {
      logicalKey: claim.testId,
      instances: instances.map(instanceOf),
      origin: 'native',
      sourceDigest: instances[0]?.sourceDigest ?? null,
      declaredKind: null,
      categories: [],
      reason: null,
      sourceLocation: claim.location ?? null,
    });
  }

  // --- prior-run hints (suggestions only, never grading) -------------------
  const hints = [...(input.priorRunHints ?? [])].sort(
    (a, b) => compareStrings(a.obligationId, b.obligationId) || compareStrings(a.logicalKey, b.logicalKey),
  );
  for (const hint of hints) {
    const row = rowsByKey.get(hint.logicalKey);
    if (row === undefined || !registry.has(hint.obligationId)) continue;
    const bindings = bindingsFor(hint.obligationId);
    if (bindings.has(hint.logicalKey)) continue;
    bindings.set(hint.logicalKey, {
      logicalKey: hint.logicalKey,
      instances: [instanceOf(row)],
      origin: 'prior-run',
      sourceDigest: row.sourceDigest,
      declaredKind: null,
      categories: [],
      reason: 'a prior run bound this test to the obligation (a hint only — it never satisfies a new run)',
      sourceLocation: row.sourceLocation,
    });
  }

  // --- inference (NEVER auto-writes a mapping; suggestions only) -----------
  for (const obligationId of obligationIdsSorted) {
    const bindings = byObligation.get(obligationId);
    if (bindings !== undefined && [...bindings.values()].some((b) => b.origin === 'native' || b.origin === 'sidecar')) {
      continue; // a declared mapping exists — inference adds nothing
    }
    const map = bindings ?? bindingsFor(obligationId);
    for (const candidate of inferredCandidates(obligationId, input.catalog)) {
      if (map.has(candidate.row.logicalKey)) continue;
      map.set(candidate.row.logicalKey, {
        logicalKey: candidate.row.logicalKey,
        instances: [instanceOf(candidate.row)],
        origin: 'inferred',
        sourceDigest: candidate.row.sourceDigest,
        declaredKind: candidate.row.inferredKind,
        categories: candidate.row.categorySignals.map((signal) => signal.label).sort(compareStrings),
        reason: `inferred, never auto-declared: ${candidate.why.join('; ')}`,
        sourceLocation: candidate.row.sourceLocation,
      });
    }
  }

  const obligations = obligationIdsSorted.map((obligationId) => ({
    obligationId,
    bindings: [...(byObligation.get(obligationId)?.values() ?? [])].sort(
      (a, b) =>
        ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || compareStrings(a.logicalKey, b.logicalKey),
    ),
  }));
  problems.sort(
    (a, b) =>
      PROBLEM_RANK[a.cause] - PROBLEM_RANK[b.cause] ||
      compareStrings(a.obligationId ?? '', b.obligationId ?? '') ||
      compareStrings(a.detail, b.detail),
  );
  return { obligations, problems: problems.map((problem) => ({ ...problem, locations: [...problem.locations] })) };
}

/** One inference candidate: the catalog row plus the matched signals. */
interface InferredCandidate {
  /** The matching catalog row. */
  row: TestCatalogEntry;
  /** Single-cause human signals explaining the match (no confidence numbers). */
  why: string[];
}

/**
 * Deterministic token inference (plan Phase 3 item 2): obligation
 * resource-id tokens (`tenant.accounts` → `tenant`, `accounts`) matched
 * against catalog rows' files, title paths, and category labels. Signals
 * feed SUGGESTIONS only — an inference never writes a mapping (§5.3).
 */
function inferredCandidates(obligationId: string, catalog: TestCatalog): InferredCandidate[] {
  const resourceId = obligationId.slice(0, Math.max(0, obligationId.indexOf(':')));
  const tokens = resourceId
    .split(/[.\-_]/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 2);
  if (tokens.length === 0) return [];
  const candidates: InferredCandidate[] = [];
  for (const row of catalog.entries) {
    const why: string[] = [];
    const title = row.titlePath.join('>').toLowerCase();
    for (const token of tokens) {
      if (row.file.toLowerCase().includes(token)) {
        why.push(`resource token '${token}' matches the test file '${row.file}'`);
      } else if (title.includes(token)) {
        why.push(`resource token '${token}' matches the test title path`);
      } else if (row.categorySignals.some((signal) => signal.label.toLowerCase().includes(token))) {
        why.push(`resource token '${token}' matches a category label`);
      }
    }
    if (why.length > 0) candidates.push({ row, why });
  }
  return candidates.sort((a, b) => compareStrings(a.row.logicalKey, b.row.logicalKey));
}

/** Cause a mapping suggestion can carry (plan §5.4 mapping rows). */
export type MappingSuggestionCause =
  | 'TEST_MAPPING_MISSING'
  | 'TEST_KIND_UNKNOWN'
  | 'TEST_MAPPING_AMBIGUOUS'
  | 'TEST_MAPPING_STALE';

/** One candidate existing test a suggestion proposes for reuse. */
export interface SuggestionCandidate {
  /** The catalog logical key of the candidate test. */
  logicalKey: string;
  /** The test's file (for quick human inspection). */
  file: string;
  /** Matched signals — the WHY, never an opaque confidence number. */
  why: string[];
}

/** One per-obligation reuse suggestion (plan Phase 3 item 6). */
export interface MappingSuggestion {
  /** The obligation the suggestion is about. */
  obligationId: string;
  /** Why the obligation is not connected yet. */
  cause: MappingSuggestionCause;
  /** Candidate existing tests, ordered by reuse (declared bindings first). */
  candidates: SuggestionCandidate[];
  /** What evidence/declaration is missing (honest, single-cause). */
  missingEvidence: string;
  /** The plan §5.4 next action for the cause. */
  nextAction: string;
  /** True ONLY when no candidate exists after resolution. */
  newTestNeeded: boolean;
}

/** Inputs of {@link mappingSuggestions}. */
export interface MappingSuggestionsInput {
  /** The current derived test catalog. */
  catalog: TestCatalog;
  /** The obligation ids to suggest for (already scoped by the caller). */
  obligationIds: readonly string[];
  /** The resolved-mappings surface from {@link resolveTestMappings}. */
  resolution: ResolvedMappings;
}

/**
 * Observe-channel guidance for one candidate row (Phase 2): tells the
 * agent WHICH proof path fits the candidate's code shape. A
 * suite-driven browser test (browser-fixture signal, no gateforge
 * fixture, no mocking) proves via `observed-e2e` — the witness watches
 * its proxy traffic and reads state itself, so no rewrite is needed. A
 * gateforge-fixture test proves via the overlay path (engine-driven).
 * Returns null when no channel guidance applies (non-browser rows).
 */
function observeHintForRow(row: TestCatalogEntry | undefined): string | null {
  if (row === undefined || row.inferredKind !== 'browser-e2e') return null;
  if (row.suppressionSignals.some((signal) => signal.kind === 'mock')) return null;
  const usesFixture = row.kindSignals.some((signal) => signal.ruleId === 'gateforge-fixture');
  if (usesFixture) {
    return 'uses the gateforge evidence fixture — overlay path: the engine drives proof, no rewrite needed';
  }
  if (row.kindSignals.some((signal) => signal.ruleId === 'browser-fixture')) {
    return 'suite-driven browser test — declare kind observed-e2e to prove it via the Observe channel ' +
      '(the witness watches its proxy traffic and reads state itself; do not rewrite it onto the fixture)';
  }
  return null;
}

/** Suggestion order = reuse order (connect → declare kind → repair stale → repair conflict). */
const SUGGESTION_RANK: Readonly<Record<MappingSuggestionCause, number>> = Object.freeze({
  TEST_MAPPING_MISSING: 0,
  TEST_KIND_UNKNOWN: 1,
  TEST_MAPPING_STALE: 2,
  TEST_MAPPING_AMBIGUOUS: 3,
});

/**
 * Produces per-obligation reuse suggestions ordered by reuse (plan
 * Phase 3 item 6). Obligations with a clean DECLARED mapping produce no
 * suggestion (their remaining gap is executed proof, not mapping).
 * `newTestNeeded` is true only when no candidate exists after resolution.
 *
 * Args:
 *   input: catalog, scoped obligation ids, and the resolution.
 *
 * Returns:
 *   MappingSuggestion[]: sorted by reuse rank, then obligation id.
 */
export function mappingSuggestions(input: MappingSuggestionsInput): MappingSuggestion[] {
  const byId = new Map(input.resolution.obligations.map((entry) => [entry.obligationId, entry.bindings]));
  const rowsByKey = new Map(input.catalog.entries.map((row) => [row.logicalKey, row]));
  const suggestions: MappingSuggestion[] = [];
  for (const obligationId of [...input.obligationIds].sort(compareStrings)) {
    const bindings = byId.get(obligationId) ?? [];
    const problems = input.resolution.problems.filter((problem) => problem.obligationId === obligationId);
    const ambiguous = problems.find((problem) => problem.cause === 'TEST_MAPPING_AMBIGUOUS');
    if (ambiguous !== undefined) {
      suggestions.push({
        obligationId,
        cause: 'TEST_MAPPING_AMBIGUOUS',
        candidates: [],
        missingEvidence: 'a safe, unambiguous declaration (the current declaration conflicts with itself or the catalog)',
        nextAction: CAUSE_NEXT_ACTIONS['TEST_MAPPING_AMBIGUOUS'],
        newTestNeeded: false,
      });
      continue;
    }
    const stale = problems.find((problem) => problem.cause === 'TEST_MAPPING_STALE');
    if (stale !== undefined) {
      const candidates = inferredCandidates(obligationId, input.catalog).map((candidate) => {
        const hint = observeHintForRow(candidate.row);
        return {
          logicalKey: candidate.row.logicalKey,
          file: candidate.row.file,
          why: [...candidate.why, ...(hint !== null ? [hint] : [])],
        };
      });
      suggestions.push({
        obligationId,
        cause: 'TEST_MAPPING_STALE',
        candidates,
        missingEvidence: `an up-to-date declaration (the current one is stale: ${stale.detail})`,
        nextAction: CAUSE_NEXT_ACTIONS['TEST_MAPPING_STALE'],
        newTestNeeded: candidates.length === 0,
      });
      continue;
    }
    const declared = bindings.filter((binding) => binding.origin === 'native' || binding.origin === 'sidecar');
    const kindUnknown = problems.find((problem) => problem.cause === 'TEST_KIND_UNKNOWN');
    if (kindUnknown !== undefined) {
      suggestions.push({
        obligationId,
        cause: 'TEST_KIND_UNKNOWN',
        candidates: declared
          .map((binding) => ({
            logicalKey: binding.logicalKey,
            file: binding.instances[0]?.file ?? '',
            why: ['mapped by declaration, but its kind is unknown'],
          }))
          .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey)),
        missingEvidence: 'a declared kind for the connected test (code analysis could not classify it)',
        nextAction: CAUSE_NEXT_ACTIONS['TEST_KIND_UNKNOWN'],
        newTestNeeded: false,
      });
      continue;
    }
    if (declared.length > 0) continue; // declared + clean: the gap is execution, not mapping
    const candidates = bindings
      .map((binding) => {
        const hint = observeHintForRow(rowsByKey.get(binding.logicalKey));
        const base =
          binding.origin === 'inferred' || binding.origin === 'prior-run'
            ? (binding.reason ?? binding.origin)
            : `bound by native annotation (${binding.logicalKey})`;
        return {
          logicalKey: binding.logicalKey,
          file: binding.instances[0]?.file ?? '',
          why: hint !== null ? [base, hint] : [base],
        };
      })
      .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
    suggestions.push({
      obligationId,
      cause: 'TEST_MAPPING_MISSING',
      candidates,
      missingEvidence:
        candidates.length > 0
          ? 'a DECLARED mapping and witnessed evidence for this change (a mapping declares intent; it supplies no test result)'
          : 'a declared mapping to any existing test — no candidate survived resolution',
      nextAction: CAUSE_NEXT_ACTIONS['TEST_MAPPING_MISSING'],
      newTestNeeded: candidates.length === 0,
    });
  }
  return suggestions.sort(
    (a, b) =>
      SUGGESTION_RANK[a.cause] - SUGGESTION_RANK[b.cause] ||
      compareStrings(a.obligationId, b.obligationId),
  );
}

/**
 * Projects resolved bindings into declared grading claims (plan §5.3:
 * both declaration paths normalize into existing claims). ONLY `native`
 * and `sidecar` bindings project — inferred and prior-run bindings are
 * suggestions and never grade. Exact duplicates of claims the run state
 * already carries are dropped idempotently. The claims declare INTENT:
 * they contain no evidence, so a mapped obligation with no witnessed
 * records still grades EVIDENCE_NOT_COLLECTED (blocking), never satisfied.
 *
 * Phase 4 note (runtime selection): the suite fixture submits evidence
 * per native annotations using the reporter's own testIds, so sidecar
 * claims (whose testId is the logical key) cannot receive runtime
 * evidence until Phase 4 wires claim injection through session open.
 *
 * Args:
 *   resolution: the resolved-mappings surface.
 *   existingClaims: the run-state claims (native annotations).
 *
 * Returns:
 *   Claim[]: validated declared claims, sorted by (obligationId, testId).
 */
export function mappingGradingClaims(
  resolution: ResolvedMappings,
  existingClaims: readonly Claim[],
): Claim[] {
  const existing = new Set(existingClaims.map((claim) => `${claim.obligationId}\u0000${claim.testId}`));
  const claims: Claim[] = [];
  for (const entry of resolution.obligations) {
    for (const binding of entry.bindings) {
      if (binding.origin !== 'native' && binding.origin !== 'sidecar') continue;
      const dedupeKey = `${entry.obligationId}\u0000${binding.logicalKey}`;
      if (existing.has(dedupeKey)) continue;
      existing.add(dedupeKey);
      const file = binding.instances[0]?.file;
      claims.push(
        ClaimSchema.parse({
          schemaVersion: 1,
          obligationId: entry.obligationId,
          testId: binding.logicalKey,
          ...(file !== undefined ? { testFile: file } : {}),
        }),
      );
    }
  }
  return claims.sort(
    (a, b) => compareStrings(a.obligationId, b.obligationId) || compareStrings(a.testId, b.testId),
  );
}
