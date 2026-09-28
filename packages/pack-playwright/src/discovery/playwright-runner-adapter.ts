/**
 * The Playwright runner adapter behind the runner-neutral
 * `RunnerAdapter` contract (plan 2026-09-25 phase 0).
 *
 * This is NOT a rewrite of the Playwright path: every call lands on the
 * code the supervised run already used (`discoverTestCatalog`,
 * `executeSupervisedPlaywright`, `parseOutcomesText`). Its job is to
 * state the four jobs — enumerate, tag, execute, parse — in the shape
 * every other runner will use, so the contract suite has something
 * honest to grade (phase 0 acceptance: "the contract suite runs against
 * the current Playwright path and passes").
 *
 * Compatibility: nothing here is on the supervised-run path. The
 * existing `PlaywrightAdapter` (discovery/adapters.ts) keeps serving the
 * CLI unchanged; this adapter is the contract-shaped view of the same
 * machinery.
 */
import { loadConfig, type GateforgeConfig } from '@gate-forge/core';
import type { RunnerExecutionEnvelope } from '@gate-forge/core';
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
import { ENV_APP_BASE_URL, ENV_RUN_TOKEN, ENV_WITNESS_URL } from '../constants.js';
import { discoverTestCatalog, type DiscoverOptions } from './discover.js';
import { executeSupervisedPlaywright, parseOutcomesText, type SupervisedRunOptions } from './supervised-run.js';

/**
 * Per-test session variables a runner adapter publishes to the test.
 *
 * These are the values the trusted CLI resolves for ONE supervisor-
 * opened session and hands to that test alone. They are new env NAMES
 * (additive — the frozen Playwright child allowlist is untouched, so an
 * existing Playwright user's run env is byte-identical); the Playwright
 * fixture itself receives the same values through the supervisor's
 * session-resolve response rather than through the environment.
 */
export const ENV_SESSION_ID = 'GATEFORGE_SESSION_ID';
export const ENV_SESSION_TOKEN = 'GATEFORGE_SESSION_TOKEN';
export const ENV_SESSION_PROXY_URL = 'GATEFORGE_SESSION_PROXY_URL';

/** The variables that carry ONE test's identity to its traffic. */
export const PLAYWRIGHT_IDENTITY_ENV: readonly string[] = [
  ENV_SESSION_ID,
  ENV_SESSION_TOKEN,
  ENV_SESSION_PROXY_URL,
];

/** Options the Playwright runner adapter accepts. */
export interface PlaywrightRunnerAdapterOptions {
  /** Discovery knobs (native list availability, timeouts). */
  discover?: Omit<DiscoverOptions, 'cwd' | 'config'>;
  /** Pre-loaded config; absent means load `<cwd>/.gateforge.yml`. */
  config?: GateforgeConfig;
  /** Supervised-run knobs (runner command override, timeout). */
  run?: SupervisedRunOptions;
}

/** Playwright behind the runner-neutral contract. */
export class PlaywrightRunnerAdapter implements RunnerAdapter {
  readonly runner = 'playwright';

  readonly capabilities = {
    inventory: 'available',
    resolveInstances: 'available',
    execute: 'available',
  } as const;

  constructor(private readonly options: PlaywrightRunnerAdapterOptions = {}) {}

  /**
   * Job 1: the expected set, fixed BEFORE the run (static scan
   * reconciled against the native list).
   *
   * Args:
   *   cwd: absolute repo root the playwright configuration lives under.
   *
   * Returns:
   *   Promise<RunnerEnumeration>: the enumerated tests, or an
   *   `unavailable` verdict. A project with no configured tests is
   *   `unavailable`, never an empty `discovered` list: nothing executed
   *   proves nothing.
   */
  async enumerate(cwd: string): Promise<RunnerEnumeration> {
    let config;
    try {
      config = this.options.config ?? loadConfig(`${cwd}/.gateforge.yml`);
    } catch (error) {
      return {
        status: 'unavailable',
        detail: `playwright enumeration could not load the gateforge config: ${describeError(error)}`,
        tests: [],
      };
    }
    let catalog;
    try {
      const discovered = await discoverTestCatalog({ cwd, config, ...this.options.discover });
      catalog = discovered.catalog;
    } catch (error) {
      return {
        status: 'unavailable',
        detail: `playwright enumeration failed: ${describeError(error)}`,
        tests: [],
      };
    }
    const tests: RunnerTestIdentity[] = catalog.entries
      .filter((entry) => entry.runner === 'playwright')
      .map((entry) => ({
        logicalKey: entry.logicalKey,
        project: entry.project,
        file: entry.file,
        titlePath: entry.titlePath,
        blockingAnnotations: [
          ...new Set(
            entry.suppressionSignals
              .filter((signal) => signal.kind === 'only' || signal.kind === 'skip' || signal.kind === 'fixme')
              .map((signal) => signal.kind),
          ),
        ].sort(),
      }))
      .sort((a, b) => (a.logicalKey < b.logicalKey ? -1 : a.logicalKey > b.logicalKey ? 1 : 0));
    if (tests.length === 0) {
      return {
        status: 'unavailable',
        detail: `playwright enumeration found no tests under ${cwd} — a zero-test run never proves coverage`,
        tests: [],
      };
    }
    return { status: 'discovered', detail: `enumerated ${String(tests.length)} playwright test(s)`, tests };
  }

  /**
   * Job 2: the per-test tag. Playwright's channel is the session proxy
   * origin: the fixture resolves the supervisor-opened session for the
   * current test and routes the page through that origin, so every
   * exchange — absolute paths included — is attributed to THAT session.
   *
   * Args:
   *   session: the test being tagged.
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
        [ENV_SESSION_ID]: context.sessionId,
        [ENV_SESSION_TOKEN]: context.sessionToken,
        [ENV_SESSION_PROXY_URL]: context.sessionProxyUrl,
      },
      tagChannel: 'session-proxy',
      identityVars: PLAYWRIGHT_IDENTITY_ENV,
      mechanism:
        'gateforge playwright fixture resolves the supervisor session for the running test and routes its page through the per-test session proxy origin',
    };
  }

  /**
   * Job 3: the supervised run (unchanged machinery, contract shape).
   *
   * Args:
   *   request: the exact selection, run identity, and wall-clock bound.
   *
   * Returns:
   *   Promise<RunnerExecutionEnvelope>: the structured outcome envelope.
   */
  async execute(request: RunnerExecuteRequest): Promise<RunnerExecutionEnvelope> {
    return executeSupervisedPlaywright(
      { logicalKeys: request.logicalKeys },
      { stateDir: request.stateDir, runId: request.runId, vars: {} },
      {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        // The project selection is part of the identity join key: a run
        // that does not select the enumerated projects reports outcomes
        // under different identities than the expected set was fixed
        // with, and supervision (correctly) calls them unplanned.
        ...(request.projects !== undefined ? { projects: request.projects } : {}),
        ...this.options.run,
      },
    );
  }

  /**
   * Job 4: the gateforge reporter's runner-outcomes document, through
   * the SAME validation and mapping the supervised run uses.
   *
   * Args:
   *   raw: the outcomes document JSON text plus the runner exit status.
   *
   * Returns:
   *   RunnerExecutionEnvelope: reporter input, never a verdict. An
   *   unreadable or malformed document is `complete: false`.
   */
  parseResults(raw: RunnerRawResults): RunnerExecutionEnvelope {
    return parseOutcomesText(raw.report, raw.processExit);
  }
}

/** Single-line message of an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
