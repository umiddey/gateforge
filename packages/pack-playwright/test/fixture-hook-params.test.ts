/**
 * Hooks registered on the fixture's `test` receive the fixtures they ask for.
 *
 * The fixture wraps `beforeAll`/`beforeEach`/`afterEach`/`afterAll` to know
 * when a hook is running (setup traffic stays uncredited). Playwright decides
 * which fixtures to build for a hook by reading the hook function's FIRST
 * parameter, so the wrapper has to present the consumer's parameter list:
 * a suite's `test.beforeEach(async ({ page }) => …)` must get its `page`,
 * with or without a hook title. Runs real Playwright, no browser and no
 * witness (option fixtures only).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYWRIGHT_CLI, makeTempProject, removeTempProject, run } from './helpers.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeTempProject(dir);
});

const SPEC = `import { test, expect } from '@gate-forge/pack-playwright/fixture';

const seen = [];
test.use({ baseURL: 'http://127.0.0.1:9/app' });

test.beforeAll(async ({ browserName }) => { seen.push('beforeAll:' + browserName); });
test.beforeEach(async ({ baseURL }) => { seen.push('beforeEach:' + baseURL); });
test.beforeEach('titled hook', async ({ baseURL }, testInfo) => { seen.push('titled:' + baseURL + ':' + testInfo.title); });
test.afterEach(async ({ baseURL }) => { seen.push('afterEach:' + baseURL); });

test('hooks got their fixtures', async () => {
  expect(seen).toEqual([
    'beforeAll:chromium',
    'beforeEach:http://127.0.0.1:9/app',
    'titled:http://127.0.0.1:9/app:hooks got their fixtures',
  ]);
});

test('afterEach ran with its fixture', async () => {
  expect(seen).toContain('afterEach:http://127.0.0.1:9/app');
});
`;

describe('fixture hooks', () => {
  it('pass the fixtures each hook destructures, titled or not', () => {
    const dir = makeTempProject('hook-params');
    dirs.push(dir);
    writeFileSync(join(dir, 'specs/hooks.spec.js'), SPEC);
    writeFileSync(
      join(dir, 'playwright.config.js'),
      "export default { testDir: './specs', workers: 1, reporter: 'line' };\n",
    );
    const outcome = run(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', 'playwright.config.js'], {
      cwd: dir,
      env: { GATEFORGE_WITNESS_URL: '', CI: '' },
    });
    expect(`${outcome.stdout}${outcome.stderr}`).toContain('2 passed');
    expect(outcome.status).toBe(0);
  });
});
