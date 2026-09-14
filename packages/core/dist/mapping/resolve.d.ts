import type { Location } from '../schemas/common.js';
import { type Claim } from '../schemas/claim.js';
import type { TestCatalog, TestKind } from '../schemas/test-catalog.js';
import type { TestMap } from '../schemas/test-map.js';
/** Why a mapping problem exists (plan §5.4 rows TEST_MAPPING_* + TEST_KIND_UNKNOWN). */
export type MappingProblemCause = 'TEST_MAPPING_AMBIGUOUS' | 'TEST_MAPPING_STALE' | 'TEST_KIND_UNKNOWN';
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
export declare function resolveTestMappings(input: ResolveMappingsInput): ResolvedMappings;
/** Cause a mapping suggestion can carry (plan §5.4 mapping rows). */
export type MappingSuggestionCause = 'TEST_MAPPING_MISSING' | 'TEST_KIND_UNKNOWN' | 'TEST_MAPPING_AMBIGUOUS' | 'TEST_MAPPING_STALE';
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
export declare function mappingSuggestions(input: MappingSuggestionsInput): MappingSuggestion[];
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
export declare function mappingGradingClaims(resolution: ResolvedMappings, existingClaims: readonly Claim[]): Claim[];
//# sourceMappingURL=resolve.d.ts.map