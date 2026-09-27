/**
 * Vitest global setup for the pack's suites: builds the workspace dists
 * the pack's real-process tests load (`@gate-forge/core`, then this
 * pack), ONCE, before any test worker starts.
 *
 * WHY here and never in a test file's `beforeAll`: `tsc` rewrites every
 * emitted file in place (open with truncate, then write). While the suite
 * runs in parallel, the compiled CLI, Playwright runner/reporter children,
 * and other projects' tests import these dists through the workspace
 * links; a rebuild during the run lets a concurrent import read an empty
 * or half-written module (`SyntaxError: ... does not provide an export
 * named ...`, node exit 1) — an intermittent failure of whichever
 * unrelated test was starting a child at that moment.
 *
 * The returned teardown fails the run when any file of those dists was
 * rewritten after this build, so a reintroduced in-suite rebuild is caught
 * on every run instead of as a rare parallel flake.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root (the gateforge monorepo). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Workspace packages built here, in dependency order (core first). */
const BUILT_PACKAGES = ['core', 'pack-playwright'] as const;

/**
 * Compiles one workspace package into its dist with its build tsconfig.
 *
 * Args:
 *   name (string): the package directory under `packages/`.
 *
 * Returns:
 *   void: nothing; the dist is current on return.
 *
 * Throws:
 *   Error: when tsc exits nonzero or is killed (full compiler output).
 */
function buildPackage(name: string): void {
  const project = `packages/${name}/tsconfig.build.json`;
  const result = spawnSync('npx', ['tsc', '-p', project], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${project} build failed (exit ${String(result.status)}, signal ${String(result.signal)}):\n${result.stdout}${result.stderr}`,
    );
  }
}

/**
 * Records the size and modification time of every file in one package's
 * dist (an in-place rewrite always changes the modification time).
 *
 * Args:
 *   name (string): the package directory under `packages/`.
 *
 * Returns:
 *   Map<string, string>: absolute file path -> `size:mtimeMs`.
 */
function distState(name: string): Map<string, string> {
  const state = new Map<string, string>();
  const pending = [join(ROOT, 'packages', name, 'dist')];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else {
        const stat = statSync(path);
        state.set(path, `${String(stat.size)}:${String(stat.mtimeMs)}`);
      }
    }
  }
  return state;
}

/**
 * Lists the dist files added, removed, or rewritten between two states.
 *
 * Args:
 *   before (Map<string, string>): the state recorded after the build.
 *   after (Map<string, string>): the state at teardown.
 *
 * Returns:
 *   string[]: the changed absolute paths, sorted.
 */
function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [path, value] of before) {
    if (after.get(path) !== value) changed.add(path);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

/**
 * Builds the dists once, then returns the teardown that proves no test
 * rewrote them during the run.
 *
 * Returns:
 *   () => void: teardown; throws when any built dist file changed.
 */
export default function setup(): () => void {
  for (const name of BUILT_PACKAGES) buildPackage(name);
  const built = BUILT_PACKAGES.map((name) => [name, distState(name)] as const);
  return () => {
    const changed = built.flatMap(([name, state]) => changedFiles(state, distState(name)));
    if (changed.length > 0) {
      throw new Error(
        `${String(changed.length)} workspace dist file(s) changed during the test run; ` +
          'tests must not rebuild a shared dist in place (test/global-setup.ts builds it once, ' +
          `before any worker starts):\n${changed.slice(0, 20).join('\n')}`,
      );
    }
  };
}
