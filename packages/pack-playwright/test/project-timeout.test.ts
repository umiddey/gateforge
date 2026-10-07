/**
 * Per-project test timeout (supervised runs honour the consumer's declared
 * timeout without ever loading the consumer config):
 *
 * - the list-mode JSON reader keeps the runner-resolved
 *   `config.projects[].timeout` per project NAME (data, never code);
 * - the synthesized trusted config writes that value as the project's own
 *   `timeout`, and keeps the engine default (60_000) when the runner
 *   reported none (or a non-positive / non-finite one).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listNativePlaywrightTests } from '../src/discovery/reconcile.js';
import { effectiveProjectTimeoutMs, synthesizeTrustedConfig } from '../src/discovery/trusted-config.js';

/** The gateforge monorepo root (for playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gateforge-timeout-${prefix}-`));
  DIRECTORIES.push(dir);
  return dir;
}

function configFor(scopes: Parameters<typeof synthesizeTrustedConfig>[0]['projectScopes'], projects: string[]): string {
  const { configPath } = synthesizeTrustedConfig({
    cwd: tempDir('cwd'),
    stateDir: tempDir('state'),
    runId: 'timeout-run',
    reporterEntry: '/engine/reporter.js',
    testFiles: ['tests/a.spec.ts', 'tests/b.spec.ts'],
    projects,
    ...(scopes === undefined ? {} : { projectScopes: scopes }),
  });
  return readFileSync(configPath, 'utf8');
}

describe('effectiveProjectTimeoutMs', () => {
  it.each([
    [30_000, 60_000],
    [60_000, 60_000],
    [60_001, 60_001],
    [180_000, 180_000],
    [0, 60_000],
    [-5, 60_000],
    [Number.NaN, 60_000],
    [Number.POSITIVE_INFINITY, 60_000],
    [undefined, 60_000],
  ])('reported %s -> %s', (reported, expected) => {
    expect(effectiveProjectTimeoutMs(reported)).toBe(expected);
  });
});

describe('synthesized per-project timeout', () => {
  it('writes the runner-reported timeout on a lone project scope', () => {
    const content = configFor(
      [{ name: 'chromium', files: ['tests/a.spec.ts', 'tests/b.spec.ts'], timeoutMs: 180_000 }],
      ['chromium'],
    );
    expect(content).toContain('projects: [{"name":"chromium","timeout":180000}]');
    // The engine default stays the global fallback for unscoped files.
    expect(content).toContain('timeout: 60000,');
  });

  it('writes each project its OWN reported timeout in a multi-project config', () => {
    const content = configFor(
      [
        { name: 'setup', files: ['tests/a.spec.ts'], timeoutMs: 30_000 },
        { name: 'chromium', files: ['tests/b.spec.ts'], dependencies: ['setup'], timeoutMs: 180_000 },
      ],
      ['chromium', 'setup'],
    );
    // `setup` reported Playwright's own 30 s default: the 60 s floor applies,
    // so it carries no timeout of its own.
    expect(content).toContain(
      'projects: [{"name":"chromium","testMatch":["tests/b.spec.ts"],"timeout":180000,"dependencies":["setup"]},' +
        '{"name":"setup","testMatch":["tests/a.spec.ts"]}]',
    );
  });

  it('keeps the 60_000 default when the scope carries no timeout', () => {
    const content = configFor([{ name: 'chromium', files: ['tests/a.spec.ts', 'tests/b.spec.ts'] }], ['chromium']);
    expect(content).toContain('projects: [{"name":"chromium"}]');
    expect(content).toContain('timeout: 60000,');
    expect(content).not.toContain('"timeout"');
  });

  it.each([0, -5, 30_000, 60_000, Number.NaN, Number.POSITIVE_INFINITY])(
    'keeps the default for a reported timeout of %s (floor, non-positive, non-finite)',
    (timeoutMs) => {
      const content = configFor([{ name: 'chromium', files: ['tests/a.spec.ts'], timeoutMs }], ['chromium']);
      expect(content).toContain('projects: [{"name":"chromium"}]');
      expect(content).not.toContain('"timeout"');
    },
  );

  it('never changes any other synthesized setting', () => {
    const plain = configFor([{ name: 'chromium', files: ['tests/a.spec.ts', 'tests/b.spec.ts'] }], ['chromium']);
    const timed = configFor(
      [{ name: 'chromium', files: ['tests/a.spec.ts', 'tests/b.spec.ts'], timeoutMs: 180_000 }],
      ['chromium'],
    );
    const strip = (text: string): string =>
      text
        .replace(/gateforge-timeout-(cwd|state)-[^"/]+/g, 'DIR')
        .replace(',"timeout":180000', '');
    expect(strip(timed)).toBe(strip(plain));
  });
});

/** A project tree whose playwright config declares per-project timeouts. */
function writeTimeoutProject(configSource: string): string {
  const root = tempDir('list');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
  }
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "private": true }\n', 'utf8');
  writeFileSync(join(root, 'playwright.config.js'), configSource, 'utf8');
  writeFileSync(
    join(root, 'x.spec.js'),
    "import { test } from 'playwright/test';\ntest('x', async () => {});\n",
    'utf8',
  );
  return root;
}

describe('list-mode reader keeps the runner-resolved project timeout', () => {
  it('maps config.projects[].timeout by project name from the real runner', async () => {
    const root = writeTimeoutProject(
      "export default { testDir: '.', projects: [{ name: 'chromium', timeout: 180000 }, { name: 'slow', timeout: 240000 }] };\n",
    );
    const result = await listNativePlaywrightTests({ cwd: root });
    expect(result.status).toBe('discovered');
    expect(result.projectTimeouts).toEqual({ chromium: 180_000, slow: 240_000 });
  });

  it('inherits a config-level timeout and drops a no-timeout (0) project', async () => {
    const root = writeTimeoutProject(
      "export default { testDir: '.', timeout: 120000, projects: [{ name: 'a' }, { name: 'b', timeout: 5000 }, { name: 'c', timeout: 0 }] };\n",
    );
    const result = await listNativePlaywrightTests({ cwd: root });
    // `0` is Playwright's "no timeout": never carried, so the engine
    // default applies to that project.
    expect(result.projectTimeouts).toEqual({ a: 120_000, b: 5_000 });
  });
});
