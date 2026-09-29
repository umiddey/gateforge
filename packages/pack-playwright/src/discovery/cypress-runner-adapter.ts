/**
 * The Cypress runner adapter behind the runner-neutral `RunnerAdapter`
 * contract (plan 2026-09-25 phase 2).
 *
 * Cypress is the second witness-producing runner: same evidence rules
 * as Playwright, same supervision, no new trust tier.
 * - enumerate: Cypress cannot list tests without running them, so the
 *   expected set is read from the spec SOURCES (`cypress/spec-scan.ts`)
 *   and fixed BEFORE the run. A spec whose titles are not static
 *   literals enumerates `unavailable` — never a guessed half-set.
 * - tag: the pack's Cypress plugin (`cypress/plugin.ts`) registers the
 *   lifecycle tasks the generated support file calls; the support file
 *   resolves THIS test's session and rewrites `cy.request` traffic at
 *   the app origin onto that session's proxy origin (the same
 *   `session-proxy` channel the Playwright fixture uses). Traffic that
 *   does not go through it (a raw browser `fetch`) stays unattributed
 *   and is credited to nothing.
 * - execute: the project's own Cypress CLI, driven with a GENERATED
 *   config file that chains the project's config and adds the pack's
 *   plugin and support file. Selection granularity is the spec FILE.
 * - parse: the report the plugin seals from mocha's own `after:run`
 *   results, strictly: a row with no spec file or no title path is
 *   never attributed, a zero-test run is incomplete, and more than one
 *   attempt for a test is a runner-assisted retry (required retries
 *   are zero) that blocks the run.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { RunnerExecutionEnvelope, RunnerInstanceOutcome } from '@gate-forge/core';
import type {
  RunnerAdapter,
  RunnerChildEnv,
  RunnerChildEnvContext,
  RunnerEnumeration,
  RunnerExecuteRequest,
  RunnerRawResults,
  RunnerSessionTag,
  RunnerTestIdentity,
} from '@gate-forge/witness/adapter';
import {
  ENV_APP_BASE_URL,
  ENV_RUN_ID,
  ENV_RUN_TOKEN,
  ENV_STATE_DIR,
  ENV_WITNESS_URL,
} from '@gate-forge/witness/constants';
import {
  cypressSupportSource,
  registerGateforgeCypressPlugin,
  type CypressRunReport,
} from '../cypress/plugin.js';
import { scanCypressSpecs } from '../cypress/spec-scan.js';
import { buildWitnessedSessionRunnerEnv } from './runner-env.js';

// Public re-exports (the CLI supervised surface drives the adapter and
// needs the plugin registration plus the report type).
export { cypressSupportSource, registerGateforgeCypressPlugin };
export type { CypressRunReport };

/** Per-test session variables a runner adapter publishes to the test. */
export const CYPRESS_ENV_SESSION_ID = 'GATEFORGE_SESSION_ID';
export const CYPRESS_ENV_SESSION_TOKEN = 'GATEFORGE_SESSION_TOKEN';
export const CYPRESS_ENV_SESSION_PROXY_URL = 'GATEFORGE_SESSION_PROXY_URL';

/** The variables that carry ONE test's identity to its traffic. */
export const CYPRESS_IDENTITY_ENV: readonly string[] = [
  CYPRESS_ENV_SESSION_ID,
  CYPRESS_ENV_SESSION_TOKEN,
  CYPRESS_ENV_SESSION_PROXY_URL,
];

/** The report document the plugin seals for one run. */
const REPORT_FILE = 'report.json';

/** Project config file names the generated config can chain. */
const PROJECT_CONFIG_NAMES: readonly string[] = [
  'cypress.config.cjs',
  'cypress.config.js',
  'cypress.config.mjs',
  'cypress.config.ts',
  'cypress.config.mts',
];

/** Cypress exit codes: 0 = all specs passed, 1 = tests failed. */
const CYPRESS_EXIT_TESTS_FAILED = 1;

/** Options the Cypress runner adapter accepts. */
export interface CypressRunnerAdapterOptions {
  /**
   * Run-scoped witness wiring for `execute` (the trusted caller's
   * channel). Absent falls back to the ambient
   * `GATEFORGE_WITNESS_URL`/`GATEFORGE_RUN_TOKEN`/`GATEFORGE_APP_BASE_URL`.
   */
  witness?: { url?: string; token?: string; appBaseUrl?: string };
  /** The browser Cypress runs (`electron` unless the project says otherwise). */
  browser?: string;
}

/**
 * The Cypress runner adapter.
 *
 * The CLI is resolved LOCAL FIRST (`<cwd>/node_modules/.bin/cypress`,
 * the same rule the supervised Playwright run applies to its browser),
 * and an absent CLI is `unavailable` — never a silent pass.
 */
export class CypressRunnerAdapter implements RunnerAdapter<CypressRunReport | null> {
  readonly runner = 'cypress';

  readonly capabilities = {
    inventory: 'available',
    resolveInstances: 'available',
    execute: 'available',
  } as const;

  constructor(private readonly options: CypressRunnerAdapterOptions = {}) {}

  /**
   * Job 1: the expected set, fixed BEFORE the run, read from the spec
   * sources (Cypress has no list mode that does not execute the suite).
   *
   * Args:
   *   cwd: absolute project root.
   *
   * Returns:
   *   Promise<RunnerEnumeration>: the enumerated tests, or an
   *   `unavailable` verdict with a single cause (no specs, a spec with
   *   non-literal titles, or a spec tree that declares no test).
   */
  async enumerate(cwd: string): Promise<RunnerEnumeration> {
    const scanned = scanCypressSpecs(cwd);
    if (scanned.status === 'unavailable') {
      return { status: 'unavailable', detail: scanned.detail, tests: [] };
    }
    const tests: RunnerTestIdentity[] = scanned.tests.map((test) => ({
      logicalKey: `${test.file}#${test.titlePath.join('>')}`,
      project: null,
      file: test.file,
      titlePath: [...test.titlePath],
      blockingAnnotations: [],
      // The generated support file spools `<file>#<title path>` —
      // registration must name the same id.
      frameworkId: `${test.file}#${test.titlePath.join('>')}`,
    }));
    return {
      status: 'discovered',
      detail: `enumerated ${String(tests.length)} Cypress test(s) from the spec sources under ${cwd}`,
      tests: tests.sort((a, b) => (a.logicalKey < b.logicalKey ? -1 : a.logicalKey > b.logicalKey ? 1 : 0)),
    };
  }

  /**
   * Job 2: the per-test tag. Cypress cannot carry per-test environment
   * (one process serves the whole run), so the tag is issued at task
   * time by the pack's plugin and delivered to the browser by the
   * generated support file; these variables document the channel the
   * fixture resolves.
   *
   * Args:
   *   _session: the test being tagged.
   *   context: run-scoped, non-secret witness wiring.
   *
   * Returns:
   *   RunnerChildEnv: the run identity plus the session-scoped tag.
   */
  childEnv(_session: RunnerSessionTag, context: RunnerChildEnvContext): RunnerChildEnv {
    return {
      vars: {
        [ENV_WITNESS_URL]: context.witnessUrl,
        [ENV_RUN_TOKEN]: context.runToken,
        [ENV_APP_BASE_URL]: context.appBaseUrl,
        [ENV_STATE_DIR]: '<run-state dir>',
        [ENV_RUN_ID]: '<run id>',
        [CYPRESS_ENV_SESSION_ID]: context.sessionId,
        [CYPRESS_ENV_SESSION_TOKEN]: context.sessionToken,
        [CYPRESS_ENV_SESSION_PROXY_URL]: context.sessionProxyUrl,
      },
      tagChannel: 'session-proxy',
      identityVars: CYPRESS_IDENTITY_ENV,
      mechanism:
        'the gateforge Cypress plugin resolves the supervisor session per started test and the ' +
        "generated support file rewrites cy.request traffic at the app origin onto that session's proxy",
    };
  }

  /**
   * Job 3: runs the SELECTED spec files through the project's own
   * Cypress CLI with a generated config that chains the project's
   * config, wires the pack's plugin and support file, and forwards the
   * run-scoped (never secret) wiring through the witnessed-session env
   * allowlist.
   *
   * Args:
   *   request: the exact selection, run identity, and wall-clock bound.
   *
   * Returns:
   *   Promise<RunnerExecutionEnvelope>: the structured outcome envelope
   *   (a Cypress exit code alone is never a gate result).
   */
  async execute(request: RunnerExecuteRequest): Promise<RunnerExecutionEnvelope> {
    const cli = this.cypressCliOf(request.cwd);
    if (cli === null) {
      return envelopeIncomplete(
        null,
        `cypress execution found no Cypress CLI under ${request.cwd} — install cypress in the project`,
      );
    }
    const projectConfig = projectConfigOf(request.cwd);
    if (projectConfig.unsupported !== null) {
      return envelopeIncomplete(
        null,
        `cypress execution cannot chain the project config ${projectConfig.unsupported} — a config ` +
          'gateforge cannot load would silently change what the run exercises, so it fails closed',
      );
    }
    const files = new Set<string>();
    for (const logicalKey of request.logicalKeys) {
      const file = logicalKeyFileOf(logicalKey);
      if (file === null) {
        return envelopeIncomplete(
          null,
          `cypress execution cannot run '${logicalKey}': not a <spec file>#<title path> identity this adapter enumerated`,
        );
      }
      files.add(file);
    }
    const runDir = join(request.stateDir, 'cypress', request.runId);
    const appBaseUrl = this.options.witness?.appBaseUrl ?? process.env[ENV_APP_BASE_URL] ?? '';
    let generated: { configFile: string; supportFile: string };
    try {
      mkdirSync(runDir, { recursive: true });
      generated = writeGeneratedConfig(runDir, projectConfig.path, projectConfig.supportFile);
    } catch (error) {
      return envelopeIncomplete(null, `cypress execution cannot write its generated config: ${(error as Error).message}`);
    }
    const argv = [
      'run',
      '--project',
      request.cwd,
      '--config-file',
      generated.configFile,
      '--browser',
      this.options.browser ?? 'electron',
      '--quiet',
      ...(files.size > 0 ? ['--spec', [...files].sort().join(',')] : []),
    ];
    const child = spawn(cli, argv, {
      cwd: request.cwd,
      env: buildWitnessedSessionRunnerEnv(
        {
          [ENV_WITNESS_URL]: this.options.witness?.url ?? process.env[ENV_WITNESS_URL] ?? '',
          [ENV_RUN_TOKEN]: this.options.witness?.token ?? process.env[ENV_RUN_TOKEN] ?? '',
          [ENV_STATE_DIR]: request.stateDir,
          [ENV_RUN_ID]: request.runId,
          [ENV_APP_BASE_URL]: appBaseUrl,
        },
        process.env,
      ),
      // Cypress drives a browser process tree; the run is killed as a
      // GROUP so no orphan browser survives a timeout.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outcome = await new Promise<{ code: number | null; timedOut: boolean; error: Error | null }>((settle) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, request.timeoutMs);
      child.stdout?.resume();
      child.stderr?.resume();
      child.once('error', (error) => {
        clearTimeout(timer);
        settle({ code: null, timedOut: false, error });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        settle({ code, timedOut, error: null });
      });
    });
    if (outcome.error !== null) {
      return envelopeIncomplete(null, `cypress execution could not start (${cli}): ${outcome.error.message}`);
    }
    if (outcome.timedOut) {
      return envelopeIncomplete(
        null,
        `cypress execution exceeded its ${String(request.timeoutMs)}ms bound and was killed — an incomplete run never grades complete`,
      );
    }
    let report = '';
    try {
      report = readFileSync(join(runDir, REPORT_FILE), 'utf8');
    } catch {
      report = '';
    }
    const envelope = this.parseResults({ processExit: outcome.code, report });
    if (report === '') {
      return {
        ...envelope,
        incompleteDetail: `cypress produced no run report in ${runDir} (exit ${String(outcome.code)}) — fail closed`,
      };
    }
    return envelope;
  }

  /**
   * Job 4: the sealed run report, strictly mapped.
   *
   * Args:
   *   raw: the report text plus the runner exit status.
   *
   * Returns:
   *   RunnerExecutionEnvelope: reporter INPUT, never a verdict. An
   *   unreadable report, a zero-test run, and a report whose rows carry
   *   no attributable identity are all `complete: false`.
   */
  parseResults(raw: RunnerRawResults): RunnerExecutionEnvelope {
    if (raw.report.trim() === '') {
      return envelopeIncomplete(raw.processExit, 'no Cypress run report — a missing report never proves anything');
    }
    let report: CypressRunReport;
    try {
      const parsed: unknown = JSON.parse(raw.report);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('the Cypress run report is not an object');
      }
      report = parsed as CypressRunReport;
    } catch (error) {
      return envelopeIncomplete(
        raw.processExit,
        `unparsable Cypress run report — fail closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const rows: Array<{ identity: { file: string; titlePath: string[] }; row: CypressRunReport['specs'][number]['tests'][number] }> = [];
    let rowCount = 0;
    for (const spec of report.specs ?? []) {
      const file = typeof spec.file === 'string' ? spec.file : '';
      for (const test of spec.tests ?? []) {
        rowCount += 1;
        const titlePath = Array.isArray(test.titlePath) ? test.titlePath : [];
        // A row with no spec file or no title cannot be joined to an
        // enumerated identity: it is attributed to NOTHING.
        if (file === '' || titlePath.length === 0) continue;
        rows.push({ identity: { file, titlePath }, row: test });
      }
    }
    if (rowCount > 0 && rows.length === 0) {
      return envelopeIncomplete(
        raw.processExit,
        `the Cypress report carries ${String(rowCount)} row(s) with no attributable spec/title identity — ` +
          'an unidentified row is never attributed to a test',
      );
    }
    if (rowCount === 0) {
      return envelopeIncomplete(raw.processExit, 'the Cypress report covers zero tests — a zero-test run is incomplete');
    }
    const outcomes: RunnerInstanceOutcome[] = rows.map((entry) => ({
      logicalKey: `${entry.identity.file}#${entry.identity.titlePath.join('>')}`,
      project: null,
      frameworkId: `${entry.identity.file}::${entry.identity.titlePath.join('::')}`,
      status:
        entry.row.state === 'passed' ? 'passed' : entry.row.state === 'pending' ? 'skipped' : 'failed',
      attempt: entry.row.attempts >= 1 ? entry.row.attempts : 1,
    }));
    if (report.retriesDetected === true || outcomes.some((outcome) => outcome.attempt > 1)) {
      return {
        processExit: raw.processExit,
        complete: false,
        incompleteDetail:
          'cypress runner-assisted retry detected (required retries are zero) — the run blocks',
        outcomes,
        fixtureOutcome: 'passed' as const,
        retriesDetected: true,
        retriesDetail: 'mocha recorded more than one attempt for at least one Cypress test',
      };
    }
    const exitDetail = cypressExitIncompleteDetail(raw.processExit);
    if (exitDetail !== null) return { ...envelopeIncomplete(raw.processExit, exitDetail), outcomes };
    return { processExit: raw.processExit, complete: true, outcomes, fixtureOutcome: 'passed' as const };
  }

  /**
   * The runner's native parsed report (diagnostics surfaces).
   *
   * Args:
   *   raw: the report text plus the runner exit status.
   *
   * Returns:
   *   CypressRunReport | null: the parsed document, or null when the
   *   report is absent or unparsable (never a guess).
   */
  parseReport(raw: RunnerRawResults): CypressRunReport | null {
    if (raw.report.trim() === '') return null;
    try {
      const parsed: unknown = JSON.parse(raw.report);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as CypressRunReport)
        : null;
    } catch {
      return null;
    }
  }

  /** The Cypress CLI for a project (local-first), or null. */
  private cypressCliOf(cwd: string): string | null {
    const local = join(cwd, 'node_modules', '.bin', 'cypress');
    return existsSync(local) ? local : null;
  }
}

/** The project's chainable Cypress config file, or why it cannot be chained. */
interface ProjectConfig {
  readonly path: string | null;
  readonly supportFile: string | null;
  readonly unsupported: string | null;
}

/**
 * Locates the project's Cypress config and its support file.
 *
 * @param cwd absolute project root.
 * @returns the config path, the support file path (when the config
 *   declares one that exists), or the reason the config cannot be
 *   chained (ESM/TypeScript configs are refused rather than silently
 *   replaced by a config that would exercise something else).
 */
function projectConfigOf(cwd: string): ProjectConfig {
  for (const name of PROJECT_CONFIG_NAMES) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    if (!name.endsWith('.cjs') && !name.endsWith('.js')) {
      return { path: null, supportFile: null, unsupported: name };
    }
    return { path, supportFile: supportFileOf(cwd), unsupported: null };
  }
  return { path: null, supportFile: supportFileOf(cwd), unsupported: null };
}

/**
 * The project's own support file (the default locations Cypress itself
 * probes), or null when the project declares/has none.
 *
 * @param cwd absolute project root.
 * @returns the absolute support-file path, or null.
 */
function supportFileOf(cwd: string): string | null {
  const candidates = [
    'cypress/support/e2e.js',
    'cypress/support/e2e.cjs',
    'cypress/support/e2e.ts',
    'cypress/support/index.js',
    'cypress/support/index.ts',
  ];
  for (const candidate of candidates) {
    const path = join(cwd, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Writes the generated config and support file for one run.
 *
 * @param runDir the run-scoped Cypress directory.
 * @param projectConfigPath the project's chainable config, or null.
 * @param projectSupportFile the project's own support file to chain first.
 * @returns the generated file paths.
 */
function writeGeneratedConfig(
  runDir: string,
  projectConfigPath: string | null,
  projectSupportFile: string | null,
): { configFile: string; supportFile: string } {
  const pluginModule = cypressPluginModulePath();
  if (pluginModule === null) {
    throw new Error(
      'the gateforge Cypress plugin module is not built — a run without it could not tag or ' +
        'report anything, so it fails closed',
    );
  }
  const supportFile = join(runDir, 'support.cjs');
  writeFileSync(supportFile, cypressSupportSource(projectSupportFile), 'utf8');
  const configFile = join(runDir, 'gateforge.config.cjs');
  const source = [
    "// Generated by gateforge (plan 2026-09-25 phase 2). Do not edit.",
    "'use strict';",
    `const { registerGateforgeCypressPlugin } = require(${JSON.stringify(pluginModule)});`,
    `const base = ${projectConfigPath === null ? '{}' : `require(${JSON.stringify(projectConfigPath)})`};`,
    'const e2e = Object.assign({}, base.e2e || {});',
    `e2e.supportFile = ${JSON.stringify(supportFile)};`,
    'const baseSetup = e2e.setupNodeEvents;',
    '// setupNodeEvents lives under the testing type: that is where',
    "// Cypress looks for it (config[testingType].setupNodeEvents).",
    'e2e.setupNodeEvents = function (on, config) {',
    '  registerGateforgeCypressPlugin(on);',
    '  if (typeof baseSetup === "function") baseSetup.call(this, on, config);',
    '};',
    'module.exports = Object.assign({}, base, {',
    '  e2e,',
    '});',
    '',
  ].join('\n');
  writeFileSync(configFile, source, 'utf8');
  return { configFile, supportFile };
}

/**
 * The built Cypress plugin module the generated config requires (the
 * dist layout, or the monorepo's compiled dist when this module runs
 * from source). Null when nothing is built.
 *
 * @returns the absolute module path, or null.
 */
function cypressPluginModulePath(): string | null {
  const candidates = [
    fileURLToPath(new URL('../cypress/plugin.js', import.meta.url)),
    fileURLToPath(new URL('../../dist/cypress/plugin.js', import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Kills a Cypress process GROUP (the CLI plus its browser children), so
 * a timed-out run leaves no orphan browser behind.
 *
 * @param child the spawned Cypress CLI process.
 * @returns void
 */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** The file part of a logical key, or null (never a wildcard). */
function logicalKeyFileOf(logicalKey: string): string | null {
  const hash = logicalKey.indexOf('#');
  if (hash <= 0) return null;
  const file = logicalKey.slice(0, hash);
  if (file === '' || logicalKey.slice(hash + 1).includes('#')) return null;
  return file;
}

/** Cypress exit codes, fail closed (0 passed, 1 test failures). */
function cypressExitIncompleteDetail(exit: number | null): string | null {
  if (exit === null) return 'cypress ended without an exit status — incomplete';
  if (exit !== 0 && exit !== CYPRESS_EXIT_TESTS_FAILED) {
    return `cypress ended with status ${String(exit)} (fatal runner error) — incomplete`;
  }
  return null;
}

/** Single-cause incomplete envelope (no outcomes are ever invented). */
function envelopeIncomplete(processExit: number | null, detail: string): RunnerExecutionEnvelope {
  return { processExit, complete: false, incompleteDetail: detail, outcomes: [], fixtureOutcome: 'unknown' as const };
}
