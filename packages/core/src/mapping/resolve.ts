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
import type { BehaviorCatalog } from '../schemas/behavior-catalog.js';
import { CAUSE_NEXT_ACTIONS } from '../schemas/verdict.js';
import { isBusinessRuleClaimId, parseBusinessRuleClaimId } from '../schemas/business-rules.js';

/** Why a mapping problem exists (plan §5.4 rows TEST_MAPPING_* + TEST_KIND_UNKNOWN). */
export type MappingProblemCause =
  | 'TEST_MAPPING_AMBIGUOUS'
  | 'TEST_INVENTORY_INCOMPLETE'
  | 'TEST_MAPPING_STALE'
  | 'TEST_KIND_UNKNOWN'
  | 'BEHAVIOR_CASE_UNMAPPED';

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
  /** Compiled behavior case ids this binding intends to execute. */
  caseIds?: string[];
}

/** Every resolved binding for one obligation (sorted by origin, then key). */
export interface ObligationBindings {
  /** The obligation the bindings claim to cover. */
  obligationId: string;
  /** The resolved declarations (possibly empty — an unmapped obligation). */
  bindings: ResolvedClaimBinding[];
}

/**
 * Every resolved binding for one business-rule CASE claim (sorted by
 * origin, then key). Structurally identical to {@link ObligationBindings}
 * and deliberately kept apart from it: the business-rules evaluator reads
 * these, the obligation grader never does.
 */
export interface RuleClaimBindings {
  /** The `business-rule:<ruleId>/<caseId>` claim id. */
  claimId: string;
  /** The resolved declarations (possibly empty — an unmapped case). */
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
  /**
   * One entry per known business-rule case claim id, sorted by id. Empty
   * unless the owner declared `rules:`, and it is never merged into
   * `obligations` — a rule binding must not reach an obligation set, a
   * graded obligation array or a receipt coverage list (plan D3,
   * invariant 3).
   */
  ruleBindings: RuleClaimBindings[];
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
  /**
   * The owner-declared BUSINESS RULE case claim ids
   * (`business-rule:<ruleId>/<caseId>`) this run's rules registry knows.
   * A separate namespace beside `obligationIds`: a rule claim resolves in
   * the same resolver and reuses every staleness, ambiguity and
   * quarantine rule, but lands in `ruleBindings`, never in `obligations`.
   */
  businessRuleClaimIds?: readonly string[];
  /** Optional prior-run observations (suggestions only, never grading). */
  priorRunHints?: readonly PriorRunHint[];
  /** Playwright files whose native test load failed; selectors there are unknown, not stale. */
  nativeErrorFiles?: readonly string[];
  /** True when native enumeration failed and produced no instances at all. */
  nativeEnumerationFailed?: boolean;
  /** Compiled behavior catalog when the complete-behavior profile is on. */
  behaviorCatalog?: BehaviorCatalog | null;
}

/**
 * Drops every binding whose test is owner-quarantined. A quarantined
 * test proves nothing, so its
 * coverage claim disappears from the mapping surface: an obligation it
 * alone covered becomes uncovered and therefore stays `missing`. The
 * problems list is preserved verbatim — a quarantine never hides a
 * mapping problem.
 *
 * Args:
 *   resolution: the resolved mappings of this run.
 *   quarantinedKeys: logical test keys the owner quarantined.
 *
 * Returns:
 *   ResolvedMappings: the same document without quarantined bindings,
 *   with the same deterministic per-obligation ordering.
 */
export function withoutQuarantinedBindings(
  resolution: ResolvedMappings,
  quarantinedKeys: ReadonlySet<string>,
): ResolvedMappings {
  if (quarantinedKeys.size === 0) return resolution;
  return {
    obligations: resolution.obligations.map((obligation) => ({
      obligationId: obligation.obligationId,
      bindings: obligation.bindings.filter((binding) => !quarantinedKeys.has(binding.logicalKey)),
    })),
    // A quarantined test proves nothing, and that holds for a rule case
    // exactly as for an obligation: dropping only the obligation side
    // would leave a case looking mapped by a test the owner excluded.
    ruleBindings: resolution.ruleBindings.map((claim) => ({
      claimId: claim.claimId,
      bindings: claim.bindings.filter((binding) => !quarantinedKeys.has(binding.logicalKey)),
    })),
    problems: resolution.problems,
  };
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
  BEHAVIOR_CASE_UNMAPPED: 3,
  TEST_INVENTORY_INCOMPLETE: 4,
});

/** Test kinds that claim end-to-end proof (mocking disqualifies them, §3.2). */
const E2E_KINDS: ReadonlySet<string> = new Set(['browser-e2e', 'observed-e2e', 'api-e2e']);
function unreadableE2EClaimDetail(claimId: string, testKey: string, file: string, kind: string): string {
  return (
    `'${claimId}': Gateforge could not read the code of test '${testKey}' (${file}), so it cannot check ` +
    `that the test really is ${kind}. Its claims are not accepted until the scan can read it. ` +
    'Most likely cause: an unresolved test-wrapper import or a file extension outside the configured scan globs.'
  );
}


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
  // The business-rule claim registry is a SEPARATE namespace (plan D3):
  // `business-rule:<ruleId>/<caseId>` ids resolve here exactly like
  // obligation ids do, but they land in `ruleBindings` and never in
  // `obligations`, so no rule binding can reach an obligation set, a
  // graded obligation array or a receipt coverage list.
  const ruleRegistry = new Set(input.businessRuleClaimIds ?? []);
  const rowsByKey = new Map(input.catalog.entries.map((row) => [row.logicalKey, row]));
  const problems: MappingProblem[] = [];
  const seenProblems = new Set<string>();
  /** claimId (obligation OR business-rule) → logicalKey → binding. */
  const byClaim = new Map<string, Map<string, ResolvedClaimBinding>>();

  /** Whether one claim id names something the current run declares. */
  const knownClaim = (claimId: string): boolean => registry.has(claimId) || ruleRegistry.has(claimId);

  /**
   * The staleness detail for a claim id naming neither an obligation nor
   * a rule case. A `business-rule:` id is checked against the OWNER's
   * `rules:` section, so the message must say that — "not in the current
   * obligation registry" would send the reader hunting an obligation.
   */
  function unknownClaimDetail(claimId: string, subject: string): string {
    if (isBusinessRuleClaimId(claimId)) {
      const pair = parseBusinessRuleClaimId(claimId);
      return (
        `${subject} claims business rule '${pair?.ruleId ?? '?'}' case '${pair?.caseId ?? '?'}', ` +
        'which the rules: section of the owner answers document does not declare ' +
        '(the rule or the case was renamed or removed); correct the mapping'
      );
    }
    return (
      `${subject} claims '${claimId}', which is not in the current obligation registry ` +
      '(the obligation vanished or the id is misspelled); correct the mapping'
    );
  }

  const pushProblem = (problem: MappingProblem): void => {
    const dedupeKey = `${problem.cause}\u0000${problem.obligationId ?? ''}\u0000${problem.detail}`;
    if (seenProblems.has(dedupeKey)) return;
    seenProblems.add(dedupeKey);
    problems.push(problem);
  };

  const bindingsFor = (claimId: string): Map<string, ResolvedClaimBinding> => {
    let existing = byClaim.get(claimId);
    if (existing === undefined) {
      existing = new Map();
      byClaim.set(claimId, existing);
    }
    return existing;
  };

  // --- sidecar declarations ------------------------------------------------
  const sidecarEntries = [...input.sidecar.tests].sort((a, b) => compareStrings(a.key, b.key));
  for (const entry of sidecarEntries) {
    const claims = [...new Set(entry.claims)].sort(compareStrings);
    const unreadableE2EClaims = new Set<string>();
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

    // A failed native load means absence from this file's catalog is
    // inconclusive. Keep independent registry errors visible.
    if (matched.length === 0) {
      const nativeLoadFailed =
        entry.selector.runner === 'playwright' &&
        (input.nativeEnumerationFailed === true ||
          input.nativeErrorFiles?.includes(entry.selector.file) === true);
      if (nativeLoadFailed) {
        for (const obligationId of claims) {
          if (!knownClaim(obligationId)) {
            pushProblem({
              cause: 'TEST_MAPPING_STALE',
              obligationId,
              detail: unknownClaimDetail(obligationId, `sidecar entry '${entry.key}'`),
              locations: [{ file: entry.selector.file, line: 1, col: 0 }],
            });
          }
        }
      } else {
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
          if (!knownClaim(obligationId)) continue;
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
      }
      continue;
    }

    // Unknown obligation ids (§5.4 TEST_MAPPING_STALE): the declaration
    // points outside the registry — the obligation vanished or the id is
    // misspelled. Other claims of the same entry still bind.
    for (const obligationId of claims) {
      if (!knownClaim(obligationId)) {
        pushProblem({
          cause: 'TEST_MAPPING_STALE',
          obligationId,
          detail: unknownClaimDetail(obligationId, `sidecar entry '${entry.key}'`),
          locations: [matched[0]?.sourceLocation ?? { file: entry.selector.file, line: 1, col: 0 }],
        });
      }
    }

    // Kind contradictions (§5.3: an explicit kind may resolve `unknown`,
    // but cannot override strong observed signals or observed mocking).
    for (const row of matched) {
      if (entry.kind !== undefined && E2E_KINDS.has(entry.kind) && row.reconciliation === 'list-only') {
        for (const obligationId of claims) {
          if (!knownClaim(obligationId)) continue;
          unreadableE2EClaims.add(obligationId);
          pushProblem({
            cause: 'TEST_KIND_UNKNOWN',
            obligationId,
            detail: unreadableE2EClaimDetail(obligationId, entry.key, row.file, entry.kind),
            locations: [row.sourceLocation],
          });
        }
        continue;
      }
      if (entry.kind === undefined) {
        if (row.inferredKind === 'unknown') {
          for (const obligationId of claims) {
            if (!knownClaim(obligationId)) continue;
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

    const resolvedCaseIds: string[] = [];
    for (const rawId of entry.caseIds ?? []) {
      const compiled = (input.behaviorCatalog?.cases ?? []).find(
        (item) => item.caseId === rawId || item.definition.id === rawId,
      );
      if (compiled === undefined) {
        pushProblem({
          cause: 'TEST_MAPPING_STALE',
          obligationId: claims[0] ?? null,
          detail:
            `sidecar entry '${entry.key}' names case '${rawId}', which is not in the current ` +
            'behavior catalog (stale or foreign); correct the mapping',
          locations: [matched[0]?.sourceLocation ?? { file: entry.selector.file, line: 1, col: 0 }],
        });
        continue;
      }
      if (!compiled.obligationIds.some((id) => claims.includes(id))) {
        pushProblem({
          cause: 'TEST_MAPPING_STALE',
          obligationId: compiled.obligationIds[0] ?? null,
          detail:
            `sidecar entry '${entry.key}' names case '${rawId}' which does not belong to any of ` +
            "this entry's claimed obligations",
          locations: [matched[0]?.sourceLocation ?? { file: entry.selector.file, line: 1, col: 0 }],
        });
        continue;
      }
      resolvedCaseIds.push(compiled.caseId);
    }

    // Bind the declaration (many-to-many allowed). Ambiguity problems
    // above stay visible; the binding itself is data for suggestions.
    for (const obligationId of claims) {
      if (!knownClaim(obligationId) || unreadableE2EClaims.has(obligationId)) continue;
      bindingsFor(obligationId).set(entry.key, {
        logicalKey: entry.key,
        instances: matched.map(instanceOf),
        origin: 'sidecar',
        sourceDigest: matched[0]?.sourceDigest ?? null,
        declaredKind: entry.kind ?? null,
        categories: [...new Set(entry.categories ?? [])].sort(compareStrings),
        reason: entry.reason,
        sourceLocation: matched[0]?.sourceLocation ?? null,
        caseIds: resolvedCaseIds.filter((caseId) => {
          const compiled = (input.behaviorCatalog?.cases ?? []).find((item) => item.caseId === caseId);
          return compiled?.obligationIds.includes(obligationId) ?? false;
        }),
      });
    }
  }

  // Cross-entry ambiguity: two entries claiming the same obligation with
  // conflicting declared kinds (§5.4 "a declaration is unsafe").
  const obligationIdsSorted = [...registry].sort(compareStrings);
  for (const obligationId of obligationIdsSorted) {
    const declared = [...(byClaim.get(obligationId)?.values() ?? [])]
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
    if (!knownClaim(claim.obligationId)) {
      pushProblem({
        cause: 'TEST_MAPPING_STALE',
        obligationId: claim.obligationId,
        detail: unknownClaimDetail(
          claim.obligationId,
          `native annotation on test '${claim.testId}'${claim.testFile !== undefined ? ` (${claim.testFile})` : ''}`,
        ),
        locations: claim.location !== undefined ? [claim.location] : [],
      });
      continue;
    }
    const instances = input.catalog.entries
      .filter((row) => row.file === claim.testFile)
      .sort((a, b) => compareStrings(a.logicalKey, b.logicalKey));
    const unreadableInstance = instances.find((row) => row.reconciliation === 'list-only');
    if (unreadableInstance !== undefined) {
      pushProblem({
        cause: 'TEST_KIND_UNKNOWN',
        obligationId: claim.obligationId,
        detail: unreadableE2EClaimDetail(
          claim.obligationId,
          claim.testId,
          unreadableInstance.file,
          'an E2E kind',
        ),
        locations: [unreadableInstance.sourceLocation],
      });
      continue;
    }
    const existingBindings = byClaim.get(claim.obligationId);
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
      caseIds: [],
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
      caseIds: [],
    });
  }

  // --- inference (NEVER auto-writes a mapping; suggestions only) -----------
  for (const obligationId of obligationIdsSorted) {
    const bindings = byClaim.get(obligationId);
    if (bindings !== undefined && [...bindings.values()].some((b) => b.origin === 'native' || b.origin === 'sidecar')) {
      continue; // a declared mapping exists — inference adds nothing
    }
    const map = bindings ?? bindingsFor(obligationId);
    // No route hints here: this surface is the DECLARED evidence, and an
    // inferred binding is a suggestion, never graded. The ranked,
    // route-aware candidate list is produced by `mappingSuggestions`.
    for (const candidate of inferredCandidates(obligationId, input.catalog, [])) {
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
        caseIds: [],
      });
    }
  }

  if (input.behaviorCatalog !== undefined && input.behaviorCatalog !== null) {
    const mappedCases = new Map<string, Set<string>>();
    for (const obligationId of obligationIdsSorted) {
      const ids = new Set<string>();
      for (const binding of byClaim.get(obligationId)?.values() ?? []) {
        if (binding.origin !== 'sidecar') continue;
        for (const caseId of binding.caseIds ?? []) ids.add(caseId);
      }
      mappedCases.set(obligationId, ids);
    }
    for (const [obligationId, required] of Object.entries(input.behaviorCatalog.requirements)) {
      const mapped = mappedCases.get(obligationId) ?? new Set<string>();
      for (const caseId of required) {
        if (mapped.has(caseId)) continue;
        const compiled = input.behaviorCatalog.cases.find((item) => item.caseId === caseId);
        pushProblem({
          cause: 'BEHAVIOR_CASE_UNMAPPED',
          obligationId,
          detail:
            `required case '${compiled?.definition.id ?? caseId}' for '${obligationId}' has no current ` +
            'declared test mapping',
          locations: [],
        });
      }
    }
  }

  const sortBindings = (bindings: ResolvedClaimBinding[]): ResolvedClaimBinding[] =>
    bindings.sort(
      (a, b) =>
        ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || compareStrings(a.logicalKey, b.logicalKey),
    );
  const obligations = obligationIdsSorted.map((obligationId) => ({
    obligationId,
    bindings: sortBindings([...(byClaim.get(obligationId)?.values() ?? [])]),
  }));
  // Rule bindings are collected from the SAME claim map but published
  // under their own key, sorted by claim id. Nothing merges them into
  // `obligations` — that separation is what keeps a rule out of every
  // obligation set, graded obligation array and receipt coverage list.
  const ruleClaimIdsSorted = [...ruleRegistry].sort(compareStrings);
  const ruleBindings = ruleClaimIdsSorted.map((claimId) => ({
    claimId,
    bindings: sortBindings([...(byClaim.get(claimId)?.values() ?? [])]),
  }));
  problems.sort(
    (a, b) =>
      PROBLEM_RANK[a.cause] - PROBLEM_RANK[b.cause] ||
      compareStrings(a.obligationId ?? '', b.obligationId ?? '') ||
      compareStrings(a.detail, b.detail),
  );
  return {
    obligations,
    ruleBindings,
    problems: problems.map((problem) => ({ ...problem, locations: [...problem.locations] })),
  };
}

/** One inference candidate: the catalog row plus the matched signals. */
interface InferredCandidate {
  /** The matching catalog row. */
  row: TestCatalogEntry;
  /** Single-cause human signals explaining the match (no confidence numbers). */
  why: string[];
  /** Deterministic evidence score (higher is stronger; see CANDIDATE_SCORE). */
  score: number;
}

/**
 * Evidence weights for candidate ranking (plan 2026-09-13 §5.3: a
 * suggestion is a SIGNAL, never hidden probability). Every weight is
 * documented and additive, so the printed reason always explains the
 * order: an explicit tag beats a route path segment, a route segment
 * beats a bare resource token, and a mocked folder subtracts.
 */
const CANDIDATE_SCORE: Readonly<Record<string, number>> = Object.freeze({
  explicitTag: 100,
  titleResourceToken: 30,
  titleOperationToken: 25,
  titleRouteSegment: 20,
  fileResourceToken: 15,
  fileRouteSegment: 10,
  categoryToken: 10,
  realFolder: 10,
  mockedSuppression: -30,
});

/**
 * Title words that stand for an obligation's operation segment
 * (`…:persistence:delete` → `delete`, `remove`, …). Generic English,
 * never a consumer name.
 */
const OPERATION_TITLE_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create: Object.freeze(['create', 'add', 'new', 'post', 'insert']),
  read: Object.freeze(['read', 'get', 'list', 'show', 'fetch', 'display', 'loads']),
  update: Object.freeze(['update', 'edit', 'modify', 'change', 'patch', 'put', 'saves']),
  delete: Object.freeze(['delete', 'remove', 'destroy', 'archive', 'clears']),
});

/** Path segments that carry no resource meaning in a route hint. */
const ROUTE_FILLER_SEGMENTS: Readonly<Record<string, true>> = Object.freeze({
  api: true,
  rest: true,
  http: true,
  https: true,
  index: true,
  gateway: true,
  service: true,
});

/**
 * Plane qualifiers qualify EVERY resource in the plane, so they identify
 * no resource at all: `@crud(tenant.accounts:create)` must never rank a
 * candidate for `tenant.http-get-api-v1-notifications-…`.
 */
const PLANE_NAME_TOKENS: Readonly<Record<string, true>> = Object.freeze({
  tenant: true,
  master: true,
  global: true,
});

/** HTTP verbs a generated `http-<method>-…` endpoint name spells out. */
const HTTP_METHOD_TOKENS: Readonly<Record<string, true>> = Object.freeze({
  get: true,
  post: true,
  put: true,
  patch: true,
  delete: true,
  head: true,
  options: true,
});

/**
 * Whether one resource-id token names the RESOURCE or only the structure
 * around it: the plane, the transport, the method, route furniture, a
 * version segment, the generated `param` marker that stands in for a
 * `{route_param}`, or the generated id-hash suffix. Only real names may
 * be matched against a test title or file.
 */
function isStructuralResourceToken(token: string): boolean {
  if (PLANE_NAME_TOKENS[token] === true) return true;
  if (GENERATED_ID_TOKENS[token] === true) return true;
  if (HTTP_METHOD_TOKENS[token] === true) return true;
  if (ROUTE_FILLER_SEGMENTS[token] === true) return true;
  if (/^v\d+$/.test(token)) return true;
  // A generated id suffix (`…-27cb390c`). At least one digit is required so
  // real hex-looking words (`decade`, `facade`) stay resource names.
  return /^[0-9a-f]{6,}$/.test(token) && /\d/.test(token);
}

/** The marker a generated id carries for each `{param}` in the route. */
const GENERATED_ID_TOKENS: Readonly<Record<string, true>> = Object.freeze({
  param: true,
});

/** The matchable resource-name tokens of one resource id. */
function resourceTokens(resourceId: string): string[] {
  return resourceId
    .split(/[.\-_]/)
    .map((token) => token.toLowerCase())
    .filter(
      (token) => token.length > 2 && !isStructuralResourceToken(token) && OPERATION_WORDS[token] !== true,
    );
}


/**
 * The route segments of one obligation's hints worth matching against a
 * test's title/file: no path parameters, no version or filler segments.
 */
function routeSegmentsOf(hints: readonly string[]): string[] {
  const segments: string[] = [];
  for (const hint of hints) {
    const path = hint.replace(/^[A-Za-z]+\s+/, '');
    for (const raw of path.split('/')) {
      const segment = raw.trim().toLowerCase();
      if (segment.length < 3) continue;
      if (segment.startsWith('{') || segment.endsWith('}')) continue;
      if (/^v\d+$/.test(segment)) continue;
      if (ROUTE_FILLER_SEGMENTS[segment] === true) continue;
      segments.push(segment);
    }
  }
  return [...new Set(segments)];
}

/** The operation segment of an obligation id (`…:persistence:delete`). */
function operationOf(obligationId: string): string {
  const parts = obligationId.split(':');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** Words of a title path, split on non-letters. */
function titleWords(titlePath: readonly string[]): string[] {
  return titlePath
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

/** A parenthesised `@tag(...)` in a title: declaration text, not prose. */
const TITLE_TAG_PATTERN = /@[A-Za-z][A-Za-z0-9_-]*\([^)]*\)/g;

/** The title path with every `@tag(...)` removed (used for word matching). */
function proseTitlePath(titlePath: readonly string[]): string[] {
  return titlePath.map((segment) => segment.replace(TITLE_TAG_PATTERN, ' '));
}

/**
 * The CRUD operation each HTTP method exercises, for the fit check an
 * explicit tag must pass before it counts for a transport obligation.
 */
const HTTP_METHOD_OPERATIONS: Readonly<Record<string, string>> = Object.freeze({
  GET: 'read',
  HEAD: 'read',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
});

/**
 * The operation an `http:*` obligation's own route method exercises, or
 * null when the obligation is not transport-shaped or its route hint
 * names no known method. A tag that DECLARES an operation is evidence
 * for an obligation only when the two agree: `@crud(…:create)` says the
 * test creates the resource, which is no evidence that it reads
 * `GET /api/v2/accounts` — and answering `new test needed: no` from it
 * sent an owner to mark a create test as the proof of a read. A
 * non-transport obligation has no route method to fit, so its tags stay
 * judged on the resource alone.
 */
function transportOperationOf(obligationId: string, routes: readonly string[]): string | null {
  if ((obligationId.split(':')[1] ?? '').toLowerCase() !== 'http') return null;
  const method = (routes[0] ?? '').split(/\s+/)[0]?.toUpperCase() ?? '';
  return HTTP_METHOD_OPERATIONS[method] ?? null;
}

/**
 * The resource names an explicit `@crud(tenant.accounts:read)` /
 * `@gateforge(<…>)` tag declares, and the operation it declares beside
 * them. Only the RESOURCE part names a resource: the text before `:`
 * (everything after it names an operation, not a resource), and a plane
 * qualifier names no resource of its own. An `@op(...)` tag is not a
 * resource declaration at all and never contributes.
 */
interface ExplicitTag {
  /** The declared resource-NAME tokens (plane qualifiers dropped). */
  tokens: string[];
  /** The declared operation after the `:`, lowercased; null when none. */
  operation: string | null;
}

function explicitTags(titlePath: readonly string[]): ExplicitTag[] {
  const tags: ExplicitTag[] = [];
  for (const segment of titlePath) {
    for (const match of segment.matchAll(/@(?:crud|gateforge|resource)\(([^)]*)\)/g)) {
      const parts = (match[1] ?? '').split(':');
      const tokens: string[] = [];
      for (const token of (parts[0] ?? '').split(/[^A-Za-z0-9]+/)) {
        const name = token.toLowerCase();
        if (name.length > 2 && PLANE_NAME_TOKENS[name] !== true) tokens.push(name);
      }
      tags.push({ tokens, operation: (parts[1] ?? '').toLowerCase() || null });
    }
  }
  return tags;
}

/** One candidate's evidence score, its reasons, and the reuse inputs. */
interface CandidateEvidence {
  score: number;
  why: string[];
  /** The verdict inputs the reuse decision reads (never re-derived). */
  verdict: {
    /** An explicit `@crud(…)`/`@gateforge(…)`/`@resource(…)` named the resource. */
    explicitTag: boolean;
    /** A resource-NAME token matched the title, the file or a category. */
    resourceToken: boolean;
    /**
     * The FILE PATH names the obligation's route: at least
     * `min(2, segments)` of the route's non-operation segments appear in
     * it. A route is a PATH — one shared word (`auth`) is a coincidence,
     * while a file named `admin_login.spec.js` for `/admin/auth/login`
     * is that route. A route with fewer than two meaningful segments
     * needs only its own segment.
     */
    fileNamesRoute: boolean;
  };
}

/** Whether one catalog row's file path names the obligation's route. */
function fileNamesRoute(fileWords: readonly string[], routeSegments: readonly string[]): boolean {
  const meaningful = routeSegments.filter((segment) => OPERATION_WORDS[segment] !== true);
  if (meaningful.length === 0) return false;
  const needed = Math.min(2, meaningful.length);
  const named = meaningful.filter((segment) => fileWords.includes(segment)).length;
  return named >= needed;
}

/**
 * Scores ONE catalog row against one obligation by the evidence the row
 * carries, and explains every contributing signal in plain words. Every
 * match is WHOLE-WORD (title path words; file path segments split on
 * `/ . _ -`), never a substring: a token hidden inside a longer word
 * (`read` in `reference`) is not evidence about anything.
 *
 * Args:
 *   obligationId: the obligation the row is a candidate for.
 *   row: the catalog row under consideration.
 *   routes: the obligation's route hints (e.g. `GET /api/v2/accounts`).
 *
 * Returns:
 *   CandidateEvidence: the additive score, its human reasons, and the
 *   boolean inputs the reuse verdict reads.
 */
function candidateEvidence(
  obligationId: string,
  row: TestCatalogEntry,
  routes: readonly string[],
): CandidateEvidence {
  const resourceId = obligationId.slice(0, Math.max(0, obligationId.indexOf(':')));
  const tokens = resourceTokens(resourceId);
  const why: string[] = [];
  let score = 0;
  // Whole-word matching, never substrings: `read` is not inside
  // `reference`, and `notifications` is not inside `notification`. A
  // `@crud(...)` tag is a DECLARATION, so its text is stripped before the
  // title is read as prose (tag matching stays a separate, explicit path).
  const words = titleWords(proseTitlePath(row.titlePath));
  const fileWords = row.file.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
  const tags = explicitTags(row.titlePath);
  // A tag that DECLARES an operation is evidence for a TRANSPORT
  // obligation only when the operation fits the route's method; for
  // every other obligation (and for a route hint naming no known
  // method) the operation is null and the resource part stands on its
  // own. A tag that declares NO operation names the resource and
  // stops there — it is never contradicted by the method, so it keeps
  // its full credit on a transport obligation too.
  const requiredOperation = transportOperationOf(obligationId, routes);
  const operationWords = OPERATION_TITLE_WORDS[operationOf(obligationId)] ?? [];
  const routeSegments = routeSegmentsOf(routes);

  // One word counts once: the first (strongest) signal for it is the only
  // one, so a resource token that is also a route segment never scores
  // twice, and an operation word is never mistaken for a resource name.
  const counted = new Set<string>();
  let distinctive = false;
  let explicitTag = false;
  let resourceToken = false;
  for (const token of tokens) {
    if (counted.has(token)) continue;
    if (
      tags.some(
        (tag) =>
          tag.tokens.includes(token) &&
          (requiredOperation === null || tag.operation === null || tag.operation === requiredOperation),
      )
    ) {
      counted.add(token);
      distinctive = true;
      explicitTag = true;
      score += CANDIDATE_SCORE['explicitTag'] ?? 0;
      why.push(`explicit tag names this obligation's resource '${token}'`);
      continue;
    }
    if (words.includes(token)) {
      counted.add(token);
      distinctive = true;
      resourceToken = true;
      score += CANDIDATE_SCORE['titleResourceToken'] ?? 0;
      why.push(`resource token '${token}' matches the test title path`);
    } else if (fileWords.includes(token)) {
      counted.add(token);
      distinctive = true;
      resourceToken = true;
      score += CANDIDATE_SCORE['fileResourceToken'] ?? 0;
      why.push(`resource token '${token}' matches the test file '${row.file}'`);
    } else if (
      row.categorySignals.some((signal) =>
        signal.label.toLowerCase().split(/[^a-z0-9]+/).includes(token),
      )
    ) {
      counted.add(token);
      distinctive = true;
      resourceToken = true;
      score += CANDIDATE_SCORE['categoryToken'] ?? 0;
      why.push(`resource token '${token}' matches a category label`);
    }
  }
  const operation = operationOf(obligationId);
  if (operation.length > 2 && operationWords.some((word) => words.includes(word))) {
    counted.add(operation);
    score += CANDIDATE_SCORE['titleOperationToken'] ?? 0;
    why.push(`title names the obligation's operation '${operation}'`);
  }
  for (const segment of routeSegments) {
    if (counted.has(segment)) continue;
    if (words.includes(segment)) {
      counted.add(segment);
      if (OPERATION_WORDS[segment] !== true) distinctive = true;
      score += CANDIDATE_SCORE['titleRouteSegment'] ?? 0;
      why.push(`title mentions the obligation's route segment '${segment}'`);
    } else if (fileWords.includes(segment)) {
      counted.add(segment);
      if (OPERATION_WORDS[segment] !== true) distinctive = true;
      score += CANDIDATE_SCORE['fileRouteSegment'] ?? 0;
      why.push(`test file mentions the obligation's route segment '${segment}'`);
    }
  }
  if (row.file.split('/').some((segment) => segment.toLowerCase() === 'real')) {
    score += CANDIDATE_SCORE['realFolder'] ?? 0;
    why.push("lives in a 'real' folder (unmocked)");
  }
  if (row.suppressionSignals.some((signal) => signal.kind === 'mock')) {
    score += CANDIDATE_SCORE['mockedSuppression'] ?? 0;
    why.push('mocks the system under test (weaker evidence)');
  }
  // An unmocked folder, an operation word or a mock signal alone never makes
  // a candidate: there must be at least one DISTINCTIVE match — a resource
  // token or a route segment that is not an operation word.
  const verdict = { explicitTag, resourceToken, fileNamesRoute: fileNamesRoute(fileWords, routeSegments) };
  return distinctive ? { score, why, verdict } : { score: 0, why: [], verdict };
}

/**
 * Every word the operation table uses. These name an OPERATION, never a
 * resource: `tenant.accounts:…:read` says what the obligation DOES, so a
 * title that merely says "read tenant.accounts through UI" is evidence
 * about no resource in particular. They are never resource tokens, and a
 * row that matches nothing else is not a candidate at all.
 */
const OPERATION_WORDS: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(
    Object.values(OPERATION_TITLE_WORDS)
      .flat()
      .map((word): [string, true] => [word, true]),
  ),
);

/**
 * Contract families whose proof is an OBSERVED-E2E suite test (the Observe
 * channel): a `unit` suite drives no app and witnesses nothing, so such a
 * row can never be the answer for them. Other families keep today's
 * behaviour — the catalog kind is evidence about the CHANNEL, and mapping
 * every contract onto it would be a second classification.
 */
const OBSERVED_E2E_CONTRACT_FAMILIES: Readonly<Record<string, true>> = Object.freeze({
  persistence: true,
  crud: true,
  http: true,
});

/**
 * Deterministic token inference (plan Phase 3 item 2): the RESOURCE-NAME
 * tokens of the obligation's resource id (`tenant.accounts` → `accounts`;
 * the plane, transport, method, route furniture, and id hash are structure,
 * not names) matched WHOLE-WORD against catalog rows' files, title paths,
 * and category labels, plus the obligation's operation and route hints.
 * Candidates are ordered by evidence score (strongest first), then by
 * logical key for stability.
 * Signals feed SUGGESTIONS only — an inference never writes a mapping (§5.3).
 */
function inferredCandidates(
  obligationId: string,
  catalog: TestCatalog,
  routes: readonly string[],
): InferredCandidate[] {
  const candidates: InferredCandidate[] = [];
  const contractFamily = (obligationId.split(':')[1] ?? '').toLowerCase();
  const observedE2e = OBSERVED_E2E_CONTRACT_FAMILIES[contractFamily] === true;
  for (const row of catalog.entries) {
    // ELIGIBILITY before ranking: a `static-only` row is a test-shaped file
    // no runner enumerated (a Vitest jsdom suite inside a
    // Playwright-configured repository, say). It can never produce the
    // witnessed evidence a mapping promises, so it is never offered.
    if (row.reconciliation === 'static-only') continue;
    // A `unit` suite drives no app: for an observed-e2e contract it can
    // never be the test that witnesses the claim.
    if (observedE2e && row.inferredKind === 'unit') continue;
    const evidence = candidateEvidence(obligationId, row, routes);
    if (evidence.why.length === 0) continue;
    candidates.push({ row, why: evidence.why, score: evidence.score });
  }
  return candidates.sort(
    (a, b) => b.score - a.score || compareStrings(a.row.logicalKey, b.row.logicalKey),
  );
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
  /** Evidence score (additive weights; higher is a stronger match). */
  score: number;
  /** 1-based position in this suggestion's ranked list. */
  rank: number;
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
  /**
   * The REUSE verdict — a question with three honest answers, not a
   * boolean:
   * - `no`: the #1 candidate can be reused and the evidence says so (an
   *   explicit tag names this resource, or the row's file names the
   *   route);
   * - `yes`: nothing can be reused — no candidate survived resolution,
   *   or every candidate mocks the system under test;
   * - `unverified`: a candidate exists but ONE signal carries it, so
   *   reuse may well be right and nothing here proves it. The owner must
   *   confirm the request really is sent before marking.
   */
  newTestNeeded: 'no' | 'yes' | 'unverified';
}

/** Inputs of {@link mappingSuggestions}. */
export interface MappingSuggestionsInput {
  /** The current derived test catalog. */
  catalog: TestCatalog;
  /** The obligation ids to suggest for (already scoped by the caller). */
  obligationIds: readonly string[];
  /** The resolved-mappings surface from {@link resolveTestMappings}. */
  resolution: ResolvedMappings;
  /**
   * Route hints per obligation (`GET /api/v2/accounts`, …) used ONLY to
   * rank candidates by route evidence. Absent (or an empty list) simply
   * means no route evidence is available — never a different order rule.
   */
  routeHints?: ReadonlyMap<string, readonly string[]>;
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
 * The ONE instruction for a mapping suggestion: when the strongest
 * candidate is an existing suite-driven browser test, the next step is to
 * MARK that test `observed-e2e` and run it with the witness — writing a
 * new overlay test while a fitting test already exists is the advice the
 * owner got wrong in 0.8.0. The overlay instruction is what remains when
 * no existing test fits the obligation (`newTestNeeded`).
 *
 * Args:
 *   obligationId: the obligation the suggestion is about.
 *   candidate: the top-ranked candidate, when one exists.
 *
 * Returns:
 *   string: the suggestion's next action.
 */
function reuseNextAction(obligationId: string, candidate: SuggestionCandidate | undefined): string {
  if (candidate === undefined) return CAUSE_NEXT_ACTIONS['TEST_MAPPING_MISSING'] ?? '';
  return (
    `mark the existing test as observed-e2e and run it with the witness — ` +
    `\`gateforge tests mark --test ${candidate.logicalKey} --kind observed-e2e ` +
    `--obligation ${obligationId} --reason "existing suite-driven browser test"\`, ` +
    `then \`gateforge test-gates --changed\` to collect its witnessed evidence`
  );
}

/**
 * The next action when reuse is PLAUSIBLE but unproven: confirm the
 * request first, and only then mark. This never prints a ready-to-run
 * `tests mark` command — handing the owner a command to run is exactly
 * the advice that was wrong when the single-signal candidate looked
 * settled.
 *
 * Args:
 *   obligationId: the obligation the suggestion is about.
 *   candidate: the top-ranked candidate.
 *   route: the request the candidate must really send.
 *
 * Returns:
 *   string: the confirmation-first next action.
 */
function unverifiedNextAction(
  obligationId: string,
  candidate: SuggestionCandidate | undefined,
  route: string,
): string {
  const where =
    candidate === undefined
      ? ''
      : ` Read ${candidate.file} and check that it really sends it.`;
  return (
    `check that the candidate really sends ${route} before marking it — ` +
    `run \`gateforge explain ${obligationId}\` to see the obligation.${where} ` +
    'A shared name is not proof; mark only once the request is in there.'
  );
}

/**
 * The REUSE verdict for one obligation's candidate list.
 *
 * `yes` when nothing can be reused: no candidate survived resolution, or
 * every candidate mocks the system under test (a mock can never witness
 * the claim, so it is not a reuse answer at all).
 *
 * `no` only when the #1 candidate is an unmocked e2e row AND the evidence
 * is more than one signal — an explicit tag that NAMES this resource, or
 * a resource-token match together with the file naming the route. One
 * shared word is a coincidence; a file named `admin_login.spec.js` for
 * `POST /admin/auth/login` is that route.
 *
 * Anything else is `unverified`: a candidate exists, reuse may well be
 * right, and NOTHING HERE PROVES IT. That is the honest answer, and it
 * is why it is a third state instead of a `false` that reads as "reuse
 * is settled".
 *
 * Args:
 *   candidates: the ranked candidate list (empty when none survived).
 *   mockedKeys: logical keys whose rows mock the system under test.
 *   verdictOf: the evidence verdict for a candidate's logical key.
 *
 * Returns:
 *   'yes' | 'no' | 'unverified': the reuse verdict.
 */
function reuseVerdict(
  candidates: readonly SuggestionCandidate[],
  mockedKeys: ReadonlySet<string>,
  verdictOf: (logicalKey: string) => CandidateEvidence['verdict'] | undefined,
): 'yes' | 'no' | 'unverified' {
  if (candidates.length === 0) return 'yes';
  if (candidates.every((candidate) => mockedKeys.has(candidate.logicalKey))) return 'yes';
  const top = candidates[0];
  if (top === undefined || mockedKeys.has(top.logicalKey)) return 'unverified';
  const verdict = verdictOf(top.logicalKey);
  if (verdict === undefined) return 'unverified';
  if (verdict.explicitTag) return 'no';
  return verdict.resourceToken && verdict.fileNamesRoute ? 'no' : 'unverified';
}

/**
 * Scores, orders, and numbers one obligation's candidate rows: evidence
 * score first (strongest match ranks #1), logical key second for
 * determinism. Every candidate carries its score and rank so the JSON
 * surface keeps the full ranked list.
 */
function rankCandidates(
  candidates: readonly {
    logicalKey: string;
    file: string;
    why: string[];
    score: number;
  }[],
): SuggestionCandidate[] {
  return [...candidates]
    .sort((a, b) => b.score - a.score || compareStrings(a.logicalKey, b.logicalKey))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/**
 * Produces per-obligation reuse suggestions ordered by reuse (plan
 * Phase 3 item 6). Obligations with a clean DECLARED mapping produce no
 * suggestion (their remaining gap is executed proof, not mapping).
 * `newTestNeeded` is a three-state REUSE verdict, not a boolean — see
 * {@link MappingSuggestion.newTestNeeded}.
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
        // A declaration exists and conflicts with itself: the gap is a
        // repair, never a new test.
        newTestNeeded: 'no',
      });
      continue;
    }
    const stale = problems.find((problem) => problem.cause === 'TEST_MAPPING_STALE');
    if (stale !== undefined) {
      const candidates = rankCandidates(
        inferredCandidates(obligationId, input.catalog, input.routeHints?.get(obligationId) ?? []).map(
          (candidate) => {
            const hint = observeHintForRow(candidate.row);
            return {
              logicalKey: candidate.row.logicalKey,
              file: candidate.row.file,
              why: [...candidate.why, ...(hint !== null ? [hint] : [])],
              score: candidate.score,
            };
          },
        ),
      );
      suggestions.push({
        obligationId,
        cause: 'TEST_MAPPING_STALE',
        candidates,
        missingEvidence: `an up-to-date declaration (the current one is stale: ${stale.detail})`,
        nextAction: CAUSE_NEXT_ACTIONS['TEST_MAPPING_STALE'],
        newTestNeeded: candidates.length === 0 ? 'yes' : 'no',
      });
      continue;
    }
    const declared = bindings.filter((binding) => binding.origin === 'native' || binding.origin === 'sidecar');
    const kindUnknown = problems.find((problem) => problem.cause === 'TEST_KIND_UNKNOWN');
    if (kindUnknown !== undefined) {
      suggestions.push({
        obligationId,
        cause: 'TEST_KIND_UNKNOWN',
        candidates: rankCandidates(
          declared.map((binding) => {
            const row = rowsByKey.get(binding.logicalKey);
            const evidence = row === undefined ? { score: 0, why: [] as string[] } : candidateEvidence(
              obligationId,
              row,
              input.routeHints?.get(obligationId) ?? [],
            );
            return {
              logicalKey: binding.logicalKey,
              file: binding.instances[0]?.file ?? '',
              why: ['mapped by declaration, but its kind is unknown', ...evidence.why],
              score: evidence.score,
            };
          }),
        ),
        missingEvidence: 'a declared kind for the connected test (code analysis could not classify it)',
        nextAction: CAUSE_NEXT_ACTIONS['TEST_KIND_UNKNOWN'],
        // A test is already declared; only its kind is missing.
        newTestNeeded: 'no',
      });
      continue;
    }
    if (declared.length > 0) continue; // declared + clean: the gap is execution, not mapping
    const mockedKeys = new Set<string>();
    const verdicts = new Map<string, CandidateEvidence['verdict']>();
    const candidates = rankCandidates(
      bindings.map((binding) => {
        const row = rowsByKey.get(binding.logicalKey);
        const hint = observeHintForRow(row);
        const base =
          binding.origin === 'inferred' || binding.origin === 'prior-run'
            ? (binding.reason ?? binding.origin)
            : `bound by native annotation (${binding.logicalKey})`;
        if (row?.suppressionSignals.some((signal) => signal.kind === 'mock') === true) {
          mockedKeys.add(binding.logicalKey);
        }
        const evidence =
          row === undefined
            ? { score: 0, why: [] as string[], verdict: undefined }
            : candidateEvidence(obligationId, row, input.routeHints?.get(obligationId) ?? []);
        if (evidence.verdict !== undefined) verdicts.set(binding.logicalKey, evidence.verdict);
        return {
          logicalKey: binding.logicalKey,
          file: binding.instances[0]?.file ?? '',
          why: [base, ...evidence.why, ...(hint !== null ? [hint] : [])],
          score: evidence.score,
        };
      }),
    );
    // A mocked candidate can never witness the claim, so when every
    // candidate mocks the system under test the obligation is not
    // satisfiable by reuse: a NEW test is needed. The mocked rows stay
    // listed as context, and no `tests mark` is offered for them.
    const onlyMocked = candidates.length > 0 && candidates.every((candidate) => mockedKeys.has(candidate.logicalKey));
    const verdict = reuseVerdict(candidates, mockedKeys, (key) => verdicts.get(key));
    // The request the candidate must REALLY send before a mark is honest:
    // the obligation's own route hint, never a guess.
    const route = input.routeHints?.get(obligationId)?.[0] ?? 'the request this obligation describes';
    suggestions.push({
      obligationId,
      cause: 'TEST_MAPPING_MISSING',
      candidates,
      missingEvidence:
        verdict === 'unverified'
          ? `CONFIRMATION that the candidate really sends ${route} — it matched on ONE signal, ` +
            'and a name in common is not proof the test drives that route'
          : onlyMocked
            ? 'a new test — only mocked candidates: every existing candidate mocks the system under ' +
              'test, so none can witness this claim (they are listed as context)'
            : candidates.length > 0
              ? 'a DECLARED mapping and witnessed evidence for this change (a mapping declares intent; it supplies no test result)'
              : 'a declared mapping to any existing test — no candidate survived resolution',
      nextAction:
        verdict === 'unverified'
          ? unverifiedNextAction(obligationId, candidates[0], route)
          : reuseNextAction(obligationId, onlyMocked ? undefined : candidates[0]),
      newTestNeeded: verdict,
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
