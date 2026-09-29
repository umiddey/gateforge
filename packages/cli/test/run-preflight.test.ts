/**
 * Managed-run preconditions (managed-run plan (2026-09-29), Part B, feedback E56):
 * the `run` section of `gateforge enforcement doctor`.
 *
 * The three expensive local mistakes each get their own honest line and
 * their own `--strict-preflight` exit: a missing verifier key, a wrong
 * interpreter path, and an unreachable target URL. The default doctor
 * keeps its report-only exit behavior, and a repository with no recipe
 * and no provisioned pin still reports every line instead of inventing
 * one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withTempRepo, type TempRepo } from '@gate-forge/core';
import { installFixture, runCli } from './helpers.js';
import { VERIFIER_KEY_FILE_ENV } from '../src/commands/common.js';

/** One precondition line. */
interface RunLine {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/** The `run` section of the doctor report. */
interface RunSection {
  ready: boolean;
  checks: RunLine[];
}

/** Temporary key rings to clean up. */
const keyDirectories: string[] = [];

afterEach(() => {
  for (const directory of keyDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * Writes an external owner-only verifier key ring.
 *
 * Returns:
 *   string: absolute path of the key file.
 */
function externalVerifierKey(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gateforge-preflight-key-'));
  keyDirectories.push(directory);
  const file = join(directory, 'keys.json');
  writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 1, activeKeyId: 'preflight-key', keys: { 'preflight-key': 'preflight-verifier-key' } })}\n`,
    { mode: 0o600 },
  );
  return file;
}

/**
 * Reads the `run` section out of a doctor JSON report.
 *
 * Args:
 *   stdout: the doctor's JSON output.
 *
 * Returns:
 *   RunSection: the preflight section.
 */
function runSection(stdout: string): RunSection {
  const report = JSON.parse(stdout) as { run: RunSection };
  return report.run;
}

/**
 * Selects one precondition line by id.
 *
 * Args:
 *   section: the run section.
 *   id: the check id.
 *
 * Returns:
 *   RunLine: the matching line.
 */
function line(section: RunSection, id: string): RunLine {
  const found = section.checks.find((check) => check.id === id);
  expect(found, `run check '${id}' present`).toBeTruthy();
  return found as RunLine;
}

/**
 * Turns the fixture project into a python-backed one whose suite runs
 * the given interpreter.
 *
 * Args:
 *   repo: the fixture repository.
 *   interpreter: argv[0] of the configured suite.
 */
function makePytestProject(repo: TempRepo, interpreter: string): void {
  const config = readFileSync(join(repo.root, '.gateforge.yml'), 'utf8');
  repo.writeFiles({
    '.gateforge.yml': `${config}${[
      'runner: pytest',
      'diagnostics:',
      '  suites:',
      '    - name: unit',
      '      runner: pytest',
      '      cwd: .',
      `      argv: ['${interpreter}', '-m', 'pytest']`,
      '      testPaths: [tests]',
      '      timeoutMs: 60000',
      '',
    ].join('\n')}`,
  });
}

describe('doctor run section (report-only by default)', () => {
  it('reports every precondition line, and the default doctor still exits 0', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['enforcement', 'doctor', '--json']);
      expect(result.code).toBe(0);
      const section = runSection(result.stdout);
      expect(section.checks.map((check) => check.id)).toEqual([
        'verifier-key',
        'approved-policy',
        'runner',
        'interpreter',
        'bytecode-safety',
        'target',
        'app-healthcheck',
        'host-load',
        'candidate-tree',
      ]);
      // A bare fixture has no installed runner: the line is honest about it.
      expect(line(section, 'runner').status).toBe('fail');
      expect(line(section, 'runner').detail).toContain('npm install --save-dev playwright');
      expect(line(section, 'interpreter').status).toBe('ok');
      expect(line(section, 'app-healthcheck').detail).toContain('gateforge run starts nothing');
    });
  });

  it('the text surface prints the run section with one line per precondition', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const result = await runCli(repo, ['enforcement', 'doctor']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('run preconditions (read-only; `gateforge run` consumes these)');
      expect(result.stdout).toContain('[FAIL] verifier-key:');
      expect(result.stdout).toContain('fix: gateforge key create --confirm');
    });
  });
});

describe('doctor run preconditions (each mistake its own line)', () => {
  it('a missing verifier key is a FAIL naming the fix, and --strict-preflight exits 1', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const report = await runCli(repo, ['enforcement', 'doctor', '--json'], { [VERIFIER_KEY_FILE_ENV]: undefined });
      expect(report.code).toBe(0);
      const section = runSection(report.stdout);
      expect(line(section, 'verifier-key').status).toBe('fail');
      expect(line(section, 'verifier-key').detail).toContain('gateforge key create --confirm');
      expect(section.ready).toBe(false);
      const strict = await runCli(repo, ['enforcement', 'doctor', '--strict-preflight'], { [VERIFIER_KEY_FILE_ENV]: undefined });
      expect(strict.code).toBe(1);
      expect(strict.stdout).toContain('[FAIL] verifier-key:');
    });
  });

  it('an external verifier key turns the line PASS and the strict preflight green', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      makePytestProject(repo, process.execPath);
      const keyFile = externalVerifierKey();
      const strict = await runCli(repo, ['enforcement', 'doctor', '--strict-preflight', '--json'], {
        [VERIFIER_KEY_FILE_ENV]: keyFile,
        PYTHONDONTWRITEBYTECODE: '1',
      });
      const section = runSection(strict.stdout);
      expect(line(section, 'verifier-key').status).toBe('ok');
      // The pin is unprovisioned in a plain fixture: honest `warn`, never `ok`.
      expect(line(section, 'approved-policy').status).toBe('warn');
      expect(section.ready).toBe(true);
    });
  });

  it('a wrong interpreter path is a FAIL naming the fix, and --strict-preflight exits 1 at it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      makePytestProject(repo, '/nonexistent/venv/bin/python');
      const keyFile = externalVerifierKey();
      const report = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        [VERIFIER_KEY_FILE_ENV]: keyFile,
        PYTHONDONTWRITEBYTECODE: '1',
      });
      expect(report.code).toBe(0);
      const section = runSection(report.stdout);
      expect(line(section, 'interpreter').status).toBe('fail');
      expect(line(section, 'interpreter').detail).toContain('/nonexistent/venv/bin/python');
      expect(line(section, 'interpreter').detail).toContain('diagnostics.suites argv[0]');
      const strict = await runCli(repo, ['enforcement', 'doctor', '--strict-preflight'], { [VERIFIER_KEY_FILE_ENV]: keyFile });
      expect(strict.code).toBe(1);
      expect(strict.stdout).toContain('[FAIL] interpreter:');
    });
  });

  it('an unreachable target URL is a FAIL naming the fix, and --strict-preflight exits 1 at it', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const keyFile = externalVerifierKey();
      const env = { [VERIFIER_KEY_FILE_ENV]: keyFile, GATEFORGE_TARGET_BASE_URL: 'http://[IP_ADDRESS]:1/' };
      const report = await runCli(repo, ['enforcement', 'doctor', '--json'], env);
      expect(report.code).toBe(0);
      const section = runSection(report.stdout);
      expect(line(section, 'target').status).toBe('fail');
      expect(line(section, 'target').detail).toContain('http://[IP_ADDRESS]:1/');
      const strict = await runCli(repo, ['enforcement', 'doctor', '--strict-preflight'], env);
      expect(strict.code).toBe(1);
      expect(strict.stdout).toContain('[FAIL] target:');
      expect(strict.stdout).toContain('[OK] interpreter:');
    });
  });

  it('a pin that does not match this candidate is a FAIL naming the cause', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      const pinned = await runCli(repo, ['enforcement', 'doctor', '--json'], {
        [VERIFIER_KEY_FILE_ENV]: externalVerifierKey(),
        GATEFORGE_APPROVED_POLICY_DIGEST: '0'.repeat(64),
      });
      const section = runSection(pinned.stdout);
      expect(line(section, 'approved-policy').status).toBe('fail');
      expect(line(section, 'approved-policy').detail).toContain('ENFORCEMENT_UNTRUSTED');
    });
  });

  it('a python run without the bytecode guard is a warn, and stale caches make it a FAIL', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      makePytestProject(repo, process.execPath);
      const env = { [VERIFIER_KEY_FILE_ENV]: externalVerifierKey() };
      const warn = line(runSection((await runCli(repo, ['enforcement', 'doctor', '--json'], env)).stdout), 'bytecode-safety');
      expect(warn.status).toBe('warn');
      expect(warn.detail).toContain('PYTHONDONTWRITEBYTECODE=1 gateforge run');
      repo.writeFiles({ 'app/__pycache__/main.cpython-312.pyc': 'stale bytecode\n' });
      const fail = line(runSection((await runCli(repo, ['enforcement', 'doctor', '--json'], env)).stdout), 'bytecode-safety');
      expect(fail.status).toBe('fail');
      expect(fail.detail).toContain('app/__pycache__');
      const guarded = runSection(
        (await runCli(repo, ['enforcement', 'doctor', '--json'], { ...env, PYTHONDONTWRITEBYTECODE: '1' })).stdout,
      );
      expect(line(guarded, 'bytecode-safety').status).toBe('ok');
    });
  });

  it('machine load stays advisory: it is reported but never fails a run', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      makePytestProject(repo, process.execPath);
      const env = { [VERIFIER_KEY_FILE_ENV]: externalVerifierKey(), PYTHONDONTWRITEBYTECODE: '1' };
      const section = runSection((await runCli(repo, ['enforcement', 'doctor', '--json'], env)).stdout);
      const load = line(section, 'host-load');
      expect(['ok', 'warn']).toContain(load.status);
      expect(load.detail).toContain('advisory only');
      expect((await runCli(repo, ['enforcement', 'doctor', '--strict-preflight'], env)).code).toBe(0);
    });
  });
});
