/**
 * Owner-declared trace (`runtime.yml trace`): the synthesized trusted
 * config writes the owner's Playwright trace mode into its `use.trace`
 * when the supervised run carries a value, and keeps `trace: 'off'`
 * when it does not — the default is unchanged. The consumer config is
 * never loaded, so an owner who turned traces on in their own config
 * must be able to declare the mode here; without it, `<state>/last-failures/`
 * never holds a trace.zip to diagnose a red supervised test from.
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
  const cwd = mkdtempSync(join(tmpdir(), 'gateforge-trace-cwd-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'gateforge-trace-state-'));
  DIRECTORIES.push(cwd, stateDir);
  return { cwd, stateDir };
}

describe('synthesized trace setting', () => {
  it.each(['on', 'retain-on-failure', 'on-first-retry', 'on-all-retries', 'retain-on-first-failure'] as const)(
    'writes the owner-declared trace mode %s into the generated config',
    (trace) => {
      const { cwd, stateDir } = tempDirs();
      const { configPath } = synthesizeTrustedConfig({
        cwd,
        stateDir,
        runId: 'run-1',
        reporterEntry: '/engine/reporter.js',
        testFiles: ['specs/a.spec.js'],
        trace,
      });
      expect(configPath).toBe(join(stateDir, TRUSTED_CONFIG_FILE));
      const content = readFileSync(configPath, 'utf8');
      expect(content).toContain(`"trace":"${trace}"`);
    },
  );

  it('keeps trace off when no trace mode is declared', () => {
    const { cwd, stateDir } = tempDirs();
    const { configPath } = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'run-1',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['specs/a.spec.js'],
    });
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain('"trace":"off"');
    expect(content).not.toMatch(/"trace":"(?!off")/);
  });
});
