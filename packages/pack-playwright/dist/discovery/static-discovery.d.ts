import { type Location } from '@gate-forge/core';
/** Default cap on files pulled in through import traversal. */
export declare const DEFAULT_MAX_TRAVERSED_FILES = 200;
/** Default bound on import-traversal depth (chain length). */
export declare const DEFAULT_MAX_IMPORT_DEPTH = 16;
/** Traversal-budget knobs for one scan. */
export interface ScanBudget {
    /** Max files pulled in through import traversal (default 200). */
    maxTraversedFiles?: number;
    /** Max import-chain depth when resolving an alias (default 16). */
    maxImportDepth?: number;
}
/** Options for one static test scan. */
export interface StaticScanOptions {
    /** Absolute repo root. */
    cwd: string;
    /** Repo-root-relative include globs (the configured test files). */
    include: readonly string[];
    /** Repo-root-relative exclude globs (any match wins). */
    exclude: readonly string[];
    /** Traversal budgets (defaults documented on {@link ScanBudget}). */
    budget?: ScanBudget;
}
/** Facts one static test call exposes for kind inference. */
export interface StaticTestFacts {
    /** Fixture names in the test callback's first parameter. */
    signatureParams: string[];
    /** `page.route(...)` (or any `<x>.route(`) inside the test body. */
    pageRoute: Location | null;
    /** fetch/axios call inside the test body. */
    httpClientCall: Location | null;
    /** fetch/axios call anywhere in the file (app-boundary import hint). */
    fileHttpClientCall: Location | null;
    /** `vi.mock(...)` / `jest.mock(...)` anywhere in the file. */
    fileMockImport: Location | null;
}
/** One statically discovered test call. */
export interface StaticTestEntry {
    /** Repo-root-relative posix file path. */
    file: string;
    /** Describe stack + title. */
    titlePath: string[];
    /** Last segment of {@link titlePath}. */
    title: string;
    /** Test-call location (diagnostics, never identity). */
    location: Location;
    /** `each`/template parameter identity, or null. */
    parameterIdentity: string | null;
    /** Suppression signals recorded at/below this call. */
    signals: Array<{
        kind: 'skip' | 'only' | 'fixme';
        detail: string;
        location: Location;
    }>;
    /** Inference facts from the call + callback body. */
    facts: StaticTestFacts;
}
/** One statically detected gap (unresolvable call, budget, dynamic title). */
export interface StaticUnresolved {
    /** Stable code, e.g. `unresolved-wrapper`. */
    code: string;
    /** Single-cause human explanation. */
    detail: string;
    /** Repo-relative file of the gap (catalog row input). */
    file: string;
    /** Title path when a literal title was readable, else a placeholder. */
    titlePath: string[];
    /** Location of the unresolved call/import. */
    location: Location;
}
/** One parser failure with its location. */
export interface StaticParseError {
    file: string;
    message: string;
    location: Location;
}
/** Result of one static scan. */
export interface StaticScanResult {
    entries: StaticTestEntry[];
    unresolved: StaticUnresolved[];
    parseErrors: StaticParseError[];
    /** Repo-relative files that were parsed (seeded + traversed). */
    scannedFiles: string[];
    /** True when the import-traversal budget cut resolution short. */
    budgetExceeded: boolean;
}
/** Placeholder titlePath for unresolved calls with no readable title. */
export declare const UNRESOLVED_TITLE_PLACEHOLDER = "<unresolved-title>";
/**
 * The gateforge pack's own module specifier (`packages/pack-playwright`):
 * its exported `test` IS a playwright test function (`base.extend` over
 * `playwright/test` — see `fixture/fixture.ts`, which documents this
 * import as the only sanctioned runner). Binding it lets the static scan
 * follow the documented consumer shape
 * (`import { test as gateforgeTest } from '@gate-forge/pack-playwright'`)
 * instead of emitting unresolvable rows for it. Every OTHER
 * module-external import stays unresolved — fail-closed is unchanged.
 */
export declare const GATEFORGE_PACK_SPECIFIER = "@gate-forge/pack-playwright";
/**
 * Signature parameter names that prove a real browser is in play.
 * `evidence` is this pack's trusted-evidence fixture — it is built on a
 * live `page` (see `fixture/fixture.ts`), so a test declaring it runs a
 * real browser journey.
 */
export declare const BROWSER_FIXTURE_PARAMS: Set<string>;
/**
 * Runs the bounded static scan over the configured globs. Every value is
 * derived from ASTs; the only I/O is reading candidate + import-target
 * files under {@link ScanBudget}.
 *
 * Args:
 *   options: cwd, include/exclude globs, and optional budgets.
 *
 * Returns:
 *   StaticScanResult: entries, unresolved rows, parse errors, scanned
 *   files, and the budget flag. Never throws for scanner-detectable
 *   problems — those are rows (fail closed as data, not silence).
 */
export declare function scanTestFiles(options: StaticScanOptions): StaticScanResult;
//# sourceMappingURL=static-discovery.d.ts.map