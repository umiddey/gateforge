/**
 * First-run fix F7 (plan 2026-09-30): the pack's own pinned
 * `playwright` must not outrank the consumer's `@playwright/test`, and
 * a genuine two-version conflict must be named as one instead of as a
 * missing dependency.
 *
 * `engine` class: the version skew is reproduced with FAKE local CLIs
 * (one that lists, one that fails to load the project) rather than a
 * second installed playwright — no network install, no browser.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listNativePlaywrightTests,
  localPlaywrightCliCandidates,
} from '../src/discovery/index.js';

/** Temp dirs to remove after each test. */
const tempDirs: string[] = [];

function makeTempDir(prefix = 'gateforge-first-run-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes a file tree (repo-relative posix keys) into a temp project. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [key, content] of Object.entries(files)) {
    const absolute = join(root, key);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

/** A fake local playwright CLI that honours the reporter output file. */
function fakeListingCli(version: string, errorMessage: string | null): string {
  return [
    `const version = ${JSON.stringify(version)};`,
    `const errorMessage = ${JSON.stringify(errorMessage)};`,
    'const fs = require("node:fs");',
    'const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;',
    'const report = {',
    '  config: { rootDir: process.cwd(), version },',
    '  suites: errorMessage',
    '    ? []',
    '    : [{ title: "", file: "e2e/accounts.spec.js", specs: [{',
    "        title: 't', id: 'spec-1', line: 2, column: 0,",
    '        tests: [{ projectName: "chromium", projectId: "chromium", expectedStatus: "passed" }],',
    '      }] }],',
    '  errors: errorMessage === null ? [] : [{ message: errorMessage }],',
    '  stats: {},',
    '};',
    'const text = JSON.stringify(report);',
    'if (out) { fs.writeFileSync(out, text); } else { console.log(text); }',
    'process.exit(0);',
    '',
  ].join('\n');
}

describe('F7: the consumer\'s own runner outranks the pack\'s pinned playwright', () => {
  it('prefers @playwright/test over a plain playwright install at the same root', () => {
    const root = makeTempDir('gateforge-first-run-cli-order-');
    const candidates = localPlaywrightCliCandidates(root);
    const test = candidates.findIndex((candidate) => candidate.includes(join('@playwright', 'test')));
    const plain = candidates.findIndex((candidate) => candidate.endsWith(join('playwright', 'cli.js')));
    expect(test).toBeGreaterThanOrEqual(0);
    expect(plain).toBeGreaterThanOrEqual(0);
    expect(test).toBeLessThan(plain);
  });

  it('resolves the consumer runner from the config directory upward', () => {
    const root = makeTempDir('gateforge-first-run-cli-up-');
    mkdirSync(join(root, 'frontend'), { recursive: true });
    const candidates = localPlaywrightCliCandidates(join(root, 'frontend'));
    // The config directory's own install first, then the repo root's.
    expect(candidates[0]).toBe(join(root, 'frontend', 'node_modules', '@playwright', 'test', 'cli.js'));
    expect(candidates).toContain(join(root, 'node_modules', '@playwright', 'test', 'cli.js'));
  });

  it('enumerates through the consumer version when the pack pin would fail to load it', async () => {
    const root = makeTempDir('gateforge-first-run-version-skew-');
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'playwright.config.js': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
      'e2e/accounts.spec.js': "import { test } from 'playwright/test';\ntest('t', async () => {});\n",
    });
    // The consumer's own CLI (1.62.1): lists the project.
    writeTree(root, {
      'node_modules/@playwright/test/package.json':
        '{ "name": "@playwright/test", "version": "1.62.1" }\n',
      'node_modules/@playwright/test/cli.js': fakeListingCli('1.62.1', null),
    });
    // The pack's hoisted pin (1.58.2) against a 1.62.1 config: the
    // two-versions conflict the pack's own comment says it must avoid.
    writeTree(root, {
      'node_modules/playwright/package.json': '{ "name": "playwright", "version": "1.58.2" }\n',
      'node_modules/playwright/cli.js': fakeListingCli(
        '1.58.2',
        'Error: Playwright Test did not expect test() to be called here.',
      ),
    });
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('discovered');
    expect(result.instances.map((instance) => instance.title)).toEqual(['t']);
  });

  it('names both versions and the real cause when the conflict is genuine', async () => {
    const root = makeTempDir('gateforge-first-run-conflict-');
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'playwright.config.js': "export default { testDir: 'e2e' };\n",
      'e2e/accounts.spec.js': "import { test } from 'playwright/test';\ntest('t', async () => {});\n",
      'node_modules/@playwright/test/package.json':
        '{ "name": "@playwright/test", "version": "1.62.1" }\n',
      'node_modules/@playwright/test/cli.js': fakeListingCli(
        '1.62.1',
        'Error: Playwright Test did not expect test() to be called here.',
      ),
      'node_modules/playwright/package.json': '{ "name": "playwright", "version": "1.58.2" }\n',
      'node_modules/playwright/cli.js': fakeListingCli(
        '1.58.2',
        'Error: Playwright Test did not expect test() to be called here.',
      ),
    });
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('discovered');
    expect(result.errors).toHaveLength(1);
    const reported = result.errors[0] ?? '';
    expect(reported).toMatch(/1\.62\.1/);
    expect(reported).toMatch(/1\.58\.2/);
    expect(reported).toMatch(/did not expect test\(\) to be called here/);
    expect(reported).not.toMatch(/missing test dependency/i);
  });
});
