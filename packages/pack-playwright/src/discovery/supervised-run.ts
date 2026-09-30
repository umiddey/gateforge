/**
 * Supervised Playwright execution (plan 2026-09-13 Phase 4 work items
 * 1-2, ADR 0005 D2; execution-authority fix: trusted-config synthesis).
 * The adapter's `execute` half. Trusted supervision owns the run — the
 * consumer's playwright config file is NEVER loaded (it is arbitrary
 * main-process code that could fabricate the lifecycle spool and the
 * outcomes document, then exit 0 before any spec executes — the
 * confirmed execution bypass). Instead the supervisor synthesizes a
 * minimal trusted config into the excluded run-state dir (exact selected
 * test files, bare project names as data, the engine reporter forced by
 * absolute path with run-state paths as constructor options, serial
 * workers, zero retries) and runs the runner with `--config <trusted>`.
 *
 * Honesty rules:
 * - Only the engine reporter writes the lifecycle spool + outcomes
 *   document, and only to parent-side paths the runner child never
 *   learns (no state paths in the child env).
 * - Reporter data is input only: per-instance outcomes are
 *   supervision-normalized here, and the expected-set comparison happens
 *   in the core supervision module, not in the runner.
 * - A nonzero process exit, a timeout kill, malformed/missing outcomes,
 *   and any non-single shard are typed incomplete runs.
 * - The child environment is an ALLOWLIST (enforcement-review fix 1):
 *   `process.env` is never merged wholesale, so signing material
 *   (GATEFORGE_WITNESS_VERIFIER_KEY) and every other unlisted variable
 *   cannot reach the untrusted runner. See `discovery/runner-env.ts`.
 * - Compatibility limits (not transparent): consumer globalSetup /
 *   globalTeardown / reporters / webServer / per-project `use` options
 *   / sharding are NOT honored. See `discovery/trusted-config.ts`.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  RunnerExecutionEnv,
  RunnerExecutionEnvelope,
  RunnerInstanceOutcome,
  RunnerSelection,
} from '@gate-forge/core';
import { buildRunnerChildEnv } from './runner-env.js';
import { localPlaywrightCliCandidates } from './reconcile.js';
import { synthesizeTrustedConfig, trustedReporterEntry, type ProjectScope } from './trusted-config.js';

/** Default whole-run wall-clock bound for one supervised playwright run. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** The runner-outcomes document the gateforge reporter writes. */
export interface RunnerOutcomesDocument {
  schemaVersion: 1;
  /** The runner's final run status (FullResult.status). */
  runStatus: string | null;
  /** Runner-level errors (globalSetup/teardown/runner body). */
  runnerErrors: string[];
  /** One row per executed test instance (per project instance). */
  outcomes: Array<{
    testId: string;
    file: string;
    titlePath: string[];
    project: string | null;
    status: string;
    attempt: number;
    expectedFailure: boolean;
  }>;
  /** Shard declaration from TEST_SHARD, or null when unsharded. */
  shard: { index: number; total: number } | null;
}

/** Options for one supervised playwright run. */
export interface SupervisedRunOptions {
  /**
   * Base argv of the runner command (default: the engine's pinned
   * playwright CLI). Tests substitute a stub runner here; production
   * never overrides it. A stub ignores the trusted `--config` flags the
   * supervisor appends (it replaces the whole invocation).
   */
  command?: readonly string[];
  /** Whole-run wall-clock bound (default {@link DEFAULT_RUN_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Repo root override (default: process cwd; the trusted testDir). */
  cwd?: string;
  /** Trusted operator-provided app proxy URL used by relative navigation. */
  appBaseUrl?: string;
  /** Trusted operator-provided browser session file (never passed to workers). */
  storageState?: string;
  /**
   * Exact repo-relative posix test files to run (the supervisor's
   * selection as data). Undefined = the runner default (every spec
   * under the root). The consumer config's scoping never applies.
   */
  testFiles?: readonly string[];
  /**
   * Exact repo-relative `file:line` locations of the selected tests
   * (the supervisor's per-TEST selection as positional arguments).
   * Undefined = file granularity. The values come from the plan fixed
   * before the run, never from the suite, and are passed as positional
   * location filters — never as a suite-controlled flag.
   */
  testLocations?: readonly string[];
  /**
   * Bare project names to run (identity only). Undefined = no project
   * filter. Per-project code options are never honored.
   */
  projects?: readonly string[];
  /**
   * The supervisor's OWN per-project file selection — each named project
   * runs exactly the files the plan attributed to it. Required whenever a
   * project-scoped config is in play (the standard `setup`-dependency auth
   * pattern): without it the runner collects every selected file under every
   * project and executes identities the registered expected set never bound.
   * Files no scope claims still run through the global `testMatch`.
   */
  projectScopes?: readonly ProjectScope[];
  /**
   * Engine reporter entry override (tests point at a built reporter;
   * production resolves the pack's own dist entry).
   */
  reporterEntry?: string;
}

/**
 * The pinned playwright version visible to this process (the pack's own
 * dependency — the same CLI the supervised run uses), or 'unknown' when
 * the manifest cannot be read (honest placeholder, never a guess).
 */
export function playwrightVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve('playwright/package.json');
    return (require(pkg) as { version?: unknown }).version as string ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Executes the configured playwright suite under trusted supervision and
 * returns the structured outcome envelope (plan Phase 4 item 1). The
 * consumer's config file is NEVER loaded (see the module doc); the run
 * uses the synthesized trusted config over the exact selected files,
 * narrowed below file granularity to the exact selected `file:line`
 * locations when the caller supplies them.
 *
 * Args:
 *   selection: the exact logical keys the supervisor expects (data only
 *     at this layer — the run is driven by `options.testFiles` plus the
 *     optional `options.testLocations`).
 *   env: run-state dir + run identity + pre-sanitized vars the child
 *     inherits (witness wiring; NEVER verifier material, NEVER state
 *     paths — the child must not locate the spool or outcomes files).
 *   options: runner command override (tests), timeout, cwd, the exact
 *     test files/locations/projects to run, reporter entry override.
 *
 * Returns:
 *   Promise<RunnerExecutionEnvelope>: the structured outcome envelope —
 *   `complete` is false with a single-cause detail for missing/failed
 *   outcomes, timeout, or nonzero exit.
 */
export async function executeSupervisedPlaywright(
  selection: RunnerSelection,
  env: RunnerExecutionEnv,
  options: SupervisedRunOptions = {},
): Promise<RunnerExecutionEnvelope> {
  void selection; // the run is driven by the file/location options; the supervisor owns the comparison
  const cwd = options.cwd ?? process.cwd();
  const outcomesPath = join(env.stateDir, 'runner-outcomes.json');
  // A stale outcomes file from a previous run must never be readable as
  // this run's result: remove it before spawning.
  rmSync(outcomesPath, { force: true });
  // Trusted-config synthesis (execution-authority fix): the consumer
  // config is data at most, never code. The synthesized config forces
  // the engine reporter (absolute entry, parent-side paths as options)
  // over the exact selected files. A hostile consumer config never
  // executes, so it cannot fabricate spool/outcomes and exit early.
  const { configPath } = synthesizeTrustedConfig({
    cwd,
    stateDir: env.stateDir,
    runId: env.runId,
    reporterEntry: options.reporterEntry ?? trustedReporterEntry(),
    ...(options.appBaseUrl !== undefined ? { appBaseUrl: options.appBaseUrl } : {}),
    ...(options.storageState !== undefined ? { storageState: options.storageState } : {}),
    ...(options.testFiles !== undefined ? { testFiles: options.testFiles } : {}),
    ...(options.projects !== undefined ? { projects: options.projects } : {}),
    ...(options.projectScopes !== undefined ? { projectScopes: options.projectScopes } : {}),
  });
  const baseCommand = options.command ?? defaultPlaywrightCommand(cwd);
  const isStub = options.command !== undefined;
  const locations = [...new Set(options.testLocations ?? [])].sort();
  const argv = isStub
    ? [...baseCommand, 'test', '--retries=0', ...locations]
    : [
        ...baseCommand,
        'test',
        '--config',
        configPath,
        '--retries=0',
        '--workers=1',
        ...locations,
      ];
  const child = spawn(argv[0] ?? '', argv.slice(1), {
    cwd,
    // ALLOWLIST ONLY (enforcement-review fix 1 + execution-authority
    // fix): no wholesale process.env merge — the verifier key and every
    // other unlisted variable never reach the untrusted runner — and NO
    // state paths (spool/outcomes/obligations locations stay parent-side
    // so worker code cannot address them). stdio stdin is 'ignore'.
    env: buildRunnerChildEnv(env.vars, process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  // Diagnostic pass-through (display only): the runner's own output never
  // authorizes anything, but a failed supervised run is undebuggable
  // without seeing WHY the tests failed. Opt-in via environment so the
  // default gate output stays pure.
  const echoRunnerOutput = process.env['GATEFORGE_DEBUG_RUNNER'] === '1';
  const outcome = await new Promise<{ code: number | null; timedOut: boolean; error: Error | null }>(
    (settle) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (echoRunnerOutput) process.stderr.write(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (echoRunnerOutput) process.stderr.write(chunk);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        settle({ code: null, timedOut: false, error });
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        settle({ code, timedOut, error: null });
      });
    },
  );
  void stdout;
  if (outcome.error !== null) {
    return incomplete(
      null,
      `supervised run could not start the runner (${argv.join(' ')}): ${outcome.error.message}`,
    );
  }
  if (outcome.timedOut) {
    return incomplete(
      outcome.code,
      `supervised run exceeded its ${String(options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)}ms bound and was killed — ` +
        'an incomplete run never reports success',
    );
  }
  const document = readOutcomesDocument(outcomesPath);
  if (document === null) {
    return incomplete(
      outcome.code,
      'runner outcomes missing or malformed — the trusted engine reporter writes them on every ' +
        'supervised run (absent = crash, kill, or lost contact; an incomplete run never reports success)',
    );
  }
  return parseOutcomesDocument(document, outcome.code);
}

/**
 * Maps one validated runner-outcomes document onto the structured
 * outcome envelope. Shared by the supervised run and the runner-adapter
 * contract's `parseResults` (plan 2026-09-25 phase 0) so BOTH read the
 * runner's report through exactly one mapping — a second copy is how a
 * supervised run and a contract run start disagreeing about what a
 * green run looks like.
 *
 * Reporter data is INPUT here, never signature authority: `complete` is
 * the adapter's honest read of runner status, runner-level errors, shard
 * completeness, retry attempts, and the process exit, and supervision
 * (`@gate-forge/core`) still compares the outcomes against the expected
 * set fixed before the run.
 *
 * Args:
 *   document: the validated runner-outcomes document.
 *   processExit: the runner process exit status (null when it never ran).
 *
 * Returns:
 *   RunnerExecutionEnvelope: the structured outcome envelope.
 */
export function parseOutcomesDocument(
  document: RunnerOutcomesDocument,
  processExit: number | null,
): RunnerExecutionEnvelope {
  const runnerErrorsFailed = document.runnerErrors.length > 0;
  const fixtureOutcome: 'passed' | 'failed' | 'unknown' =
    document.runStatus === 'passed' && !runnerErrorsFailed
      ? 'passed'
      : document.runStatus === null
        ? 'unknown'
        : 'failed';
  const shardComplete = document.shard === null || document.shard.total <= 1;
  const outcomes: RunnerInstanceOutcome[] = document.outcomes.map((row) => ({
    logicalKey: `${row.file}#${row.titlePath.join('>')}`,
    project: row.project,
    frameworkId: row.testId,
    status: normalizeStatus(row.status),
    attempt: row.attempt >= 1 ? row.attempt : 1,
    expectedFailure: row.expectedFailure === true,
  }));
  const maxAttempt = outcomes.reduce((max, row) => Math.max(max, row.attempt), 1);
  const retriesDetected = maxAttempt > 1;
  // A row the reporter could not identify belongs to NO test. The
  // reporter always writes the runner's own test id, so this only fires
  // for a report whose per-test identity never reached it — and then
  // the run is incomplete rather than partially attributed (the same
  // rule the witness applies to traffic that bypassed every session
  // channel).
  const unattributed = outcomes.filter((row) => row.frameworkId === '').length;
  const complete =
    unattributed === 0 &&
    document.runStatus === 'passed' &&
    !runnerErrorsFailed &&
    shardComplete &&
    !retriesDetected &&
    processExit === 0;
  return {
    processExit,
    complete,
    outcomes,
    fixtureOutcome,
    shards: document.shard === null ? null : { complete: shardComplete, detail: `TEST_SHARD reported ${String(document.shard.index)}/${String(document.shard.total)}` },
    retriesDetected,
    ...(retriesDetected
      ? { retriesDetail: `an instance reported attempt ${String(maxAttempt)} (required retries are zero)` }
      : {}),
    engines: { node: process.version, playwright: playwrightVersion() },
    browsers: {},
    ...(complete
      ? {}
      : {
          incompleteDetail:
            unattributed > 0
              ? `${String(unattributed)} outcome row(s) carried no runner test id — untagged results are never attributed to a test`
              : document.runStatus !== 'passed'
                ? `runner reported final status '${String(document.runStatus ?? 'unknown')}'`
                : runnerErrorsFailed
                  ? `runner-level errors observed: ${document.runnerErrors[0] ?? ''}`
                  : !shardComplete
                    ? `shard run incomplete (${String(document.shard?.total ?? '?')} shards declared)`
                    : processExit !== 0
                      ? `runner exited with status ${String(processExit)}`
                      : 'supervised run incomplete',
        }),
  };
}

/**
 * Parses a runner-outcomes document supplied as TEXT: the
 * runner-adapter contract's `parseResults` surface, so a caller can
 * grade a report the adapter did not spawn.
 *
 * Args:
 *   raw: the outcomes document JSON text.
 *   processExit: the runner process exit status.
 *
 * Returns:
 *   RunnerExecutionEnvelope: the envelope, or a typed incomplete one
 *   when the document is unreadable (fail closed).
 */
export function parseOutcomesText(raw: string, processExit: number | null): RunnerExecutionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return incomplete(
      processExit,
      `runner outcomes are not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validated = validateOutcomesDocument(parsed);
  if (validated === null) {
    return incomplete(
      processExit,
      'runner outcomes are missing or malformed — a malformed report is never read as a green run',
    );
  }
  return parseOutcomesDocument(validated, processExit);
}

/**
 * Default runner command: the scanned repo's own playwright CLI when it
 * has one, else the engine's own pinned playwright. The CLI is passed
 * as a PLAIN absolute filesystem path — Node's process entry must be a
 * path, never a `file:` URL (a URL argument fails with
 * MODULE_NOT_FOUND before the runner starts, which would masquerade as
 * a failed suite). A broken pack dependency surfaces as the typed
 * incomplete envelope (the argv names the path), never a hang.
 *
 * Args:
 *   cwd: absolute root of the repo being run, when the caller knows it.
 *
 * Returns:
 *   readonly string[]: `[process.execPath, <playwright cli.js>]`.
 */
export function defaultPlaywrightCommand(cwd?: string): readonly string[] {
  // CONSUMER-FIRST resolution (consumer migration, E22; install
  // rehearsal F7): the supervised run must execute under the scanned
  // repo's OWN playwright — its config and specs load through that
  // version, and a mismatch dies with the two-versions-of-@playwright/
  // test conflict, not with a missing dependency. Candidate order is
  // the nearest install first, `@playwright/test` before the bare
  // `playwright` pin. Fixture repos symlink the monorepo node_modules,
  // so the fallback resolves identically.
  if (cwd !== undefined) {
    for (const candidate of localPlaywrightCliCandidates(cwd)) {
      if (existsSync(candidate)) return [process.execPath, candidate];
    }
  }
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('playwright/package.json');
  const cli = join(pkg.slice(0, -'package.json'.length), 'cli.js');
  return [process.execPath, cli];
}

/**
 * Reads + structurally validates the runner-outcomes document (the
 * gateforge reporter's supervision input). Exported for the trusted
 * supervisor (the CLI), which joins outcomes rows against its planned
 * expected set — reporter data is input only, never signature authority.
 *
 * Args:
 *   path: absolute outcomes document path.
 *
 * Returns:
 *   RunnerOutcomesDocument | null: the parsed document, or null when
 *   missing/malformed (supervision then fails closed).
 */
export function readRunnerOutcomes(path: string): RunnerOutcomesDocument | null {
  return readOutcomesDocument(path);
}

/** Reads + structurally validates the runner-outcomes document. */
function readOutcomesDocument(path: string): RunnerOutcomesDocument | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateOutcomesDocument(parsed);
}

/**
 * Structurally validates an already-parsed runner-outcomes value.
 * Split out of the reader so the runner-adapter contract can grade a
 * report TEXT it was handed — with no file on disk — through the SAME
 * validation the supervised run applies.
 *
 * Args:
 *   value: the parsed JSON value.
 *
 * Returns:
 *   RunnerOutcomesDocument | null: the validated document, or null when
 *   the shape is wrong (fail closed — never a partial read).
 */
export function validateOutcomesDocument(value: unknown): RunnerOutcomesDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc['schemaVersion'] !== 1 || !Array.isArray(doc['outcomes'])) return null;
  const outcomes: RunnerOutcomesDocument['outcomes'] = [];
  for (const entry of doc['outcomes']) {
    if (typeof entry !== 'object' || entry === null) return null;
    const row = entry as Record<string, unknown>;
    if (
      typeof row['testId'] !== 'string' ||
      typeof row['file'] !== 'string' ||
      !Array.isArray(row['titlePath']) ||
      typeof row['status'] !== 'string' ||
      typeof row['attempt'] !== 'number'
    ) {
      return null;
    }
    outcomes.push({
      testId: row['testId'],
      file: row['file'],
      titlePath: (row['titlePath'] as unknown[]).filter((s): s is string => typeof s === 'string'),
      project: typeof row['project'] === 'string' ? row['project'] : null,
      status: row['status'],
      attempt: row['attempt'],
      expectedFailure: row['expectedFailure'] === true,
    });
  }
  const shard =
    typeof doc['shard'] === 'object' && doc['shard'] !== null
      ? (doc['shard'] as { index?: unknown; total?: unknown })
      : null;
  return {
    schemaVersion: 1,
    runStatus: typeof doc['runStatus'] === 'string' ? doc['runStatus'] : null,
    runnerErrors: Array.isArray(doc['runnerErrors'])
      ? (doc['runnerErrors'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    outcomes,
    shard:
      shard !== null && typeof shard['index'] === 'number' && typeof shard['total'] === 'number'
        ? { index: shard['index'], total: shard['total'] }
        : null,
  };
}

/** Maps the runner's status strings onto the envelope vocabulary. */
function normalizeStatus(status: string): RunnerInstanceOutcome['status'] {
  if (status === 'passed' || status === 'failed' || status === 'skipped' || status === 'fixme' || status === 'not-run') {
    return status;
  }
  // Unknown statuses (e.g. 'interrupted') block: they are not passes.
  return 'failed';
}

/** Builds a typed incomplete envelope with a single-cause detail. */
function incomplete(processExit: number | null, detail: string): RunnerExecutionEnvelope {
  return {
    processExit,
    complete: false,
    outcomes: [],
    fixtureOutcome: 'unknown',
    shards: null,
    retriesDetected: false,
    engines: { node: process.version, playwright: playwrightVersion() },
    browsers: {},
    incompleteDetail: detail,
  };
}
