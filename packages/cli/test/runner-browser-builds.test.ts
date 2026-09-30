/**
 * Browser-build readiness: the runner the supervised run actually
 * launches pins its OWN browser revisions, and a nonempty browser cache
 * holding another release's builds is not a launchable browser.
 *
 * A real third-party app reproduced the false all-clear: `enforcement
 * doctor` and the strict preflight both reported the browser ready,
 * because they counted cache ENTRIES, while the consumer's Playwright
 * (resolved next to its own config, a different release from the
 * hoisted one) pins revisions the cache never held — so every test in
 * the first witnessed run died with `Executable doesn't exist at
 * .../chromium_headless_shell-<rev>/…`.
 *
 * Pinned here:
 *   - a nonempty cache missing a build the RESOLVED runner pins is a
 *     `fail` naming the exact `npx playwright install` and the config's
 *     directory (the place the consumer's Playwright lives);
 *   - the same repo with the pinned builds installed is `ok`;
 *   - a repo whose runner ships no readable registry keeps the
 *     historical wording (an unresolvable install invents no revisions).
 *
 * Deterministic and offline: every file is a fixture, and
 * `PLAYWRIGHT_BROWSERS_PATH` points the probe at a temp cache.
 */
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';

/** The registry a consumer Playwright 1.62.1 ships (chromium at 1234). */
const CONSUMER_REGISTRY = JSON.stringify({
  browsers: [
    { name: 'chromium', revision: '1234', installByDefault: true },
    { name: 'chromium-headless-shell', revision: '1234', installByDefault: true },
    { name: 'firefox', revision: '1466', installByDefault: true },
  ],
});

/** A Playwright config whose single project launches chromium. */
const CHROMIUM_CONFIG =
  "export default { projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: true } }] };\n";

/** One doctor line, by check id. */
interface DoctorLine {
  /** Stable check id inside its section. */
  id: string;
  status: string;
  detail: string;
}

/** The doctor report of a repo, as JSON. */
async function doctorReport(
  repo: { root: string },
  env: Record<string, string | undefined> = {},
): Promise<{
  checks: DoctorLine[];
  run: { checks: DoctorLine[] };
}> {
  const result = await runCli(repo as never, ['enforcement', 'doctor', '--json'], env);
  expect(result.code).toBe(0); // the doctor is a diagnostic: it always runs
  return JSON.parse(result.stdout) as { checks: DoctorLine[]; run: { checks: DoctorLine[] } };
}

/** Selects one line by id. */
function lineOf(lines: readonly DoctorLine[], id: string): DoctorLine {
  const found = lines.find((entry) => entry.id === id);
  expect(found, `line '${id}' is present`).toBeTruthy();
  return found as DoctorLine;
}

/** The enforcement doctor's `runner` readiness line. */
async function runnerCheck(
  repo: { root: string },
  env: Record<string, string | undefined> = {},
): Promise<DoctorLine> {
  return lineOf((await doctorReport(repo, env)).checks, 'runner');
}

describe('runner readiness names the browser builds the resolved runner pins', () => {
  it('fails a nonempty cache that holds another release\'s browser builds', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // The consumer's own install next to its own config: a different
      // Playwright release from any hoisted one.
      repo.writeFiles({
        'e2e/playwright.config.ts': CHROMIUM_CONFIG,
        'e2e/node_modules/@playwright/test/package.json':
          '{"name":"@playwright/test","version":"1.62.1"}\n',
        'e2e/node_modules/@playwright/test/node_modules/playwright-core/package.json':
          '{"name":"playwright-core","version":"1.62.1"}\n',
        'e2e/node_modules/@playwright/test/node_modules/playwright-core/browsers.json':
          CONSUMER_REGISTRY,
      });
      // A cache that is NOT empty — it holds the OTHER release's builds,
      // which is exactly the case a count of entries called healthy.
      const cache = repo.path('ms-playwright');
      repo.writeFiles({
        'ms-playwright/chromium-1208/INSTALLATION_COMPLETE': '',
        'ms-playwright/chromium_headless_shell-1208/INSTALLATION_COMPLETE': '',
      });
      const check = await runnerCheck(repo, { PLAYWRIGHT_BROWSERS_PATH: cache });
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('chromium-1234');
      expect(check.detail).toContain("Executable doesn't exist");
      // The fix names the command AND the directory whose config
      // resolves this runner (a sub-project owns its own install).
      expect(check.detail).toContain('npx playwright install chromium');
      expect(check.detail).toContain(repo.path('e2e'));
      // The strict preflight is the surface a run consumes: it must
      // refuse the same run for the same reason, or `gateforge run`
      // spends the whole suite failing every test.
      const preflight = lineOf((await doctorReport(repo, { PLAYWRIGHT_BROWSERS_PATH: cache })).run.checks, 'runner');
      expect(preflight.status).toBe('fail');
      expect(preflight.detail).toContain('chromium-1234');
      expect(preflight.detail).toContain('npx playwright install chromium');
    });
  });

  it('is ok once the pinned builds are installed in that same cache', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'e2e/playwright.config.ts': CHROMIUM_CONFIG,
        'e2e/node_modules/@playwright/test/package.json':
          '{"name":"@playwright/test","version":"1.62.1"}\n',
        'e2e/node_modules/@playwright/test/node_modules/playwright-core/package.json':
          '{"name":"playwright-core","version":"1.62.1"}\n',
        'e2e/node_modules/@playwright/test/node_modules/playwright-core/browsers.json':
          CONSUMER_REGISTRY,
      });
      repo.writeFiles({
        'ms-playwright/chromium-1234/INSTALLATION_COMPLETE': '',
        'ms-playwright/chromium_headless_shell-1234/INSTALLATION_COMPLETE': '',
      });
      const check = await runnerCheck(repo, { PLAYWRIGHT_BROWSERS_PATH: repo.path('ms-playwright') });
      expect(check.status).toBe('ok');
      expect(check.detail).toContain('chromium-1234');
      expect(check.detail).not.toContain("Executable doesn't exist");
    });
  });

  it('keeps the historical wording for a runner that ships no readable registry', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'playwright.config.ts': CHROMIUM_CONFIG,
        'node_modules/playwright/package.json': '{"name":"playwright","version":"1.62.1"}\n',
        'ms-playwright/chromium-1208/INSTALLATION_COMPLETE': '',
      });
      const check = await runnerCheck(repo, { PLAYWRIGHT_BROWSERS_PATH: repo.path('ms-playwright') });
      expect(check.status).toBe('ok');
      expect(check.detail).toBe(
        `playwright installed; browsers installed (1 entries) under '${repo.path('ms-playwright')}'`,
      );
    });
  });
});
