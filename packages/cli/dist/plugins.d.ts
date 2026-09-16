import { type ConfigPlugin, type DetectorOutput, type PluginRegistration } from '@gate-forge/core';
/** One plugin run: detector contributions + pinned registrations. */
export interface PluginRunResult {
    contributions: DetectorOutput[];
    registrations: PluginRegistration[];
}
/** Default export shape every in-process plugin must provide. */
export interface InProcessPluginModule {
    discover(paths: readonly string[]): Promise<{
        resources: unknown[];
        unresolved: unknown[];
        findings: unknown[];
        classificationSignals: unknown[];
    }> | {
        resources: unknown[];
        unresolved: unknown[];
        findings: unknown[];
        classificationSignals: unknown[];
    };
}
/**
 * Runs every configured plugin over the same path list.
 *
 * Args:
 *   plugins: plugin entries from `.gateforge.yml` (config order).
 *   paths: expanded repo-relative include paths (possibly empty).
 *   cwd: repo root; subprocess cwd and in-process module base.
 *
 * Returns:
 *   PluginRunResult: one validated contribution per plugin, plus the
 *   pinned registrations for the run manifest.
 *
 * Throws:
 *   UsageError (exit 2): config/usage problems — spawn failures,
 *   GPP/2 protocol violations, import failures, invalid discovery
 *   documents. A failed plugin never yields a partial contribution.
 */
export declare function runPlugins(plugins: readonly ConfigPlugin[], paths: readonly string[], cwd: string): Promise<PluginRunResult>;
//# sourceMappingURL=plugins.d.ts.map