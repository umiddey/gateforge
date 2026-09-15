import { type GateforgeConfig, type TestCatalog } from '@gateforge/core';
import { repoRelative } from './pytest-adapter.js';
/** Options for one discovery run. */
export interface DiscoverOptions {
    /** Absolute repo root. */
    cwd: string;
    /** The validated gateforge config. */
    config: GateforgeConfig;
    /** Collect configured pytest suites (default: list them only). */
    collectPytest?: boolean;
    /** Native playwright `--list` timeout (default 60s). */
    playwrightTimeoutMs?: number;
}
/** The discovery result: the validated catalog plus its canonical JSON. */
export interface DiscoverResult {
    catalog: TestCatalog;
    /** Canonical JSON of the catalog (deterministic, snapshot-able). */
    json: string;
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
 *   Promise<DiscoverResult>: validated catalog + canonical JSON.
 *
 * Throws:
 *   TestDiscoveryError: when an enabled native enumeration could not
 *   run at all (spawn failure, timeout, unparseable output) — the CLI
 *   maps this to exit 2. Scanner-detectable problems are rows, not
 *   throws.
 */
export declare function discoverTestCatalog(options: DiscoverOptions): Promise<DiscoverResult>;
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
export declare function templateTitlePattern(title: string): RegExp | null;
export { repoRelative };
//# sourceMappingURL=discover.d.ts.map