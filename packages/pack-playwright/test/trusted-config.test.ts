/**
 * Trusted-config synthesis unit tests (execution-authority fix): the
 * synthesized config never references the consumer config, forces the
 * engine reporter by absolute entry with parent-side paths as options,
 * pins serial/zero-retry/forbid-only, and carries the exact selected
 * files + bare project names as data.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  synthesizeTrustedConfig,
  TRUSTED_CONFIG_FILE,
  trustedReporterEntry,
} from '../src/discovery/trusted-config.js';

const DIRECTORIES: string[] = [];

afterEach(() => {
  for (const dir of DIRECTORIES.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDirs(): { cwd: string; stateDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'gateforge-trusted-cwd-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'gateforge-trusted-state-'));
  DIRECTORIES.push(cwd, stateDir);
  return { cwd, stateDir };
}

describe('synthesizeTrustedConfig', () => {
  it('writes a trusted config forcing the engine reporter with parent-side options', () => {
    const { cwd, stateDir } = tempDirs();
    const { configPath, reporterOptions } = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'run-1',
      reporterEntry: '/engine/reporter.js',
      appBaseUrl: 'http://127.0.0.1:43127',
      storageState: '/tmp/e2e/.auth/contractor.json',
      testFiles: ['specs/a.spec.js', 'specs/b.spec.js'],
      projects: ['chromium'],
    });
    expect(configPath).toBe(join(stateDir, TRUSTED_CONFIG_FILE));
    const content = readFileSync(configPath, 'utf8');
    // The consumer config is never referenced.
    expect(content).not.toMatch(/playwright\.config/);
    // Exact selected files + bare projects as data.
    expect(content).toContain(JSON.stringify(['specs/a.spec.js', 'specs/b.spec.js']));
    expect(content).toContain('"baseURL":"http://127.0.0.1:43127"');
    expect(content).toContain('"storageState":"/tmp/e2e/.auth/contractor.json"');
    expect(content).toContain('"chromium"');
    // Engine reporter forced by absolute entry with embedded options.
    expect(content).toContain('/engine/reporter.js');
    expect(content).toContain(join(stateDir, 'runner-outcomes.json'));
    // Serial, zero-retry, forbid-only, headless.
    expect(content).toContain('workers: 1');
    expect(content).toContain('retries: 0');
    expect(content).toContain('forbidOnly: true');
    // No consumer-code hooks survive synthesis.
    expect(content).not.toMatch(/globalSetup|globalTeardown|webServer/);
    expect(reporterOptions.stateDir).toBe(stateDir);
    expect(reporterOptions.runId).toBe('run-1');
    expect(reporterOptions.outcomesPath).toBe(join(stateDir, 'runner-outcomes.json'));
  });

  it('omits testMatch/projects when nothing was selected (runner default)', () => {
    const { cwd, stateDir } = tempDirs();
    const { configPath } = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'run-1',
      reporterEntry: '/engine/reporter.js',
    });
    const content = readFileSync(configPath, 'utf8');
    expect(content).not.toContain('testMatch');
    expect(content).not.toContain('projects');
  });

  it('deduplicates and sorts files and projects deterministically', () => {
    const { cwd, stateDir } = tempDirs();
    const first = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'run-1',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['z.spec.js', 'a.spec.js', 'a.spec.js'],
      projects: ['firefox', 'chromium', 'chromium'],
    });
    const secondState = mkdtempSync(join(tmpdir(), 'gateforge-trusted-state-'));
    DIRECTORIES.push(secondState);
    const second = synthesizeTrustedConfig({
      cwd,
      stateDir: secondState,
      runId: 'run-1',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['a.spec.js', 'z.spec.js'],
      projects: ['chromium', 'firefox'],
    });
    const normalize = (content: string): string =>
      content.replaceAll(stateDir, '<state>').replaceAll(secondState, '<state>');
    expect(normalize(readFileSync(first.configPath, 'utf8'))).toBe(
      normalize(readFileSync(second.configPath, 'utf8')),
    );
  });

  it('scopes test files per project, leaving unscoped files in the global match', () => {
    const { cwd, stateDir } = tempDirs();
    const { configPath } = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'setup-dep',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['tests/auth.setup.ts', 'tests/feature.spec.ts', 'tests/other.spec.ts'],
      projects: ['chromium', 'setup'],
      projectScopes: [
        { name: 'setup', files: ['tests/auth.setup.ts'] },
        { name: 'chromium', files: ['tests/feature.spec.ts'] },
      ],
    });
    const content = readFileSync(configPath, 'utf8');
    // Each project carries ONLY the files the plan attributed to it: a
    // global match would run the whole suite once per project.
    expect(content).toContain(
      `projects: [{"name":"chromium","testMatch":["tests/feature.spec.ts"]},{"name":"setup","testMatch":["tests/auth.setup.ts"]}]`,
    );
    // The file no project scope claims keeps running, via the global match.
    expect(content).toContain(`testMatch: ["tests/other.spec.ts"]`);
    expect(content).not.toContain('null');
  });

  it('drops a project scope that owns no file instead of running it empty', () => {
    const { cwd, stateDir } = tempDirs();
    const { configPath } = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'empty-scope',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['tests/feature.spec.ts'],
      projects: ['chromium', 'setup'],
      projectScopes: [
        { name: 'chromium', files: ['tests/feature.spec.ts'] },
        { name: 'setup', files: [] },
      ],
    });
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain(`projects: [{"name":"chromium","testMatch":["tests/feature.spec.ts"]}]`);
    expect(content).not.toContain('"setup"');
  });

  it('selects the same files with or without a scope that owns them all', () => {
    const { cwd, stateDir } = tempDirs();
    const plain = synthesizeTrustedConfig({
      cwd,
      stateDir,
      runId: 'no-scope',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['specs/a.spec.js', 'specs/b.spec.js'],
      projects: ['chromium'],
    });
    const otherState = mkdtempSync(join(tmpdir(), 'gateforge-trusted-state-'));
    DIRECTORIES.push(otherState);
    const scoped = synthesizeTrustedConfig({
      cwd,
      stateDir: otherState,
      runId: 'no-scope',
      reporterEntry: '/engine/reporter.js',
      testFiles: ['specs/a.spec.js', 'specs/b.spec.js'],
      projects: ['chromium'],
      projectScopes: [{ name: 'chromium', files: ['specs/a.spec.js', 'specs/b.spec.js'] }],
    });
    // One project owning every selected file selects exactly the same set a
    // global testMatch does, so a single-project run is unaffected by the
    // scoping: only the `projects:` shape differs.
    const plainContent = readFileSync(plain.configPath, 'utf8');
    const scopedContent = readFileSync(scoped.configPath, 'utf8');
    expect(plainContent).toContain('testMatch: ["specs/a.spec.js","specs/b.spec.js"]');
    expect(scopedContent).toContain(
      'projects: [{"name":"chromium","testMatch":["specs/a.spec.js","specs/b.spec.js"]}]',
    );
    // Every selected file is still selected exactly once.
    expect(scopedContent.match(/specs\/[ab]\.spec\.js/g)).toHaveLength(2);
  });

  it('trustedReporterEntry resolves to the pack dist reporter', () => {
    const entry = trustedReporterEntry();
    expect(entry.endsWith(join('dist', 'reporter', 'reporter.js'))).toBe(true);
  });
});
