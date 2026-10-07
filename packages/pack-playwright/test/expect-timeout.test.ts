/**
 * Owner-declared assertion timeout (`runtime.yml expectTimeoutSeconds`,
 * carried as `expectTimeoutMs`): the synthesized trusted config writes
 * `expect.timeout` when the supervised run carries a value and emits no
 * `expect` key when it does not — Playwright's own 5-second default
 * stands. The consumer config is never loaded, so an owner who raised
 * the assertion timeout there must be able to declare it to the
 * supervisor in the runtime document.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { synthesizeTrustedConfig, TRUSTED_CONFIG_FILE } from '../src/discovery/trusted-config.js';

const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDirs(): { cwd: string; stateDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'gateforge-expect-cwd-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'gateforge-expect-state-'));
  DIRECTORIES.push(cwd, stateDir);
  return { cwd, stateDir };
}

describe('synthesized expect timeout', () => {
  it('writes the owner-declared expect timeout into the generated config', () => {
    const { cwd, stateDir } = tempDirs();
    const { configPath } = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'run-1',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['specs/a.spec.js'],
      expectTimeoutMs: 15_000,
    });
    expect(configPath).toBe(join(stateDir, TRUSTED_CONFIG_FILE));
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('expect: { timeout: 15000 },');
  });

  it('emits no expect key when no expect timeout is declared', () => {
    const { cwd, stateDir } = tempDirs();
    const { configPath } = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'run-1',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['specs/a.spec.js'],
    });
    const content = readFileSync(configPath, 'utf8');
    expect(content).not.toMatch(/expect:/);
  });
});
