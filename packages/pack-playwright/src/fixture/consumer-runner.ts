/**
 * Consumer-runner binding for the evidence fixture.
 *
 * The fixture used to import `playwright/test` statically, which resolves
 * from THIS package's location. The pack declares `playwright` as a hard
 * dependency, so that import is pinned to the pack's own copy — which is
 * NOT the copy the consumer's suite runs on. When a consumer pins a
 * different `@playwright/test` (any repo whose own version differs from
 * the pack's pin), npm installs two copies, the consumer's config and specs
 * load theirs, and this module loads the pack's. Both live in one runner
 * process and Playwright's module guard refuses the second load:
 *
 *   Error: Requiring @playwright/test second time,
 *   First:  …/@playwright/test/node_modules/playwright/lib/index.js:68
 *   Second: …/node_modules/playwright/lib/index.js:56
 *
 * Native enumeration then enumerates nothing (`discovered=0`,
 * `inventoryComplete=false`) and no witnessed run is possible — the
 * documented `evidence.ui` / `persistence` lane is unreachable for that
 * repository.
 *
 * The fix binds the fixture to the SAME runner the enumeration and the
 * supervised execution already use: the consumer's own `@playwright/test`
 * when the repository installs one, resolved from the run's own context,
 * and the pack's pinned `playwright/test` when it does not. Node's module
 * cache then hands back the very instance the consumer's config and specs
 * already loaded, so there is one copy in the process.
 *
 * Resolution bases, in order:
 *   1. the Playwright config directory the supervisor discovered, handed to
 *      the runner child as {@link ENV_PLAYWRIGHT_CONFIG_DIR} — this is what makes a
 *      NON-ROOT config with its OWN `node_modules` work, not just a hoisted
 *      repository-root install;
 *   2. the process working directory and each of its ancestors — the
 *      hoisted case, and the case where the child has no context var.
 *
 * Nothing here reads a candidate Playwright into the WITNESS or the
 * engine-owned browser: this module is imported only by test code in the
 * supervised runner process, exactly as the fixture always was.
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENV_PLAYWRIGHT_CONFIG_DIR } from '../constants.js';
import type * as PlaywrightTest from 'playwright/test';

const consumerRunner = await loadConsumerRunner();

/** The pack's own pinned runner, imported ONLY when the repository has no
 * runner of its own. Loading it unconditionally would put the pack's copy
 * into the process even when a consumer runner was found, and then the
 * CONSUMER's copy is the refused second load — the very guard this module
 * exists to avoid. */
const packRunner = consumerRunner === null ? await import('playwright/test') : null;

/** Shape this module re-exports, taken from the pack's own runner. */
type RunnerModule = typeof PlaywrightTest;

/** Directories to resolve the consumer's runner from, nearest first. */
function candidateBases(env: NodeJS.ProcessEnv): string[] {
  const bases: string[] = [];
  const declared = env[ENV_PLAYWRIGHT_CONFIG_DIR];
  if (typeof declared === 'string' && declared.length > 0) bases.push(resolve(declared));
  let current = resolve(process.cwd());
  for (;;) {
    bases.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return bases;
}

/**
 * Resolves the consumer's own runner entry point, or null when the
 * repository installs none (a repository that relies on the pack's pin).
 */
function resolveConsumerRunner(env: NodeJS.ProcessEnv): string | null {
  for (const base of candidateBases(env)) {
    // `@playwright/test` first (the consumer's own runner, the same
    // preference the discovery CLI resolver uses), then a bare
    // `playwright` install that ships the test entry.
    for (const specifier of ['@playwright/test', 'playwright/test'] as const) {
      try {
        const requireFrom = createRequire(join(base, 'noop.js'));
        return requireFrom.resolve(specifier);
      } catch {
        // not installed under this base — try the next one
      }
    }
  }
  return null;
}

/**
 * Loads the consumer's runner, or returns null when it cannot be loaded as
 * one module (a broken install must fall back to the pack's runner rather
 * than take the whole suite down at import time).
 */
async function loadConsumerRunner(): Promise<RunnerModule | null> {
  const entry = resolveConsumerRunner(process.env);
  if (entry === null) return null;
  try {
    const namespace = (await import(pathToFileURL(entry).href)) as Partial<RunnerModule> & {
      default?: Partial<RunnerModule>;
    };
    // `@playwright/test` is CommonJS: `import()` of its entry yields
    // `default` (plus `module.exports`), and its named exports are NOT
    // always detected by the CJS lexer. Read both shapes, so a consumer
    // runner shipping either one binds instead of silently falling back to
    // the pack's copy — which is the failure this module exists to fix.
    const test = typeof namespace.test === 'function' ? namespace.test : namespace.default?.test;
    const expect = typeof namespace.expect === 'function' ? namespace.expect : namespace.default?.expect;
    if (typeof test !== 'function' || typeof expect !== 'function') return null;
    return { ...namespace, test, expect } as RunnerModule;
  } catch {
    return null;
  }
}

/**
 * The runner the evidence fixture extends: the consumer's own
 * `@playwright/test` when the repository installs one, the pack's pinned
 * `playwright/test` otherwise. Identical to a fresh pack install with no
 * consumer Playwright, which is the common case the default must keep.
 */
export const boundRunner: RunnerModule = consumerRunner ?? (packRunner as RunnerModule);

/** True when the fixture is bound to a consumer-installed runner. */
export const boundToConsumerRunner: boolean = consumerRunner !== null;

/** `test` from the bound runner. */
export const test = boundRunner.test;

/** `expect` from the bound runner — the SAME instance, so an assertion
 * written against the consumer's runner is the one that grades the run. */
export const expect = boundRunner.expect;
