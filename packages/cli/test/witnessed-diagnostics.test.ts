/**
 * Server-witnessed persistence channel CLI tests (GAP 1 + GAP 2 fixes):
 *
 * - GAP 1 (mapping resolver collects pytest): `check` discovers the
 *   catalog WITH pytest collection, so a sidecar selector pointing at a
 *   configured pytest suite RESOLVES (the obligation grades
 *   EVIDENCE_NOT_COLLECTED — declared, unevidenced) instead of typing
 *   TEST_MAPPING_STALE; genuinely stale selectors still block.
 * - GAP 2 (witnessed pytest participant): diagnostics suites marked
 *   `witnessed: true` are excluded from every ADVISORY surface (they run
 *   only inside the supervised test-gates window), run there with the
 *   run-scoped env (STATE_DIR/RUN_ID/WITNESS_URL/RUN_TOKEN — never the
 *   verifier key), and a red/incomplete witnessed run projects typed
 *   blocking entries.
 *
 * Real pytest runs against temp repos; no mocks.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, withTempRepo, type TempRepo } from '@gate-forge/core';
import { runCli, installFixture, OBLIGATION_ACCOUNTS, OBLIGATION_ORDERS } from './helpers.js';
import { runDiagnosticSuites, runWitnessedPytestSuites } from '../src/diagnostics.js';
import { resolveStateDir } from '../src/state.js';
import { FIXED_AT } from './helpers.js';

/** The fake collector argv: prints the integration node id exactly as
 * `pytest --collect-only -q` would (suite cwd is `backend`, so the file
 * part stays suite-relative — the same shape `collectPytestSuite` parses
 * from a real collector). */
const COLLECTOR_ARGV =
  `      argv: ['python3', '-c', 'import sys; print("tests/integration/test_leads_outbox_transactions.py::test_booking_and_outbox_commit_atomically")']`;

/** The diagnostics registry YAML appended to the fixture config. */
function diagnosticsYaml(mode: 'collector' | 'real-pytest'): string {
  const witnessedArgv = mode === 'collector' ? COLLECTOR_ARGV : "      argv: ['python3', '-m', 'pytest', '-q']";
  return [
    'diagnostics:',
    '  suites:',
    '    - name: backend-outbox-pytest',
    '      runner: pytest',
    '      cwd: backend',
    witnessedArgv,
    "      testPaths: ['tests']",
    '      timeoutMs: 60000',
    '      witnessed: true',
    '    - name: unit-tests',
    '      runner: pytest',
    '      cwd: .',
    "      argv: ['python3', '-m', 'pytest', '-q']",
    "      testPaths: ['tests']",
    '      timeoutMs: 60000',
  ].join('\n');
}

/** Installs the fixture config PLUS the diagnostics registry. */
function installConfigWithDiagnostics(repo: TempRepo, mode: 'collector' | 'real-pytest'): void {
  const configPath = join(repo.root, '.gateforge.yml');
  writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}${diagnosticsYaml(mode)}\n`);
}

/** Writes the sidecar mapping the collected pytest node id to the accounts obligation. */
function writeSidecar(repo: TempRepo, options: { staleEntry?: boolean } = {}): void {
  repo.writeFiles({
    '.gateforge/test-map.yml': [
      'schemaVersion: 1',
      'tests:',
      '  - key: pytest:backend-outbox-pytest:backend/tests/integration/test_leads_outbox_transactions.py:test_booking_and_outbox_commit_atomically',
      '    selector:',
      '      runner: pytest',
      '      file: backend/tests/integration/test_leads_outbox_transactions.py',
      '      titlePath:',
      '        - test_booking_and_outbox_commit_atomically',
      '    kind: server-e2e',
      '    claims:',
      `      - ${OBLIGATION_ACCOUNTS}`,
      '    reason: The real-Postgres transaction test commits the booking and outbox row atomically.',
      ...(options.staleEntry === true
        ? [
            '  - key: pytest:backend-outbox-pytest:backend/tests/integration/test_leads_outbox_transactions.py:test_that_vanished',
            '    selector:',
            '      runner: pytest',
            '      file: backend/tests/integration/test_leads_outbox_transactions.py',
            '      titlePath:',
            '        - test_that_vanished',
            '    kind: server-e2e',
            '    claims:',
            `      - ${OBLIGATION_ORDERS}`,
            '    reason: Deliberately stale selector proving staleness still fires after the fix.',
          ]
        : []),
    ].join('\n'),
  });
}

interface VerdictJson {
  obligationId: string;
  verdict: string;
  cause: string | null;
  nextAction: string | null;
}

interface BlockingJson {
  cause: string | null;
  name: string | null;
  detail: string;
}

interface ReportJson {
  verdicts: VerdictJson[];
  blocking: BlockingJson[];
}

describe('GAP 1: the mapping resolver sees collected pytest rows (check gate)', () => {
  it('a pytest selector resolves against the collected catalog — EVIDENCE_NOT_COLLECTED, never TEST_MAPPING_STALE', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      installConfigWithDiagnostics(repo, 'collector');
      repo.writeFiles({
        'backend/tests/integration/test_leads_outbox_transactions.py':
          'def test_booking_and_outbox_commit_atomically():\n    assert True\n',
      });
      writeSidecar(repo);

      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1); // no witnessed evidence yet — the gate stays red
      const report = JSON.parse(result.stdout) as ReportJson;
      // The pytest mapping RESOLVED: declared-but-unevidenced — never
      // TEST_MAPPING_STALE, never TEST_MAPPING_MISSING.
      const accounts = report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS);
      expect(accounts?.cause).toBe('EVIDENCE_NOT_COLLECTED');
      expect(accounts?.verdict).toBe('missing');
      expect(result.stdout).not.toContain('TEST_MAPPING_STALE');
      // Nothing got a free pass.
      expect(report.verdicts.every((v) => v.verdict !== 'satisfied' && v.verdict !== 'waived')).toBe(true);
    });
  });

  it('a genuinely stale pytest selector still types TEST_MAPPING_STALE (the fix never suppresses staleness)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      installConfigWithDiagnostics(repo, 'collector');
      repo.writeFiles({
        'backend/tests/integration/test_leads_outbox_transactions.py':
          'def test_booking_and_outbox_commit_atomically():\n    assert True\n',
      });
      writeSidecar(repo, { staleEntry: true });

      const result = await runCli(repo, ['check', '--format', 'json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as ReportJson;
      // The stale entry (titlePath no longer collected) blocks typed...
      const stale = report.blocking.filter((entry) => entry.cause === 'TEST_MAPPING_STALE');
      expect(stale).toHaveLength(1);
      expect(stale[0]?.name).toBe(OBLIGATION_ORDERS);
      expect(stale[0]?.detail).toContain('test_that_vanished');
      // ...while the live pytest selector keeps resolving.
      const accounts = report.verdicts.find((v) => v.obligationId === OBLIGATION_ACCOUNTS);
      expect(accounts?.cause).toBe('EVIDENCE_NOT_COLLECTED');
      const accountsStale = report.blocking.find(
        (entry) => entry.cause === 'TEST_MAPPING_STALE' && entry.name === OBLIGATION_ACCOUNTS,
      );
      expect(accountsStale).toBeUndefined();
    });
  });
});

describe('GAP 2: witnessed suites are excluded from every advisory surface', () => {
  it('runDiagnosticSuites skips witnessed suites and reports the exclusion (never silent)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      installConfigWithDiagnostics(repo, 'real-pytest');
      repo.writeFiles({
        'tests/test_unit.py': 'def test_unit_passes():\n    assert True\n',
        'backend/tests/test_outbox.py': 'def test_outbox_passes():\n    assert True\n',
      });
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      const run = await runDiagnosticSuites({
        config,
        cwd: repo.root,
        stateDir: resolveStateDir(repo.root),
        inputDigest: 'a'.repeat(64),
        now: FIXED_AT,
      });
      // Only the advisory suite ran; the witnessed suite is named as
      // excluded — visible, never silent.
      expect(run.results.map((result) => result.suite)).toEqual(['unit-tests']);
      expect(run.witnessedExcluded).toEqual(['backend-outbox-pytest']);
      expect(run.exitCode).toBe(0);
    });
  });

  it('`tests diagnose --suite <witnessed>` refuses with exit 2 (the advisory window can never run it)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      installConfigWithDiagnostics(repo, 'real-pytest');
      repo.writeFiles({
        'backend/tests/test_outbox.py': 'def test_outbox_passes():\n    assert True\n',
      });
      const result = await runCli(repo, ['tests', 'diagnose', '--suite', 'backend-outbox-pytest']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('witnessed: true');
      expect(result.stderr).toContain('test-gates --changed');
    });
  });

  it('`tests diagnose` prints the witnessed exclusion and still grades the advisory suites', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      installConfigWithDiagnostics(repo, 'real-pytest');
      repo.writeFiles({
        'tests/test_unit.py': 'def test_unit_passes():\n    assert True\n',
        'backend/tests/test_outbox.py': 'def test_outbox_passes():\n    assert True\n',
      });
      const result = await runCli(repo, ['tests', 'diagnose']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('backend-outbox-pytest');
      expect(result.stdout).toContain('EXCLUDED from the advisory run');
      expect(result.stdout).toContain('supervised test-gates window');
    });
  });
});

describe('GAP 2: the supervised witnessed step (runWitnessedPytestSuites)', () => {
  it('runs the witnessed suite with the run-scoped env: STATE_DIR/RUN_ID present, verifier key absent, consumer DSN crosses', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      installConfigWithDiagnostics(repo, 'real-pytest');
      repo.writeFiles({
        'backend/tests/test_outbox.py': [
          'import os',
          'def test_participant_env():',
          '    assert os.environ["GATEFORGE_STATE_DIR"]',
          '    assert os.environ["GATEFORGE_RUN_ID"] == "run-123"',
          '    assert "GATEFORGE_WITNESS_VERIFIER_KEY" not in os.environ',
          '    assert os.environ["PORTAL_TX_TEST_DSN"] == "postgresql://127.0.0.1/tx"',
        ].join('\n'),
      });
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      const run = await runWitnessedPytestSuites({
        config,
        cwd: repo.root,
        stateDir: resolveStateDir(repo.root),
        childEnv: {
          GATEFORGE_STATE_DIR: resolveStateDir(repo.root),
          GATEFORGE_RUN_ID: 'run-123',
          GATEFORGE_WITNESS_URL: 'http://127.0.0.1:9/witness',
          GATEFORGE_RUN_TOKEN: 'token-123',
          PORTAL_TX_TEST_DSN: 'postgresql://127.0.0.1/tx',
        },
      });
      expect(run.results).toHaveLength(1);
      expect(run.results[0]?.status).toBe('completed');
      expect(run.results[0]?.counts.passed).toBe(1);
      expect(run.blocking).toEqual([]);
    });
  });

  it('a red witnessed run yields typed blocking details (the mapped test is never graded green)', async () => {
    await withTempRepo({}, async (repo) => {
      installFixture(repo);
      installConfigWithDiagnostics(repo, 'real-pytest');
      repo.writeFiles({
        'backend/tests/test_outbox.py':
          'def test_outbox_fails():\n    assert 1 == 2, "outbox row never committed"\n',
      });
      const config = loadConfig(join(repo.root, '.gateforge.yml'));
      const run = await runWitnessedPytestSuites({
        config,
        cwd: repo.root,
        stateDir: resolveStateDir(repo.root),
        childEnv: { GATEFORGE_STATE_DIR: '/x', GATEFORGE_RUN_ID: 'r' },
      });
      expect(run.results[0]?.status).toBe('failures');
      expect(run.results[0]?.counts.failed).toBe(1);
      expect(run.blocking).toHaveLength(1);
      expect(run.blocking[0]).toContain('backend-outbox-pytest');
      expect(run.blocking[0]).toContain('did not complete cleanly');
    });
  });
});
