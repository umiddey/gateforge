/** Bind only in a runner child or to an already-loaded runner; pack-root imports are trusted. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as PlaywrightTest from 'playwright/test';
import { ENV_PLAYWRIGHT_CONFIG_DIR } from '../constants.js';
import { localPlaywrightCliCandidates } from '../runner-resolution.js';

type RunnerModule = Pick<typeof PlaywrightTest, 'test' | 'expect'>;

function runnerFrom(namespace: unknown): RunnerModule | undefined {
  const loaded = namespace as (Partial<RunnerModule> & {
    default?: Partial<RunnerModule>;
  }) | null | undefined;
  const test = typeof loaded?.test === 'function' ? loaded.test : loaded?.default?.test;
  const expect = typeof loaded?.expect === 'function' ? loaded.expect : loaded?.default?.expect;
  return typeof test === 'function' && typeof expect === 'function' ? { test, expect } : undefined;
}

function readRunner(namespace: unknown, origin: string): RunnerModule {
  const runner = runnerFrom(namespace);
  if (runner === undefined) {
    throw new Error(`The selected Playwright runner '${origin}' exposes no test/expect.`);
  }
  return runner;
}

const childContext = process.env[ENV_PLAYWRIGHT_CONFIG_DIR];
const cli = localPlaywrightCliCandidates(childContext || process.cwd()).find(existsSync);
let consumer: RunnerModule | undefined;
if (cli !== undefined) {
  const requireFrom = createRequire(cli);
  const entry = requireFrom.resolve(
    cli.endsWith(join('@playwright', 'test', 'cli.js')) ? '@playwright/test' : 'playwright/test',
  );
  const cached = requireFrom.cache[entry];
  if (cached !== undefined) {
    // A worker loading a plain `playwright/test` spec can import this
    // package while Playwright's CJS entry is still evaluating. Its
    // cache record then has empty exports; use the core test API entry
    // that public entry itself requires, preserving the same runner.
    const cachedRunner = runnerFrom(cached.exports);
    if (cachedRunner !== undefined) {
      consumer = cachedRunner;
    } else if (
      cached.exports !== null &&
      typeof cached.exports === 'object' &&
      Object.keys(cached.exports).length === 0
    ) {
      const playwrightEntry = requireFrom.resolve('playwright/test');
      const coreEntry = join(dirname(playwrightEntry), 'lib', 'index.js');
      consumer = readRunner(requireFrom(coreEntry), entry);
    } else {
      consumer = readRunner(cached.exports, entry);
    }
  } else if (childContext) {
    // Only engine-created runner children may load a previously unloaded consumer module.
    // Load/shape errors propagate: a broken selected runner never falls back to a second copy.
    consumer = readRunner(requireFrom(entry), entry);
  }
}

// Synchronously, and never with a static import: loading the fallback
// unconditionally would introduce a second runner, and a top-level await
// here would make this ESM entry unloadable from a CommonJS suite
// (`require(...)` -> ERR_REQUIRE_ASYNC_MODULE). `playwright/test` is
// CommonJS, so a plain require lands on the SAME instance the CLI uses.
const runner = consumer ?? readRunner(createRequire(import.meta.url)('playwright/test'), 'pack Playwright');
export const test: typeof PlaywrightTest.test = runner.test;
export const expect: typeof PlaywrightTest.expect = runner.expect;