import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { autoSessionNodeOptions } from '../src/fixture/auto-session-env.js';
import { supervisedRunnerChildEnv } from '../src/discovery/supervised-run.js';

const hook = fileURLToPath(new URL('../dist/fixture/auto-session.cjs', import.meta.url));
describe('witnessed Playwright preload environment', () => {
  it.each([
    'node_modules/playwright/lib/common/process.js',
    'node_modules/playwright/lib/worker/workerProcessEntry.js',
    'node_modules/playwright/lib/loader/loaderProcessEntry.js',
  ])('fails loud rather than skipping the fixture in fork entry %s', (entry) => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-preload-fork-'));
    try {
      const script = join(root, entry);
      mkdirSync(join(script, '..'), { recursive: true });
      writeFileSync(script, "console.log('worker continued without fixture');\n");
      // Select this deliberately incomplete consumer install, not the pack fallback.
      writeFileSync(join(root, 'node_modules/playwright/cli.js'), '');
      const child = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GATEFORGE_WITNESS_URL: 'http://127.0.0.1:9',
          GATEFORGE_PLAYWRIGHT_CONFIG_DIR: root,
          NODE_OPTIONS: autoSessionNodeOptions(undefined),
        },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain(`gateforge auto-session: cannot load the witnessed fixture for runner ${script}`);
      expect(child.stderr).toContain("Cannot find module 'playwright/test'");
      expect(child.stdout).not.toContain('worker continued without fixture');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['app/server.js', 'node_modules/playwright/helper.js', 'node_modules/playwright/cli.js'])(
    'leaves unrelated process %s untouched even with inherited worker metadata', (entry) => {
      const root = mkdtempSync(join(tmpdir(), 'gateforge-preload-helper-'));
      try {
        const script = join(root, entry);
        mkdirSync(join(script, '..'), { recursive: true });
        writeFileSync(script, "console.log('untouched helper');\n");
        const child = spawnSync(process.execPath, [script], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_WORKER_INDEX: '1',
            GATEFORGE_WITNESS_URL: 'http://127.0.0.1:9',
            GATEFORGE_PLAYWRIGHT_CONFIG_DIR: root,
            NODE_OPTIONS: autoSessionNodeOptions(undefined),
          },
        });
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        expect(child.stdout.trim()).toBe('untouched helper');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('registers Gateforge page routing fixtures on a plain import in a real runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-preload-real-runner-'));
    // The default is the repository's pinned runner. Supply an independent
    // install to exercise another real version without re-resolving this repo.
    const runnerRequire = process.env['GATEFORGE_TEST_PLAYWRIGHT_INSTALL']
      ? createRequire(join(process.env['GATEFORGE_TEST_PLAYWRIGHT_INSTALL'], 'package.json'))
      : createRequire(import.meta.url);
    try {
      for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
        const manifest = runnerRequire.resolve(`${name}/package.json`);
        const target = join(root, 'node_modules', name);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(dirname(manifest), target, { recursive: true, dereference: true });
      }
      writeFileSync(join(root, 'package.json'), '{"type":"module","private":true}\n');
      writeFileSync(join(root, 'playwright.config.mjs'), 'export default {testDir:".",workers:1,retries:0,use:{headless:true}};\n');
      writeFileSync(join(root, 'automatic.spec.mjs'), [
        "import { test, expect } from '@playwright/test';",
        "test('plain import owns the witnessed page fixtures', async ({ page, surface, browserPages }) => {",
        '  expect(browserPages).toBeUndefined();',
        '  expect(surface).toBeUndefined();',
        "  await page.goto('data:text/html,<h1>automatic fixture</h1>');",
        "  await expect(page.locator('h1')).toHaveText('automatic fixture');",
        '});',
      ].join('\n'));
      // Native Playwright rejects surface/browserPages as unknown fixtures.
      // No witness is needed for registration; real proxy traffic is covered
      // by the supervised browser suites and consumer witnessed proof.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GATEFORGE_')));
      const child = spawnSync(process.execPath, [join(root, 'node_modules/playwright/cli.js'), 'test', '--reporter=line'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...env, GATEFORGE_PLAYWRIGHT_CONFIG_DIR: root, NODE_OPTIONS: autoSessionNodeOptions(undefined) },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr + child.stdout).toBe(0);
      expect(child.stdout).toContain('1 passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
  it('fails closed with the selected runner and cause when its fixture cannot load', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-preload-missing-runner-'));
    try {
      const cli = join(root, 'node_modules/playwright/cli.js');
      mkdirSync(join(root, 'node_modules/playwright'), { recursive: true });
      writeFileSync(cli, "console.log('runner continued without fixture');\n");
      const child = spawnSync(process.execPath, [cli, 'test'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GATEFORGE_WITNESS_URL: 'http://127.0.0.1:9',
          GATEFORGE_PLAYWRIGHT_CONFIG_DIR: root,
          NODE_OPTIONS: autoSessionNodeOptions(undefined),
        },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain(`gateforge auto-session: cannot load the witnessed fixture for runner ${cli}`);
      expect(child.stderr).toContain("Cannot find module 'playwright/test'");
      expect(child.stdout).not.toContain('runner continued without fixture');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('quotes the shipped hook and preserves existing options', () => {
    expect(autoSessionNodeOptions('--max-old-space-size=512')).toBe(`--max-old-space-size=512 --require ${JSON.stringify(hook)}`);
  });
  it('adds the hook only to witnessed children', () => {
    expect(supervisedRunnerChildEnv({}, process.cwd(), {})['NODE_OPTIONS']).toBeUndefined();
    expect(supervisedRunnerChildEnv({ GATEFORGE_WITNESS_URL: 'http://127.0.0.1:1' }, process.cwd(), {})['NODE_OPTIONS']).toBe(`--require ${JSON.stringify(hook)}`);
  });
  it('retains supervisor-supplied options without admitting ambient loader controls', () => {
    const child = supervisedRunnerChildEnv({ GATEFORGE_WITNESS_URL: 'http://127.0.0.1:1', NODE_OPTIONS: '--max-old-space-size=512' }, process.cwd(), { NODE_OPTIONS: '--require unwanted.cjs' });
    expect(child['NODE_OPTIONS']).toBe(`--max-old-space-size=512 --require ${JSON.stringify(hook)}`);
  });
  it('forwards root properties without changing either the fixture or the real runner', () => {
    const forwardRoot = createRequire(import.meta.url)('../src/fixture/auto-session-root.cjs');
    const root = { test: {}, request: {}, chromium: { name: 'original' }, defineConfig: () => 'config' };
    const fixture = new Proxy({ extend: () => 'tracked extension' }, {});
    const request = { newContext: () => 'direct context' };
    const fixtureKeys = Reflect.ownKeys(fixture);
    const forwarded = forwardRoot(root, fixture, request);
    expect(forwarded).not.toBe(fixture);
    expect(forwarded.test).toBe(forwarded);
    expect(forwarded.request).toBe(request);
    expect(forwarded.extend()).toBe('tracked extension');
    expect(forwarded.defineConfig).toBe(root.defineConfig);
    root.chromium = { name: 'updated' };
    expect(forwarded.chromium).toBe(root.chromium);
    expect(root.test).not.toBe(fixture);
    expect(root.request).not.toBe(request);
    expect(Reflect.ownKeys(fixture)).toEqual(fixtureKeys);
    expect('test' in fixture).toBe(false);
    expect('request' in fixture).toBe(false);
    expect('chromium' in fixture).toBe(false);
    expect('request' in forwarded).toBe(true);
    expect('chromium' in forwarded).toBe(true);
  });
});
