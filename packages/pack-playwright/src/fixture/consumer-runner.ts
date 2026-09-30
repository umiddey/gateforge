/**
 * Consumer-runner binding for the evidence fixture.
 *
 * The fixture used to import `playwright/test` statically, which resolves
 * from THIS package's location and is therefore pinned to the pack's own
 * copy. The pack declares `playwright` as a hard dependency, so that
 * import is pinned to the pack's copy — which is NOT the copy the
 * consumer's suite runs on. When a consumer pins a different
 * `@playwright/test`, npm installs two copies, the consumer's config and
 * specs load theirs, and this module loads the pack's. Both live in one
 * runner process and Playwright's module guard refuses the second load:
 *
 *   Error: Requiring @playwright/test second time,
 *   First:  …/@playwright/test/node_modules/playwright/lib/index.js:68
 *   Second: …/node_modules/playwright/lib/index.js:56
 *
 * Native enumeration then enumerates nothing (`discovered=0`,
 * `inventoryComplete=false`) and no witnessed run is possible for that
 * repository.
 *
 * The fixture binds to the SAME runner the enumeration and the supervised
 * execution use, under two rules that matter more than the binding itself:
 *
 * 1. **No candidate code in a trusted process.** This module is reachable
 *    from the pack ROOT, which the CLI and the witness import, so it must
 *    never execute consumer code there. The consumer's runner is loaded
 *    only when this process HAS ALREADY LOADED IT (read back out of the
 *    module cache — no new code runs, which is what keeps a plain
 *    `playwright --list` working, because the consumer's config loads the
 *    runner before any spec does), or when trusted supervision marked this
 *    process as the runner CHILD through
 *    {@link ENV_PLAYWRIGHT_CONFIG_DIR}. A trusted process with neither
 *    stays on the pack's pinned runner and executes nothing of the
 *    candidate's.
 * 2. **A selected runner that is broken is an error, never a silent
 *    fallback.** Falling back would hide the real failure behind a second
 *    copy of Playwright — the exact failure this module exists to remove.
 *    Only ABSENCE of a consumer runner falls back.
 *
 * Resolution order per directory, walking upward the way node resolves a
 * module: `node_modules/@playwright/test` before `node_modules/playwright`
 * IN THAT SAME DIRECTORY, so a nearer bare install is never beaten by a
 * farther `@playwright/test`. This is the same nearest-first,
 * same-directory pairing the CLI resolver uses for the executable
 * (`localPlaywrightCliCandidates`), and the supervised run resolves the
 * runner from the same directory, so all three agree.
 *
 * Nothing here loads candidate Playwright into the witness or the
 * engine-owned browser: this module is imported by test code in the
 * supervised runner process, and by the pack root in trusted processes
 * where rule 1 keeps it to the pack's own pin.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENV_PLAYWRIGHT_CONFIG_DIR } from '../constants.js';
import type * as PlaywrightTest from 'playwright/test';

/** Shape this module re-exports, taken from the pack's own runner. */
type RunnerModule = typeof PlaywrightTest;

/** One resolved consumer runner entry and the resolver that found it. */
interface ConsumerRunnerEntry {
  /** Absolute path of the runner's entry module. */
  readonly entry: string;
  /** The resolver whose module cache is this process's. */
  readonly requireFrom: NodeRequire;
}

/**
 * The nearest consumer runner, walking upward from `startDir`: in EACH
 * directory `node_modules/@playwright/test` before
 * `node_modules/playwright`, so the nearest install wins and a nearer bare
 * `playwright` is never beaten by a farther `@playwright/test`.
 *
 * @param startDir - absolute directory to start the upward walk from.
 * @returns the resolved entry, or null when no directory has one.
 */
function nearestConsumerRunnerEntry(startDir: string): ConsumerRunnerEntry | null {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    const requireFrom = createRequire(join(dir, 'noop.js'));
    // Presence is checked IN THIS DIRECTORY first: node resolution alone
    // would find a farther `@playwright/test` before this directory's own
    // bare `playwright`, which is not the pairing the CLI resolver uses.
    const directories: ReadonlyArray<readonly [string, string]> = [
      [join('node_modules', '@playwright', 'test'), '@playwright/test'],
      [join('node_modules', 'playwright'), 'playwright/test'],
    ];
    for (const [relative, specifier] of directories) {
      if (!existsSync(join(dir, relative))) continue;
      try {
        return { entry: requireFrom.resolve(specifier), requireFrom };
      } catch {
        // the directory exists but does not resolve as a runner — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
  }
  return null;
}

/**
 * Reads `test`/`expect` out of a loaded runner namespace. `@playwright/test`
 * is CommonJS, so an `import()` of its entry yields `default` (plus
 * `module.exports`) rather than the named exports.
 *
 * @param namespace - the module namespace or CommonJS exports.
 * @param origin - human-readable origin for the error message.
 * @returns the runner module.
 * @throws Error when the selected runner exposes no `test`/`expect` — a
 * broken selected runner is a failure, never a silent fallback.
 */
function readRunner(namespace: unknown, origin: string): RunnerModule {
  const loaded = namespace as Partial<RunnerModule> & { default?: Partial<RunnerModule> };
  const test = typeof loaded.test === 'function' ? loaded.test : loaded.default?.test;
  const expect = typeof loaded.expect === 'function' ? loaded.expect : loaded.default?.expect;
  if (typeof test !== 'function' || typeof expect !== 'function') {
    throw new Error(
      `the selected Playwright runner at '${origin}' exposes no test/expect — ` +
        'a broken runner is reported, never replaced by a second copy of Playwright',
    );
  }
  return { ...loaded, test, expect } as RunnerModule;
}

/** Absolute config directory trusted supervision set for this child, or null. */
function childConfigDir(env: NodeJS.ProcessEnv): string | null {
  const declared = env[ENV_PLAYWRIGHT_CONFIG_DIR];
  return typeof declared === 'string' && declared.length > 0 ? resolve(declared) : null;
}

const childContext = childConfigDir(process.env);
const consumerEntry =
  (childContext === null ? null : nearestConsumerRunnerEntry(childContext)) ??
  // Without a config directory the process working directory and its
  // ancestors are the whole context (the hoisted repository-root case).
  nearestConsumerRunnerEntry(process.cwd());

let consumerRunner: RunnerModule | null = null;
if (consumerEntry !== null) {
  // Already loaded HERE: reuse the exports, execute nothing.
  const cached = consumerEntry.requireFrom.cache[consumerEntry.entry];
  if (cached !== undefined) {
    consumerRunner = readRunner(cached.exports, consumerEntry.entry);
  } else if (childContext !== null) {
    // Trusted supervision marked this process as the runner child: loading
    // the consumer's own runner is the whole point.
    consumerRunner = readRunner(
      await import(pathToFileURL(consumerEntry.entry).href),
      consumerEntry.entry,
    );
  }
  // Otherwise: a trusted process that has not loaded the consumer runner
  // executes nothing of the candidate's and keeps the pack's pin below.
}

/** The pack's own pinned runner — imported only when nothing else binds. */
const packRunner = consumerRunner === null ? await import('playwright/test') : null;

/**
 * The runner the evidence fixture extends: the consumer's own
 * `@playwright/test` when this process already runs on it or is the
 * supervised runner child, the pack's pinned `playwright/test` otherwise.
 * Identical to a fresh pack install with no consumer Playwright, which is
 * the common case the default must keep.
 */
export const boundRunner: RunnerModule = consumerRunner ?? (packRunner as RunnerModule);

/** True when the fixture is bound to a consumer-installed runner. */
export const boundToConsumerRunner: boolean = consumerRunner !== null;

/** `test` from the bound runner. */
export const test = boundRunner.test;

/** `expect` from the bound runner — the SAME instance, so an assertion
 * written against the consumer's runner is the one that grades the run. */
export const expect = boundRunner.expect;
