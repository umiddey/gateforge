/**
 * Effective evaluation scope for `check --changed` (plan §12.2, D4) and
 * the Phase 4 conservative expansion (plan 2026-09-13 Phase 4 item 2,
 * E15): one scope decision is computed BEFORE grading and applied
 * consistently to obligations AND blocking entries. `check` without
 * `--changed` stays all-files. `check --changed` expands to all-files
 * when the diff touches any gate-defining input, a TEST file, a file in
 * a test directory (test fixtures/helpers), the runner configuration,
 * the mapping sidecar — or, under strict E2E mode, any UNCLASSIFIED
 * changed file (a behavior change nothing can attribute is treated
 * conservatively and additionally surfaces as `CHANGE_UNMAPPED`).
 *
 * The gate-defining set reuses the Phase 6 input inventory — the same
 * `.gateforge.yml`, policy/classification paths, pack configs, adapter
 * and waiver directories, repo-local plugin modules, dependency
 * manifests, and ignore-control basenames the snapshot hashes — instead
 * of maintaining a second configuration list. Directory checks match
 * path segments, never accidental string prefixes. Deleted files are
 * still in the changed list and trigger expansion. A `.gateforge.yml`
 * change that merely points at a new policy file triggers a full check
 * on its own: the pointer change is gate-defining without reading the
 * old policy.
 *
 * Journey coverage associations (plan Phase 3 item 7) are NOT
 * implemented yet, so an unclassified change cannot be excused by a
 * journey declaration: it stays conservative + `CHANGE_UNMAPPED`
 * (documented Phase 4 deviation; Phase 5 owns the association surface).
 *
 * Docs-only exclusion (plan Phase 5 item 5): a change whose ENTIRE
 * changed set is Markdown under `docs/` is exempt from the strict-mode
 * unclassified handling (no expansion, no CHANGE_UNMAPPED). The rule is
 * deliberately narrow and ENGINE-OWNED — never candidate-configurable:
 * `docs/*.md` only, never any config/policy path (those are matched as
 * gate-defining inputs first), and a change that touches BOTH docs and
 * code is NOT docs-only — in a mixed change the docs files are unknown
 * changes like any other and stay blocking under strict E2E mode.
 */
import { spawnSync } from 'node:child_process';
import { normalizeChangedFiles } from '@gate-forge/core';
import { GIT_SCOPE_CONTROL_BASENAMES, MANIFEST_NAMES, normalizeRepoModule, PACK_CONFIGS, } from './input-snapshot.js';
/**
 * Normalizes a repo-relative config path to posix form.
 *
 * Args:
 *   path: configured path (e.g. `config.policies`).
 *
 * Returns:
 *   string: posix-normalized path without a leading `./`.
 */
function normalizeRepoPath(path) {
    const posix = path.split('\\').join('/');
    return posix.startsWith('./') ? posix.slice(2) : posix;
}
/**
 * Segment-aware directory membership: a changed file is inside a
 * gate-defining directory only on a segment boundary — `adapters2/x`
 * is NOT inside `adapters`.
 *
 * Args:
 *   file: normalized changed path.
 *   dir: normalized gate-defining directory.
 *
 * Returns:
 *   boolean: true for the dir itself or a path beneath it.
 */
function underDir(file, dir) {
    return file === dir || file.startsWith(`${dir}/`);
}
/**
 * Matches one changed file against the gate-defining inputs.
 *
 * Args:
 *   file: normalized changed path.
 *   gate: normalized gate-defining paths (config-derived, Phase 6 reuse).
 *
 * Returns:
 *   string | null: the matched input/reason, or null for source-only files.
 */
function matchGateDefiningInput(file, gate) {
    if (file === '.gateforge.yml')
        return '.gateforge.yml';
    if (file === gate.policies)
        return gate.policies;
    if (file === gate.classificationPolicy)
        return gate.classificationPolicy;
    if (file === gate.baselines)
        return gate.baselines;
    if (PACK_CONFIGS.includes(file))
        return file;
    if (underDir(file, gate.adapters))
        return gate.adapters;
    if (underDir(file, gate.waivers))
        return gate.waivers;
    for (const module of gate.pluginModules) {
        if (file === module || underDir(file, module))
            return module;
    }
    const basename = file.split('/').pop() ?? '';
    if (MANIFEST_NAMES.includes(basename))
        return file;
    if (GIT_SCOPE_CONTROL_BASENAMES.includes(basename))
        return file;
    return null;
}
/**
 * Computes one effective evaluation scope for a `--changed` run.
 *
 * Args:
 *   input: config, actual normalized diff list, and the optional Phase 4
 *     expansion inputs — catalog test files (with their directories for
 *     fixture/helper expansion), runner config file names, whether the
 *     mapping sidecar is present, the known resource source files, and
 *     whether strict E2E mode is on (unclassified changes then expand
 *     AND surface as CHANGE_UNMAPPED).
 *
 * Returns:
 *   ScopeDecision: `all` with sorted `expandedBecause` reasons when any
 *   changed file is gate-defining, test/fixture/runner-config/mapping
 *   related, or (strict mode) unclassified; otherwise the narrowed
 *   `changed` scope with `unmappedFiles` populated (strict mode only).
 */
export function computeEvaluationScope(input) {
    const changed = normalizeChangedFiles([...input.changedFiles]);
    const pluginModules = [];
    for (const plugin of input.config.plugins) {
        const module = plugin.module;
        if (typeof module !== 'string')
            continue;
        if (!module.startsWith('./') && !module.startsWith('../'))
            continue;
        const normalized = normalizeRepoModule(module);
        if (normalized !== null && normalized.length > 0)
            pluginModules.push(normalized);
    }
    const gate = {
        policies: normalizeRepoPath(input.config.policies),
        classificationPolicy: normalizeRepoPath(input.config.classificationPolicy),
        baselines: normalizeRepoPath(input.config.baselines),
        adapters: normalizeRepoPath(input.config.adapters),
        waivers: normalizeRepoPath(input.config.waivers),
        pluginModules,
    };
    // Phase 4 expansion inputs: test files + their directories (fixtures/
    // helpers live beside the tests), runner configs, and the sidecar.
    const testFiles = new Set((input.testFiles ?? []).map(normalizeRepoPath));
    const testDirs = new Set();
    for (const file of testFiles) {
        const dir = file.split('/').slice(0, -1).join('/');
        if (dir.length > 0)
            testDirs.add(dir);
    }
    const runnerConfigs = new Set((input.runnerConfigs ?? []).map(normalizeRepoPath));
    const knownSources = new Set((input.knownSourceFiles ?? []).map(normalizeRepoPath));
    const strictE2E = input.strictE2E === true;
    const reasons = new Set();
    const unmappedFiles = new Set();
    // Docs-only exemption candidates: `docs/**.md` files. The exemption
    // applies ONLY when the whole changed set is such files (checked after
    // the loop) — a mixed docs+code change is never docs-only.
    const docsOnlyFiles = new Set();
    const isDocsOnly = (file) => file.startsWith('docs/') && file.endsWith('.md');
    for (const file of changed) {
        const reason = matchGateDefiningInput(file, gate);
        if (reason !== null) {
            reasons.add(reason);
            continue;
        }
        if (input.mappingSidecar === true && file === TEST_MAP_SIDECAR) {
            reasons.add(TEST_MAP_SIDECAR);
            continue;
        }
        if (runnerConfigs.has(file)) {
            reasons.add(file);
            continue;
        }
        if (testFiles.has(file)) {
            reasons.add(`test:${file}`);
            continue;
        }
        if ([...testDirs].some((dir) => underDir(file, dir))) {
            reasons.add(`test-infra:${file.split('/').slice(0, -1).join('/')}`);
            continue;
        }
        if (knownSources.has(file))
            continue;
        if (isDocsOnly(file)) {
            docsOnlyFiles.add(file);
            continue;
        }
        // Unclassified change: nothing can attribute it. Strict E2E mode
        // treats it conservatively (full scope + CHANGE_UNMAPPED); outside
        // strict mode the historical narrowed contract is unchanged.
        if (strictE2E) {
            reasons.add(`unclassified:${file}`);
            unmappedFiles.add(file);
        }
    }
    // Mixed docs+code change: the docs files keep their unknown-change
    // treatment (the exemption is denied — candidate-controlled suppression
    // must stay impossible), so they join the unmapped set under strict mode.
    if (docsOnlyFiles.size > 0 && docsOnlyFiles.size < changed.length && strictE2E) {
        for (const file of docsOnlyFiles) {
            reasons.add(`unclassified:${file}`);
            unmappedFiles.add(file);
        }
    }
    const expandedBecause = [...reasons].sort();
    if (expandedBecause.length > 0) {
        return { mode: 'all', changedFiles: changed, expandedBecause, unmappedFiles: [...unmappedFiles].sort() };
    }
    return { mode: 'changed', changedFiles: changed, expandedBecause: [], unmappedFiles: [...unmappedFiles].sort() };
}
/** The tracked mapping sidecar path (scope-expansion trigger). */
const TEST_MAP_SIDECAR = '.gateforge/test-map.yml';
/**
 * Runs one git command for the mismatch check, returning stdout lines.
 *
 * Args:
 *   cwd: repo root.
 *   env: process environment (GIT_* threading, like the providers).
 *   args: git argument vector.
 *
 * Returns:
 *   string[] | null: normalized paths, or null when git fails.
 */
function gitNameOnly(cwd, env, args) {
    const result = spawnSync('git', [...args], { cwd, env, encoding: 'utf8' });
    if (result.error !== undefined || result.status !== 0)
        return null;
    return normalizeChangedFiles((result.stdout ?? '').split('\n').filter((line) => line.length > 0));
}
/**
 * Lists files whose staged (index) bytes differ from working-tree bytes.
 * The local-staged provider reports index-vs-HEAD, but discovery reads
 * working-tree bytes — certifying "staged" scope from worktree bytes
 * would be dishonest, so these files need an explicit blocking/usage
 * diagnostic (plan §12.3). No isolated index snapshot is evaluated in
 * this repair, and no isolated worktree is added to dodge the diagnostic.
 *
 * Args:
 *   cwd: repo root.
 *   env: process environment (GIT_* threading, like the providers).
 *
 * Returns:
 *   string[]: normalized, sorted mismatch list (empty when clean).
 */
export function detectStagedWorkingTreeMismatches(cwd, env) {
    const staged = gitNameOnly(cwd, env, ['diff', '--cached', '--name-only']);
    if (staged === null)
        return [];
    const unstaged = gitNameOnly(cwd, env, ['diff', '--name-only']);
    if (unstaged === null)
        return [];
    const unstagedSet = new Set(unstaged);
    return staged.filter((file) => unstagedSet.has(file));
}
//# sourceMappingURL=scope.js.map