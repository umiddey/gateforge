/**
 * The Vitest runner adapter behind the runner-neutral `RunnerAdapter`
 * contract (plan 2026-09-25 phase 4), graded by the SHARED conformance
 * suite — the same pass/fail/skip/retry/unplanned/zero/untagged
 * behaviours the Playwright and pytest adapters are graded on.
 *
 * The host materializes REAL vitest projects (vitest symlinked from the
 * monorepo, real `vitest list --json` enumeration, real `vitest run`
 * JSON reports through the pack's gateforge reporter — no mocks).
 * The retry scenario runs the runner's OWN retry setting
 * (`test.retry: 1`); what is under test is that the adapter DETECTS
 * the retry from the reporter's flags document.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runRunnerAdapterContract,
  type ContractObservation,
  type ContractScenario,
  type RunnerContractHost,
} from '@gate-forge/witness/adapter';
import {
  VitestRunnerAdapter,
  mergeVitestRunnerFlags,
} from '../src/discovery/vitest-runner-adapter.js';

/** The gateforge monorepo root (vitest module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The pack's built Vitest reporter module (what the adapter loads). */
const GATEFORGE_REPORTER = join(ROOT, 'packages/pack-playwright/dist/vitest/reporter.js');

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

/** The scenario identity every variant declares (file + title path). */
const SCENARIO_FILE = 'tests/contract.test.mjs';
const SCENARIO_TITLE = 'contract';

/** The vitest body for one scenario kind (same identity in every variant). */
function vitestFor(kind: ContractScenario['kind'], options: { nested?: boolean } = {}): string {
  const head = "import { describe, it, expect } from 'vitest';\n";
  const body = (() => {
    switch (kind) {
      case 'pass':
        return "it('contract', () => { expect(1).toBe(1); });";
      case 'fail':
        return "it('contract', () => { throw new Error('contract failure'); });";
      case 'skip':
        return "it.skip('contract', () => { expect(1).toBe(1); });";
      case 'unplanned':
        return [
          "it('contract', () => { expect(1).toBe(1); });",
          "it('stowaway', () => { expect(1).toBe(1); });",
        ].join('\n');
      case 'zero':
        return '// no tests\n';
      case 'retry': {
        // Fails on the first attempt, passes on the second: the
        // runner's OWN retry setting (vitest retry: 1 in the config)
        // produces attempt 2, and the adapter must DETECT it from the
        // reporter's flags document.
        return [
          "it('contract', () => {",
          "  globalThis.__calls = (globalThis.__calls ?? 0) + 1;",
          '  if (globalThis.__calls < 2) throw new Error(\'first attempt fails\');',
          '});',
        ].join('\n');
      }
      default:
        throw new Error(`contract: no vitest body for scenario '${String(kind)}'`);
    }
  })();
  if (options.nested === true) {
    return `${head}describe('suite', () => {\n${body.split('\n').map((line) => `  ${line}`).join('\n')}\n});\n`;
  }
  return `${head}${body}\n`;
}

/**
 * Builds a temp vitest project (gateforge config + vitest symlink).
 *
 * Args:
 *   files: repo-relative posix keys to their contents.
 *   retry: the runner's own retry setting (a caller that needs another
 *     config simply rewrites the file).
 *
 * Returns:
 *   string: the project root.
 */
function vitestProject(files: Record<string, string>, retry = false): string {
  const root = tempDir('gateforge-vitest-contract-');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules', 'vitest'), join(root, 'node_modules', 'vitest'), 'dir');
  writeTree(root, {
    'package.json': '{ "type": "module", "private": true }\n',
    'vitest.config.mjs': [
      "import { defineConfig } from 'vitest/config';",
      'export default defineConfig({',
      "  test: {",
      "    include: ['tests/**/*.test.mjs'],",
      `    retry: ${retry ? '1' : '0'},`,
      '  },',
      '});',
      '',
    ].join('\n'),
    ...files,
  });
  return root;
}

const VITEST_HOST: RunnerContractHost = {
  runner: 'vitest',
  project: null,
  // The runner's own naming: a vitest test collects at a .test.mjs path
  // with the title path as the test name (see RunnerContractHost.scenario).
  scenario: { file: SCENARIO_FILE, titlePath: [SCENARIO_TITLE] },

  async materialize(scenario) {
    if (scenario.kind === 'zero') {
      return vitestProject({ [SCENARIO_FILE]: vitestFor('zero') });
    }
    return vitestProject({ [SCENARIO_FILE]: vitestFor(scenario.kind) }, scenario.kind === 'retry');
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
    // A jest-compatible JSON document whose every row carries no file
    // and no title — the shape a report takes when its rows cannot be
    // joined to an enumerated identity. Nothing may be attributed.
    return JSON.stringify({
      numTotalTests: 1,
      success: true,
      testResults: [
        { name: '', status: 'passed', assertionResults: [{ fullName: '', status: 'passed', title: '' }] },
      ],
    });
  },

  run(adapter, projectRoot, scenario) {
    const stateDir = join(projectRoot, '.gateforge-state');
    mkdirSync(stateDir, { recursive: true });
    const reportPath = join(stateDir, 'report.json');
    const runId = 'contract-run';
    const child = runSync(
      projectRoot,
      [
        join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--run',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
        `--reporter=${GATEFORGE_REPORTER}`,
        SCENARIO_FILE,
      ],
      {
        // The run-scoped wiring the pack reporter needs (same allowlist
        // shape the adapter's execute builds — no verifier key).
        env: { GATEFORGE_STATE_DIR: stateDir, GATEFORGE_RUN_ID: runId },
      },
    );
    let report = '';
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch {
      report = '';
    }
    let envelope = adapter.parseResults({ processExit: child.status, report, cwd: projectRoot });
    // Retry evidence lives in the reporter's flags document (the
    // JSON reporter has no retry surface) — same merge `execute` does.
    let flags = '';
    try {
      flags = readFileSync(join(stateDir, 'vitest', runId, 'runner-flags.json'), 'utf8');
    } catch {
      flags = '';
    }
    envelope = mergeVitestRunnerFlags(envelope, flags);
    const observation: ContractObservation = {
      envelope,
      raw: { processExit: child.status, report },
      ...(scenario.kind === 'retry' ? { note: 'retry produced with the runner own test.retry 1 setting' } : {}),
    };
    return Promise.resolve(observation);
  },
};

/** Runs one command to completion (captured). */
function runSync(
  cwd: string,
  command: readonly string[],
  options: { env?: Record<string, string> } = {},
): { status: number | null } {
  const child = spawnSync(command[0] ?? '', command.slice(1), {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { status: child.status };
}

describe('vitest behind the runner-adapter contract', () => {
  it('passes the shared contract suite (plan 2026-09-25 phase 4)', async () => {
    const adapter = new VitestRunnerAdapter();
    const violations = await runRunnerAdapterContract(adapter, VITEST_HOST);
    expect(violations).toEqual([]);
  });

  it('enumerates the expected set from a real project before the run', async () => {
    const root = vitestProject({
      [SCENARIO_FILE]: vitestFor('pass', { nested: true }),
    });
    const enumeration = await new VitestRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('discovered');
    expect(enumeration.tests).toHaveLength(1);
    expect(enumeration.tests[0]?.logicalKey).toBe('tests/contract.test.mjs#suite>contract');
  });

  it('keeps the zero-test enumeration honest', async () => {
    const root = vitestProject({ [SCENARIO_FILE]: vitestFor('zero') });
    const enumeration = await new VitestRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('unavailable');
    expect(enumeration.tests).toEqual([]);
  });

  it('tags every session with its own proxy origin (contract: tag-varies-per-session)', () => {
    const adapter = new VitestRunnerAdapter();
    const first = adapter.childEnv(
      { logicalKey: 'tests/a.test.mjs#one', frameworkId: 'tests/a.test.mjs::one', project: null },
      {
        witnessUrl: 'http://127.0.0.1:1',
        runToken: 'token',
        sessionId: 'session-one',
        sessionToken: 'session-token-one',
        sessionProxyUrl: 'http://127.0.0.1:9101',
        appBaseUrl: 'http://127.0.0.1:2',
      },
    );
    const second = adapter.childEnv(
      { logicalKey: 'tests/a.test.mjs#two', frameworkId: 'tests/a.test.mjs::two', project: null },
      {
        witnessUrl: 'http://127.0.0.1:1',
        runToken: 'token',
        sessionId: 'session-two',
        sessionToken: 'session-token-two',
        sessionProxyUrl: 'http://127.0.0.1:9102',
        appBaseUrl: 'http://127.0.0.1:2',
      },
    );
    expect(first.tagChannel).toBe('session-proxy');
    expect(first.vars['GATEFORGE_SESSION_PROXY_URL']).not.toBe(second.vars['GATEFORGE_SESSION_PROXY_URL']);
    expect(first.vars['GATEFORGE_WITNESS_VERIFIER_KEY']).toBeUndefined();
  });

  it('refuses to attribute report rows that carry no file/title identity', () => {
    const envelope = new VitestRunnerAdapter().parseResults({
      processExit: 0,
      report: VITEST_HOST.untaggedReport(),
    });
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toContain('no attributable');
  });

  it('blocks a runner-assisted retry detected from the reporter flags', () => {
    const green = new VitestRunnerAdapter().parseResults({
      processExit: 0,
      report: JSON.stringify({
        numTotalTests: 1,
        testResults: [
          {
            name: '/tmp/x/tests/contract.test.mjs',
            status: 'passed',
            assertionResults: [{ ancestorTitles: [], title: 'contract', status: 'passed' }],
          },
        ],
      }),
    });
    expect(green.complete).toBe(true);
    const merged = mergeVitestRunnerFlags(
      green,
      JSON.stringify({ schemaVersion: 1, retriesDetected: true }),
    );
    expect(merged.complete).toBe(false);
    expect(merged.retriesDetected).toBe(true);
  });
});

describe('enumeration never leaks gate wiring into consumer test code', () => {
  it('runs the consumer config with no GATEFORGE_* name in its environment', async () => {
    // The consumer's vitest.config runs INSIDE the enumeration child, so
    // whatever the child environment holds is readable (and exfiltrable)
    // by the repository being gated. Signing material must never be there.
    const dump = tempDir('gateforge-vitest-envdump-') + '/env.json';
    const root = vitestProject({ [SCENARIO_FILE]: vitestFor('pass') });
    writeTree(root, {
      'vitest.config.mjs': [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(dump)}, JSON.stringify(Object.fromEntries(`,
        '  Object.entries(process.env).filter(([name]) => name.startsWith("GATEFORGE_")),',
        '), null, 2), "utf8");',
        "import { defineConfig } from 'vitest/config';",
        'export default defineConfig({ test: { include: ["tests/**/*.test.mjs"] } });',
        '',
      ].join('\n'),
    });
    const previous = {
      key: process.env['GATEFORGE_WITNESS_VERIFIER_KEY'],
      token: process.env['GATEFORGE_RUN_TOKEN'],
    };
    process.env['GATEFORGE_WITNESS_VERIFIER_KEY'] = 'verifier-secret-never-in-untrusted-code';
    process.env['GATEFORGE_RUN_TOKEN'] = 'run-token-never-in-untrusted-code';
    let leaked: string[];
    try {
      const enumeration = await new VitestRunnerAdapter().enumerate(root);
      expect(enumeration.status).toBe('discovered');
      // The dump file is the proof the config really executed in the child.
      leaked = existsSync(dump) ? Object.keys(JSON.parse(readFileSync(dump, 'utf8')) as object) : ['<config never ran>'];
    } finally {
      if (previous.key === undefined) delete process.env['GATEFORGE_WITNESS_VERIFIER_KEY'];
      else process.env['GATEFORGE_WITNESS_VERIFIER_KEY'] = previous.key;
      if (previous.token === undefined) delete process.env['GATEFORGE_RUN_TOKEN'];
      else process.env['GATEFORGE_RUN_TOKEN'] = previous.token;
    }
    expect(leaked).toEqual([]);
  });
});
