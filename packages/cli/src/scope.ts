/**
 * Effective evaluation scope for `check --changed` (plan §12.2, D4).
 *
 * One scope decision is computed BEFORE grading and applied consistently
 * to obligations AND blocking entries. `check` without `--changed` stays
 * all-files. `check --changed` expands to all-files when the diff touches
 * any gate-defining input.
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
 */
import { spawnSync } from 'node:child_process';
import { normalizeChangedFiles, type GateforgeConfig } from '@gateforge/core';
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
    adapters: string;
    waivers: string;
    pluginModules: readonly string[];
  },
): string | null {
  if (file === '.gateforge.yml') return '.gateforge.yml';
  if (file === gate.policies) return gate.policies;
  if (file === gate.classificationPolicy) return gate.classificationPolicy;
  if (file === gate.baselines) return gate.baselines;
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
 *   config: validated `.gateforge.yml` (custom policy/classification
 *     paths included by construction — they are read from the config,
 *     never compared against defaults).
 *   changedFiles: actual normalized diff list from the diff provider.
 *
 * Returns:
 *   ScopeDecision: `all` with sorted `expandedBecause` reasons when any
 *   changed file is gate-defining (deleted files included — they are
 *   still in the diff list); otherwise the narrowed `changed` scope.
 */
export function computeEvaluationScope(input: {
  config: GateforgeConfig;
  changedFiles: readonly string[];
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
    adapters: normalizeRepoPath(input.config.adapters),
    waivers: normalizeRepoPath(input.config.waivers),
    pluginModules,
  };
  const reasons = new Set<string>();
  for (const file of changed) {
    const reason = matchGateDefiningInput(file, gate);
    if (reason !== null) reasons.add(reason);
  }
  const expandedBecause = [...reasons].sort();
  if (expandedBecause.length > 0) {
    return { mode: 'all', changedFiles: changed, expandedBecause };
  }
  return { mode: 'changed', changedFiles: changed, expandedBecause: [] };
}

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
