/**
 * The supervised Playwright child and the readiness check that guards it
 * must read the SAME browser cache.
 *
 * Reproduced on a real third-party install: `PLAYWRIGHT_BROWSERS_PATH`
 * was set to a cache the operator populated with `npx playwright install
 * chromium`, `enforcement doctor` reported the pinned browser builds
 * present under THAT directory and exited 0, and the very next
 * supervised run failed every single test with `Executable doesn't exist
 * at $HOME/.cache/ms-playwright/...`. The doctor's cache resolution reads
 * the variable (`cli/playwright-browsers.ts` `defaultBrowsersPath`), but
 * the child was spawned with an allowlist-only environment that did not
 * carry it, so the child fell back to `$HOME/.cache/ms-playwright` — a
 * directory nobody had ever checked.
 *
 * Pinned here:
 *   - `buildRunnerChildEnv` passes `PLAYWRIGHT_BROWSERS_PATH` from the
 *     ambient environment to the child (an operator-chosen cache PATH,
 *     never a secret — the same class as the `HOME`/`TMPDIR` basics and
 *     the XDG names the CLI already forwards);
 *   - the child env and the doctor's cache resolution AGREE: build the
 *     child env from the same operator environment the doctor reads and
 *     resolve the child's cache the way Playwright itself does;
 *   - nothing else widened: a secret or a parent-side run-state path is
 *     still refused, and an unrelated ambient name still does not cross.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  RUNNER_PARENT_SIDE_ENV,
  RUNNER_SECRET_ENV,
  RUNNER_SYSTEM_ALLOWLIST,
  RunnerEnvError,
  buildRunnerChildEnv,
} from '../src/discovery/runner-env.js';

describe('the supervised Playwright child reads the browser cache the doctor checked', () => {
  it('carries the operator-set cache path to the child', () => {
    const cache = '/var/cache/ms-playwright-operator';
    const child = buildRunnerChildEnv({}, { PATH: '/usr/bin', PLAYWRIGHT_BROWSERS_PATH: cache });
    expect(child['PLAYWRIGHT_BROWSERS_PATH']).toBe(cache);
    expect(RUNNER_SYSTEM_ALLOWLIST).toContain('PLAYWRIGHT_BROWSERS_PATH');
  });

  it('resolves the SAME cache the doctor resolves for that environment', () => {
    // The doctor's resolution, verbatim (cli/playwright-browsers.ts):
    // the variable wins, otherwise $HOME/.cache/ms-playwright.
    const defaultBrowsersPath = (env: Record<string, string | undefined>): string =>
      env['PLAYWRIGHT_BROWSERS_PATH'] ?? join(homedir(), '.cache', 'ms-playwright');

    const withCache = buildRunnerChildEnv({}, { PATH: '/usr/bin', PLAYWRIGHT_BROWSERS_PATH: '/var/cache/pw' });
    const withoutCache = buildRunnerChildEnv({}, { PATH: '/usr/bin' });
    // Operator-set: the child's cache is the one the doctor verified.
    expect(defaultBrowsersPath(withCache)).toBe('/var/cache/pw');
    expect(defaultBrowsersPath(withCache)).toBe(defaultBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '/var/cache/pw' }));
    // Unset: both fall back to the same default cache.
    expect(defaultBrowsersPath(withoutCache)).toBe(join(homedir(), '.cache', 'ms-playwright'));
    expect(defaultBrowsersPath(withoutCache)).toBe(defaultBrowsersPath({}));
  });

  it('supervisor-supplied vars win over ambient, and nothing else widened', () => {
    const child = buildRunnerChildEnv(
      { PLAYWRIGHT_BROWSERS_PATH: '/var/cache/from-vars' },
      { PATH: '/usr/bin', PLAYWRIGHT_BROWSERS_PATH: '/var/cache/ambient', SOME_SECRET_TOKEN: 'x' },
    );
    expect(child['PLAYWRIGHT_BROWSERS_PATH']).toBe('/var/cache/from-vars');
    // An unrelated ambient name still does not cross the allowlist.
    expect(child['SOME_SECRET_TOKEN']).toBeUndefined();
    // Signing material and parent-side run-state paths are still refused.
    for (const secret of RUNNER_SECRET_ENV) {
      expect(() => buildRunnerChildEnv({ [secret]: 'x' }, {})).toThrow(RunnerEnvError);
    }
    for (const parentSide of RUNNER_PARENT_SIDE_ENV) {
      expect(() => buildRunnerChildEnv({ [parentSide]: '/x' }, {})).toThrow(RunnerEnvError);
    }
  });
});
