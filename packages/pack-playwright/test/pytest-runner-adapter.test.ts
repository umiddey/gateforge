/**
 * The pytest runner adapter behind the runner-neutral `RunnerAdapter`
 * contract (plan 2026-09-25 phase 3), graded by the SHARED conformance
 * suite every adapter must pass — the same pass/fail/skip/retry/
 * unplanned/zero/untagged behaviours the Playwright adapter is graded on.
 *
 * The host materializes REAL pytest projects (real `.gateforge.yml` with
 * a configured diagnostics suite, real collection, real junit reports —
 * no mocks): enumeration runs the configured argv with `--collect-only
 * -q`, scenario runs produce real junit XML, and every envelope is the
 * adapter's own `parseResults` reading of what the runner emitted.
 *
 * The interpreter comes from `GATEFORGE_PYTEST_TEST_PYTHON` (the same
 * env-carried mechanism the Alembic Postgres tests use for their
 * interpreter); when it is not exported the suite skips — a missing
 * interpreter is an unavailable harness, never a silent pass.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runRunnerAdapterContract,
  type ContractObservation,
  type ContractScenario,
  type RunnerContractHost,
} from '@gate-forge/witness/adapter';
import { PytestRunnerAdapter } from '../src/discovery/pytest-runner-adapter.js';

/** The pytest interpreter the host and the configured suites run. */
const PYTHON = process.env['GATEFORGE_PYTEST_TEST_PYTHON'] ?? 'python3';

/** True when the interpreter can import pytest + the rerun plugin. */
function hasPytestRunner(): boolean {
  const probe = spawnSync(PYTHON, ['-c', 'import pytest, pytest_rerunfailures'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return probe.status === 0;
}

const PYTEST_AVAILABLE = hasPytestRunner();

/** Temp dirs removed after the suite. */
const TEMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TEMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One temp dir, removed after the suite. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

/** Writes a file tree (repo-relative posix keys) into a project root. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [key, content] of Object.entries(files)) {
    const absolute = join(root, key);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
}

/**
 * The gateforge config the enumeration reads: the playwright contract's
 * minimal document plus ONE configured pytest suite (the §3.5 shape —
 * the adapter only ever composes this argv).
 */
function configYaml(): string {
  return [
    'schemaVersion: 1',
    'project:',
    '  languages: [python]',
    '  paths:',
    '    include: ["tests/**/*.py"]',
    '    exclude: []',
    'plugins: []',
    'policies: .gateforge/policies.yml',
    'classificationPolicy: .gateforge/classification-policy.yml',
    'adapters: .gateforge/adapters',
    'waivers: .gateforge/waivers',
    'baselines: .gateforge/baselines/obligations.json',
    'changed:',
    '  provider: auto',
    'witness:',
    '  maxDurationSeconds: 5',
    'diagnostics:',
    '  suites:',
    '    - name: contract-pytest',
    '      runner: pytest',
    '      cwd: .',
    `      argv: ["${PYTHON}", "-m", "pytest"]`,
    '      testPaths: ["tests"]',
    '      timeoutMs: 120000',
    '      witnessed: true',
    'clock:',
    '  mode: fixed',
    '  fixedAt: "2026-01-01T00:00:00.000Z"',
    '',
  ].join('\n');
}

/** Shared placeholder config files every materialized project needs. */
function placeholderGateforgeFiles(): Record<string, string> {
  return {
    '.gateforge/policies.yml': 'schemaVersion: 1\npolicies: []\n',
    '.gateforge/classification-policy.yml':
      "schemaVersion: 1\nscanRoots: []\ntrustedInternalEntryPoints: []\ninternalRules: []\ndeclarations:\n  internality: gateforge:internal\nvolatileFields: []\n",
    '.gateforge/baselines/obligations.json': '{ "schemaVersion": 1, "fingerprints": [] }\n',
  };
}

/** The pytest body for one scenario kind (same identity in every variant). */
function pytestFor(kind: ContractScenario['kind']): string {
  switch (kind) {
    case 'pass':
      return 'def test_contract():\n    assert True\n';
    case 'fail':
      return "def test_contract():\n    raise AssertionError('contract failure')\n";
    case 'skip':
      return 'import pytest\n\n\n@pytest.mark.skip(reason="contract skip")\ndef test_contract():\n    assert True\n';
    case 'unplanned':
      return 'def test_contract():\n    assert True\n\n\ndef test_stowaway():\n    assert True\n';
    case 'zero':
      return '';
    case 'retry': {
      // Fails on the first attempt, passes on the second: the runner's
      // OWN retry setting (--reruns 1, applied by the host run) is what
      // produces attempt 2, and the adapter must DETECT the retry when
      // the junit report arrives.
      return [
        'import os',
        '',
        '',
        'def test_contract():',
        "    attempts_file = os.environ['GATEFORGE_CONTRACT_ATTEMPTS_FILE']",
        '    seen = 0',
        '    if os.path.exists(attempts_file):',
        "        seen = int(open(attempts_file, encoding='utf-8').read() or '0')",
        "    with open(attempts_file, 'w', encoding='utf-8') as handle:",
        '        handle.write(str(seen + 1))',
        '    if seen == 0:',
        "        raise AssertionError('first attempt fails')",
        '',
      ].join('\n');
    }
    default:
      throw new Error(`contract: no pytest body for scenario '${String(kind)}'`);
  }
}

/** The scenario identity every variant declares (file + title path). */
const SCENARIO_FILE = 'tests/test_contract.py';
const SCENARIO_TITLE_PATH = ['test_contract'];

/** Builds a temp pytest project with the gateforge config in place. */
function pytestProject(files: Record<string, string>): string {
  const root = tempDir('gateforge-pytest-contract-');
  writeTree(root, {
    'package.json': '{ "type": "module", "private": true }\n',
    '.gateforge.yml': configYaml(),
    ...placeholderGateforgeFiles(),
    ...files,
  });
  return root;
}

const PYTEST_HOST: RunnerContractHost = {
  runner: 'pytest',
  project: null,
  // The runner's own naming: a pytest module collects at a `.py` path
  // with the test function as the title path (see RunnerContractHost.scenario).
  scenario: { file: SCENARIO_FILE, titlePath: SCENARIO_TITLE_PATH },

  async materialize(scenario) {
    if (scenario.kind === 'zero') {
      return pytestProject({ 'tests/placeholder.py': '' });
    }
    return pytestProject({ [SCENARIO_FILE]: pytestFor(scenario.kind) });
  },

  executeRequest(projectRoot, scenario) {
    return {
      logicalKeys: scenario.expectedLogicalKeys,
      stateDir: join(projectRoot, '.gateforge-state'),
      runId: 'contract-run',
      timeoutMs: 120_000,
      cwd: projectRoot,
    };
  },

  untaggedReport() {
    // A junit document whose every row lacks the pytest `file`
    // attribute — the shape a report takes when its rows cannot be
    // joined to an enumerated identity. Nothing may be attributed.
    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="1" time="0.01">',
      '<testcase classname="tests.test_contract" name="test_contract" time="0.001" />',
      '</testsuite></testsuites>',
    ].join('');
  },

  run(adapter, projectRoot, scenario) {
    const stateDir = join(projectRoot, '.gateforge-state');
    mkdirSync(stateDir, { recursive: true });
    const reportPath = join(stateDir, 'report.xml');
    // The supervised policy forbids retries, so the retry case runs the
    // REAL runner with its own setting (--reruns 1): what is under test
    // is that the adapter DETECTS the retry when the report carries one.
    const reruns = scenario.kind === 'retry' ? ['--reruns', '1'] : [];
    const attemptsFile = join(stateDir, 'attempts');
    const child = spawnSync(
      PYTHON,
      [
        '-m',
        'pytest',
        '-q',
        '-o',
        'junit_family=xunit1',
        `--junitxml=${reportPath}`,
        ...reruns,
        'tests',
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          ...(scenario.kind === 'retry' ? { GATEFORGE_CONTRACT_ATTEMPTS_FILE: attemptsFile } : {}),
        },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    let report = '';
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch {
      report = '';
    }
    const raw = { processExit: child.status, report };
    const observation: ContractObservation = {
      envelope: adapter.parseResults(raw),
      raw,
      ...(scenario.kind === 'retry' ? { note: 'retry produced with the runner own --reruns 1 setting' } : {}),
    };
    return Promise.resolve(observation);
  },
};

describe.skipIf(!PYTEST_AVAILABLE)('pytest behind the runner-adapter contract', () => {
  it('passes the shared contract suite (plan 2026-09-25 phase 3)', async () => {
    const adapter = new PytestRunnerAdapter();
    const violations = await runRunnerAdapterContract(adapter, PYTEST_HOST);
    expect(violations).toEqual([]);
  });

  it('enumerates the expected set from a real project before the run', async () => {
    const root = pytestProject({ [SCENARIO_FILE]: pytestFor('pass') });
    const enumeration = await new PytestRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('discovered');
    const test = enumeration.tests.find(
      (entry) => entry.file === SCENARIO_FILE && entry.titlePath.join('>') === 'test_contract',
    );
    expect(test?.logicalKey).toBe('tests/test_contract.py#test_contract');
    expect(test?.project).toBeNull();
  });

  it('keeps the zero-test enumeration honest', async () => {
    const root = pytestProject({ 'tests/placeholder.py': '' });
    const enumeration = await new PytestRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('unavailable');
    expect(enumeration.tests).toEqual([]);
  });

  it('tags every session with its own proxy origin (contract: tag-varies-per-session)', () => {
    const adapter = new PytestRunnerAdapter();
    const first = adapter.childEnv(
      { logicalKey: 'tests/test_a.py#test_one', frameworkId: 'tests/test_a.py::test_one', project: null },
      {
        witnessUrl: 'http://127.0.0.1:1',
        runToken: 'token',
        sessionId: 'session-one',
        sessionToken: 'session-token-one',
        sessionProxyUrl: 'http://127.0.0.1:9001',
        appBaseUrl: 'http://127.0.0.1:2',
      },
    );
    const second = adapter.childEnv(
      { logicalKey: 'tests/test_a.py#test_two', frameworkId: 'tests/test_a.py::test_two', project: null },
      {
        witnessUrl: 'http://127.0.0.1:1',
        runToken: 'token',
        sessionId: 'session-two',
        sessionToken: 'session-token-two',
        sessionProxyUrl: 'http://127.0.0.1:9002',
        appBaseUrl: 'http://127.0.0.1:2',
      },
    );
    expect(first.tagChannel).toBe('session-proxy');
    expect(first.vars['GATEFORGE_SESSION_PROXY_URL']).not.toBe(second.vars['GATEFORGE_SESSION_PROXY_URL']);
    expect(first.vars['GATEFORGE_WITNESS_VERIFIER_KEY']).toBeUndefined();
  });

  it('refuses to attribute junit rows that carry no pytest file identity', () => {
    const envelope = new PytestRunnerAdapter().parseResults({
      processExit: 0,
      report: PYTEST_HOST.untaggedReport(),
    });
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toContain('no attributable');
  });

  it('detects a runner-assisted retry from duplicated junit rows (contract: retry)', () => {
    const duplicated = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="1" time="0.02">',
      '<testcase classname="tests.test_contract" name="test_contract" file="tests/test_contract.py" line="3" time="0.001"><failure message="first attempt fails">trace</failure></testcase>',
      '<testcase classname="tests.test_contract" name="test_contract" file="tests/test_contract.py" line="3" time="0.001" />',
      '</testsuite></testsuites>',
    ].join('');
    const envelope = new PytestRunnerAdapter().parseResults({ processExit: 0, report: duplicated });
    expect(envelope.retriesDetected).toBe(true);
    expect(envelope.outcomes).toHaveLength(1);
    expect(envelope.outcomes[0]?.attempt).toBe(2);
  });
});
