/**
 * A suite that mixes the fixture's `test` with Playwright's own keeps its
 * file order when page observation is off.
 *
 * Playwright schedules tests whose runners differ in a worker-scoped
 * fixture in separate worker groups. The fixture replaces the worker-scoped
 * `browser` only for page observation (it needs a debugging port); doing it
 * always moved every fixture test behind the plain ones, and a suite whose
 * later files rely on state an earlier fixture test created broke.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAYWRIGHT_CLI, makeTempProject, removeTempProject, run } from './helpers.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeTempProject(dir);
});

const FIXTURE_SPEC = (name: string) =>
  `import { test } from '@gate-forge/pack-playwright/fixture';\ntest('${name}', async () => {});\n`;
const PLAIN_SPEC = (name: string) => `import { test } from 'playwright/test';\ntest('${name}', async () => {});\n`;

describe('fixture runner and Playwright runner in one suite', () => {
  it('run in file order without page observation', () => {
    const dir = makeTempProject('run-order');
    dirs.push(dir);
    writeFileSync(join(dir, 'specs/a.spec.js'), FIXTURE_SPEC('a fixture'));
    writeFileSync(join(dir, 'specs/b.spec.js'), PLAIN_SPEC('b plain'));
    writeFileSync(join(dir, 'specs/c.spec.js'), FIXTURE_SPEC('c fixture'));
    writeFileSync(
      join(dir, 'playwright.config.js'),
      "export default { testDir: './specs', workers: 1, fullyParallel: false, reporter: 'list' };\n",
    );
    const outcome = run(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', 'playwright.config.js'], {
      cwd: dir,
      env: { GATEFORGE_WITNESS_URL: '', GATEFORGE_PAGE_OBSERVATION_ENABLED: '', CI: '' },
    });
    const output = `${outcome.stdout}${outcome.stderr}`;
    expect(outcome.status, output).toBe(0);
    const order = ['a fixture', 'b plain', 'c fixture'].map((title) => output.indexOf(`› ${title}`));
    expect(order.every((index) => index >= 0), output).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });
});
