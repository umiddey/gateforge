/**
 * First-run fix F6 (plan 2026-09-30): a consumer's Playwright config
 * that prints to STDOUT at load time (a dotenv/dotenvx banner, a stray
 * `console.log`) must not break native test enumeration. The report is
 * read from the reporter's own output file, a channel stdout noise
 * cannot corrupt.
 *
 * `engine` class: list mode only, no browser is launched, no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listNativePlaywrightTests, TestDiscoveryError } from '../src/discovery/index.js';

/** The gateforge monorepo root (the engine's own pinned playwright). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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

/** A temp project the engine's own pinned playwright can list. */
function makePlaywrightProject(files: Record<string, string>): string {
  const root = makeTempDir('gateforge-first-run-pw-');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
  }
  writeTree(root, {
    'package.json': '{ "type": "module", "private": true }\n',
    'playwright.config.js': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    ...files,
  });
  return root;
}

describe('F6: a config-time stdout banner does not break native enumeration', () => {
  it('enumerates through a reporter file when the config logs to stdout at load time', async () => {
    const root = makePlaywrightProject({
      'playwright.config.js': [
        "// a dotenvx-style banner, the shape a consumer's own .env loader prints",
        "console.log('◇ injected env (11) from .env');",
        "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };",
        '',
      ].join('\n'),
      'e2e/accounts.spec.js': [
        "import { test } from 'playwright/test';",
        "test('creates an account', async () => {});",
        '',
      ].join('\n'),
    });
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('discovered');
    expect(result.instances.map((instance) => instance.title)).toEqual(['creates an account']);
    expect(result.errors).toEqual([]);
  });

  it('names stdout pollution as the likely cause when the report itself is unreadable', async () => {
    const root = makeTempDir('gateforge-first-run-broken-');
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      // A CLI that prints a banner and no reporter document at all.
      'node_modules/@playwright/test/cli.js': [
        "console.log('◇ injected env (11) from .env');",
        'process.exit(1);',
        '',
      ].join('\n'),
      'node_modules/@playwright/test/package.json': '{ "name": "@playwright/test", "version": "1.62.1" }\n',
      'playwright.config.js': "export default { testDir: 'e2e' };\n",
      'e2e/accounts.spec.js': "import { test } from 'playwright/test';\ntest('t', () => {});\n",
    });
    await expect(listNativePlaywrightTests({ cwd: root })).rejects.toThrow(/reporter JSON/i);
  });
});
