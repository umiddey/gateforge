/**
 * First-run fix F16 (plan 2026-09-30): the static scanner must resolve
 * an import the way node/TS resolve it, so a file and a directory
 * sharing a name never makes a directory the resolution result (which
 * read as `EISDIR` and reported a false parse error against the
 * consumer's own source).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTestFiles } from '../src/discovery/index.js';

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

describe('F16: a directory never wins a specifier over a file', () => {
  it('resolves a specifier matching a generated directory to its index module', () => {
    const root = makeTempDir('gateforge-first-run-dirlayout-');
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'e2e/accounts.spec.ts': [
        "import { test as base } from '../src/client';",
        'export const test = base.extend({});',
        "test('uses the client', async () => {});",
        '',
      ].join('\n'),
      'src/client/index.ts': "import { test as pw } from 'playwright/test';\nexport const test = pw;\n",
      'src/client.gen.ts': 'export const createClient = () => ({});\n',
    });
    const result = scanTestFiles({
      cwd: root,
      include: ['e2e/**/*.spec.ts'],
      exclude: [],
    });
    expect(result.parseErrors).toEqual([]);
    expect(result.entries.map((entry) => entry.titlePath.join('>'))).toEqual(['uses the client']);
    expect(result.scannedFiles).toContain('src/client/index.ts');
  });

  it('prefers the file over a same-named directory (node/TS resolution order)', () => {
    const root = makeTempDir('gateforge-first-run-filewins-');
    writeTree(root, {
      'package.json': '{ "type": "module", "private": true }\n',
      'e2e/accounts.spec.ts': [
        "import { test as base } from './client';",
        'export const test = base.extend({});',
        "test('uses the local client', async () => {});",
        '',
      ].join('\n'),
      'e2e/client.ts': "import { test as pw } from 'playwright/test';\nexport const test = pw;\n",
      'e2e/client/index.ts': 'export const createClient = () => ({});\n',
    });
    const result = scanTestFiles({
      cwd: root,
      include: ['e2e/**/*.spec.ts'],
      exclude: [],
    });
    expect(result.parseErrors).toEqual([]);
    expect(result.scannedFiles).toContain('e2e/client.ts');
    expect(result.scannedFiles).not.toContain('e2e/client');
  });
});
