/**
 * Pure helpers shared by global-setup and its tests. Kept separate so
 * `vitest list` can import them from source without pulling in dist
 * builds or the globalSetup module graph.
 */

/**
 * True when this Node process is vitest's `list` subcommand (inventory
 * only — no test workers execute).
 */
export function isVitestListInvocation(argv: readonly string[] = process.argv): boolean {
  return argv.includes('list');
}

/**
 * True when vitest runs under a supervised gateforge gate (workspace dists
 * were built before the runner child started).
 */
export function isSupervisedGateforgeRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const runId = env['GATEFORGE_RUN_ID'];
  if (runId !== undefined && runId !== '') return true;
  const runToken = env['GATEFORGE_RUN_TOKEN'];
  return runToken !== undefined && runToken !== '';
}
