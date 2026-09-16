/**
 * `gateforge tests`: the existing-test workflow (plan 2026-09-13
 * Phase 2-3, Phase 4 diagnose). Five subcommands:
 *
 * - `discover` — inventory the repository's tests into the derived
 *   run-state catalog (Phase 2).
 * - `suggest` — resolve mappings for the run's obligations and produce
 *   reuse-ordered suggestions with typed causes (TEST_MAPPING_MISSING /
 *   TEST_KIND_UNKNOWN / TEST_MAPPING_AMBIGUOUS / TEST_MAPPING_STALE).
 *   An inspection surface, NOT a gate: exit 0 even with blocking mapping
 *   problems.
 * - `mark` — validate a declaration against the CURRENT catalog and
 *   obligation registry, then write/update `.gateforge/test-map.yml`
 *   ATOMICALLY and idempotently, printing the exact diff. Never edits
 *   test files, never adds waivers, refuses contradictions.
 * - `explain` — the per-test §4 report: requirements, existing-test
 *   identity, mapping origin, honest execution status, next action, and
 *   `New test needed`. Exit 2 for an unknown key.
 * - `diagnose` — the §3.5 advisory alarm (Phase 4): runs the CONFIGURED
 *   pytest diagnostic suites once per suite, isolated (own process,
 *   GATEFORGE_* stripped, finite timeout, junit XML in excluded run
 *   state), and prints/serializes a SEPARATE diagnostic report. Exit
 *   codes: 0 completed run with ≥1 passing test and no unexpected
 *   failures; 1 test failures; 2 unavailable/incomplete (collection
 *   error, timeout, missing interpreter, interruption, zero tests, or
 *   only skipped/xfail). Diagnostic results are never fed into claims,
 *   witness records, baselines, waivers, or E2E satisfaction.
 *
 * All subcommands accept `--json` for machine-readable output and print
 * deterministic human text otherwise. Exit codes follow the repo
 * contract: 0 ok, 2 config/usage errors (including unknown keys/ids and
 * failed native enumeration).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, compareStrings, mappingSuggestions, TestKindSchema, } from '@gateforge/core';
import { discoverTestCatalog, TestDiscoveryError } from '@gateforge/pack-playwright';
import { parseArgs, stringFlag } from '../args.js';
import { diagnosticsJson, renderDiagnosticsText, runDiagnosticSuites } from '../diagnostics.js';
import { UsageError } from '../errors.js';
import { writeLine } from '../io.js';
import { collectInputFiles, computeInputSnapshot, diffInputFiles, SnapshotUnavailableError, UnsupportedSnapshotError, } from '../input-snapshot.js';
import { diffLines, loadOptionalTestMap, relativeToRepo, resolveRepositoryMappings, serializeTestMap, TEST_MAP_RELATIVE, writeTestMapAtomic, } from '../mapping.js';
import { runPipeline, sourcesByResourceId } from '../pipeline.js';
import { resolveProvider } from '../providers.js';
import { httpRoutesView, resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
export const TESTS_USAGE = `\
usage: gateforge tests discover [--json] [--pytest]
       gateforge tests suggest [--changed] [--json]
       gateforge tests mark --test <key> --kind <kind> [--category <c>]... \\
         --obligation <id>... --reason "<text>"
       gateforge tests explain --test <key> [--json]
       gateforge tests diagnose [--suite <name>] [--json]`;
/** The derived catalog file under the run-state directory. */
export const CATALOG_FILE_NAME = 'test-catalog.json';
/**
 * Runs the `tests` command family (discover/suggest/mark/explain).
 *
 * Args:
 *   io: process context.
 *   argv: flags + positionals after the `tests` subcommand.
 *
 * Returns:
 *   number: exit code — 0 on success (unresolved catalog rows and
 *     blocking mapping problems are DATA on the inspection surfaces),
 *     2 for config/usage errors.
 * @throws UsageError for unknown subcommands/flags, unknown test keys or
 *   obligation ids, contradictory declarations, and failed native
 *   enumeration; config errors propagate from core (all exit 2).
 */
export async function testsCommand(io, argv) {
    const { options, positionals } = parseArgs(argv);
    const subcommand = positionals[0];
    if (subcommand === undefined || options['help'] === true) {
        writeLine(io.stdout, TESTS_USAGE);
        return subcommand === undefined && options['help'] !== true ? 2 : 0;
    }
    switch (subcommand) {
        case 'discover':
            return discoverSubcommand(io, options);
        case 'suggest':
            return suggestSubcommand(io, options);
        case 'mark':
            return markSubcommand(io, options);
        case 'explain':
            return explainSubcommand(io, options);
        case 'diagnose':
            return diagnoseSubcommand(io, options);
        default:
            throw new UsageError(`unknown tests subcommand '${subcommand}' (${TESTS_USAGE.split('\n')[0] ?? TESTS_USAGE})`);
    }
}
/** Runs one discovery pass and persists the derived catalog artifact. */
async function runDiscovery(cwd, config, stateDir, collectPytest) {
    let discovered;
    try {
        discovered = await discoverTestCatalog({ cwd, config, collectPytest });
    }
    catch (error) {
        // A failed native enumeration is a config/environment problem
        // (exit 2), never an empty catalog.
        if (error instanceof TestDiscoveryError)
            throw new UsageError(error.message);
        throw error;
    }
    // The catalog is a DERIVED artifact: it lives under the run-state dir
    // (excluded from tracked inputs), never beside the tests it inventories.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, CATALOG_FILE_NAME), `${discovered.json}\n`, 'utf8');
    return discovered;
}
// ---------------------------------------------------------------------------
// tests discover (Phase 2 surface, unchanged behavior)
// ---------------------------------------------------------------------------
/** Implements `tests discover`. */
async function discoverSubcommand(io, options) {
    rejectUnknownFlags(options, ['json', 'pytest', 'help'], TESTS_USAGE);
    const asJson = options['json'] === true;
    const config = loadConfigAt(io.cwd);
    const stateDir = resolveStateDir(io.cwd);
    const { catalog, json } = await runDiscovery(io.cwd, config, stateDir, options['pytest'] === true);
    if (asJson) {
        writeLine(io.stdout, json);
        return 0;
    }
    const discovered = catalog.entries.filter((entry) => entry.discoveryStatus === 'discovered').length;
    writeLine(io.stdout, `test catalog: discovered=${String(discovered)}` +
        ` unresolved=${String(catalog.unresolved.length)}` +
        ` parseErrors=${String(catalog.parseErrors.length)}` +
        ` inventoryComplete=${catalog.inventoryComplete ? 'true' : 'false'}`);
    const histogram = new Map();
    for (const entry of catalog.entries) {
        histogram.set(entry.inferredKind, (histogram.get(entry.inferredKind) ?? 0) + 1);
    }
    const kinds = [...histogram.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    writeLine(io.stdout, `kinds: ${kinds.map(([kind, count]) => `${kind}=${String(count)}`).join(', ') || '(none)'}`);
    for (const summary of catalog.runnerSummaries) {
        writeLine(io.stdout, `runner ${summary.runner}/${summary.name}: ${summary.status} — ${summary.detail}`);
    }
    if (catalog.unresolved.length > 0) {
        writeLine(io.stdout, `unresolved (${String(catalog.unresolved.length)}):`);
        for (const gap of catalog.unresolved) {
            writeLine(io.stdout, `  [${gap.code}] ${gap.location.file}:${String(gap.location.line)} — ${gap.detail}`);
        }
    }
    if (catalog.parseErrors.length > 0) {
        writeLine(io.stdout, `parse errors (${String(catalog.parseErrors.length)}):`);
        for (const parseError of catalog.parseErrors) {
            writeLine(io.stdout, `  ${parseError.location.file}:${String(parseError.location.line)} — ${parseError.message}`);
        }
    }
    writeLine(io.stdout, `catalog written: ${join(stateDir, CATALOG_FILE_NAME)}`);
    return 0;
}
/** Implements `tests suggest [--changed]`. */
async function suggestSubcommand(io, options) {
    rejectUnknownFlags(options, ['changed', 'json', 'help'], TESTS_USAGE);
    const asJson = options['json'] === true;
    const diffScoped = options['changed'] === true;
    const config = loadConfigAt(io.cwd);
    const stateDir = resolveStateDir(io.cwd);
    // The same pipeline every gate command runs: obligations come from the
    // policy engine (the registry the resolver validates against), and the
    // join-aware source map powers the `--changed` obligation filter.
    const provider = diffScoped ? resolveProvider(config.changed.provider, io.cwd, io.env).provider : 'all-files';
    const pipeline = await runPipeline({ cwd: io.cwd, env: io.env, config, provider, stateDir });
    const discovered = await runDiscovery(io.cwd, config, stateDir, true);
    const mapped = await resolveRepositoryMappings({
        cwd: io.cwd,
        config,
        stateDir,
        obligations: pipeline.policy.obligations,
        catalog: discovered.catalog,
    });
    // `--changed` narrows the SUGGESTED obligations to the changed scope
    // with the existing join-aware rule (resource source + call sources).
    // It never hides resolution problems for out-of-scope obligations at
    // the gate (that is check's job); this surface only orders work.
    let scoped = pipeline.policy.obligations;
    let scopeMode = 'all';
    if (diffScoped) {
        scopeMode = 'changed';
        const changedSet = new Set(pipeline.changedFiles);
        const sources = sourcesByResourceId(pipeline.graph);
        scoped = pipeline.policy.obligations.filter((obligation) => (sources.get(obligation.resourceId) ?? []).some((source) => changedSet.has(source)));
    }
    const suggestions = mappingSuggestions({
        catalog: discovered.catalog,
        obligationIds: scoped.map((obligation) => obligation.id),
        resolution: mapped.resolution,
    });
    const suggestionJson = suggestions.map((suggestion) => ({
        obligationId: suggestion.obligationId,
        cause: suggestion.cause,
        candidates: suggestion.candidates.map((candidate) => ({
            logicalKey: candidate.logicalKey,
            file: candidate.file,
            why: [...candidate.why],
        })),
        missingEvidence: suggestion.missingEvidence,
        nextAction: suggestion.nextAction,
        newTestNeeded: suggestion.newTestNeeded,
    }));
    if (asJson) {
        writeLine(io.stdout, canonicalJson({
            schemaVersion: 1,
            scope: {
                mode: scopeMode,
                changedFiles: [...pipeline.changedFiles].sort(compareStrings),
                obligationsInScope: scoped.length,
            },
            problems: mapped.resolution.problems,
            suggestions: suggestionJson,
        }));
        return 0;
    }
    writeLine(io.stdout, `suggest: ${String(pipeline.policy.obligations.length)} obligation(s) considered` +
        ` (${String(scoped.length)} in ${scopeMode} scope),` +
        ` ${String(mapped.resolution.problems.length)} mapping problem(s),` +
        ` ${String(suggestions.length)} suggestion(s)`);
    for (const problem of mapped.resolution.problems) {
        const where = problem.obligationId === null ? '' : ` for '${problem.obligationId}'`;
        writeLine(io.stdout, `problem [${problem.cause}]${where}: ${problem.detail}`);
    }
    for (const suggestion of suggestions) {
        writeLine(io.stdout, `[${suggestion.cause}] ${suggestion.obligationId}`);
        writeLine(io.stdout, `  missing evidence: ${suggestion.missingEvidence}`);
        writeLine(io.stdout, `  next action: ${suggestion.nextAction}`);
        writeLine(io.stdout, `  new test needed: ${suggestion.newTestNeeded ? 'yes' : 'no'}`);
        if (suggestion.candidates.length > 0) {
            writeLine(io.stdout, '  candidates:');
            for (const candidate of suggestion.candidates) {
                writeLine(io.stdout, `  - ${candidate.logicalKey} (${candidate.file})`);
                for (const why of candidate.why) {
                    writeLine(io.stdout, `    why: ${why}`);
                }
            }
        }
    }
    return 0;
}
// ---------------------------------------------------------------------------
// tests mark (Phase 3)
// ---------------------------------------------------------------------------
/** Implements `tests mark --test … --kind … --obligation … --reason …`. */
async function markSubcommand(io, options) {
    rejectUnknownFlags(options, ['test', 'kind', 'category', 'obligation', 'reason', 'json', 'help'], TESTS_USAGE);
    const asJson = options['json'] === true;
    const testKey = stringFlag(options, 'test');
    const kind = stringFlag(options, 'kind');
    const reason = stringFlag(options, 'reason');
    const categories = flagArray(options, 'category');
    const obligationIds = flagArray(options, 'obligation');
    if (testKey === undefined ||
        kind === undefined ||
        reason === undefined ||
        obligationIds.length === 0) {
        writeLine(io.stderr, MARK_USAGE_LINE);
        throw new UsageError('tests mark requires --test <key>, --kind <kind>, at least one --obligation <id>, and --reason "<text>"');
    }
    const validatedKind = validateKind(kind);
    const config = loadConfigAt(io.cwd);
    const stateDir = resolveStateDir(io.cwd);
    // Validate against the CURRENT catalog and obligation registry (plan
    // §5.3): a declaration pointing outside either fails with a precise
    // error before any byte is written.
    const pipeline = await runPipeline({
        cwd: io.cwd,
        env: io.env,
        config,
        provider: 'all-files',
        stateDir,
    });
    const registry = new Set(pipeline.policy.obligations.map((obligation) => obligation.id));
    const unknownObligations = obligationIds.filter((id) => !registry.has(id));
    if (unknownObligations.length > 0) {
        throw new UsageError(`unknown obligation id '${unknownObligations[0]}' — not generated by the current policies ` +
            `(run gateforge obligations --json for the registry)`);
    }
    const discovered = await runDiscovery(io.cwd, config, stateDir, true);
    const entry = discovered.catalog.entries.find((candidate) => candidate.logicalKey === testKey);
    if (entry === undefined) {
        throw new UsageError(`unknown test key '${testKey}' — not in the discovered catalog ` +
            `(${String(discovered.catalog.entries.length)} entries; run gateforge tests discover --json)`);
    }
    assertKindDeclarationAllowed(entry, validatedKind, testKey);
    const newEntry = {
        key: testKey,
        selector: {
            runner: entry.runner,
            ...(entry.project !== null ? { project: entry.project } : {}),
            file: entry.file,
            titlePath: [...entry.titlePath],
        },
        kind: validatedKind,
        ...(categories.length > 0 ? { categories: [...new Set(categories)].sort(compareStrings) } : {}),
        claims: [...new Set(obligationIds)].sort(compareStrings),
        reason,
    };
    const previousMap = loadOptionalTestMap(io.cwd) ?? { schemaVersion: 1, tests: [] };
    const tests = previousMap.tests.filter((existing) => existing.key !== testKey);
    tests.push(newEntry);
    tests.sort((a, b) => compareStrings(a.key, b.key));
    const nextMap = { schemaVersion: 1, tests };
    const previousContent = serializeTestMap(previousMap);
    const nextContent = serializeTestMap(nextMap);
    const path = relativeToRepo(io.cwd, join(io.cwd, TEST_MAP_RELATIVE));
    if (previousContent === nextContent) {
        // Idempotency (plan §5.3): re-running mark produces NO change — not
        // even a rewritten file.
        if (asJson) {
            writeLine(io.stdout, canonicalJson({ schemaVersion: 1, path, changed: false, entry: newEntry }));
        }
        else {
            writeLine(io.stdout, `mark: no changes — '${testKey}' is already declared exactly so in ${path}`);
        }
        return 0;
    }
    writeTestMapAtomic(io.cwd, nextMap);
    const diff = diffLines(previousContent, nextContent);
    if (asJson) {
        writeLine(io.stdout, canonicalJson({
            schemaVersion: 1,
            path,
            changed: true,
            diff,
            entry: newEntry,
        }));
    }
    else {
        writeLine(io.stdout, `mark: wrote ${path} (existing tests untouched; a declaration is intent, not proof)`);
        writeLine(io.stdout, `--- ${previousMap.tests.length === 0 ? '/dev/null' : path}`);
        writeLine(io.stdout, `+++ ${path}`);
        for (const line of diff) {
            writeLine(io.stdout, line);
        }
    }
    return 0;
}
const MARK_USAGE_LINE = 'usage: gateforge tests mark --test <key> --kind <kind> [--category <c>]... --obligation <id>... --reason "<text>"';
/** Reads a repeated flag as a string array (single value → one element). */
function flagArray(options, name) {
    const value = options[name];
    if (value === undefined)
        return [];
    if (typeof value === 'string')
        return [value];
    if (Array.isArray(value))
        return value.filter((entry) => typeof entry === 'string');
    return [];
}
/** Validates `--kind` against the supported TestKind vocabulary. */
function validateKind(kind) {
    const parsed = TestKindSchema.safeParse(kind);
    if (!parsed.success) {
        throw new UsageError(`--kind must be one of: browser-e2e, api-e2e, unit, integration, component, unknown (got '${kind}')`);
    }
    return parsed.data;
}
/**
 * Refuses declarations that contradict the CURRENT catalog evidence
 * (plan §5.3): an explicit kind may resolve `unknown`, but cannot
 * override observed mocking or a strong code-signal classification.
 * Both locations land in the error (exit 2, nothing written).
 */
function assertKindDeclarationAllowed(entry, kind, key) {
    const mock = entry.suppressionSignals.find((signal) => signal.kind === 'mock');
    if (mock !== undefined && (kind === 'browser-e2e' || kind === 'api-e2e')) {
        throw new UsageError(`cannot mark '${key}' as '${kind}': the catalog observed mocking (${mock.detail}) at ` +
            `${mock.location.file}:${String(mock.location.line)} — an explicit kind cannot override observed mocking (§5.3)`);
    }
    const strong = entry.kindSignals[0];
    if (entry.inferredKind !== 'unknown' &&
        entry.kindSignals.length > 0 &&
        kind !== entry.inferredKind) {
        throw new UsageError(`cannot mark '${key}' as '${kind}': inference resolved '${entry.inferredKind}' from strong code ` +
            `signals (${strong?.ruleId ?? 'unknown'} at ${strong?.location.file ?? entry.file}:` +
            `${String(strong?.location.line ?? entry.sourceLocation.line)}) — correct the declaration or the classification`);
    }
}
// ---------------------------------------------------------------------------
// tests explain (Phase 3)
// ---------------------------------------------------------------------------
/** Implements `tests explain --test <key>`. */
async function explainSubcommand(io, options) {
    rejectUnknownFlags(options, ['test', 'json', 'help'], TESTS_USAGE);
    const asJson = options['json'] === true;
    const testKey = stringFlag(options, 'test');
    if (testKey === undefined) {
        writeLine(io.stderr, 'usage: gateforge tests explain --test <key> [--json]');
        throw new UsageError('tests explain requires --test <key>');
    }
    const config = loadConfigAt(io.cwd);
    const stateDir = resolveStateDir(io.cwd);
    const pipeline = await runPipeline({
        cwd: io.cwd,
        env: io.env,
        config,
        provider: 'all-files',
        stateDir,
    });
    const discovered = await runDiscovery(io.cwd, config, stateDir, true);
    const mapped = await resolveRepositoryMappings({
        cwd: io.cwd,
        config,
        stateDir,
        obligations: pipeline.policy.obligations,
        catalog: discovered.catalog,
    });
    const entry = discovered.catalog.entries.find((candidate) => candidate.logicalKey === testKey);
    if (entry === undefined) {
        // Exit 2 for an unknown key (usage/config error, not a gate result).
        throw new UsageError(`unknown test key '${testKey}' — not in the discovered catalog ` +
            `(${String(discovered.catalog.entries.length)} entries; run gateforge tests discover --json)`);
    }
    const report = explainReport(testKey, entry, mapped, pipeline.policy.obligations);
    if (asJson) {
        writeLine(io.stdout, canonicalJson(report));
        return 0;
    }
    for (const block of report.blocks) {
        writeLine(io.stdout, `Requirement: ${block.requirement}`);
        writeLine(io.stdout, `Existing test: ${report.existingTest.key} (${report.existingTest.file})`);
        writeLine(io.stdout, `Mapping: ${block.mapping}`);
        writeLine(io.stdout, `Execution: ${report.execution}`);
        writeLine(io.stdout, `Next action: ${block.nextAction}`);
        writeLine(io.stdout, `New test needed: ${block.newTestNeeded}`);
        if (block !== report.blocks[report.blocks.length - 1])
            writeLine(io.stdout, '');
    }
    return 0;
}
/**
 * Assembles the explain report for one test (pure; deterministic).
 * Joins: sidecar entries by key, native annotations by test file (the
 * reporter's testId is runner-internal), resolution bindings by key.
 */
function explainReport(testKey, entry, mapped, obligations) {
    const registry = new Set(obligations.map((obligation) => obligation.id));
    const sidecarEntry = mapped.sidecar?.tests.find((candidate) => candidate.key === testKey) ?? null;
    const nativeClaims = mapped.nativeClaims.filter((claim) => claim.testFile === entry.file);
    const bindings = mapped.resolution.obligations.flatMap((obligation) => obligation.bindings
        .filter((binding) => binding.logicalKey === testKey)
        .map((binding) => ({ obligationId: obligation.obligationId, binding })));
    const obligationIds = [
        ...new Set([
            ...(sidecarEntry?.claims ?? []),
            ...nativeClaims.map((claim) => claim.obligationId),
            ...bindings.map((entry_) => entry_.obligationId),
        ]),
    ].sort(compareStrings);
    // `new test needed` comes from the resolver's own suggestion rule for
    // each obligation (candidates empty after resolution ⇒ true).
    const suggestions = new Map(mappingSuggestions({
        catalog: mapped.catalog,
        obligationIds: obligationIds.filter((id) => registry.has(id)),
        resolution: mapped.resolution,
    }).map((suggestion) => [suggestion.obligationId, suggestion]));
    const blocks = obligationIds.map((obligationId) => {
        const sidecarDeclares = sidecarEntry?.claims.includes(obligationId) === true;
        const nativeDeclares = nativeClaims.some((claim) => claim.obligationId === obligationId);
        const binding = bindings.find((candidate) => candidate.obligationId === obligationId)?.binding ?? null;
        const inRegistry = registry.has(obligationId);
        let mapping;
        let nextAction;
        if (sidecarDeclares) {
            mapping = 'declared by agent (test-map.yml)';
            nextAction =
                'run the existing test with the browser observer; its witnessed evidence must cover this change (execution and sealing land in Phase 4)';
        }
        else if (nativeDeclares) {
            mapping = 'declared by native annotation';
            nextAction =
                'run the existing test with the browser observer; its witnessed evidence must cover this change (execution and sealing land in Phase 4)';
        }
        else if (binding?.origin === 'prior-run') {
            mapping = 'prior run (suggestion only — never satisfies a new run)';
            nextAction = 'confirm the link with tests mark if correct; then run the test with the browser observer';
        }
        else if (binding?.origin === 'inferred') {
            mapping = 'inferred (suggestion only — never auto-declared)';
            nextAction = 'confirm the inference with tests mark if correct; then run the test with the browser observer';
        }
        else {
            mapping = 'unmapped';
            nextAction = inRegistry
                ? 'run tests suggest to find candidate existing tests; mark the test if it covers this obligation'
                : 'correct the claim — the obligation id is not in the current registry';
        }
        const suggestionNewTest = suggestions.get(obligationId)?.newTestNeeded === true;
        const newTestNeeded = !inRegistry
            ? 'unknown (the obligation id is not in the current registry)'
            : sidecarDeclares || nativeDeclares
                ? 'no'
                : suggestionNewTest
                    ? 'yes'
                    : 'no';
        return {
            requirement: inRegistry ? obligationId : `${obligationId} (not in the current registry)`,
            mapping,
            nextAction,
            newTestNeeded,
        };
    });
    if (blocks.length === 0) {
        blocks.push({
            requirement: '(none — no obligation involves this test)',
            mapping: 'unmapped',
            nextAction: 'run tests suggest to see which obligations need coverage and which existing tests could provide it',
            newTestNeeded: 'unknown (no obligation involves this test)',
        });
    }
    return {
        schemaVersion: 1,
        existingTest: {
            key: testKey,
            file: entry.file,
            titlePath: [...entry.titlePath],
            inferredKind: entry.inferredKind,
        },
        execution: 'not run for this change (execution and evidence sealing land in Phase 4)',
        blocks,
    };
}
// ---------------------------------------------------------------------------
// tests diagnose (Phase 4, §3.5)
// ---------------------------------------------------------------------------
/** Implements `tests diagnose [--suite <name>] [--json]`. */
async function diagnoseSubcommand(io, options) {
    rejectUnknownFlags(options, ['suite', 'json', 'help'], TESTS_USAGE);
    const asJson = options['json'] === true;
    const suiteName = stringFlag(options, 'suite');
    const config = loadConfigAt(io.cwd);
    const stateDir = resolveStateDir(io.cwd);
    // The alarm runs WITHOUT a browser or witness (§3.5), but it still
    // binds results to the current input identity: the same pipeline +
    // snapshot every gate command runs, with the same drift discipline.
    let preFiles = null;
    let snapshotUnavailable = false;
    try {
        preFiles = collectInputFiles(io.cwd, config, stateDir);
    }
    catch (error) {
        if (error instanceof SnapshotUnavailableError) {
            snapshotUnavailable = true;
        }
        else if (error instanceof UnsupportedSnapshotError) {
            throw new UsageError(`unsupported input snapshot: ${error.message}`);
        }
        else {
            throw error;
        }
    }
    const pipeline = await runPipeline({
        cwd: io.cwd,
        env: io.env,
        config,
        provider: 'all-files',
        stateDir,
    });
    let inputDigest = null;
    if (!snapshotUnavailable) {
        const postDiscovery = collectInputFiles(io.cwd, config, stateDir);
        const drift = preFiles === null ? [] : diffInputFiles(preFiles, postDiscovery);
        if (drift.length > 0) {
            throw new UsageError(`input tree changed around discovery (${drift.slice(0, 3).join('; ')}); no reliable input identity — refusing the diagnostic run`);
        }
        inputDigest = computeInputSnapshot({
            cwd: io.cwd,
            config,
            stateDir,
            classifications: pipeline.classificationsView.resources,
            obligations: pipeline.policy.obligations,
            httpRoutes: httpRoutesView(pipeline.graph),
            plugins: pipeline.manifest.plugins.map((plugin) => ({ id: plugin.id, version: plugin.version })),
        }).inputDigest;
    }
    const run = await runDiagnosticSuites({
        config,
        cwd: io.cwd,
        stateDir,
        inputDigest,
        ...(suiteName !== undefined ? { suiteName } : {}),
        now: pipeline.now,
    });
    if (asJson) {
        writeLine(io.stdout, diagnosticsJson(run, inputDigest));
    }
    else {
        renderDiagnosticsText(io, run, inputDigest);
    }
    return run.exitCode;
}
//# sourceMappingURL=tests.js.map