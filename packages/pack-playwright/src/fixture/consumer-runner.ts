/** Bind only in a runner child or to an already-loaded runner; pack-root imports are trusted. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as PlaywrightTest from 'playwright/test';
import { ENV_PLAYWRIGHT_CONFIG_DIR } from '../constants.js';
import { localPlaywrightCliCandidates } from '../runner-resolution.js';

type RunnerModule = Pick<typeof PlaywrightTest, 'test' | 'expect'>;

function readRunner(namespace: unknown, origin: string): RunnerModule {
  const loaded = namespace as (Partial<RunnerModule> & {
    default?: Partial<RunnerModule>;
  }) | null | undefined;
  const test = typeof loaded?.test === 'function' ? loaded.test : loaded?.default?.test;
  const expect = typeof loaded?.expect === 'function' ? loaded.expect : loaded?.default?.expect;
  if (typeof test !== 'function' || typeof expect !== 'function') {
    throw new Error(`The selected Playwright runner '${origin}' exposes no test/expect.`);
  }
  return { test, expect };
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
    // Plain Playwright has already loaded this module; reusing it executes no candidate code.
    consumer = readRunner(cached.exports, entry);
  } else if (childContext) {
    // Only engine-created runner children may load a previously unloaded consumer module.
    // Import/shape errors propagate: a broken selected runner never falls back to a second copy.
    consumer = readRunner(await import(pathToFileURL(entry).href), entry);
  }
}

// Static import cannot work: loading the fallback unconditionally would introduce a second runner.
const runner = consumer ?? readRunner(await import('playwright/test'), 'pack Playwright');
export const test: typeof PlaywrightTest.test = runner.test;
export const expect: typeof PlaywrightTest.expect = runner.expect;
