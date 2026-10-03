/**
 * The Cypress runner adapter behind the runner-neutral `RunnerAdapter`
 * contract (plan 2026-09-25 phase 2), graded by the SHARED conformance
 * suite every adapter must pass — the same pass/fail/skip/retry/
 * unplanned/zero behaviours the Playwright and Vitest adapters are
 * graded on, plus the untagged-report case.
 *
 * The host materializes REAL Cypress projects (real config, real
 * specs, real headless Electron runs — no mocks): the expected set is
 * enumerated from the spec sources, scenario runs are real mocha
 * results, and every envelope is the adapter's own `parseResults`
 * reading of the report its plugin sealed.
 *
 * The Cypress CLI comes from `GATEFORGE_CYPRESS_TEST_BIN` (the same
 * env-carried mechanism the Alembic Postgres tests use for their
 * server). When it is not exported the suite SKIPS — a missing Cypress
 * install is an unavailable harness, never a silent pass.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { CypressRunnerAdapter } from '../src/discovery/cypress-runner-adapter.js';

/** The Cypress CLI install the host materializes projects against. */
const CYPRESS_BIN = process.env['GATEFORGE_CYPRESS_TEST_BIN'] ?? '';

/** True when the pointed-at install really is a Cypress CLI. */
function hasCypressRunner(): boolean {
  if (CYPRESS_BIN === '') return false;
  const probe = spawnSync(CYPRESS_BIN, ['version'], { encoding: 'utf8', timeout: 120_000 });
  return probe.status === 0;
}

const CYPRESS_AVAILABLE = hasCypressRunner();

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

/** The spec path every scenario variant declares. */
const SPEC_FILE = 'cypress/e2e/contract.cy.js';

/** The spec body for one scenario kind (same identity in every variant). */
function specFor(kind: ContractScenario['kind']): string {
  const cases: Record<ContractScenario['kind'], string> = {
    pass: "it('contract', () => {\n  expect(1).to.eq(1);\n});\n",
    fail: "it('contract', () => {\n  throw new Error('contract failure');\n});\n",
    skip: "it.skip('contract', () => {\n  expect(1).to.eq(1);\n});\n",
    unplanned:
      "it('contract', () => {\n  expect(1).to.eq(1);\n});\n" +
      "it('stowaway', () => {\n  expect(1).to.eq(1);\n});\n",
    zero: '// no tests declared\n',
    // The suite grades the untagged case through `untaggedReport` (a
    // report whose rows carry no identity), never through a spec.
    untagged: "it('contract', () => {\n  expect(1).to.eq(1);\n});\n",
    // Fails on the first attempt and passes on the second: the runner's
    // OWN `retries` setting produces attempt 2, and the adapter must
    // DETECT it from the report the plugin sealed.
    retry:
      "it('contract', () => {\n" +
      "  cy.task('contract-attempt').then((attempt) => {\n" +
      "    if (attempt === 1) throw new Error('first attempt fails');\n" +
      '  });\n' +
      '});\n',
  };
  return cases[kind];
}

/** The project config the scenarios run under (plain CommonJS, no deps). */
function cypressConfig(retry: boolean): string {
  return [
    "const attemptState = { count: 0 };",
    'module.exports = {',
    '  e2e: {',
    '    supportFile: false,',
    "    specPattern: 'cypress/e2e/**/*.cy.js',",
    '    video: false,',
    '    screenshotOnRunFailure: false,',
    `    retries: ${retry ? '1' : '0'},`,
    '    setupNodeEvents(on) {',
    '      on("task", {',
    '        "contract-attempt": () => {',
    '          attemptState.count += 1;',
    '          return attemptState.count;',
    '        },',
    '      });',
    '    },',
    '  },',
    '};',
    '',
  ].join('\n');
}

/** Builds a temp Cypress project wired to the real Cypress install. */
function cypressProject(spec: string, retry = false): string {
  const root = tempDir('gateforge-cypress-contract-');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(CYPRESS_BIN, join(root, 'node_modules', '.bin', 'cypress'));
  writeTree(root, {
    'package.json': '{ "name": "gateforge-cypress-contract", "private": true }\n',
    'cypress.config.cjs': cypressConfig(retry),
    [SPEC_FILE]: spec,
  });
  return root;
}

/** The contract host: real Cypress projects, real runs, no mocks. */
const CYPRESS_HOST: RunnerContractHost = {
  runner: 'cypress',
  project: null,
  // Cypress collects a spec at a .cy.js path with mocha's title path.
  scenario: { file: SPEC_FILE, titlePath: ['contract'] },

  materialize(scenario) {
    return Promise.resolve(cypressProject(specFor(scenario.kind), scenario.kind === 'retry'));
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
    // A sealed report whose every row carries no spec file and no title
    // — the shape a report takes when its rows cannot be joined to an
    // enumerated identity. Nothing may be attributed.
    return JSON.stringify({
      schemaVersion: 1,
      retriesDetected: false,
      specs: [{ file: '', tests: [{ titlePath: [], state: 'passed', attempts: 1 }] }],
    });
  },

  run(adapter, projectRoot) {
    // The host runs the project exactly as the adapter would: the
    // generated config wires the pack's plugin, which seals the report
    // from mocha's own after:run results.
    const stateDir = join(projectRoot, '.gateforge-state');
    const runId = 'contract-run';
    const run = adapter.execute({
      logicalKeys: [`${SPEC_FILE}#contract`],
      stateDir,
      runId,
      timeoutMs: 120_000,
      cwd: projectRoot,
    });
    return run.then((envelope) => {
      let report = '';
      try {
        report = readFileSync(join(stateDir, 'cypress', runId, 'report.json'), 'utf8');
      } catch {
        report = '';
      }
      const observation: ContractObservation = {
        envelope,
        raw: { processExit: envelope.processExit, report },
      };
      return observation;
    });
  },
};

describe.skipIf(!CYPRESS_AVAILABLE)('cypress behind the runner-adapter contract', () => {
  it('passes the shared contract suite (plan 2026-09-25 phase 2)', async () => {
    const violations = await runRunnerAdapterContract(new CypressRunnerAdapter(), CYPRESS_HOST);
    expect(violations).toEqual([]);
  });

  it('enumerates the expected set from the spec sources before the run', async () => {
    const root = cypressProject(specFor('unplanned'));
    const enumeration = await new CypressRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('discovered');
    expect(enumeration.tests.map((test) => test.logicalKey).sort()).toEqual([
      'cypress/e2e/contract.cy.js#contract',
      'cypress/e2e/contract.cy.js#stowaway',
    ]);
  });

  it('keeps the zero-test enumeration honest', async () => {
    const root = cypressProject(specFor('zero'));
    const enumeration = await new CypressRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('unavailable');
    expect(enumeration.tests).toEqual([]);
  });

  it('refuses to enumerate a spec whose titles are not literals', async () => {
    const root = cypressProject(`const title = 'contract';\nit(title, () => {});\n`);
    const enumeration = await new CypressRunnerAdapter().enumerate(root);
    expect(enumeration.status).toBe('unavailable');
    expect(enumeration.detail).toContain('non-literal title');
  });

  it('refuses to attribute report rows that carry no spec/title identity', () => {
    const envelope = new CypressRunnerAdapter().parseResults({
      processExit: 0,
      report: CYPRESS_HOST.untaggedReport(),
    });
    expect(envelope.complete).toBe(false);
    expect(envelope.incompleteDetail).toContain('no attributable');
  });

  it('blocks a runner-assisted retry the report records', () => {
    const envelope = new CypressRunnerAdapter().parseResults({
      processExit: 0,
      report: JSON.stringify({
        schemaVersion: 1,
        retriesDetected: false,
        specs: [
          {
            file: 'cypress/e2e/contract.cy.js',
            tests: [{ titlePath: ['contract'], state: 'passed', attempts: 2 }],
          },
        ],
      }),
    });
    expect(envelope.complete).toBe(false);
    expect(envelope.retriesDetected).toBe(true);
  });
});
