/**
 * Engine-owned browser readiness: the browser the ENGINE drives is not
 * the browser the CONSUMER's tests launch.
 *
 * The false all-clear this pins is real. A consumer on
 * `@playwright/test` 1.62.1 with Chromium 1234 installed and correct was
 * reported `ok` by both the enforcement doctor's `runner` line and the run
 * preflight, while `@gate-forge/pack-playwright`'s own pinned 1.58.2
 * wanted `chromium_headless_shell-1208` — which the cache never held. The
 * first witnessed run then died inside the witness with `Executable
 * doesn't exist`, after readiness said it would not.
 *
 * Every fact here is a real file: a real installed engine package, its
 * real `browsers.json` registry, a real cache directory that genuinely
 * lacks the engine's pinned build. Nothing asserts on source text.
 *
 * Deterministic and offline: no browser is downloaded and none is
 * launched — the readiness check reads the registry and the cache, and
 * `PLAYWRIGHT_BROWSERS_PATH` points it at a temp cache.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';

/** The consumer's own release (Chromium 1234), installed and correct. */
const CONSUMER_REGISTRY = JSON.stringify({
  browsers: [
    { name: 'chromium', revision: '1234', installByDefault: true },
    { name: 'chromium-headless-shell', revision: '1234', installByDefault: true },
  ],
});

/** The engine pack's own pin (Chromium 1208) — the release it launches. */
const ENGINE_REGISTRY = JSON.stringify({
  browsers: [
    { name: 'chromium', revision: '1208', installByDefault: true },
    { name: 'chromium-headless-shell', revision: '1208', installByDefault: true },
  ],
});

/** One doctor line, by check id. */
interface DoctorLine {
  /** Stable check id inside its section. */
  id: string;
  status: string;
  detail: string;
}

/** Selects one line by id. */
function lineOf(lines: readonly DoctorLine[], id: string): DoctorLine {
  const found = lines.find((entry) => entry.id === id);
  expect(found, `line '${id}' is present`).toBeTruthy();
  return found as DoctorLine;
}

/** The doctor report of a repo, as JSON. */
async function doctorReport(
  repo: TempRepo,
  env: Record<string, string | undefined>,
): Promise<{ checks: DoctorLine[]; run: { checks: DoctorLine[] } }> {
  const result = await runCli(repo, ['enforcement', 'doctor', '--json'], env);
  expect(result.code).toBe(0); // the doctor is a diagnostic: it always runs
  return JSON.parse(result.stdout) as { checks: DoctorLine[]; run: { checks: DoctorLine[] } };
}

describe('engine-owned browser readiness is checked apart from the consumer runner', () => {
  it('refuses a run whose consumer Chromium is installed but whose engine build is missing', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'playwright.config.ts': "export default { projects: [{ use: { browserName: 'chromium' } }] };\n",
        'node_modules/@playwright/test/package.json': '{"name":"@playwright/test","version":"1.62.1"}\n',
        'node_modules/@playwright/test/node_modules/playwright-core/package.json':
          '{"name":"playwright-core","version":"1.62.1"}\n',
        'node_modules/@playwright/test/node_modules/playwright-core/browsers.json': CONSUMER_REGISTRY,
        'node_modules/@gate-forge/pack-playwright/package.json':
          '{"name":"@gate-forge/pack-playwright","version":"0.8.0"}\n',
        'node_modules/playwright/package.json': '{"name":"playwright","version":"1.58.2"}\n',
        'node_modules/playwright/cli.js': '// the engine install CLI\n',
        'node_modules/playwright-core/package.json': '{"name":"playwright-core","version":"1.58.2"}\n',
        'node_modules/playwright-core/browsers.json': ENGINE_REGISTRY,
        'ms-playwright/chromium-1234/INSTALLATION_COMPLETE': '',
        'ms-playwright/chromium_headless_shell-1234/INSTALLATION_COMPLETE': '',
      });
      const env = { PLAYWRIGHT_BROWSERS_PATH: repo.path('ms-playwright') };
      const report = await doctorReport(repo, env);

      // The premise: the CONSUMER's own readiness is genuinely green.
      const runner = lineOf(report.checks, 'runner');
      expect(runner.status, runner.detail).toBe('ok');
      expect(runner.detail).toContain('chromium-1234');

      // The finding: a missing ENGINE build can never be reported ready.
      const engine = lineOf(report.checks, 'engine-browser');
      expect(engine.status, engine.detail).toBe('fail');
      expect(engine.detail).toContain('chromium_headless_shell-1208');
      expect(engine.detail).toContain('1.58.2');

      // The remedy is the ENGINE's own CLI by absolute path. `npx
      // playwright install` would resolve the CONSUMER's release and
      // install the revision the cache already holds.
      expect(engine.detail).toContain(`node '${repo.path('node_modules/playwright/cli.js')}' install chromium`);
      expect(engine.detail).not.toContain('npx playwright install');

      // The run preflight refuses the same run for the same reason: this
      // is the surface `gateforge run` consumes before spending the suite.
      const preflight = lineOf(report.run.checks, 'engine-browser');
      expect(preflight.status, preflight.detail).toBe('fail');
      expect(preflight.detail).toBe(engine.detail);
    });
  });

  it('is ok once the engine build it pins is installed in that same cache', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      repo.writeFiles({
        'node_modules/@playwright/test/package.json': '{"name":"@playwright/test","version":"1.62.1"}\n',
        'node_modules/@playwright/test/node_modules/playwright-core/package.json':
          '{"name":"playwright-core","version":"1.62.1"}\n',
        'node_modules/@playwright/test/node_modules/playwright-core/browsers.json': CONSUMER_REGISTRY,
        'node_modules/@gate-forge/pack-playwright/package.json':
          '{"name":"@gate-forge/pack-playwright","version":"0.8.0"}\n',
        'node_modules/playwright/package.json': '{"name":"playwright","version":"1.58.2"}\n',
        'node_modules/playwright/cli.js': '// the engine install CLI\n',
        'node_modules/playwright-core/package.json': '{"name":"playwright-core","version":"1.58.2"}\n',
        'node_modules/playwright-core/browsers.json': ENGINE_REGISTRY,
        'ms-playwright/chromium-1234/INSTALLATION_COMPLETE': '',
        'ms-playwright/chromium_headless_shell-1234/INSTALLATION_COMPLETE': '',
        'ms-playwright/chromium-1208/INSTALLATION_COMPLETE': '',
        'ms-playwright/chromium_headless_shell-1208/INSTALLATION_COMPLETE': '',
      });
      const report = await doctorReport(repo, { PLAYWRIGHT_BROWSERS_PATH: repo.path('ms-playwright') });
      const engine = lineOf(report.checks, 'engine-browser');
      expect(engine.status, engine.detail).toBe('ok');
      expect(engine.detail).toContain('chromium_headless_shell-1208');
      expect(engine.detail).not.toContain('Executable doesn\'t exist');
    });
  });

  it('demands no browser at all from a repository that never opens one', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      // A pytest repository proves its cases over HTTP and queue: no
      // engine-browser channel, so no engine Chromium is ever opened.
      repo.writeFiles({ '.gateforge.yml': `${readFileSync(repo.path('.gateforge.yml'), 'utf8')}\nrunner: pytest\n` });
      const report = await doctorReport(repo, { PLAYWRIGHT_BROWSERS_PATH: repo.path('ms-playwright') });
      const engine = lineOf(report.checks, 'engine-browser');
      expect(engine.status, engine.detail).toBe('ok');
      expect(engine.detail).toContain('not required');
      // No install command is offered for a browser this repo never uses.
      expect(engine.detail).not.toContain('install');
    });
  });
});