/**
 * `tests diagnose` / advisory diagnostics tests (plan 2026-09-13 §3.5,
 * Phase 4 items 9-10, E23/E24/E25): exit codes 0 (completed, ≥1 pass, no
 * unexpected failures) / 1 (test failures) / 2 (unavailable or
 * incomplete — collection error, missing interpreter, zero tests, only
 * skipped/xfail); stale reports surface DIAGNOSTIC_RESULT_STALE and
 * never look current; and hard separation — a green diagnostic run never
 * clears a blocking obligation, a failing diagnostic never changes the
 * E2E exit. Runs REAL pytest against temp repos.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, type DiagnosticSuite, type GateforgeConfig, type TempRepo } from '@gateforge/core';
import type { DiagnosticRunResult } from '@gateforge/pack-playwright';
import { configYml, currentInputDigest, FIXED_AT, PLUGIN_SOURCE, runCli, withTempRepo } from './helpers.js';
import {
  diagnosticsExitCode,
  diagnosticsJson,
  renderDiagnosticsText,
  runDiagnosticSuites,
} from '../src/diagnostics.js';
import { resolveStateDir } from '../src/state.js';
import { CaptureStream, type Io } from '../src/index.js';

/** A pytest suite config pointing at `tests/`. */
function suite(name: string, overrides: Partial<DiagnosticSuite> = {}): DiagnosticSuite {
  return {
    name,
    runner: 'pytest',
    cwd: '.',
    argv: ['python3', '-m', 'pytest'],
    testPaths: ['tests'],
    timeoutMs: 60_000,
    ...overrides,
  };
}

/** YAML block registering one diagnostic suite in `.gateforge.yml`. */
function diagnosticsYaml(suites: readonly DiagnosticSuite[]): string {
  const rows = suites.map(
    (entry) =>
      `    - name: ${entry.name}\n` +
      `      runner: ${entry.runner}\n` +
      `      cwd: ${entry.cwd}\n` +
      `      argv: [${entry.argv.map((part) => `'${part}'`).join(', ')}]\n` +
      `      testPaths: [${entry.testPaths.map((part) => `'${part}'`).join(', ')}]\n` +
      `      timeoutMs: ${String(entry.timeoutMs)}\n`,
  );
  return `diagnostics:\n  suites:\n${rows.join('')}`;
}

/** The zero-obligation project yaml (no tracked resources). */
function projectYaml(suites: readonly DiagnosticSuite[]): string {
  return `${configYml()}${diagnosticsYaml(suites)}`;
}

const ZERO_OBLIGATION_PROJECT = {
  '.gateforge/policies.yml':
    'schemaVersion: 1\npolicies:\n  - id: user-facing-crud\n    when:\n      exposure: user-facing\n    require:\n      - persistence:read\n',
  '.gateforge/classification-policy.yml':
    "schemaVersion: 1\nscanRoots: ['src/**/*.txt']\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations:\n  internality: gateforge:internal\nvolatileFields: []\n",
  'plugin.mjs': PLUGIN_SOURCE,
};

/** Runs the configured suites of a repo's real `.gateforge.yml`. */
async function diagnose(
  repo: TempRepo,
  inputDigest: string | null,
  suiteName?: string,
) {
  const config: GateforgeConfig = loadConfig(join(repo.root, '.gateforge.yml'));
  return runDiagnosticSuites({
    config,
    cwd: repo.root,
    stateDir: resolveStateDir(repo.root),
    inputDigest,
    now: FIXED_AT,
    ...(suiteName !== undefined ? { suiteName } : {}),
  });
}

describe('tests diagnose exit codes against real pytest (E23/E24)', () => {
  it('exit 0: a completed run with ≥1 passing test and no unexpected failures', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_email.py': 'def test_sends_email():\n    assert True\n',
      });
      const run = await diagnose(repo, 'a'.repeat(64));
      expect(run.exitCode).toBe(0);
      const only = run.results[0];
      expect(only?.status).toBe('completed');
      expect(only?.counts.passed).toBe(1);
      expect(only?.complete).toBe(true);
      expect(only?.reportExists).toBe(true);
      expect(only?.reportPath).toMatch(/diagnostics[/\\]backend\.xml$/);
      expect(only?.nodeIds.join('\n')).toMatch(/test_sends_email/);
    });
  });

  it('exit 1: an assertion failure names the exact node id and message', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_email.py': 'def test_sends_email():\n    assert 1 == 2, "email was not sent"\n',
      });
      const run = await diagnose(repo, 'a'.repeat(64));
      expect(run.exitCode).toBe(1);
      const only = run.results[0];
      expect(only?.status).toBe('failures');
      expect(only?.causes).toEqual(['DIAGNOSTIC_TEST_FAILURE']);
      expect(only?.counts.failed).toBe(1);
      expect(only?.cases[0]?.nodeId).toMatch(/test_sends_email/);
      expect(only?.cases[0]?.message).toMatch(/email was not sent/);
    });
  });

  it('exit 2: a collection error is incomplete (DIAGNOSTIC_RUN_INCOMPLETE), never passing', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_broken.py': 'import module_that_does_not_exist_xyz\n',
      });
      const run = await diagnose(repo, 'a'.repeat(64));
      expect(run.exitCode).toBe(2);
      const only = run.results[0];
      expect(only?.status).toBe('incomplete');
      expect(only?.complete).toBe(false);
      expect(only?.causes).toEqual(['DIAGNOSTIC_RUN_INCOMPLETE']);
    });
  });

  it('exit 2: only skipped cases — nothing executed, never displayed as passing', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_skipped.py': 'import pytest\n\ndef test_skipped():\n    pytest.skip("not ready")\n',
      });
      const run = await diagnose(repo, 'a'.repeat(64));
      expect(run.exitCode).toBe(2);
      const only = run.results[0];
      expect(only?.counts.skipped).toBe(1);
      expect(only?.counts.passed).toBe(0);
      expect(only?.incompleteDetail).toMatch(/only skipped/i);
    });
  });

  it('exit 2: only xfail cases are an incomplete run with an explicit xfail counter', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_xfail.py':
          'import pytest\n\n@pytest.mark.xfail\ndef test_expected_broken():\n    assert False\n',
      });
      const run = await diagnose(repo, 'a'.repeat(64));
      expect(run.exitCode).toBe(2);
      expect(run.results[0]?.counts.xfailed).toBe(1);
      expect(run.results[0]?.status).toBe('incomplete');
    });
  });

  it('exit 2: zero collected tests (empty scope) is an unavailable run', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/.gitkeep': '',
      });
      const zeroTests = await diagnose(repo, null);
      expect(zeroTests.exitCode).toBe(2);
      expect(zeroTests.results[0]?.status).toBe('incomplete');
    });
  });

  it('exit 2: a missing interpreter is an unavailable run naming the argv', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([
          suite('broken', { argv: ['no-such-interpreter-xyz', '-m', 'pytest'], timeoutMs: 30_000 }),
        ]),
        'tests/test_ok.py': 'def test_ok():\n    assert True\n',
      });
      const run = await diagnose(repo, null);
      expect(run.exitCode).toBe(2);
      expect(run.results[0]?.spawnError).toMatch(/no-such-interpreter-xyz/);
    });
  });

  it('exit 2: a suite exceeding its finite timeout is killed and sealed incomplete (E24)', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([
          // The test itself would pass — the TIMEOUT is the failure mode:
          // the killed run must stay incomplete, never a passing run.
          suite('slow', { timeoutMs: 1_000 }),
        ]),
        'tests/test_slow.py': 'import time\n\ndef test_hangs():\n    time.sleep(30)\n',
      });
      const run = await diagnose(repo, null);
      expect(run.exitCode).toBe(2);
      const only = run.results[0];
      expect(only?.status).toBe('incomplete');
      expect(only?.timedOut).toBe(true);
      expect(only?.complete).toBe(false);
      expect(only?.causes).toEqual(['DIAGNOSTIC_RUN_INCOMPLETE']);
      expect(only?.incompleteDetail).toMatch(/timeout/);
    });
  }, 30_000);
});

describe('diagnostics staleness and report honesty (E25)', () => {
  it('a report for different inputs is stale: DIAGNOSTIC_RESULT_STALE, never looks current', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_ok.py': 'def test_ok():\n    assert True\n',
      });
      const first = await diagnose(repo, 'a'.repeat(64));
      expect(first.previousReportStale).toBe(false);
      const second = await diagnose(repo, 'b'.repeat(64));
      expect(second.previousReportStale).toBe(true);
      const json = diagnosticsJson(second, 'b'.repeat(64));
      expect(json).toMatch(/DIAGNOSTIC_RESULT_STALE/);
      // A missing/unavailable current digest can never look fresh either.
      const third = await diagnose(repo, null);
      expect(third.previousReportStale).toBe(true);
    });
  });

  it('the rendered report is never an unqualified "all tests passed"', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_ok.py': 'def test_ok():\n    assert True\n',
      });
      const run = await diagnose(repo, 'a'.repeat(64));
      const stdout = new CaptureStream();
      const io: Io = { cwd: repo.root, env: {}, stdout, stderr: new CaptureStream() };
      renderDiagnosticsText(io, run, 'a'.repeat(64));
      const text = stdout.text();
      expect(text).toMatch(/completed/);
      expect(text).toMatch(/advisory only/);
      expect(text.toLowerCase()).not.toMatch(/all tests passed/);
    });
  });

  it('the exit-code aggregator covers the §3.5 matrix', () => {
    const base: DiagnosticRunResult = {
      suite: 's',
      status: 'completed',
      exitCode: 0,
      timedOut: false,
      spawnError: null,
      collectionErrors: [],
      selectedScope: ['tests'],
      nodeIds: [],
      cases: [],
      counts: { passed: 1, failed: 0, errors: 0, skipped: 0, xfailed: 0 },
      complete: true,
      incompleteDetail: null,
      causes: [],
      reportPath: 'r.xml',
      reportExists: true,
      reportUnparsable: false,
    };
    const as = (over: Partial<DiagnosticRunResult>): DiagnosticRunResult => ({ ...base, ...over });
    expect(diagnosticsExitCode([])).toBe(0);
    expect(diagnosticsExitCode([as({ status: 'completed' })])).toBe(0);
    expect(diagnosticsExitCode([as({ status: 'failures', causes: ['DIAGNOSTIC_TEST_FAILURE'] })])).toBe(1);
    // Incomplete beats failures in aggregation severity.
    expect(
      diagnosticsExitCode([as({ status: 'failures' }), as({ status: 'incomplete', complete: false })]),
    ).toBe(2);
    // A completed run with zero passes (all skipped) is 2.
    expect(
      diagnosticsExitCode([as({ counts: { passed: 0, failed: 0, errors: 0, skipped: 1, xfailed: 0 } })]),
    ).toBe(2);
  });
});

describe('hard separation: diagnostics never touch the E2E decision (E25)', () => {
  it('a green diagnostic run never clears a blocking browser obligation', async () => {
    await withTempRepo({}, async (repo) => {
      // Standard fixture: resources exist, no claims/evidence → blocked.
      const { installFixture } = await import('./helpers.js');
      installFixture(repo);
      repo.writeFiles({
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_ok.py': 'def test_ok():\n    assert True\n',
      });
      const before = await runCli(repo, ['check']);
      expect(before.code).toBe(1);
      const diag = await diagnose(repo, await currentInputDigest(repo));
      expect(diag.exitCode).toBe(0);
      const after = await runCli(repo, ['check']);
      expect(after.code).toBe(1);
    });
  });

  it('a failing diagnostic run never changes a clean E2E exit; tests diagnose exits 1', async () => {
    await withTempRepo({}, async (repo) => {
      repo.writeFiles({
        ...ZERO_OBLIGATION_PROJECT,
        '.gateforge.yml': projectYaml([suite('backend')]),
        'tests/test_email.py': 'def test_sends_email():\n    assert 1 == 2\n',
      });
      const check = await runCli(repo, ['check']);
      expect(check.code).toBe(0);
      const cliDiagnose = await runCli(repo, ['tests', 'diagnose']);
      expect(cliDiagnose.code).toBe(1);
      expect(cliDiagnose.stdout).toMatch(/DIAGNOSTIC_TEST_FAILURE/);
      expect(cliDiagnose.stdout).toMatch(/advisory alarm/);
      const checkAgain = await runCli(repo, ['check']);
      expect(checkAgain.code).toBe(0);
    });
  });
});
