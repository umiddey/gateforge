/**
 * Launch probe: an INSTALLED browser build can still be unable to start.
 *
 * A clean `node:20` container reproduced the whole first-run defect:
 * `npx playwright install chromium` succeeded, `enforcement doctor`
 * reported every pinned build installed, and then every supervised test
 * died with `browserType.launch: Target page, context or browser has
 * been closed` — because the Debian image has no browser SYSTEM
 * libraries, and the dynamic loader fails before `main`, so the real
 * cause only exists in the truncated browser log nobody local can see.
 *
 * Pinned here:
 *   - a build whose executable cannot start is a `fail` naming the first
 *     loader line and the exact `npx playwright install-deps` fix, on
 *     BOTH the doctor's `runner` line and the strict preflight the run
 *     consumes (so a run stops before it spends the suite);
 *   - a build that starts keeps today's wording BYTE FOR BYTE;
 *   - no executable file, or a platform that is not Linux, makes NO
 *     claim at all (the probe never invents a failure).
 *
 * Deterministic and offline: the "browsers" are tiny shell scripts in a
 * temp cache, and `PLAYWRIGHT_BROWSERS_PATH` points the probe at it.
 */
import { chmodSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withTempRepo } from '@gate-forge/core';
import { probeBrowserLaunch } from '../src/playwright-browsers.js';
import { installFixture, runCli } from './helpers.js';

/** The registry a consumer Playwright 1.62.1 ships (chromium at 1234). */
const CONSUMER_REGISTRY = JSON.stringify({
  browsers: [
    { name: 'chromium', revision: '1234', installByDefault: true },
    { name: 'chromium-headless-shell', revision: '1234', installByDefault: true },
  ],
});

/** A Playwright config whose single project launches chromium, headless. */
const CHROMIUM_CONFIG =
  "export default { projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: true } }] };\n";

/** The consumer's own Playwright install, next to its own config. */
const CONSUMER_INSTALL: Record<string, string> = {
  'e2e/playwright.config.ts': CHROMIUM_CONFIG,
  'e2e/node_modules/@playwright/test/package.json': '{"name":"@playwright/test","version":"1.62.1"}\n',
  'e2e/node_modules/@playwright/test/node_modules/playwright-core/package.json':
    '{"name":"playwright-core","version":"1.62.1"}\n',
  'e2e/node_modules/@playwright/test/node_modules/playwright-core/browsers.json': CONSUMER_REGISTRY,
};

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
): Promise<{ checks: DoctorLine[]; run: { checks: DoctorLine[] } }> {
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

/**
 * Writes both pinned builds with a given executable body, executable.
 *
 * Args:
 *   repo: the fixture repository.
 *   body: shell script body each build's executable runs.
 */
function writeInstalledBuilds(repo: { writeFiles: (files: Record<string, string>) => void; path: (p: string) => string }, body: string): void {
  repo.writeFiles({
    'ms-playwright/chromium-1234/chrome-linux64/chrome': body,
    'ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell': body,
  });
  for (const relative of [
    'ms-playwright/chromium-1234/chrome-linux64/chrome',
    'ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
  ]) {
    chmodSync(repo.path(relative), 0o755);
  }
}

describe('an installed browser build is probed before a run trusts it', () => {
  it('fails a build the machine cannot start, naming the loader line and install-deps', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles(CONSUMER_INSTALL);
      // What a Debian image without the browser's system libraries does:
      // the dynamic loader gives up before main, so the browser's own
      // output is empty and the loader owns the only diagnostic there is.
      writeInstalledBuilds(
        repo,
        '#!/bin/sh\n' +
          "echo 'chrome: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory' >&2\n" +
          'exit 127\n',
      );
      const cache = repo.path('ms-playwright');
      const report = await doctorReport(repo, { PLAYWRIGHT_BROWSERS_PATH: cache });
      // The whole sentence is pinned: the build, the loader's own line,
      // the fix command, and the directory whose config resolves this
      // runner. A second broken build of the same browser is not
      // repeated — one line that names cause and fix beats two.
      const sentence =
        "the browser build '" +
        `${cache}/chromium-1234' is installed but cannot start on this machine: ` +
        'chrome: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory; ' +
        `fix: run \`npx playwright install-deps chromium\` in '${repo.path('e2e')}' ` +
        "(installs the browser's system libraries; needs root or sudo)";
      const check = lineOf(report.checks, 'runner');
      expect(check.status).toBe('fail');
      expect(check.detail).toBe(`playwright installed; ${sentence}`);
      // The strict preflight is the surface the RUN consumes: a run must
      // stop at preflight, not after failing every test for an hour.
      const preflight = lineOf(report.run.checks, 'runner');
      expect(preflight.status).toBe('fail');
      expect(preflight.detail).toContain(sentence);
    });
  });

  it('keeps today\'s wording byte for byte when the installed builds start', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles(CONSUMER_INSTALL);
      writeInstalledBuilds(repo, '#!/bin/sh\necho "Chromium 1234.0.0"\nexit 0\n');
      const cache = repo.path('ms-playwright');
      const report = await doctorReport(repo, { PLAYWRIGHT_BROWSERS_PATH: cache });
      const check = lineOf(report.checks, 'runner');
      expect(check.status).toBe('ok');
      expect(check.detail).toBe(
        `playwright installed; browsers installed (2 entries) under '${cache}'; ` +
          `every browser build this runner pins for these projects is installed ` +
          `(chromium-1234, chromium_headless_shell-1234) under '${cache}'`,
      );
    });
  });

  it('makes no claim without an executable, off Linux, or for a non-chromium build', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        ...CONSUMER_INSTALL,
        'ms-playwright/chromium-1234/INSTALLATION_COMPLETE': '',
      });
      const browsersPath = repo.path('ms-playwright');
      // A cache entry with no executable file: an unprobeable build is
      // never a failing build.
      expect(probeBrowserLaunch({ name: 'chromium', revision: '1234' }, browsersPath)).toBeNull();
      // Not Linux: the loader diagnosis this probe reports is a Linux
      // one, and nothing else has been observed, so nothing is claimed.
      expect(
        probeBrowserLaunch({ name: 'chromium', revision: '1234' }, browsersPath, { platform: 'darwin' }),
      ).toBeNull();
      // Installed, startable, and NOT chromium-family.
      repo.writeFiles({ 'ms-playwright/firefox-1466/firefox/firefox': '#!/bin/sh\nexit 0\n' });
      expect(probeBrowserLaunch({ name: 'firefox', revision: '1466' }, browsersPath)).toBeNull();
    });
  });
});
