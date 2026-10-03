/**
 * Plugin invocation (ADR 0002) — the frozen surface G5's detectors and
 * G6's test-gates consume.
 *
 * Two transports, both fed the SAME expanded include path list:
 *
 * - `subprocess` (GPP/3): spawn the configured `command` argv via
 *   {@link PluginSession}, perform the pinned handshake, one lock-step
 *   `discover`, then the shutdown handshake. The session is disposed on
 *   every path — a protocol violation never leaves a stray plugin
 *   process behind. The host validates the result payload against the
 *   pinned discovery shape (GF-12/18: fail closed with E_* codes).
 *   GPP/2 peers fail closed at the handshake with an actionable
 *   expected-versus-received `E_PROTOCOL_VERSION` diagnostic (ADR 0003 D6).
 * - `in-process`: dynamic-import the configured `module` and call its
 *   default export's `discover(paths)`. The module contract is the same
 *   discovery shape the wire protocol carries:
 *
 *   ```ts
 *   export default {
 *     discover(paths: readonly string[]):
 *       Promise<{resources: unknown[], unresolved: unknown[], findings: unknown[], classificationSignals: unknown[]}>
 *       | {resources: unknown[], unresolved: unknown[], findings: unknown[], classificationSignals: unknown[]},
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
import {
  DetectorOutputSchema,
  type ConfigPlugin,
  type DetectorOutput,
  type PluginRegistration,
} from '@gate-forge/core';
import { PluginSession } from '@gate-forge/plugin-protocol';
import { UsageError } from './errors.js';
import {
  digestPathListInputs,
  lookupPluginCache,
  storePluginResult,
  type CacheControl,
  type CacheCounts,
} from './run-cache.js';

/** One plugin run: detector contributions + pinned registrations + cache accounting. */
export interface PluginRunResult {
  contributions: DetectorOutput[];
  registrations: PluginRegistration[];
  /** Cache accounting for this run (0/0 when the cache is disabled). */
  cache: CacheCounts;
}

/** Default export shape every in-process plugin must provide. */
export interface InProcessPluginModule {
  discover(
    paths: readonly string[],
  ):
    | Promise<{
        resources: unknown[];
        unresolved: unknown[];
        findings: unknown[];
        classificationSignals: unknown[];
      }>
    | {
        resources: unknown[];
        unresolved: unknown[];
        findings: unknown[];
        classificationSignals: unknown[];
      };
}

/**
 * Runs every configured plugin over the same path list, reusing cached
 * discovery results when a cache control is provided and every key input
 * (plugin config, module bytes, input bytes, interpreter identity) is
 * unchanged. A cache miss runs the plugin exactly as before and stores
 * the validated result; any doubt (unreadable input, unprobeable
 * interpreter, corrupt entry) runs fresh — the cache only ever skips
 * work whose inputs are byte-identical.
 *
 * Args:
 *   plugins: plugin entries from `.gateforge.yml` (config order).
 *   paths: expanded repo-relative include paths (possibly empty).
 *   cwd: repo root; subprocess cwd and in-process module base.
 *   cache: cache control; omitted or disabled means a full scan.
 *
 * Returns:
 *   PluginRunResult: one validated contribution per plugin, the pinned
 *   registrations for the run manifest, and the cache hit/miss counts.
 *
 * Throws:
 *   UsageError (exit 2): config/usage problems — spawn failures,
 *   GPP/2 protocol violations, import failures, invalid discovery
 *   documents. A failed plugin never yields a partial contribution.
 */
export async function runPlugins(
  plugins: readonly ConfigPlugin[],
  paths: readonly string[],
  cwd: string,
  cache?: CacheControl,
): Promise<PluginRunResult> {
  const contributions: DetectorOutput[] = [];
  const registrations: PluginRegistration[] = [];
  const cacheCounts: CacheCounts = { hits: 0, misses: 0 };
  const cacheActive = cache !== undefined && !cache.disabled;
  const inputsDigest = cacheActive ? digestPathListInputs(cwd, paths) : null;
  for (const plugin of plugins) {
    const cached =
      cacheActive && inputsDigest !== null
        ? lookupPluginCache(cache.stateDir, plugin, inputsDigest, cwd, process.env)
        : null;
    if (cached !== null) {
      contributions.push(cached);
      cacheCounts.hits += 1;
    } else {
      const fresh =
        plugin.transport === 'subprocess'
          ? await runSubprocessPlugin(plugin, paths, cwd)
          : await runInProcessPlugin(plugin, paths, cwd);
      contributions.push(fresh);
      if (cacheActive) {
        cacheCounts.misses += 1;
        if (inputsDigest !== null) {
          storePluginResult(cache.stateDir, plugin, inputsDigest, cwd, process.env, fresh);
        }
      }
    }
    registrations.push({ id: plugin.id, version: plugin.version, transport: plugin.transport });
  }
  return { contributions, registrations, cache: cacheCounts };
}

/** Drives one GPP/3 subprocess plugin session over the path list. */
async function runSubprocessPlugin(
  plugin: ConfigPlugin,
  paths: readonly string[],
  cwd: string,
): Promise<DetectorOutput> {
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
    const outcome =
      paths.length > 0
        ? await session.discover(paths)
        : { resources: [], unresolved: [], findings: [], classificationSignals: [] };
    await session.shutdown();
    return {
      detectorId: plugin.id,
      detectorVersion: plugin.version,
      resources: outcome.resources,
      unresolved: outcome.unresolved,
      findings: outcome.findings,
      classificationSignals: outcome.classificationSignals,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new UsageError(`plugin '${plugin.id}' (${plugin.transport}) failed: ${error.message}`);
    }
    throw error;
  } finally {
    // Dispose is idempotent and never throws: clean shutdown leaves it a
    // no-op; any earlier failure kills the process and reaps it.
    await session.dispose();
  }
}

/**
 * The remedy for a plugin whose declared `version:` does not match the
 * detector the module reports. Copying a sibling entry's version is the
 * ordinary mistake, and the contract error alone names neither the field
 * nor the fix, so the boundary says both: the field to edit, the value
 * the detector declares, and the command that writes it.
 *
 * Args:
 *   plugin: the pinned plugin config entry.
 *   detector: the identity the signal claimed.
 *
 * Returns:
 *   string: the fix sentence (empty when the id, not the version, is
 *   what mismatched — a foreign id is never repaired by a version edit).
 */
function signalIdentityFix(
  plugin: ConfigPlugin,
  detector: { id: string; version: string },
): string {
  if (detector.id !== plugin.id) {
    return (
      `the signal claims a different detector id ('${detector.id}'), which no ` +
      `plugins[].version edit can repair — a plugin may only signal under its own id`
    );
  }
  return (
    `the signal's version ('${detector.version}') is the version the pack's detector declares, ` +
    `not the pack's npm version; fix: set version: '${detector.version}' on the ` +
    `'${plugin.id}' entry in .gateforge.yml, or run \`gateforge init --plugins ${plugin.id}\` ` +
    'to write the pin the installed pack declares'
  );
}

/** Loads and drives one in-process plugin module. */
async function runInProcessPlugin(
  plugin: ConfigPlugin,
  paths: readonly string[],
  cwd: string,
): Promise<DetectorOutput> {
  const moduleSpecifier = plugin.module;
  if (moduleSpecifier === undefined) {
    throw new UsageError(`in-process plugin '${plugin.id}' has no module (config error)`);
  }
  const resolved =
    moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')
      ? pathToFileURL(join(cwd, moduleSpecifier)).href
      : moduleSpecifier;
  let api: InProcessPluginModule;
  try {
    const loaded = (await import(resolved)) as { default?: unknown; discover?: unknown };
    api = (loaded.default ?? loaded) as InProcessPluginModule;
  } catch (error) {
    throw new UsageError(
      `in-process plugin '${plugin.id}': cannot import module '${moduleSpecifier}': ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof api !== 'object' || api === null || typeof api.discover !== 'function') {
    throw new UsageError(
      `in-process plugin '${plugin.id}': module '${moduleSpecifier}' must default-export ` +
        `{ discover(paths) } (the pinned in-process plugin contract)`,
    );
  }
  let result: {
    resources: unknown[];
    unresolved: unknown[];
    findings: unknown[];
    classificationSignals: unknown[];
    scannedPaths?: string[];
  };
  try {
    const outcome = await api.discover(paths);
    result = {
      resources: Array.isArray(outcome.resources) ? outcome.resources : [],
      unresolved: Array.isArray(outcome.unresolved) ? outcome.unresolved : [],
      findings: Array.isArray(outcome.findings) ? outcome.findings : [],
      // GPP/3 (ADR 0003 D6): mandatory on the discovery contract. A
      // pre-GPP/3 in-process plugin omitting the field stays undefined
      // here and the DetectorOutputSchema parse below fails closed with
      // an actionable migration diagnostic — never a silent default.
      classificationSignals: outcome.classificationSignals,
      // Coverage evidence (ADR 0003 D4): optional; omitted ⇒ the
      // complete-scan attestation fails closed.
      ...(Array.isArray((outcome as Record<string, unknown>)['scannedPaths'])
        ? { scannedPaths: (outcome as unknown as { scannedPaths: string[] }).scannedPaths }
        : {}),
    };
  } catch (error) {
    throw new UsageError(
      `in-process plugin '${plugin.id}' discover failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = DetectorOutputSchema.safeParse({
    detectorId: plugin.id,
    detectorVersion: plugin.version,
    ...result,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? '<document>';
    throw new UsageError(
      `in-process plugin '${plugin.id}' returned an invalid discovery result: ` +
        `${path}: ${issue?.message ?? 'unknown issue'}`,
    );
  }
  // Authority tie (ADR 0003 D6, subprocess parity): every classification
  // signal must carry the PINNED plugin identity. A plugin module that
  // claims another issuer — most critically the engine's own
  // `gateforge.core@1` suppressive authority — is forging, and forgery
  // must fail closed at the boundary with an actionable diagnostic, never
  // flow into the classifier.
  for (const signal of parsed.data.classificationSignals) {
    if (signal.detector.id !== plugin.id || signal.detector.version !== plugin.version) {
      throw new UsageError(
        `in-process plugin '${plugin.id}'@'${plugin.version}' returned a classification signal ` +
          `claiming detector ${JSON.stringify(signal.detector.id)}@` +
          `${JSON.stringify(signal.detector.version)}; signal identity must equal the pinned ` +
          `plugin identity (suppressive authority is engine-issued, never plugin-issued); ` +
          signalIdentityFix(plugin, signal.detector),
      );
    }
  }
  return parsed.data;
}