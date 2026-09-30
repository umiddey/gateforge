/** Real module-loading boundaries and runner execution; no network installs or browser needed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listNativePlaywrightTests } from '../src/discovery/reconcile.js';
import { executeSupervisedPlaywright } from '../src/discovery/supervised-run.js';

const requireFrom = createRequire(import.meta.url);
const packRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureEntry = pathToFileURL(join(packRoot, 'dist/index.js')).href;
const directories: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-runner-binding-'));
  directories.push(root);
  writeTree(root, { 'package.json': '{"type":"module","private":true}' });
  return root;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function copyRealRunner(root: string): string {
  const manifest = requireFrom.resolve('playwright/package.json');
  const core = createRequire(manifest).resolve('playwright-core/package.json');
  const modules = join(root, 'node_modules');
  mkdirSync(modules, { recursive: true });
  cpSync(dirname(manifest), join(modules, 'playwright'), { recursive: true, dereference: true });
  cpSync(dirname(core), join(modules, 'playwright-core'), { recursive: true, dereference: true });
  return join(modules, 'playwright', 'cli.js');
}

function maliciousRunner(root: string): string {
  const marker = join(root, 'candidate-executed');
  writeTree(root, {
    'node_modules/@playwright/test/package.json': '{"name":"@playwright/test","main":"index.cjs"}',
    'node_modules/@playwright/test/cli.js': 'throw new Error("A farther runner was selected");',
    'node_modules/@playwright/test/index.cjs':
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n` +
      "throw Object.assign(new Error('Broken consumer install'), { code: 'BROKEN_CONSUMER_RUNNER' });\n",
  });
  return marker;
}

const spec = [
  `import { test, expect } from ${JSON.stringify(fixtureEntry)};`,
  "test('verifier material stays outside the runner', async () => {",
  "  expect(Boolean(process.env.GATEFORGE_WITNESS_VERIFIER_KEY)).toBe(false);",
  '});',
].join('\n');

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('consumer runner binding', () => {
  it('does not execute a candidate runner when the trusted process imports the pack root', () => {
    const root = tempProject();
    const marker = maliciousRunner(root);
    const env = { ...process.env };
    delete env['GATEFORGE_PLAYWRIGHT_CONFIG_DIR'];
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(fixtureEntry)});`], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('preserves a selected broken runner error instead of silently loading the pack fallback', () => {
    const root = tempProject();
    const marker = maliciousRunner(root);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', [
      // Intentional dynamic import: exercise the selected module's actual failure boundary.
      `try { await import(${JSON.stringify(fixtureEntry)}); }`,
      "catch (error) { process.exitCode = error.code === 'BROKEN_CONSUMER_RUNNER' ? 77 : 78; }",
    ].join('\n')], {
      cwd: root,
      env: { ...process.env, GATEFORGE_PLAYWRIGHT_CONFIG_DIR: root },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(77);
    expect(existsSync(marker)).toBe(true);
  });

  it('uses an independent non-root runner for both enumeration and supervised fixture execution', async () => {
    const root = tempProject();
    const frontend = join(root, 'frontend');
    const marker = maliciousRunner(root);
    const cli = copyRealRunner(frontend);
    writeTree(root, {
      'frontend/playwright.config.mjs': "import { defineConfig } from 'playwright/test';\nexport default defineConfig({testDir:'tests',projects:[{name:'chromium'}]});\n",
      'frontend/tests/binding.spec.mjs': spec,
    });
    // Plain Playwright has no engine-set child context; the fixture must reuse its cached runner.
    const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GATEFORGE_')));
    const raw = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json'], {
      cwd: frontend, env: rawEnv, encoding: 'utf8', timeout: 30_000,
    });
    expect(raw.status, raw.stderr).toBe(0);
    const report = JSON.parse(raw.stdout) as { suites: Array<{ specs: Array<{ title: string }> }> };
    expect(report.suites.flatMap((suite) => suite.specs.map((entry) => entry.title))).toEqual([
      'verifier material stays outside the runner',
    ]);
    const native = await listNativePlaywrightTests({ cwd: root });
    expect(native.errors).toEqual([]);
    expect(native.instances.map((instance) => instance.file)).toEqual(['frontend/tests/binding.spec.mjs']);
    vi.stubEnv('GATEFORGE_WITNESS_VERIFIER_KEY', 'must-stay-in-the-supervisor');
    const stateDir = join(root, '.state');
    mkdirSync(stateDir);
    const execution = await executeSupervisedPlaywright(
      { logicalKeys: ['binding'] },
      { stateDir, runId: 'binding', vars: {} },
      { cwd: root, testFiles: ['frontend/tests/binding.spec.mjs'], projects: ['chromium'], timeoutMs: 30_000 },
    );
    expect(execution.processExit, execution.incompleteDetail).toBe(0);
    expect(execution.outcomes.map((outcome) => ({ logicalKey: outcome.logicalKey, status: outcome.status }))).toEqual([
      { logicalKey: 'frontend/tests/binding.spec.mjs#verifier material stays outside the runner', status: 'passed' },
    ]);
    expect(existsSync(marker)).toBe(false);
  }, 90_000);

  it('executes the fixture through the pinned fallback when the repository installs no runner', async () => {
    const root = tempProject();
    writeTree(root, {
      'playwright.config.mjs': "export default {testDir:'tests',projects:[{name:'chromium'}]};",
      'tests/binding.spec.mjs': spec,
    });
    const stateDir = join(root, '.state');
    mkdirSync(stateDir);
    const native = await listNativePlaywrightTests({ cwd: root });
    expect(native.errors).toEqual([]);
    expect(native.instances.map((instance) => instance.file)).toEqual(['tests/binding.spec.mjs']);
    const execution = await executeSupervisedPlaywright(
      { logicalKeys: ['fallback'] },
      { stateDir, runId: 'fallback', vars: {} },
      { cwd: root, testFiles: ['tests/binding.spec.mjs'], projects: ['chromium'], timeoutMs: 30_000 },
    );
    expect(execution.processExit, execution.incompleteDetail).toBe(0);
    expect(execution.outcomes.map((outcome) => ({ logicalKey: outcome.logicalKey, status: outcome.status }))).toEqual([
      { logicalKey: 'tests/binding.spec.mjs#verifier material stays outside the runner', status: 'passed' },
    ]);
  }, 90_000);
});
