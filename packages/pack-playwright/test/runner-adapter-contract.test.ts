/**
 * The runner-adapter contract, run against the Playwright path (plan
 * 2026-09-25 phase 0 acceptance: "the contract suite runs against the
 * current Playwright path and passes — proves the interface is honest").
 *
 * Every scenario spawns the REAL playwright CLI over a temp project
 * with the engine's trusted synthesized config and the engine reporter,
 * then grades `adapter.parseResults` over the report the runner actually
 * wrote. Nothing here hand-writes an outcomes document: a contract pass
 * means the adapter reads a real runner's output the way supervision
 * needs, and a Cypress/pytest/Vitest adapter that cannot is caught by
 * the same suite.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runRunnerAdapterContract,
  type ContractObservation,
  type ContractScenario,
  type RunnerContractHost,
} from '@gate-forge/witness/adapter';
import { PlaywrightRunnerAdapter } from '../src/discovery/playwright-runner-adapter.js';
import { defaultPlaywrightCommand } from '../src/discovery/supervised-run.js';
import { synthesizeTrustedConfig, trustedReporterEntry } from '../src/discovery/trusted-config.js';

/** The gateforge monorepo root (playwright module resolution). */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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

/** The gateforge config the enumeration reads (minimal, valid). */
const CONFIG_YAML = [
  'schemaVersion: 1',
  'project:',
  '  languages: [typescript]',
  '  paths:',
  '    include: ["e2e/**/*.ts"]',
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
  'clock:',
  '  mode: fixed',
  '  fixedAt: "2026-01-01T00:00:00.000Z"',
  '',
].join('\n');

/**
 * The spec body for one scenario kind. Every variant declares the SAME
 * test identity (`e2e/contract.spec.ts` › `contract`); only the
 * behaviour differs, so the expected set never moves between scenarios.
 */
function specFor(kind: ContractScenario['kind']): string {
  // Every kind is covered by the switch below; the throw keeps the
  // return type honest if a new kind is added without a spec body.
  const header = ["import { test } from 'playwright/test';", ''];
  switch (kind) {
    case 'pass':
      return [...header, "test('contract', async () => {});", ''].join('\n');
    case 'fail':
      return [...header, "test('contract', async () => { throw new Error('contract failure'); });", ''].join('\n');
    case 'skip':
      return [...header, "test.skip('contract', async () => {});", ''].join('\n');
    case 'unplanned':
      return [
        ...header,
        "test('contract', async () => {});",
        "test('stowaway', async () => {});",
        '',
      ].join('\n');
    case 'zero':
      return [...header, ''].join('\n');
    case 'retry': {
      // Fails on the first attempt, passes on the second: the runner's
      // own retry setting is what produces attempt 2, and the adapter
      // must DETECT it when the report arrives.
      const counter = "process.env['GATEFORGE_CONTRACT_ATTEMPTS'] ?? '0'";
      return [
        ...header,
        "import { readFileSync, writeFileSync } from 'node:fs';",
        `const attemptsFile = process.env['GATEFORGE_CONTRACT_ATTEMPTS_FILE'] ?? '';`,
        "test('contract', async () => {",
        `  const seen = attemptsFile === '' ? 0 : Number(readFileSync(attemptsFile, 'utf8'));`,
        "  if (attemptsFile !== '') writeFileSync(attemptsFile, String(seen + 1));",
        '  if (seen === 0) throw new Error(\'first attempt fails\');',
        '});',
        `void ${counter};`,
        '',
      ].join('\n');
    }
    default:
      throw new Error(`contract: no spec body for scenario '${String(kind)}'`);
  }
}

/** Builds a temp project the engine's playwright can run. */
function playwrightProject(files: Record<string, string>): string {
  const root = tempDir('gateforge-pw-contract-');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const name of ['playwright', 'playwright-core']) {
    symlinkSync(join(ROOT, 'node_modules', name), join(root, 'node_modules', name), 'dir');
  }
  writeTree(root, {
    'package.json': '{ "type": "module", "private": true }\n',
    'playwright.config.js': "export default { testDir: 'e2e', projects: [{ name: 'chromium' }] };\n",
    '.gateforge.yml': CONFIG_YAML,
    ...files,
  });
  return root;
}

const PLAYWRIGHT_HOST: RunnerContractHost = {
  runner: 'playwright',
  project: 'chromium',

  async materialize(scenario) {
    if (scenario.kind === 'zero') {
      return playwrightProject({
        'e2e/placeholder.spec.ts': "export const nothing = true;\n",
      });
    }
    return playwrightProject({ [scenario.file]: specFor(scenario.kind) });
  },

  executeRequest(projectRoot, scenario) {
    return {
      logicalKeys: scenario.expectedLogicalKeys,
      stateDir: join(projectRoot, '.gateforge-state'),
      runId: 'contract-run',
      timeoutMs: 120_000,
      cwd: projectRoot,
      projects: ['chromium'],
    };
  },

  untaggedReport() {
    return JSON.stringify({
      schemaVersion: 1,
      runStatus: 'passed',
      runnerErrors: [],
      shard: null,
      outcomes: [
        {
          testId: '',
          file: 'e2e/contract.spec.ts',
          titlePath: ['contract'],
          project: 'chromium',
          status: 'passed',
          attempt: 1,
          expectedFailure: false,
        },
      ],
    });
  },

  run(adapter, projectRoot, scenario) {
    const stateDir = join(projectRoot, '.gateforge-state');
    const outcomesPath = join(stateDir, 'runner-outcomes.json');
    const { configPath } = synthesizeTrustedConfig({
      cwd: projectRoot,
      stateDir,
      runId: 'contract-run',
      reporterEntry: trustedReporterEntry(),
      testFiles: scenario.kind === 'zero' ? undefined : [scenario.file],
      projects: ['chromium'],
    });
    // The supervised policy forces zero retries, so the retry case runs
    // the REAL runner with its own setting: what is under test is that
    // the adapter DETECTS the retry when a report carries one.
    const retries = scenario.kind === 'retry' ? '1' : '0';
    const attemptsFile = join(stateDir, 'attempts');
    const [command, ...prefix] = defaultPlaywrightCommand(projectRoot);
    const child = spawnSync(
      command ?? process.execPath,
      [
        ...prefix,
        'test',
        '--config',
        configPath,
        '--retries',
        retries,
        '--workers',
        '1',
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ...(scenario.kind === 'retry' ? { GATEFORGE_CONTRACT_ATTEMPTS_FILE: attemptsFile } : {}),
        },
        encoding: 'utf8',
        timeout: 180_000,
      },
    );
    let report = '';
    try {
      report = readFileSync(outcomesPath, 'utf8');
    } catch {
      report = '';
    }
    const raw = { processExit: child.status, report };
    const observation: ContractObservation = {
      envelope: adapter.parseResults(raw),
      raw,
      ...(scenario.kind === 'retry' ? { note: 'retry produced with the runner own --retries 1 setting' } : {}),
    };
    return Promise.resolve(observation);
  },
};

describe('playwright behind the runner-adapter contract', () => {
  it('passes the shared contract suite (plan 2026-09-25 phase 0)', async () => {
    const adapter = new PlaywrightRunnerAdapter();
    const violations = await runRunnerAdapterContract(adapter, PLAYWRIGHT_HOST);
    expect(violations).toEqual([]);
  });

  it('enumerates the expected set from a real project before the run', async () => {
    const root = playwrightProject({
      'e2e/contract.spec.ts': specFor('pass'),
    });

    const enumeration = await new PlaywrightRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('discovered');
    const suite = enumeration.tests.find(
      (test) => test.titlePath.join('>') === 'contract' && test.file === 'e2e/contract.spec.ts',
    );
    expect(suite?.project).toBe('chromium');
  });

  it('tags every session with its own proxy origin (contract: tag-varies-per-session)', () => {
    const adapter = new PlaywrightRunnerAdapter();
    const first = adapter.childEnv(
      { logicalKey: 'a#one', frameworkId: 'one', project: null },
      {
        witnessUrl: 'http://127.0.0.1:1',
        runToken: 'token',
        sessionId: 'session-one',
        sessionToken: 'session-token-one',
        sessionProxyUrl: 'http://127.0.0.1:1',
        appBaseUrl: 'http://127.0.0.1:2',
      },
    );
    const second = adapter.childEnv(
      { logicalKey: 'a#two', frameworkId: 'two', project: null },
      {
        witnessUrl: 'http://127.0.0.1:1',
        runToken: 'token',
        sessionId: 'session-two',
        sessionToken: 'session-token-two',
        sessionProxyUrl: 'http://127.0.0.1:2',
        appBaseUrl: 'http://127.0.0.1:2',
      },
    );
    expect(first.tagChannel).toBe('session-proxy');
    expect(first.vars['GATEFORGE_SESSION_PROXY_URL']).not.toBe(second.vars['GATEFORGE_SESSION_PROXY_URL']);
    expect(first.vars['GATEFORGE_WITNESS_VERIFIER_KEY']).toBeUndefined();
  });

  it('refuses to attribute outcomes whose runner identity never arrived', () => {
    const envelope = new PlaywrightRunnerAdapter().parseResults({
      processExit: 0,
      report: PLAYWRIGHT_HOST.untaggedReport(),
    });
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toContain('no runner test id');
  });

  it('keeps the zero-test enumeration honest', async () => {
    const root = playwrightProject({ 'e2e/placeholder.spec.ts': 'export const nothing = true;\n' });
    const enumeration = await new PlaywrightRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('unavailable');
    expect(enumeration.tests).toEqual([]);
  });
});
