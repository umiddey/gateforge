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
import { normalizeChangedFiles, type GateforgeConfig } from '@gate-forge/core';
import picomatch from 'picomatch';
import { GATEFORGE_TEST_MAP_PATH } from './gateforge-owned.js';
import {
  GIT_SCOPE_CONTROL_BASENAMES,
  MANIFEST_NAMES,
  normalizeRepoModule,
  PACK_CONFIGS,
} from './input-snapshot.js';

/** One effective evaluation scope, decided before grading. */
export interface ScopeDecision {
  /** `all` = evaluate every obligation and blocker; `changed` = diff-narrowed. */
  mode: 'all' | 'changed';
  /** Actual normalized diff list from the provider (kept for reporting). */
  changedFiles: string[];
  /** Sorted matched gate-defining inputs/reasons that forced expansion. */
  expandedBecause: string[];
  /**
   * Phase 4 (E15, strict E2E mode only): changed source files no
   * detector/resource join can attribute AND no mapping covers — each
   * becomes a `CHANGE_UNMAPPED` blocking entry in the caller. Empty in
   * non-strict mode (the historical contract is unchanged there).
   */
  unmappedFiles: string[];
  /**
   * 0.9.0 D2: the Gateforge-owned policy inputs in the changed set (see
   * `gateforge-owned.ts`). They are reported here for visibility and are
   * never part of `unmappedFiles`.
   */
  policyInputs: string[];
  /**
   * 0.9.0 D2: true when the WHOLE changed set is Gateforge-owned policy
   * input. Such a change cannot alter product behavior, so the caller keeps
   * the adopted baseline's forgiveness instead of dragging adopted E2E
   * obligations into a strict re-grade. False as soon as one product, test,
   * runner-config, manifest or ignore-control file is in the set.
   */
  policyInputsOnly: boolean;
  /**
   * 0.10.2: true when EVERY changed file is attributed to a
   * product-behaviour-neutral kind — a Gateforge-owned policy input, a
   * gate-defining input (manifest, lockfile, ignore control, pack config,
   * policy document, adapter/waiver record, plugin module), the mapping
   * sidecar, a runner configuration, a runtime-declared input, a catalog
   * test file, a file the catalog's own tests import (test
   * infrastructure), or a `docs/**.md` file — and NO product resource
   * source is in the set. Such a change set cannot alter product
   * behaviour; `check` uses it, together with the adoption-commit
   * verdict, to decide that the adopted baseline survives the strict-E2E
   * re-grade on the commit that wires the gate. False as soon as one
   * file is unclassified or is a discovered resource's source.
   */
  productBehaviorNeutral: boolean;
  /**
   * 0.10.2: true when the WHOLE changed set is Markdown under `docs/`
   * (`docs/**.md`) — the engine-owned docs-only exemption, decided in
   * the SAME loop that attributes each file so it can never disagree
   * with the attribution it reads. False as soon as one non-docs file
   * is in the set (a mixed change is never docs-only) and false for an
   * empty change set.
   *
   * This is the one decision that also reaches EVIDENCE: a docs-only
   * slice can seal a receipt over zero records, because no obligation
   * can arise from a Markdown file. Nothing about the docs-exclude
   * mechanism is involved, and nothing here relaxes a product change.
   */
  docsOnly: boolean;
}

/**
 * Normalizes a repo-relative config path to posix form.
 *
 * Args:
 *   path: configured path (e.g. `config.policies`).
 *
 * Returns:
 *   string: posix-normalized path without a leading `./`.
 */
function normalizeRepoPath(path: string): string {
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
function underDir(file: string, dir: string): boolean {
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
function matchGateDefiningInput(
  file: string,
  gate: {
    policies: string;
    classificationPolicy: string;
    baselines: string;
    behaviorPolicy: string | null;
    adapters: string;
    waivers: string;
    pluginModules: readonly string[];
  },
): string | null {
  if (file === '.gateforge.yml') return '.gateforge.yml';
  if (file === gate.policies) return gate.policies;
  if (file === gate.classificationPolicy) return gate.classificationPolicy;
  if (file === gate.baselines) return gate.baselines;
  if (gate.behaviorPolicy !== null && file === gate.behaviorPolicy) return gate.behaviorPolicy;
  if (PACK_CONFIGS.includes(file)) return file;
  if (underDir(file, gate.adapters)) return gate.adapters;
  if (underDir(file, gate.waivers)) return gate.waivers;
  for (const module of gate.pluginModules) {
    if (file === module || underDir(file, module)) return module;
  }
  const basename = file.split('/').pop() ?? '';
  if (MANIFEST_NAMES.includes(basename)) return file;
  if (GIT_SCOPE_CONTROL_BASENAMES.includes(basename)) return file;
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
export function computeEvaluationScope(input: {
  config: GateforgeConfig;
  changedFiles: readonly string[];
  testFiles?: readonly string[];
  runnerConfigs?: readonly string[];
  mappingSidecar?: boolean;
  knownSourceFiles?: readonly string[];
  strictE2E?: boolean;
  /**
   * Files the suite's own catalog tests load by relative import
   * (`tests/e2e/support/**`, `tests/e2e/fixtures/**`, any shared helper
   * module) — the IMPORT GRAPH, not a folder name, so a random
   * `support/` nothing imports gets no pass. They expand the scope like
   * the tests that import them.
   */
  testInfrastructureFiles?: readonly string[];
  /**
   * Repository files the staged runtime document NAMES as a command
   * argument or an env file (a `scripts/e2e/*` runner, a compose
   * override, an `.env` it loads). They can change what runs, so they
   * are gate-defining and expand the scope.
   */
  runtimeInputs?: readonly string[];
  /**
   * Changed paths that this change DELETED and that no configured
   * runner's own test-file selection ever claimed. A deletion cannot
   * introduce behaviour, and a file no runner collects is not a test
   * file, so neither expands the scope nor becomes unmapped. A deletion
   * of a file a runner DOES collect keeps every other rule.
   */
  removedUnclaimedFiles?: readonly string[];
  /**
   * 0.9.0 D2: the changed paths already classified as Gateforge-owned policy
   * inputs by the caller (it owns the candidate checkout, this module stays
   * pure). They are never unmapped and they never expand the scope.
   */
  policyInputs?: readonly string[];
}): ScopeDecision {
  const changed = normalizeChangedFiles([...input.changedFiles]);
  const pluginModules: string[] = [];
  for (const plugin of input.config.plugins) {
    const module = plugin.module;
    if (typeof module !== 'string') continue;
    if (!module.startsWith('./') && !module.startsWith('../')) continue;
    const normalized = normalizeRepoModule(module);
    if (normalized !== null && normalized.length > 0) pluginModules.push(normalized);
  }
  const gate = {
    policies: normalizeRepoPath(input.config.policies),
    classificationPolicy: normalizeRepoPath(input.config.classificationPolicy),
    baselines: normalizeRepoPath(input.config.baselines),
    behaviorPolicy: input.config.behaviorPolicy === undefined ? null : normalizeRepoPath(input.config.behaviorPolicy),
    adapters: normalizeRepoPath(input.config.adapters),
    waivers: normalizeRepoPath(input.config.waivers),
    pluginModules,
  };
  // Phase 4 expansion inputs: test files + their directories (fixtures/
  // helpers live beside the tests), runner configs, and the sidecar.
  const testFiles = new Set((input.testFiles ?? []).map(normalizeRepoPath));
  const testDirs = new Set<string>();
  for (const file of testFiles) {
    const dir = file.split('/').slice(0, -1).join('/');
    if (dir.length > 0) testDirs.add(dir);
  }
  const runnerConfigs = new Set((input.runnerConfigs ?? []).map(normalizeRepoPath));
  const importedByTests = new Set((input.testInfrastructureFiles ?? []).map(normalizeRepoPath));
  const runtimeInputs = new Set((input.runtimeInputs ?? []).map(normalizeRepoPath));
  const removedUnclaimed = new Set((input.removedUnclaimedFiles ?? []).map(normalizeRepoPath));
  const knownSources = new Set((input.knownSourceFiles ?? []).map(normalizeRepoPath));
  const strictE2E = input.strictE2E === true;
  const reasons = new Set<string>();
  const unmappedFiles = new Set<string>();
  // 0.9.0 D2: the Gateforge-owned policy inputs of this change set, classified
  // by the caller (it owns the candidate checkout; this module stays pure).
  const policyInputs = new Set((input.policyInputs ?? []).map(normalizeRepoPath));
  // 0.10.2: the changed files attributed to a product-behaviour-neutral
  // kind. Marked in the SAME loop that classifies them, so the neutral
  // answer can never disagree with the attribution it reads.
  const neutralFiles = new Set<string>();
  const policyInputFiles = new Set<string>();
  // Docs-only exemption candidates: `docs/**.md` files. The exemption
  // applies ONLY when the whole changed set is such files (checked after
  // the loop) — a mixed docs+code change is never docs-only.
  const docsOnlyFiles = new Set<string>();
  const isDocsOnly = (file: string): boolean =>
    file.startsWith('docs/') && file.endsWith('.md');
  // 0.10.2: the owner's declared test/dev tooling globs, compiled once
  // for this change set. ABSENT = no matchers = exactly today's answer
  // for every file, which is what the key's contract promises.
  const testToolingMatchers = (input.config.project.paths.testTooling ?? []).map((glob) => picomatch(glob));
  for (const file of changed) {
    // Each branch below is one attribution of the file. The branches
    // marked neutral are the kinds that cannot carry product behaviour;
    // `knownSources` (a discovered resource's own source) and the
    // unclassified fall-through are deliberately NOT among them.
    if (policyInputs.has(file)) {
      policyInputFiles.add(file);
      neutralFiles.add(file);
    }
    const reason = matchGateDefiningInput(file, gate);
    if (reason !== null) {
      reasons.add(reason);
      neutralFiles.add(file);
      continue;
    }
    if (input.mappingSidecar === true && file === TEST_MAP_SIDECAR) {
      reasons.add(TEST_MAP_SIDECAR);
      neutralFiles.add(file);
      continue;
    }
    if (runnerConfigs.has(file)) {
      reasons.add(file);
      neutralFiles.add(file);
      continue;
    }
    if (runtimeInputs.has(file)) {
      reasons.add(file);
      neutralFiles.add(file);
      continue;
    }
    if (testFiles.has(file)) {
      reasons.add(`test:${file}`);
      neutralFiles.add(file);
      continue;
    }
    if ([...testDirs].some((dir) => underDir(file, dir))) {
      reasons.add(`test-infra:${file.split('/').slice(0, -1).join('/')}`);
      neutralFiles.add(file);
      continue;
    }
    if (importedByTests.has(file)) {
      reasons.add(`test-infra:${file}`);
      neutralFiles.add(file);
      continue;
    }
    // A file this change removed that no runner's own selection ever
    // claimed: nothing collected it, so deleting it removes no test and
    // no behaviour. It neither expands the scope nor blocks as unmapped
    // — the one honest reading of a deletion the runner never saw. It is
    // NOT counted neutral: nothing classifies what the file was.
    if (removedUnclaimed.has(file)) continue;
    // A discovered resource's own source is product behaviour by
    // definition: it is never neutral.
    if (knownSources.has(file)) continue;
    // 0.10.2: the OWNER asserts this path is test/developer tooling. The
    // pass is deliberately weak — it expands the scope exactly like test
    // infrastructure (so a change to declared tooling is never proven by
    // a slice of the suite) and is neutral, so it is never
    // CHANGE_UNMAPPED. It sits AFTER the known-source check above: a
    // discovered resource's own source is product behaviour, and no
    // declaration may hide it (the caller turns such a glob into a
    // config error).
    if (testToolingMatchers.some((matcher) => matcher(file))) {
      reasons.add(`test-tooling:${file}`);
      neutralFiles.add(file);
      continue;
    }
    if (isDocsOnly(file)) {
      docsOnlyFiles.add(file);
      neutralFiles.add(file);
      continue;
    }
    // 0.9.0 D2: a Gateforge-owned policy input (config, policy documents,
    // adapter/waiver/baseline records, generated gate wiring, the managed
    // block of the owner's CI/pre-commit config) is governed by the
    // owner-approved policy digest, never by a product obligation — so it is
    // neither unmapped nor a scope-expansion reason. Placed after the
    // test-file / test-infra / mapping-sidecar checks, which keep expanding
    // for the files they own.
    if (policyInputs.has(file)) continue;
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
  // must stay impossible), so they join the unmapped set under strict mode
  // and stop counting as neutral along with it.
  if (docsOnlyFiles.size > 0 && docsOnlyFiles.size < changed.length && strictE2E) {
    for (const file of docsOnlyFiles) {
      reasons.add(`unclassified:${file}`);
      unmappedFiles.add(file);
      neutralFiles.delete(file);
    }
  }
  const expandedBecause = [...reasons].sort();
  const decision = {
    expandedBecause,
    unmappedFiles: [...unmappedFiles].sort(),
    policyInputs: [...policyInputFiles].sort(),
    policyInputsOnly: changed.length > 0 && policyInputFiles.size === changed.length,
    productBehaviorNeutral: changed.length > 0 && neutralFiles.size === changed.length,
    // Read off the SAME `docsOnlyFiles` set the mixed-change denial above
    // uses, so the two can never disagree: `docsOnly` is exactly "every
    // changed file was classified as `docs/**.md`" — false for a mixed
    // change and false for an empty change set.
    docsOnly: changed.length > 0 && docsOnlyFiles.size === changed.length,
  };
  return expandedBecause.length > 0
    ? { mode: 'all', changedFiles: changed, ...decision }
    : { mode: 'changed', changedFiles: changed, ...decision };
}

/** One declared test-tooling glob that reaches a discovered resource's own source. */
export interface TestToolingConflict {
  /** The product source file the glob matches. */
  file: string;
  /** The declared glob, verbatim. */
  glob: string;
}

/**
 * The declared test-tooling globs that match a discovered resource's own
 * source.
 *
 * The declaration cannot hide product code: `computeEvaluationScope`
 * reads the resource-source check FIRST and never reaches the tooling
 * branch for such a file, so a change to it keeps its ordinary
 * attribution. This is the other half — the owner is told their glob is
 * wrong instead of silently watching a narrowing pass take effect. Both
 * `check` and `enforcement doctor` report the same list from this one
 * function, so they cannot disagree.
 *
 * Args:
 *   config: the loaded gateforge config.
 *   knownSourceFiles: every repo-relative path a discovered resource
 *     claims as its own source.
 *
 * Returns:
 *   TestToolingConflict[]: sorted by file; empty when nothing conflicts
 *   (including when the owner declares no globs at all).
 */
export function testToolingSourceConflicts(
  config: GateforgeConfig,
  knownSourceFiles: readonly string[],
): TestToolingConflict[] {
  const globs = config.project.paths.testTooling ?? [];
  if (globs.length === 0 || knownSourceFiles.length === 0) return [];
  const matchers = globs.map((glob) => ({ glob, matches: picomatch(glob) }));
  const conflicts: TestToolingConflict[] = [];
  for (const raw of knownSourceFiles) {
    const file = normalizeRepoPath(raw);
    const hit = matchers.find((matcher) => matcher.matches(file));
    if (hit !== undefined) conflicts.push({ file, glob: hit.glob });
  }
  return conflicts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** The tracked mapping sidecar path (scope-expansion trigger). */
const TEST_MAP_SIDECAR = GATEFORGE_TEST_MAP_PATH;

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
function gitNameOnly(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): string[] | null {
  const result = spawnSync('git', [...args], { cwd, env, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return null;
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
export function detectStagedWorkingTreeMismatches(
  cwd: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const staged = gitNameOnly(cwd, env, ['diff', '--cached', '--name-only']);
  if (staged === null) return [];
  const unstaged = gitNameOnly(cwd, env, ['diff', '--name-only']);
  if (unstaged === null) return [];
  const unstagedSet = new Set(unstaged);
  return staged.filter((file) => unstagedSet.has(file));
}
