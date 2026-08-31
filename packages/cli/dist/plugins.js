/**
 * Plugin invocation (ADR 0002) — the frozen surface G5's detectors and
 * G6's test-gates consume.
 *
 * Two transports, both fed the SAME expanded include path list:
 *
 * - `subprocess` (GPP/2): spawn the configured `command` argv via
 *   {@link PluginSession}, perform the pinned handshake, one lock-step
 *   `discover`, then the shutdown handshake. The session is disposed on
 *   every path — a protocol violation never leaves a stray plugin
 *   process behind. The host validates the result payload against the
 *   pinned discovery shape (GF-12/18: fail closed with E_* codes).
 * - `in-process`: dynamic-import the configured `module` and call its
 *   default export's `discover(paths)`. The module contract is the same
 *   discovery shape the wire protocol carries:
 *
 *   ```ts
 *   export default {
 *     discover(paths: readonly string[]):
 *       Promise<{resources: unknown[], unresolved: unknown[], findings: unknown[]}>
 *       | {resources: unknown[], unresolved: unknown[], findings: unknown[]},
 *   };
 *   ```
 *
 *   Relative module specifiers (`./…`, `../…`) resolve against the repo
 *   root (cwd); anything else is a package specifier. The returned
 *   document is validated against the frozen `DetectorOutputSchema`;
 *   invalid output fails closed naming the plugin.
 *
 * Determinism: plugins run in config order, each contribution feeds
 * `buildResourceGraph` verbatim, and the graph owns all sorting.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DetectorOutputSchema, } from '@gateforge/core';
import { PluginSession } from '@gateforge/plugin-protocol';
import { UsageError } from './errors.js';
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
export async function runPlugins(plugins, paths, cwd) {
    const contributions = [];
    const registrations = [];
    for (const plugin of plugins) {
        if (plugin.transport === 'subprocess') {
            contributions.push(await runSubprocessPlugin(plugin, paths, cwd));
        }
        else {
            contributions.push(await runInProcessPlugin(plugin, paths, cwd));
        }
        registrations.push({ id: plugin.id, version: plugin.version, transport: plugin.transport });
    }
    return { contributions, registrations };
}
/** Drives one GPP/2 subprocess plugin session over the path list. */
async function runSubprocessPlugin(plugin, paths, cwd) {
    const command = plugin.command;
    if (command === undefined) {
        throw new UsageError(`subprocess plugin '${plugin.id}' has no command (config error)`);
    }
    const session = new PluginSession({
        command,
        pluginId: plugin.id,
        pluginVersion: plugin.version,
        cwd,
    });
    try {
        await session.start();
        const outcome = paths.length > 0
            ? await session.discover(paths)
            : { resources: [], unresolved: [], findings: [] };
        await session.shutdown();
        return {
            detectorId: plugin.id,
            detectorVersion: plugin.version,
            resources: outcome.resources,
            unresolved: outcome.unresolved,
            findings: outcome.findings,
        };
    }
    catch (error) {
        if (error instanceof Error) {
            throw new UsageError(`plugin '${plugin.id}' (${plugin.transport}) failed: ${error.message}`);
        }
        throw error;
    }
    finally {
        // Dispose is idempotent and never throws: clean shutdown leaves it a
        // no-op; any earlier failure kills the process and reaps it.
        await session.dispose();
    }
}
/** Loads and drives one in-process plugin module. */
async function runInProcessPlugin(plugin, paths, cwd) {
    const moduleSpecifier = plugin.module;
    if (moduleSpecifier === undefined) {
        throw new UsageError(`in-process plugin '${plugin.id}' has no module (config error)`);
    }
    const resolved = moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')
        ? pathToFileURL(join(cwd, moduleSpecifier)).href
        : moduleSpecifier;
    let api;
    try {
        const loaded = (await import(resolved));
        api = (loaded.default ?? loaded);
    }
    catch (error) {
        throw new UsageError(`in-process plugin '${plugin.id}': cannot import module '${moduleSpecifier}': ` +
            `${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof api !== 'object' || api === null || typeof api.discover !== 'function') {
        throw new UsageError(`in-process plugin '${plugin.id}': module '${moduleSpecifier}' must default-export ` +
            `{ discover(paths) } (the pinned in-process plugin contract)`);
    }
    let result;
    try {
        const outcome = await api.discover(paths);
        result = {
            resources: Array.isArray(outcome.resources) ? outcome.resources : [],
            unresolved: Array.isArray(outcome.unresolved) ? outcome.unresolved : [],
            findings: Array.isArray(outcome.findings) ? outcome.findings : [],
        };
    }
    catch (error) {
        throw new UsageError(`in-process plugin '${plugin.id}' discover failed: ` +
            `${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = DetectorOutputSchema.safeParse({
        detectorId: plugin.id,
        detectorVersion: plugin.version,
        ...result,
    });
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.join('.') ?? '<document>';
        throw new UsageError(`in-process plugin '${plugin.id}' returned an invalid discovery result: ` +
            `${path}: ${issue?.message ?? 'unknown issue'}`);
    }
    return parsed.data;
}
//# sourceMappingURL=plugins.js.map