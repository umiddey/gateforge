/**
 * Managed-run preconditions (managed-run plan (2026-09-29), Part B, feedback E56).
 *
 * `gateforge doctor` gained a `run` section: every precondition a
 * witnessed local run depends on, as ONE deterministic read-only line
 * with the exact fix command. The section adds no authority — it runs
 * no suite, starts no service and changes no file. Its default posture
 * is report-only (the doctor's exit behavior is unchanged); with
 * `--strict-preflight` the first FAIL ends the command with exit 1, so
 * `gateforge run` never spends fifty minutes discovering a missing
 * interpreter.
 *
 * Honesty rules (ADR 0005 D1, unchanged from the enforcement doctor):
 * a precondition is `ok` only when it was actually observed; anything
 * Gateforge cannot observe is `warn`, never `ok`; a broken boundary is
 * `fail` with the command that repairs it. Checks are returned in
 * DECLARED order — the order a run consumes them in — so "the first
 * FAIL" is deterministic.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { policyWeakenedCandidate, type GateforgeConfig } from '@gate-forge/core';
import { findPlaywrightConfig } from '@gate-forge/pack-playwright';
import { loadConfigAt } from './commands/common.js';
import { trustedPolicyDigestForConfig } from './execution.js';
import { browserBuildSummary, browserLaunchSummary, inspectBrowserBuilds, unlaunchableBuilds } from './playwright-browsers.js';
import { resolveVerifierKeyring } from './verifier-keys.js';
import {
  engineBrowserRequirement,
  engineBrowserSummary,
  inspectEngineBrowserBuilds,
  resolveEngineBrowserInstall,
} from './engine-browser.js';
import { describeApprovedPolicyResolution, resolveApprovedPolicyDigest } from './trusted-policy.js';
import { resolveStateDir } from './state.js';
import { sampleHostLoad } from './host-load.js';
import { loadRunRecipe, runRecipeStep, type RunRecipe } from './run-recipe.js';
import type { Io } from './io.js';

/** Status of one preflight line (identical vocabulary to the enforcement doctor). */
export type RunCheckStatus = 'ok' | 'warn' | 'fail';

/** One deterministic precondition line. */
export interface RunCheck {
  /** Stable check id inside the `run` section. */
  id: string;
  /** ok / warn / fail. */
  status: RunCheckStatus;
  /** What was observed, and the exact fix command when it is not ok. */
  detail: string;
}

/** The `run` section of the doctor report. */
export interface RunPreflightReport {
  /** Preconditions in declared order. */
  checks: RunCheck[];
  /** True when no precondition failed. */
  ready: boolean;
}

/** Options for {@link buildRunPreflight}. */
export interface RunPreflightOptions {
  /**
   * Base URL the operator supplied for this run; falls back to
   * `GATEFORGE_TARGET_BASE_URL` / `GATEFORGE_APP_BASE_URL`. When
   * neither is configured the target line has nothing to probe and
   * never invents a target.
   */
  targetBaseUrl?: string;
  /** Milliseconds allowed for the app probes (target + healthcheck). */
  probeTimeoutMs?: number;
  /**
   * The run uses an external witness (`--witness-url`): the target base
   * URL is that witness's observation proxy, which counts every exchange
   * and refuses the run-context binding once it has seen one. The target
   * is then never probed; the witness attests it at binding instead.
   */
  externalWitness?: boolean;
}

/** Load average above this multiple of the CPU count is a warning. */
const LOAD_WARNING_FACTOR = 1.5;

/** Free disk below this percentage is a warning. */
const FREE_DISK_WARNING_PERCENT = 5;

/** Default milliseconds for a reachability probe. */
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

/** Milliseconds allowed for a runner/interpreter `--version` probe. */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Maximum bytecode cache directories named in one diagnostic. */
const MAX_NAMED_CACHES = 5;

/** Maximum directory depth of the bytecode-cache scan. */
const MAX_SCAN_DEPTH = 8;

/**
 * Runs a process with a hard deadline and returns its trimmed output.
 *
 * Args:
 *   file: executable to run.
 *   args: arguments for the executable.
 *   cwd: working directory.
 *   env: environment for the child.
 *   timeoutMs: wall-clock budget in milliseconds.
 *
 * Returns:
 *   { code, output }: exit code (124 on timeout, 127 when it could not
 *   start) and the last 400 characters of combined output.
 */
function probeProcess(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): { code: number; output: string } {
  const result = spawnSync(file, [...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined) return { code: 127, output: result.error.message };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status === null) return { code: 124, output: `did not finish within ${String(timeoutMs)}ms` };
  return { code: result.status, output: output.slice(-400) };
}

/**
 * Resolves an executable that may be a path or a bare name looked up on
 * PATH (argv[0] of a configured suite is either).
 *
 * Args:
 *   name: executable as declared.
 *   cwd: repository root a relative path resolves against.
 *   env: environment whose PATH is searched.
 *
 * Returns:
 *   string | null: absolute path of the executable, or null.
 */
function resolveExecutable(name: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (name.includes('/') || name.includes('\\')) {
    const absolute = resolve(cwd, name);
    try {
      if (statSync(absolute).isFile()) return absolute;
    } catch {
      return null;
    }
    return null;
  }
  for (const directory of (env['PATH'] ?? '').split(':')) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Unreadable PATH entries are skipped, exactly like execvp.
    }
  }
  return null;
}

/**
 * Reports the verifier key ring a witnessed run needs: an active key
 * that resolves OUTSIDE the repository and the run-state directory.
 *
 * Args:
 *   cwd: repository root.
 *   env: operator environment (key source variables).
 *
 * Returns:
 *   RunCheck: the verifier-key precondition line.
 */
function verifierKeyCheck(cwd: string, env: NodeJS.ProcessEnv): RunCheck {
  try {
    const keyring = resolveVerifierKeyring(cwd, env, [resolveStateDir(cwd)]);
    if (keyring === null) {
      return {
        id: 'verifier-key',
        status: 'fail',
        detail:
          'no external verifier key is configured, so a witnessed run cannot seal a verifying receipt; ' +
          'fix: gateforge key create --confirm',
      };
    }
    return {
      id: 'verifier-key',
      status: 'ok',
      detail: `active verifier key '${keyring.active.keyId}' resolves outside the repository (key material is never printed)`,
    };
  } catch (error) {
    return {
      id: 'verifier-key',
      status: 'fail',
      detail: `verifier key could not be resolved: ${(error as Error).message.split('\n')[0] ?? 'unknown'}; fix: gateforge key create --confirm`,
    };
  }
}

/**
 * Reports whether an owner-approved policy revision is provisioned from
 * a trusted channel and whether it matches this candidate.
 *
 * Args:
 *   cwd: repository root.
 *   config: loaded repository config (never an approval source).
 *   env: operator environment (protected pin variable).
 *
 * Returns:
 *   RunCheck: the approved-policy precondition line.
 */
function approvedPolicyCheck(cwd: string, config: GateforgeConfig, env: NodeJS.ProcessEnv): RunCheck {
  const resolution = resolveApprovedPolicyDigest({ env, candidateCwd: cwd, candidateConfig: config });
  if (resolution.status !== 'ok') {
    return {
      id: 'approved-policy',
      status: 'fail',
      detail: `${describeApprovedPolicyResolution(resolution)}; fix: provision GATEFORGE_APPROVED_POLICY_DIGEST outside the candidate`,
    };
  }
  if (resolution.digest === null) {
    return {
      id: 'approved-policy',
      status: 'warn',
      detail:
        `${describeApprovedPolicyResolution(resolution)}; a witnessed run still works, but nothing binds the ` +
        'policy revision — fix: export GATEFORGE_APPROVED_POLICY_DIGEST=<digest>',
    };
  }
  try {
    const candidateDigest = trustedPolicyDigestForConfig(cwd, config);
    if (policyWeakenedCandidate(resolution.digest, candidateDigest).weakened) {
      return {
        id: 'approved-policy',
        status: 'fail',
        detail:
          `approved policy digest ${resolution.digest.slice(0, 12)}… does not match this candidate's policy ` +
          `revision ${candidateDigest.slice(0, 12)}…; strict runs block with ENFORCEMENT_UNTRUSTED — ` +
          'fix: re-pin GATEFORGE_APPROVED_POLICY_DIGEST from the trusted revision',
      };
    }
    return {
      id: 'approved-policy',
      status: 'ok',
      detail: `${describeApprovedPolicyResolution(resolution)} — matches this candidate policy revision`,
    };
  } catch (error) {
    return {
      id: 'approved-policy',
      status: 'fail',
      detail: `trusted policy digest could not be computed: ${(error as Error).message.split('\n')[0] ?? 'unknown'}`,
    };
  }
}

/**
 * Finds the installed runner package where the supervised run resolves
 * it: for Playwright, from the directory of the config enumeration runs
 * (a sub-project like `e2e/` owns its own install), then from the
 * repository root; each start walks up like Node resolution.
 *
 * Args:
 *   cwd: repository root.
 *   runner: the configured runner.
 *   packageNames: package names to accept, in preference order.
 *
 * Returns:
 *   string | null: the absolute path of the first `package.json` found.
 */
export function findRunnerManifest(cwd: string, runner: string, packageNames: readonly string[]): string | null {
  const starts: string[] = [];
  if (runner === 'playwright') {
    const playwrightConfig = findPlaywrightConfig(cwd);
    if (playwrightConfig !== null) starts.push(dirname(join(cwd, playwrightConfig)));
  }
  starts.push(resolve(cwd));
  for (const start of starts) {
    let cursor = start;
    for (let depth = 0; depth < 6; depth += 1) {
      for (const packageName of packageNames) {
        const candidate = join(cursor, 'node_modules', packageName, 'package.json');
        if (existsSync(candidate)) return candidate;
      }
      const parent = resolve(cursor, '..');
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return null;
}

/**
 * Reports whether the configured runner's BINARY resolves and reports a
 * version. The enforcement doctor's `runner` line answers a different
 * question (is the runner configured and installed); this one answers
 * "can this exact executable be launched, and which version is it".
 *
 * Args:
 *   cwd: repository root.
 *   config: loaded repository config.
 *   env: operator environment (PATH).
 *
 * Returns:
 *   RunCheck: the runner precondition line.
 */
function runnerCheck(cwd: string, config: GateforgeConfig, env: NodeJS.ProcessEnv): RunCheck {
  if (config.runner === 'pytest') {
    const suites = config.diagnostics?.suites ?? [];
    if (suites.length === 0) {
      return {
        id: 'runner',
        status: 'warn',
        detail: 'pytest is the configured runner but no diagnostics suite is configured; fix: declare diagnostics.suites in .gateforge.yml',
      };
    }
    for (const suite of suites) {
      const declared = suite.argv[0] ?? '';
      const resolved = resolveExecutable(declared, cwd, env);
      const probe = probeProcess(resolved ?? declared, ['--version'], cwd, env, VERSION_PROBE_TIMEOUT_MS);
      if (resolved === null || probe.code !== 0) {
        return {
          id: 'runner',
          status: 'fail',
          detail:
            `pytest suite '${suite.name}' runs '${declared}', which does not run (${resolved === null ? 'not found' : `exit ${String(probe.code)}`}); ` +
            `fix: point diagnostics.suites argv[0] at an installed interpreter or pytest (e.g. a venv's bin/pytest)`,
        };
      }
    }
    const versions = suites.map((suite) => {
      const probe = probeProcess(resolveExecutable(suite.argv[0] ?? '', cwd, env) ?? '', ['--version'], cwd, env, VERSION_PROBE_TIMEOUT_MS);
      return probe.output.split('\n')[0] ?? 'version unknown';
    });
    return {
      id: 'runner',
      status: 'ok',
      detail: `pytest suite(s) ${suites.map((suite) => suite.name).join(', ')} resolve and run: ${versions.join('; ')}`,
    };
  }
  const manifest = findRunnerManifest(
    cwd,
    config.runner,
    config.runner === 'playwright' ? ['@playwright/test', 'playwright'] : [config.runner],
  );
  if (manifest === null) {
    const packageName = config.runner;
    return {
      id: 'runner',
      status: 'fail',
      detail: `${config.runner} is the configured runner but ${packageName} is not installed; fix: npm install --save-dev ${packageName}`,
    };
  }
  let version = 'unknown';
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string') version = parsed.version;
  } catch {
    // A readable-but-unparsable manifest stays 'ok' with an unknown version.
  }
  // A resolvable binary is not a launchable browser: the resolved
  // runner pins its own browser revisions, and a cache holding another
  // release's builds fails every test with "Executable doesn't exist".
  if (config.runner === 'playwright') {
    const readiness = inspectBrowserBuilds(manifest, playwrightConfigText(cwd), env);
    const configPath = findPlaywrightConfig(cwd);
    const installCwd = configPath === null ? cwd : dirname(join(cwd, configPath));
    if (readiness.missing.length > 0) {
      return {
        id: 'runner',
        status: 'fail',
        detail:
          `${config.runner} resolves at '${manifest}' (version ${version}), but ` +
          browserBuildSummary(readiness, installCwd),
      };
    }
    // Installed is not startable: the same loader failure the doctor
    // reports stops the run here, BEFORE the suite spends its hours
    // failing every test for a reason the operator was never told.
    const launch = browserLaunchSummary(unlaunchableBuilds(readiness), installCwd);
    if (launch !== '') {
      return {
        id: 'runner',
        status: 'fail',
        detail: `${config.runner} resolves at '${manifest}' (version ${version}), but ${launch}`,
      };
    }
  }
  return {
    id: 'runner',
    status: 'ok',
    detail: `${config.runner} resolves at '${manifest}' (version ${version}); the supervised run can execute it`,
  };
}

/**
 * The engine-owned browser precondition, for repositories that declare
 * engine-controlled browser evidence.
 *
 * It is a SEPARATE line from `runner` because the two answer different
 * questions and routinely disagree: `runner` reports the browser the
 * CONSUMER's tests launch, this one the browser the ENGINE drives
 * through `EngineBrowserManager`. A consumer on `@playwright/test`
 * 1.62.1 with Chromium 1234 installed makes `runner` say `ok` while the
 * pack's own pinned 1.58.2 wants 1208 — and the run then dies inside the
 * witness with `Executable doesn't exist`. This line refuses that run
 * first and names the engine's OWN install command, because
 * `npx playwright install` resolves the consumer's release and installs
 * the revision the cache already holds.
 *
 * The check is CONSERVATIVE: it inspects nothing and demands nothing for
 * a repository that declares no `engine-browser` case, so a pytest /
 * API-only setup is never told to install a Chromium it cannot open.
 *
 * Args:
 *   cwd: repository root.
 *   config: loaded repository config.
 *   env: operator environment (`PLAYWRIGHT_BROWSERS_PATH`).
 *
 * Returns:
 *   RunCheck: the engine-owned browser precondition line.
 */
function engineBrowserCheck(cwd: string, config: GateforgeConfig, env: NodeJS.ProcessEnv): RunCheck {
  const requirement = engineBrowserRequirement(cwd, config.runner, config.behaviorPolicy);
  if (!requirement.required) {
    return { id: 'engine-browser', status: 'ok', detail: `engine browser not required — ${requirement.reason}` };
  }
  const resolution = resolveEngineBrowserInstall(cwd);
  if (resolution.kind === 'not-installed') {
    return {
      id: 'engine-browser',
      status: 'warn',
      detail:
        `${requirement.reason}, but @gate-forge/pack-playwright is not installed under this repository — ` +
        'the engine browser could not be inspected',
    };
  }
  if (resolution.kind === 'no-pinned-playwright') {
    return {
      id: 'engine-browser',
      status: 'warn',
      detail:
        `${requirement.reason}, but the installed @gate-forge/pack-playwright resolves no readable pinned ` +
        'playwright release — the engine browser could not be inspected',
    };
  }
  const readiness = inspectEngineBrowserBuilds(resolution.install, env);
  const summary = engineBrowserSummary(readiness);
  if (readiness.missing.length > 0 || readiness.unlaunchable.length > 0) {
    return { id: 'engine-browser', status: 'fail', detail: summary };
  }
  return { id: 'engine-browser', status: 'ok', detail: summary };
}

/**
 * The resolved Playwright config's source ('' when the repository has
 * none): the config names the browsers its projects launch.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   string: the config text, or '' when there is no readable config.
 */
function playwrightConfigText(cwd: string): string {
  const config = findPlaywrightConfig(cwd);
  if (config === null) return '';
  try {
    return readFileSync(join(cwd, config), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Reports the configured interpreter paths of a python-backed run: the
 * argv[0] of every configured suite must exist AND run. A wrong path is
 * the single most expensive local mistake, so it is a hard FAIL.
 *
 * Args:
 *   cwd: repository root.
 *   config: loaded repository config.
 *   env: operator environment (PATH).
 *
 * Returns:
 *   RunCheck: the interpreter precondition line.
 */
function interpreterCheck(cwd: string, config: GateforgeConfig, env: NodeJS.ProcessEnv): RunCheck {
  if (config.runner !== 'pytest') {
    return {
      id: 'interpreter',
      status: 'ok',
      detail: `not applicable: the configured runner '${config.runner}' uses no python interpreter`,
    };
  }
  const suites = config.diagnostics?.suites ?? [];
  if (suites.length === 0) {
    return { id: 'interpreter', status: 'warn', detail: 'no interpreter configured (no diagnostics.suites in .gateforge.yml)' };
  }
  const failures: string[] = [];
  const resolved: string[] = [];
  for (const suite of suites) {
    const declared = suite.argv[0] ?? '';
    const absolute = resolveExecutable(declared, cwd, env);
    if (absolute === null) {
      failures.push(`'${declared}' (suite '${suite.name}') does not exist`);
      continue;
    }
    const probe = probeProcess(absolute, ['--version'], cwd, env, VERSION_PROBE_TIMEOUT_MS);
    if (probe.code !== 0) {
      failures.push(`'${absolute}' (suite '${suite.name}') does not run (exit ${String(probe.code)})`);
      continue;
    }
    resolved.push(`${absolute} (${probe.output.split('\n')[0] ?? 'version unknown'})`);
  }
  if (failures.length > 0) {
    return {
      id: 'interpreter',
      status: 'fail',
      detail: `configured interpreter path(s) unusable: ${failures.join('; ')}; fix: correct diagnostics.suites argv[0] in .gateforge.yml (e.g. .venv/bin/python)`,
    };
  }
  return { id: 'interpreter', status: 'ok', detail: `configured interpreter(s) run: ${resolved.join('; ')}` };
}

/**
 * Lists bytecode cache directories in the candidate tree (bounded scan).
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   string[]: repository-relative paths of the `__pycache__` directories.
 */
function findBytecodeCaches(cwd: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (found.length >= MAX_NAMED_CACHES || depth > MAX_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_NAMED_CACHES) return;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = join(directory, entry.name);
      if (entry.name === '__pycache__') found.push(relative(cwd, child));
      else walk(child, depth + 1);
    }
  };
  walk(cwd, 0);
  return found.sort();
}

/**
 * Reports whether the run can write bytecode into the candidate tree.
 * Python bytecode caches are candidate bytes: a suite that rewrites
 * `__pycache__` mid-run voids its own receipt, so the run is only
 * bytecode-safe with the environment guard or a pre-compiled tree.
 *
 * Args:
 *   cwd: repository root.
 *   config: loaded repository config.
 *   env: operator environment.
 *
 * Returns:
 *   RunCheck: the bytecode-safety precondition line.
 */
function bytecodeSafetyCheck(cwd: string, config: GateforgeConfig, env: NodeJS.ProcessEnv): RunCheck {
  if (config.runner !== 'pytest') {
    return {
      id: 'bytecode-safety',
      status: 'ok',
      detail: `not applicable: the configured runner '${config.runner}' writes no python bytecode`,
    };
  }
  const guard = env['PYTHONDONTWRITEBYTECODE'];
  if (guard !== undefined && guard !== '' && guard !== '0') {
    return {
      id: 'bytecode-safety',
      status: 'ok',
      detail: `PYTHONDONTWRITEBYTECODE=${guard}: the run writes no bytecode into the candidate tree`,
    };
  }
  const caches = findBytecodeCaches(cwd);
  if (caches.length === 0) {
    return {
      id: 'bytecode-safety',
      status: 'warn',
      detail:
        'PYTHONDONTWRITEBYTECODE is not set: a python import during the run would write __pycache__ bytes into the ' +
        'candidate tree and void the receipt; fix: PYTHONDONTWRITEBYTECODE=1 gateforge run (or pre-compile the tree)',
    };
  }
  return {
    id: 'bytecode-safety',
    status: 'fail',
    detail:
      `PYTHONDONTWRITEBYTECODE is not set and the candidate tree already holds bytecode caches (${caches.join(', ')}): ` +
      'a run can rewrite those bytes and void its own receipt; fix: PYTHONDONTWRITEBYTECODE=1 gateforge run, or ' +
      'remove the caches and pre-compile them outside the run',
  };
}

/**
 * Probes the attested target the run will exercise, but only when a
 * base URL is configured: without one there is nothing to probe and
 * Gateforge never invents a target.
 *
 * Args:
 *   url: base URL from the flag or the environment.
 *   timeoutMs: probe deadline.
 *
 * Returns:
 *   Promise<RunCheck>: the target precondition line.
 */
async function targetCheck(url: string, timeoutMs: number): Promise<RunCheck> {
  const started = Date.now();
  // The probe runs in THIS process (no child, no shell): a reachability
  // check must not depend on what a spawned process is allowed to do.
  let reachable = false;
  let note = '';
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    reachable = response.status < 500;
    if (!reachable) note = ` (HTTP ${String(response.status)})`;
  } catch (error) {
    note = ` (${(error as Error).message.split('\n')[0] ?? 'unreachable'})`;
  }
  if (reachable) {
    return { id: 'target', status: 'ok', detail: `target '${url}' is reachable (${String(Date.now() - started)}ms)` };
  }
  return {
    id: 'target',
    status: 'fail',
    detail:
      `target '${url}' is not reachable${note}; the run would test nothing — ` +
      'fix: start the app (recipe services_up) and export GATEFORGE_TARGET_BASE_URL to its base URL',
  };
}

/**
 * Reports whether the recipe's own readiness probe passes, when a
 * recipe exists. Without a recipe there is nothing Gateforge started,
 * so the line is honest about managing nothing.
 *
 * Args:
 *   cwd: repository root.
 *   env: operator environment.
 *   recipe: loaded recipe, or null when the repository declares none.
 *   timeoutMs: probe deadline for the recipe's own budget.
 *
 * Returns:
 *   Promise<RunCheck>: the app-healthcheck precondition line.
 */
async function appHealthcheckCheck(
  cwd: string,
  env: NodeJS.ProcessEnv,
  recipe: RunRecipe | null,
  timeoutMs: number,
): Promise<RunCheck> {
  if (recipe === null || recipe.healthcheck === null) {
    return {
      id: 'app-healthcheck',
      status: 'ok',
      detail: 'no recipe healthcheck declared (no .gateforge/runtime.yml lifecycle): gateforge run starts nothing',
    };
  }
  const outcome = await runRecipeStep(recipe.healthcheck, cwd, env, { timeoutMs, log: () => undefined });
  if (outcome.code === 0) {
    return { id: 'app-healthcheck', status: 'ok', detail: 'recipe healthcheck passed' };
  }
  return {
    id: 'app-healthcheck',
    status: 'fail',
    detail: `recipe healthcheck failed (exit ${String(outcome.code)}); fix: make the app healthy, or declare the healthcheck in .gateforge/runtime.yml`,
  };
}

/**
 * Reports machine load as an ADVISORY only: a busy host explains flaky
 * failures, it never invalidates a proof.
 *
 * Args:
 *   cwd: repository root (selects the filesystem the run writes to).
 *
 * Returns:
 *   RunCheck: the host-load advisory line.
 */
function hostLoadCheck(cwd: string): RunCheck {
  const sample = sampleHostLoad(cwd);
  const load = sample.loadAverage[0] ?? 0;
  const notes: string[] = [];
  let status: RunCheckStatus = 'ok';
  if (load > sample.cpuCount * LOAD_WARNING_FACTOR) {
    status = 'warn';
    notes.push(`load ${load.toFixed(1)} on ${String(sample.cpuCount)} CPUs (advisory: slow or flaky-looking runs are likelier)`);
  }
  if (sample.freeDiskPercent < FREE_DISK_WARNING_PERCENT) {
    status = 'warn';
    notes.push(`free disk space is ${sample.freeDiskPercent.toFixed(1)}% (advisory)`);
  }
  return {
    id: 'host-load',
    status,
    detail:
      notes.length === 0
        ? `load ${load.toFixed(1)} on ${String(sample.cpuCount)} CPUs, ${sample.freeDiskPercent.toFixed(1)}% disk free (advisory only)`
        : `${notes.join('; ')} — advisory only, it never fails a run`,
  };
}

/**
 * Reports whether the candidate tree can be hashed at all, and whether
 * the working tree is clean enough for a run whose receipt binds those
 * exact bytes.
 *
 * Args:
 *   cwd: repository root.
 *   env: Git environment.
 *
 * Returns:
 *   RunCheck: the candidate-tree precondition line.
 */
function candidateTreeCheck(cwd: string, env: NodeJS.ProcessEnv): RunCheck {
  const inventory = spawnSync('git', ['ls-files', '--stage', '-z'], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (inventory.error !== undefined || inventory.status !== 0) {
    return {
      id: 'candidate-tree',
      status: 'fail',
      detail:
        'no usable Git inventory: the candidate tree cannot be hashed, so no receipt can be sealed; ' +
        'fix: run inside a Git repository with a valid index',
    };
  }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (status.error !== undefined || status.status !== 0) {
    return { id: 'candidate-tree', status: 'ok', detail: 'candidate tree is computable (git inventory available; working-tree state unknown)' };
  }
  const dirty = (status.stdout ?? '').split('\n').filter((line) => line.trim().length > 0);
  if (dirty.length === 0) {
    return { id: 'candidate-tree', status: 'ok', detail: 'candidate tree is computable and the working tree is clean' };
  }
  return {
    id: 'candidate-tree',
    status: 'warn',
    detail:
      `candidate tree is computable but the working tree has ${String(dirty.length)} uncommitted change(s); the run seals ` +
      'a receipt for the bytes on disk — fix: commit or stash them (git status --short) before the run',
  };
}

/**
 * Builds the whole `run` preflight section, in the order a managed run
 * consumes the preconditions. Every check is read-only.
 *
 * Args:
 *   io: process context (cwd + operator environment).
 *   options: optional base URL override and probe deadline.
 *
 * Returns:
 *   Promise<RunPreflightReport>: deterministic precondition section.
 */
export async function buildRunPreflight(io: Io, options: RunPreflightOptions = {}): Promise<RunPreflightReport> {
  const cwd = io.cwd;
  const env = io.env;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let config: GateforgeConfig | null = null;
  let recipe: RunRecipe | null = null;
  let loadError: string | null = null;
  try {
    config = loadConfigAt(cwd);
  } catch (error) {
    loadError = (error as Error).message.split('\n')[0] ?? 'unknown';
  }
  if (config !== null) {
    try {
      recipe = loadRunRecipe(cwd, config);
    } catch (error) {
      // A broken recipe is a precondition failure, never a crash: the
      // healthcheck line names it and the rest of the section still runs.
      loadError = (error as Error).message.split('\n')[0] ?? 'unknown';
      recipe = null;
    }
  }
  const skipped = (id: string, what: string): RunCheck => ({
    id,
    status: 'fail',
    detail: `${what} not checked: ${loadError ?? '.gateforge.yml could not be loaded'}`,
  });

  const checks: RunCheck[] = [];
  if (config === null) {
    checks.push({
      id: 'config',
      status: 'fail',
      detail: `.gateforge.yml could not be loaded: ${loadError ?? 'unknown'}; fix: run gateforge init in this repository`,
    });
  }
  checks.push(verifierKeyCheck(cwd, env));
  checks.push(config === null ? skipped('approved-policy', 'approved policy digest') : approvedPolicyCheck(cwd, config, env));
  checks.push(config === null ? skipped('runner', 'runner binary + version') : runnerCheck(cwd, config, env));
  // The engine-owned browser is a SEPARATE precondition from `runner`:
  // on a real install the consumer's Chromium and the engine's are
  // different Playwright releases, so `runner: ok` beside a missing
  // engine build is the exact false all-clear this line refuses.
  checks.push(config === null ? skipped('engine-browser', 'engine-owned browser build') : engineBrowserCheck(cwd, config, env));
  checks.push(config === null ? skipped('interpreter', 'configured interpreter paths') : interpreterCheck(cwd, config, env));
  checks.push(config === null ? skipped('bytecode-safety', 'bytecode-safe settings') : bytecodeSafetyCheck(cwd, config, env));
  const baseUrl = options.targetBaseUrl ?? env['GATEFORGE_TARGET_BASE_URL'] ?? env['GATEFORGE_APP_BASE_URL'] ?? '';
  checks.push(
    options.externalWitness === true
      ? {
          id: 'target',
          status: 'ok',
          detail:
            'not probed: the run uses an external witness (--witness-url), whose observation proxy fronts the target; ' +
            'a probe through it would count as an exchange before the run binds it, and the witness attests the target itself',
        }
      : baseUrl === ''
        ? { id: 'target', status: 'ok', detail: 'no target base URL configured (GATEFORGE_TARGET_BASE_URL): nothing to probe; a supervised run starts its own app' }
        : await targetCheck(baseUrl, probeTimeoutMs),
  );
  checks.push(await appHealthcheckCheck(cwd, env, recipe, probeTimeoutMs));
  checks.push(hostLoadCheck(cwd));
  checks.push(candidateTreeCheck(cwd, env));
  return { checks, ready: checks.every((check) => check.status !== 'fail') };
}

/**
 * Selects the first failing precondition — the one `--strict-preflight`
 * exits on, and the one `gateforge run` reports before doing any work.
 *
 * Args:
 *   report: the built preflight section.
 *
 * Returns:
 *   RunCheck | null: the first failing line in declared order, or null.
 */
export function firstFailingCheck(report: RunPreflightReport): RunCheck | null {
  return report.checks.find((check) => check.status === 'fail') ?? null;
}
