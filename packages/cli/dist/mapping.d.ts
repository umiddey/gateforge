import { type BlockingEntry, type Claim, type GateforgeConfig, type Obligation, type ResolvedMappings, type ResourceGraph, type TestCatalog, type TestMap } from '@gateforge/core';
import type { MappedCoverage } from '@gateforge/core';
/** The tracked sidecar path, repo-root-relative (plan §5.1 row 2). */
export declare const TEST_MAP_RELATIVE = ".gateforge/test-map.yml";
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
export declare function loadOptionalTestMap(cwd: string): TestMap | null;
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
export declare function serializeTestMap(testMap: TestMap): string;
/**
 * Atomically writes the sidecar: a temp file on the same filesystem,
 * fsync-free rename into place (a crash never leaves a half-written
 * tracked declaration).
 *
 * Args:
 *   cwd: absolute repo root.
 *   testMap: the validated document to write.
 */
export declare function writeTestMapAtomic(cwd: string, testMap: TestMap): void;
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
    priorRunHints?: readonly {
        logicalKey: string;
        obligationId: string;
    }[];
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
export declare function resolveRepositoryMappings(options: MappingResolutionOptions): Promise<MappingResolutionResult>;
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
export declare function mappingBlocking(problems: ResolvedMappings['problems']): BlockingEntry[];
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
export declare function gradingClaimsFor(resolution: ResolvedMappings, nativeClaims: readonly Claim[]): Claim[];
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
export declare function diffLines(before: string, after: string): string[];
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
export declare function relativeToRepo(cwd: string, absolute: string): string;
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
export declare function mappedCoverageFrom(resolution: ResolvedMappings, obligations: readonly Obligation[], graph: ResourceGraph): MappedCoverage[];
//# sourceMappingURL=mapping.d.ts.map