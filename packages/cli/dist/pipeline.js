/**
 * The shared run pipeline: config → path expansion → plugin discovery →
 * resource graph → obligations → manifest. Every subcommand that touches
 * the engine (discover, obligations, check, test-gates) runs the same
 * pipeline so outputs agree byte-for-byte across commands.
 *
 * Staleness populations (invariant 9 / GF-06) are loaded here for every
 * run: claims from the run-state dir, adapters from the configured
 * adapters directory, waivers from the configured waivers directory
 * (judged against the injected clock). The changed-file provider is the
 * caller's choice — `all-files` for full runs, a resolved diff provider
 * for `check --changed` — and is stamped into the manifest.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { ClaimSchema, ClassificationFileSchema, PolicyFileSchema, RunManifestSchema, buildResourceGraph, compareStrings, evaluatePolicies, jsonPathFor, loadWaivers, } from '@gateforge/core';
import { UsageError } from './errors.js';
import { clockFromConfig } from './clock.js';
import { expandIncludePaths } from './glob.js';
import { runPlugins } from './plugins.js';
import { readJsonArray } from './state.js';
import { providerFor } from './providers.js';
/** Source-file map resourceId → repo-relative source (for diff scoping). */
export function sourceByResourceId(graph) {
    const map = new Map();
    for (const resource of graph.resources) {
        if (resource.id !== null)
            map.set(resource.id, resource.source);
    }
    return map;
}
/** Reads the HEAD sha of the repo in `cwd`, or null when unavailable. */
export function headSha(cwd) {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
    if (result.error !== undefined || result.status !== 0)
        return null;
    const sha = (result.stdout ?? '').trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
/** Reads a YAML document fail-closed (missing/unparsable → UsageError). */
export function loadYaml(path, label) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        const code = error.code ?? 'UNKNOWN';
        throw new UsageError(`cannot read ${label} file '${path}' (${code})`);
    }
    try {
        return parseYaml(raw);
    }
    catch (error) {
        throw new UsageError(`${label} file '${path}' is not valid YAML: ${error.message.split('\n')[0] ?? 'parse error'}`);
    }
}
/** Lists adapter names (basenames sans `.mjs`) from the adapters dir. */
export function loadAdapterNames(cwd, dir) {
    const absolute = resolveRepoPath(cwd, dir);
    let entries;
    try {
        entries = readdirSync(absolute);
    }
    catch {
        return []; // no adapters directory: nothing to watch
    }
    return entries
        .filter((entry) => entry.endsWith('.mjs'))
        .map((entry) => entry.slice(0, -'.mjs'.length))
        .sort(compareStrings);
}
/** Resolves a repo-root-relative config path against the cwd. */
export function resolveRepoPath(cwd, repoRelative) {
    const normalized = repoRelative.split('\\').join('/');
    if (normalized.startsWith('/')) {
        throw new UsageError(`config path '${repoRelative}' must be repo-root-relative, not absolute`);
    }
    return join(cwd, ...normalized.split('/'));
}
/** First zod issue as one actionable `path: message` line. */
function firstIssueText(error, fallback) {
    const issue = error.issues?.[0];
    return issue === undefined ? fallback : `${jsonPathFor(issue.path)}: ${issue.message}`;
}
/**
 * Runs the full pipeline.
 *
 * Args:
 *   options: cwd, env, validated config, provider identity, state dir.
 *
 * Returns:
 *   PipelineResult: contributions, graph, policy result, manifest, the
 *   injected run instant, and changed files.
 *
 * Throws:
 *   UsageError (exit 2): fail-closed problems — plugin failures, missing
 *   policy/classification documents, invalid policy documents, or an
 *   unreadable git state for the chosen provider.
 */
export async function runPipeline(options) {
    const { cwd, env, config, provider, stateDir } = options;
    const clock = clockFromConfig(config);
    const paths = expandIncludePaths(config.project.paths.include, config.project.paths.exclude, cwd);
    const { contributions, registrations } = await runPlugins(config.plugins, paths, cwd);
    const classificationsRaw = loadYaml(resolveRepoPath(cwd, config.classifications), 'classifications');
    const classificationsParsed = ClassificationFileSchema.safeParse(classificationsRaw);
    if (!classificationsParsed.success) {
        throw new UsageError(`classifications document is invalid: ${firstIssueText(classificationsParsed.error, 'unknown issue')}`);
    }
    const policiesRaw = loadYaml(resolveRepoPath(cwd, config.policies), 'policies');
    const policiesParsed = PolicyFileSchema.safeParse(policiesRaw);
    if (!policiesParsed.success) {
        throw new UsageError(`policies document is invalid: ${firstIssueText(policiesParsed.error, 'unknown issue')}`);
    }
    // Claims reach graph and policy engines as validated documents (the
    // verdict engine re-reads the raw state itself and stays lenient —
    // GF-23 degraded records belong there, not in the policy layer).
    const claimsRaw = readJsonArray(stateDir, 'claims.json');
    const claims = claimsRaw.filter((entry) => ClaimSchema.safeParse(entry).success);
    const adapters = loadAdapterNames(cwd, config.adapters);
    const waiverLoad = loadWaivers(resolveRepoPath(cwd, config.waivers), { now: clock.now() });
    const graph = buildResourceGraph({
        detectors: contributions,
        classifications: classificationsParsed.data,
        claims,
        adapters,
        waivers: waiverLoad.waivers,
    });
    const policy = evaluatePolicies({
        graph,
        policies: policiesParsed.data,
        claims,
    });
    const now = clock.now();
    const changedFiles = providerFor(provider, cwd, env).changedFiles();
    const manifest = RunManifestSchema.parse({
        schemaVersion: 1,
        runId: options.runId ?? randomUUID(),
        startedAt: now,
        gitSha: headSha(cwd),
        provider,
        plugins: registrations,
        attestationScope: null,
    });
    return { contributions, graph, policy, manifest, now, changedFiles };
}
//# sourceMappingURL=pipeline.js.map