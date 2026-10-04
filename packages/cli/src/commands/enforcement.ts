/**
 * `gateforge enforcement doctor` (plan 2026-09-13 Phase 5 item 7): one
 * honest diagnostic surface for the enforcement boundary — hook
 * presence + ACTIVATION, runner readiness, observer capability, trusted
 * binary/policy ownership, snapshot mode, and the standard/managed mode
 * boundary. It is a diagnostic: exit 0 whenever it runs, with per-check
 * statuses (`ok`/`warn`/`fail`) and an overall readiness verdict.
 * Deterministic `--json`.
 *
 * Honesty rules (ADR 0005 D1):
 * - detecting a hook NEVER counts as managed protection. The
 *   `managed-guarantee` check states plainly that standard mode has no
 *   managed commit guarantee;
 * - in managed mode, an agent-writable authoritative `.git` is reported
 *   as `managed guarantees NOT active: authoritative repository is
 *   agent-writable` (a `fail` status);
 * - the broker surface reported here is the MECHANISM (`gateforge
 *   broker commit`), not a deployed service — reachability of an
 *   external broker is reported `warn`/`not configured` unless an
 *   operator-provided probe says otherwise.
 */
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { BehaviorPolicySchema } from '@gate-forge/core';
import type { GateforgeConfig } from '@gate-forge/core';
import { parse as parseYaml } from 'yaml';
import { auditAdapters } from '../adapter-audit.js';
import {
  allCapabilities,
  canonicalJson,
  policyWeakenedCandidate,
  resolveStrictnessMode,
  type JsonValue,
  type StrictnessMode,
} from '@gate-forge/core';
import { parseArgs } from '../args.js';
import { trustedPolicyDigestForConfig } from '../execution.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { findRunnerConfigPath, TEST_MAP_RELATIVE } from '../mapping.js';
import { inspectCommitHook, isFrameworkManagedHookBody } from '../git-hooks.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { resolveStateDir } from '../state.js';
import { resolveVerifierKeyring } from '../verifier-keys.js';
import {
  APPROVED_POLICY_DIGEST_ENV,
  TRUSTED_CONFIG_ENV,
  describeApprovedPolicyResolution,
  resolveApprovedPolicyDigest,
} from '../trusted-policy.js';
import {
  engineIdentity,
  engineInstallProvenance,
  enginePackageRoot,
  engineSourceLine,
  type EngineIdentity,
} from '../engine-identity.js';
import { buildRunPreflight, findRunnerManifest, firstFailingCheck, type RunPreflightReport } from '../run-preflight.js';
import {
  declaresNoNamedProject,
  findPlaywrightConfig,
  listNativePlaywrightTests,
  unnamedProjectConfigWarning,
  type NativeListResult,
} from '@gate-forge/pack-playwright';
import {
  browserBuildSummary,
  browserLaunchSummary,
  defaultBrowsersPath,
  inspectBrowserBuilds,
  unlaunchableBuilds,
} from '../playwright-browsers.js';
import {
  engineBrowserRequirement,
  engineBrowserSummary,
  inspectEngineBrowserBuilds,
  resolveEngineBrowserInstall,
} from '../engine-browser.js';

export const ENFORCEMENT_USAGE = 'usage: gateforge enforcement doctor [--json] [--strict-preflight]';

/** Status of one doctor check. */
export type DoctorStatus = 'ok' | 'warn' | 'fail';

/** One deterministic doctor check result. */
export interface DoctorCheck {
  /** Stable check id (e.g. `hook`, `managed-guarantee`). */
  id: string;
  /** ok / warn / fail — fail means the reported boundary is broken. */
  status: DoctorStatus;
  /** Precise, honest detail (no false protection claims). */
  detail: string;
}

/** The complete doctor report (checks in stable order + overall). */
export interface DoctorReport {
  /** Enforcement mode from config (default standard). */
  mode: 'standard' | 'managed';
  /** Whether strict E2E mode is enabled in config. */
  strictE2E: boolean;
  /** Engine installation that produced this diagnostic. */
  engine: EngineIdentity;
  /** Highest verified enforcement level (0 through 3). */
  level: 0 | 1 | 2 | 3;
  /** Per-check results in stable id order. */
  checks: DoctorCheck[];
  /** True when no check has status `fail`. */
  ready: boolean;
  /**
   * Managed-run preconditions (managed-run plan (2026-09-29), Part B): read-only
   * lines for everything a local witnessed run depends on. Additive —
   * the enforcement `checks` array above is unchanged.
   */
  run: RunPreflightReport;
}

/**
 * Runs `git` with NUL/UTF-8 output; null on any failure (a doctor check
 * reports the failure class, it never throws).
 */
function probe(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[]): string | null {
  const result = spawnSync('git', [...args], { cwd, env, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

/**
 * Hashes the files the input snapshot would see (tracked + untracked non-ignored).
 *
 * Args:
 *   root: isolated hook-check checkout (a Git repository).
 *   env: environment for the Git inventory call.
 *
 * Returns:
 *   Map<string, string>: relative file paths mapped to content or symlink digests.
 */
function snapshotHookWorkspace(root: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const files = new Map<string, string>();
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.error !== undefined || listed.status !== 0) {
    throw new Error(`git inventory failed: ${(listed.stderr ?? listed.error?.message ?? '').trim()}`);
  }
  for (const path of listed.stdout.split('\0')) {
    if (path === '') continue;
    const absolute = join(root, ...path.split('/'));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      files.set(path, 'deleted');
      continue;
    }
    if (stat.isSymbolicLink()) {
      files.set(path, createHash('sha256').update(readlinkSync(absolute)).digest('hex'));
    } else if (stat.isFile()) {
      files.set(path, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
    }
  }
  return files;
}

/**
 * Runs configured pre-commit hooks twice in a disposable checkout and reports workspace writes.
 *
 * Args:
 *   cwd: owner repository whose hook configuration will be copied.
 *   env: caller environment used only to locate the hook runner.
 *
 * Returns:
 *   { status, detail }: advisory hook-mutation doctor result.
 */
function precommitMutationCheck(cwd: string, env: NodeJS.ProcessEnv): { status: DoctorStatus; detail: string } {
  const configPath = join(cwd, '.pre-commit-config.yaml');
  if (!existsSync(configPath)) {
    return { status: 'warn', detail: 'no .pre-commit-config.yaml; hook mutation behavior was not checked' };
  }
  let hookIds: string[] = [];
  try {
    const config = parseYaml(readFileSync(configPath, 'utf8')) as { repos?: unknown };
    const repos = Array.isArray(config?.repos) ? config.repos : [];
    hookIds = repos.flatMap((repo) => {
      if (typeof repo !== 'object' || repo === null || !('hooks' in repo) || !Array.isArray(repo.hooks)) return [];
      return repo.hooks.flatMap((hook: unknown) =>
        typeof hook === 'object' && hook !== null && 'id' in hook && typeof hook.id === 'string'
          ? [hook.id]
          : [],
      );
    });
  } catch (error) {
    return { status: 'warn', detail: `pre-commit configuration could not be parsed: ${(error as Error).message}` };
  }

  const scratchRoot = mkdtempSync(join(tmpdir(), 'gateforge-hook-doctor-'));
  const checkout = join(scratchRoot, 'checkout');
  const excluded = new Set(['.git', 'node_modules', 'dist', 'coverage', '.venv']);
  // Hooks run with the invoking user's HOME/XDG so installed interpreters
  // (e.g. uv-managed Pythons) and the existing pre-commit cache are found,
  // exactly as on a real commit. Only the checkout is isolated.
  const passthrough = ['PATH', 'HOME', 'LANG', 'PRE_COMMIT_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME'];
  const safeEnv: NodeJS.ProcessEnv = {
    TMPDIR: scratchRoot,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of passthrough) {
    const value = env[name] ?? process.env[name];
    if (value !== undefined) safeEnv[name] = value;
  }
  safeEnv['LANG'] ??= 'C.UTF-8';
  try {
    cpSync(cwd, checkout, {
      recursive: true,
      filter: (source) => {
        const path = relative(cwd, source);
        if (path === '') return true;
        if (path.split(sep).some((segment) => excluded.has(segment))) return false;
        try {
          return !lstatSync(source).isSymbolicLink();
        } catch {
          return false;
        }
      },
    });
    for (const args of [
      ['init', '--quiet'],
      ['add', '--all'],
      ['-c', 'user.name=Gateforge Doctor', '-c', 'user.email=doctor@localhost', 'commit', '--quiet', '-m', 'hook doctor snapshot'],
    ]) {
      const initialized = spawnSync('git', args, { cwd: checkout, env: safeEnv, encoding: 'utf8' });
      if (initialized.error !== undefined || initialized.status !== 0) {
        return { status: 'warn', detail: `isolated hook checkout could not be prepared: ${(initialized.stderr ?? initialized.error?.message ?? '').trim()}` };
      }
    }
    const mutations = new Set<string>();
    const failures: string[] = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const before = snapshotHookWorkspace(checkout, safeEnv);
      const result = spawnSync('pre-commit', ['run', '--all-files'], {
        cwd: checkout,
        env: safeEnv,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return { status: 'warn', detail: 'pre-commit is unavailable; hook mutation behavior was not checked' };
      }
      const after = snapshotHookWorkspace(checkout, safeEnv);
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(path) !== after.get(path)) mutations.add(path);
      }
      if (result.error !== undefined || result.status !== 0) {
        failures.push(`run ${pass + 1}: ${lastLines(result.stderr || result.stdout || result.error?.message || `exit ${String(result.status)}`, 3)}`);
      }
    }
    if (mutations.size > 0) {
      // These are the REPOSITORY's own hooks, and the doctor runs
      // before (or without) any Gateforge hook — so the advice has to
      // be ordered the way the owner meets it: install the hook first,
      // then give it the first position. Telling someone to reorder a
      // hook they do not have yet is not actionable.
      const recommendation =
        hookIds[0] === 'gateforge-check'
          ? ''
          : '; these are your repo\'s own hooks, not Gateforge\'s — run `gateforge init --blocking` ' +
            '(or `gateforge enforce`) to install gateforge-check, then move its entry to the ' +
            'FIRST in .pre-commit-config.yaml, above these hooks, so a file-mutating hook cannot invalidate its receipt';
      return {
        status: 'warn',
        detail: `pre-commit hooks modified workspace files on repeated runs: ${summarizePaths([...mutations].sort(), 5)}${recommendation}`,
      };
    }
    if (failures.length > 0) {
      return {
        status: 'warn',
        detail:
          `pre-commit hooks did not complete cleanly in an isolated copy (without ${[...excluded].filter((name) => name !== '.git').join(', ')}), ` +
          `so file changes by hooks were not checked; hooks that need those folders fail there. ` +
          `Run \`pre-commit run --all-files\` in the repository to see the full error. Last lines: ${failures.join('; ')}`,
      };
    }
    return { status: 'ok', detail: 'pre-commit hooks ran twice without workspace file mutations' };
  } catch (error) {
    return { status: 'warn', detail: `hook mutation behavior was not checked: ${(error as Error).message}` };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

/**
 * Keeps the last non-empty lines of a command's output for a one-line summary.
 *
 * Args:
 *   text: raw command output.
 *   count: number of trailing non-empty lines to keep.
 *
 * Returns:
 *   string: the kept lines joined with " | ".
 */
function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-count)
    .join(' | ');
}

/**
 * Lists the first few paths and counts the remainder.
 *
 * Args:
 *   paths: sorted relative paths.
 *   limit: maximum number of paths to name.
 *
 * Returns:
 *   string: e.g. "a, b, c and 4 more".
 */
function summarizePaths(paths: readonly string[], limit: number): string {
  const named = paths.slice(0, limit).join(', ');
  return paths.length > limit ? `${named} and ${String(paths.length - limit)} more` : named;
}

/**
 * Finds repository files that could expose the active verifier key.
 *
 * Args:
 *   cwd: repository root.
 *   env: key-source and Git environment.
 *
 * Returns:
 *   object: offending relative paths and a non-secret scan status.
 */
function verifierKeyExposure(cwd: string, env: NodeJS.ProcessEnv): { paths: string[]; configured: boolean; scanError: boolean } {
  let activeKey: string | undefined;
  let configured = false;
  let scanError = false;
  try {
    activeKey = resolveVerifierKeyring(cwd, env, [resolveStateDir(cwd)])?.active.key;
    configured = activeKey !== undefined;
  } catch {
    scanError = true;
  }
  const listingArgs = [
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
  ];
  const listedPaths: string[] = [];
  for (const args of listingArgs) {
    const listed = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (listed.error !== undefined || listed.status !== 0) {
      return { paths: [], configured, scanError: true };
    }
    listedPaths.push(...(listed.stdout ?? '').split('\0'));
  }
  const keyBytes = activeKey === undefined ? null : Buffer.from(activeKey, 'utf8');
  const paths: string[] = [];
  for (const relativePath of new Set(listedPaths)) {
    if (relativePath.length === 0) continue;
    const absolutePath = resolve(cwd, relativePath);
    try {
      const stat = lstatSync(absolutePath);
      if (!stat.isFile()) continue;
      if (relativePath.split(/[\\/]/).at(-1) === 'verifier.key') {
        paths.push(relativePath);
        continue;
      }
      if (keyBytes === null || stat.size !== keyBytes.length) continue;
      if (readFileSync(absolutePath).equals(keyBytes)) paths.push(relativePath);
    } catch {
      scanError = true;
    }
  }
  return { paths: [...new Set(paths)].sort(), configured, scanError };
}

/**
 * Cheap playwright readiness probe: package resolvable where the
 * supervised run resolves it (next to the Playwright config, then from
 * the repo root upward) and the browser builds THAT runner pins present
 * in the cache (default cache or PLAYWRIGHT_BROWSERS_PATH). Counting
 * cache entries proves nothing: a cache holding another Playwright
 * release's builds is nonempty and still fails every test with
 * `Executable doesn't exist`. Never launches anything.
 *
 * Args:
 *   cwd: repository root.
 *   env: operator environment (PLAYWRIGHT_BROWSERS_PATH).
 *
 * Returns:
 *   {status, detail}: ok / warn (no browsers at all) / fail (no
 *   package, or a pinned build the run would launch is missing).
 */
function playwrightReadiness(cwd: string, env: NodeJS.ProcessEnv): { status: DoctorStatus; detail: string } {
  // The SAME resolution order the supervised run uses (see
  // `runnerCheck`): `@playwright/test` first, so the browser builds
  // checked are the ones the run will actually launch.
  const packageJson = findRunnerManifest(cwd, 'playwright', ['@playwright/test', 'playwright']);
  if (packageJson === null) {
    return {
      status: 'fail',
      detail: 'playwright is not installed (no node_modules/playwright found from the repo root); the supervised E2E runner cannot execute',
    };
  }
  const browsersPath = defaultBrowsersPath(env);
  let browsers = 'missing';
  try {
    const entries = readdirSafe(browsersPath);
    browsers = entries.length > 0 ? `installed (${String(entries.length)} entries)` : 'missing';
  } catch {
    browsers = 'missing';
  }
  if (browsers === 'missing') {
    return {
      status: 'warn',
      detail: `playwright installed; browsers NOT found under '${browsersPath}' — run \`npx playwright install\` before the supervised run`,
    };
  }
  // The cache is nonempty; only the builds the RESOLVED runner pins say
  // whether its tests can launch. A runner that ships no readable
  // registry keeps the historical line (an unresolvable install never
  // invents revisions).
  const configDir = playwrightInstallCwd(cwd);
  const readiness = inspectBrowserBuilds(packageJson, playwrightConfigText(cwd), env);
  const builds = browserBuildSummary(readiness, configDir);
  if (builds === '') {
    return { status: 'ok', detail: `playwright installed; browsers ${browsers} under '${browsersPath}'` };
  }
  if (readiness.missing.length > 0) {
    return { status: 'fail', detail: `playwright installed; ${builds}` };
  }
  // Installed is not startable: on a bare Linux image the dynamic
  // loader fails before `main`, and the cause never reaches the report.
  const launch = browserLaunchSummary(unlaunchableBuilds(readiness), configDir);
  if (launch !== '') {
    return { status: 'fail', detail: `playwright installed; ${launch}` };
  }
  return { status: 'ok', detail: `playwright installed; browsers ${browsers} under '${browsersPath}'; ${builds}` };
}

/**
 * The directory a `npx playwright install` fix must run in: the one
 * holding the Playwright config the supervised run resolves the runner
 * from (a sub-project like `e2e/` owns its own install), else the
 * repository root.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   string: the absolute directory the install command runs in.
 */
function playwrightInstallCwd(cwd: string): string {
  const config = findPlaywrightConfig(cwd);
  return config === null ? resolve(cwd) : dirname(resolve(cwd, config));
}

/**
 * Readiness of the ENGINE-OWNED browser — the Chromium
 * `@gate-forge/pack-playwright` pins and `EngineBrowserManager` drives
 * for every `engine-browser` case, `ui.action` and `visible.confirm`.
 *
 * This is a separate fact from the `runner` line on purpose. The runner
 * line answers "can the CONSUMER's tests launch a browser"; this one
 * answers "can the ENGINE drive its own". A consumer whose Playwright is
 * a different release from the pack's pin makes those two answers
 * disagree — the consumer's Chromium 1234 installed and correct, the
 * engine's 1208 absent — and reporting only the first is what let a
 * first witnessed run die in the witness on `Executable doesn't exist`
 * after the runner line said `ok`.
 *
 * The line is additive and leaves `runner` unchanged. A Playwright runner
 * conservatively requires the engine browser; other runners without an
 * `engine-browser` behavior case report that it is not required.
 *
 * Args:
 *   cwd: repository root.
 *   config: the loaded repository config.
 *   env: operator environment (`PLAYWRIGHT_BROWSERS_PATH`).
 *
 * Returns:
 *   {status, detail}: fail when a required engine build is missing or
 *   cannot start, warn when the requirement exists but cannot be
 *   observed, ok otherwise.
 */
function engineBrowserReadiness(
  cwd: string,
  config: GateforgeConfig,
  env: NodeJS.ProcessEnv,
): { status: DoctorStatus; detail: string } {
  const requirement = engineBrowserRequirement(cwd, config.runner, config.behaviorPolicy);
  if (!requirement.required) return { status: 'ok', detail: `engine browser not required — ${requirement.reason}` };
  const resolution = resolveEngineBrowserInstall(cwd);
  if (resolution.kind === 'not-installed') {
    return {
      status: 'warn',
      detail:
        `${requirement.reason}, but @gate-forge/pack-playwright is not installed under this repository — ` +
        'the engine browser could not be inspected',
    };
  }
  if (resolution.kind === 'no-pinned-playwright') {
    return {
      status: 'warn',
      detail:
        `${requirement.reason}, but the installed @gate-forge/pack-playwright resolves no readable pinned ` +
        'playwright release — the engine browser could not be inspected',
    };
  }
  const readiness = inspectEngineBrowserBuilds(resolution.install, env);
  const summary = engineBrowserSummary(readiness);
  if (readiness.missing.length > 0 || readiness.unlaunchable.length > 0) {
    return { status: 'fail', detail: summary };
  }
  return { status: 'ok', detail: summary };
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
    return readFileSync(resolve(cwd, config), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Runner readiness for the CONFIGURED runner (`runner:` in
 * `.gateforge.yml`; absent = playwright). Playwright keeps its exact
 * historical probe, id and detail — a repository without the key sees
 * byte-identical output. A non-Playwright runner reports the two cheap
 * facts the supervised run needs: its own declaration (a config file at
 * the repository root for vitest/cypress, a configured suite for pytest)
 * and a resolvable runner package/binary. Nothing is launched.
 *
 * Args:
 *   cwd: repository root.
 *   config: the loaded repository config.
 *   env: the process environment (PATH resolution for pytest).
 *
 * Returns:
 *   {status, detail}: ok when both facts hold, fail otherwise.
 */
function runnerReadiness(
  cwd: string,
  config: GateforgeConfig,
  env: NodeJS.ProcessEnv,
): { status: DoctorStatus; detail: string } {
  if (config.runner === 'playwright') return playwrightReadiness(cwd, env);
  if (config.runner === 'pytest') return pytestReadiness(cwd, config, env);
  return nodeRunnerReadiness(cwd, config.runner);
}

/**
 * Readiness for a node-based runner (vitest, cypress): its config file
 * at the repository root plus its package resolvable like Node resolves
 * it (the CLI may run from a workspace root).
 *
 * Args:
 *   cwd: repository root.
 *   runner: the configured runner name.
 *
 * Returns:
 *   {status, detail}: ok when the config file and the package resolve.
 */
function nodeRunnerReadiness(cwd: string, runner: string): { status: DoctorStatus; detail: string } {
  const configFile = findRunnerConfigPath(cwd, runner);
  if (configFile === null) {
    return {
      status: 'fail',
      detail:
        `${runner} is the configured runner but no ${runner} config file was found at the repository root ` +
        `(expected ${runner}.config.* at the repository root); the supervised E2E runner cannot execute`,
    };
  }
  if (findUpwardPackage(cwd, runner) === null) {
    return {
      status: 'fail',
      detail:
        `${runner} is configured (${configFile}) but ${runner} is not installed ` +
        `(no node_modules/${runner} found from the repo root); run \`npm install --save-dev ${runner}\` ` +
        'before the supervised run',
    };
  }
  return {
    status: 'ok',
    detail: `${runner} configured (${configFile}) and installed; the supervised run can execute it`,
  };
}

/**
 * Readiness for pytest: the owner registers the suite explicitly (there
 * is no config file to probe) and the `pytest` executable must resolve on
 * PATH. Fail-open to `fail` — an unresolvable runner never runs.
 *
 * Args:
 *   cwd: repository root.
 *   config: the loaded repository config.
 *   env: the process environment (PATH resolution).
 *
 * Returns:
 *   {status, detail}: ok when a suite is configured and pytest resolves.
 */
function pytestReadiness(
  cwd: string,
  config: GateforgeConfig,
  env: NodeJS.ProcessEnv,
): { status: DoctorStatus; detail: string } {
  const suites = (config.diagnostics?.suites ?? []).filter((suite) => suite.runner === 'pytest');
  if (suites.length === 0) {
    return {
      status: 'fail',
      detail:
        'pytest is the configured runner but no pytest suite is configured in .gateforge.yml ' +
        '(diagnostics.suites); the supervised E2E runner cannot execute',
    };
  }
  const names = suites.map((suite) => suite.name).join(', ');
  const binary = findOnPath(env['PATH'], 'pytest');
  if (binary === null) {
    return {
      status: 'fail',
      detail:
        `pytest suite(s) configured (${names}) but no pytest executable was found on PATH; ` +
        'install it (python -m pip install pytest) before the supervised run',
    };
  }
  return {
    status: 'ok',
    detail: `pytest suite(s) configured (${names}) and pytest resolves at '${binary}'; the supervised run can execute it`,
  };
}

/**
 * Resolves `<package>/package.json` upward from the repository root the
 * way Node resolution walks (the CLI may run from a workspace root).
 *
 * Args:
 *   cwd: repository root.
 *   packageName: the runner's npm package name.
 *
 * Returns:
 *   string | null: the absolute package.json path, or null.
 */
function findUpwardPackage(cwd: string, packageName: string): string | null {
  let cursor = resolve(cwd);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(cursor, 'node_modules', packageName, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * Resolves an executable on PATH without launching anything.
 *
 * Args:
 *   pathValue: the PATH environment value.
 *   command: the executable name.
 *
 * Returns:
 *   string | null: the absolute path of the first match, or null.
 */
function findOnPath(pathValue: string | undefined, command: string): string | null {
  if (pathValue === undefined || pathValue.length === 0) return null;
  for (const entry of pathValue.split(sep)) {
    if (entry.length === 0) continue;
    const candidate = join(entry, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not executable here: keep scanning PATH
    }
  }
  return null;
}

/** Safe directory listing (missing dir → empty). */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
/**
 * Whether a `.pre-commit-config.yaml` declares Gateforge's hook.
 *
 * Args:
 *   path: absolute path to `.pre-commit-config.yaml`.
 *
 * Returns:
 *   boolean: true when a hook with id `gateforge-check` is declared.
 */
function declaresGateforgeCheck(path: string): boolean {
  if (!existsSync(path)) return false;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  // Parsed YAML is external input: every step narrows with `typeof` /
  // `in` so a malformed config answers "not wired" instead of trusting a
  // fabricated shape.
  if (typeof parsed !== 'object' || parsed === null || !('repos' in parsed)) return false;
  const repos = parsed.repos;
  if (!Array.isArray(repos)) return false;
  return repos.some((repo) => {
    if (typeof repo !== 'object' || repo === null || !('hooks' in repo)) return false;
    const hooks = repo.hooks;
    if (!Array.isArray(hooks)) return false;
    return hooks.some(
      (hook) =>
        typeof hook === 'object' && hook !== null && 'id' in hook && hook.id === 'gateforge-check',
    );
  });
}

/**
 * Whether this repository's commit gate runs through a pre-commit
 * FRAMEWORK.
 *
 * A framework regenerates `.git/hooks/pre-commit` from
 * `.pre-commit-config.yaml` on every `pre-commit install`, so the file
 * in `.git/hooks` carries the framework's signature and never a
 * Gateforge marker. Reading only for our marker therefore reported
 * "a non-gateforge pre-commit hook exists … gateforge did not touch it"
 * about a repository where `init` had just wired the gate through the
 * framework config — the two commands contradicted each other on the
 * same file. Both halves must hold: the hook file is framework
 * generated AND the framework config actually declares our hook.
 *
 * Args:
 *   cwd: repository root.
 *   hookPath: the resolved `.git/hooks/pre-commit` path, if any.
 *
 * Returns:
 *   boolean: true when the gate is wired through the framework.
 */
function frameworkHookGateWired(cwd: string, hookPath: string | null): boolean {
  if (hookPath === null || !existsSync(hookPath)) return false;
  if (!isFrameworkManagedHookBody(readFileSync(hookPath, 'utf8'))) return false;
  return declaresGateforgeCheck(join(cwd, '.pre-commit-config.yaml'));
}

/**
 * Detects generated CI wiring without treating a template as server-side
 * protection.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   boolean: true when a Gateforge template is present and included.
 */
function hasWiredCi(cwd: string): boolean {
  const gitlabTemplate = join(cwd, '.gateforge', 'ci', 'gitlab-gateforge.yml');
  const gitlabConfig = join(cwd, '.gitlab-ci.yml');
  if (existsSync(gitlabTemplate) && existsSync(gitlabConfig)) {
    return readFileSync(gitlabConfig, 'utf8').includes('.gateforge/ci/gitlab-gateforge.yml');
  }
  const githubTemplate = join(cwd, '.github', 'workflows', 'gateforge.yml');
  return existsSync(githubTemplate) && readFileSync(githubTemplate, 'utf8').includes('# Generated by Gateforge');
}

/**
 * Probes GitHub branch protection using the caller's existing read-only
 * CLI authentication.
 *
 * Args:
 *   io: process context.
 *
 * Returns:
 *   {verified, detail}: verified required-check status or an honest warning.
 */
function probeGitHubProtection(io: Io): { verified: boolean; detail: string } {
  if ((io.env['GH_TOKEN'] ?? io.env['GITHUB_TOKEN'] ?? '').length === 0) {
    return { verified: false, detail: 'server protection: not verified (no GitHub API token configured)' };
  }
  const repository = io.env['GITHUB_REPOSITORY'];
  const branch = io.env['GITHUB_BASE_REF'] ?? io.env['CI_DEFAULT_BRANCH'];
  if (repository === undefined || branch === undefined || repository.length === 0 || branch.length === 0) {
    return { verified: false, detail: 'server protection: not verified (repository or protected branch is unknown)' };
  }
  const result = spawnSync(
    'gh',
    ['api', `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`],
    { cwd: io.cwd, env: io.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.error !== undefined || result.status !== 0) {
    return { verified: false, detail: 'server protection: not verified (GitHub branch-protection probe failed)' };
  }
  try {
    const protection = JSON.parse(result.stdout ?? '') as {
      required_status_checks?: { contexts?: unknown };
    };
    const contexts = protection.required_status_checks?.contexts;
    const required = Array.isArray(contexts) && contexts.some((context) => context === 'gateforge');
    return required
      ? { verified: true, detail: `server protection: verified required status check 'gateforge' on '${branch}'` }
      : { verified: false, detail: `server protection: branch is not verified to require status check 'gateforge' on '${branch}'` };
  } catch {
    return { verified: false, detail: 'server protection: not verified (GitHub returned an unreadable protection response)' };
  }
}

/**
 * Probes GitLab branch protection and require-success merge settings with
 * read-only API requests.
 *
 * Args:
 *   io: process context.
 *
 * Returns:
 *   {verified, detail}: verified branch and pipeline requirements or warning.
 */
function probeGitLabProtection(io: Io): { verified: boolean; detail: string } {
  if ((io.env['GITLAB_TOKEN'] ?? io.env['GLAB_TOKEN'] ?? '').length === 0) {
    return { verified: false, detail: 'server protection: not verified (no GitLab API token configured)' };
  }
  const project = io.env['CI_PROJECT_ID'];
  const branch = io.env['CI_DEFAULT_BRANCH'];
  if (project === undefined || !/^[0-9]+$/.test(project) || branch === undefined || branch.length === 0) {
    return { verified: false, detail: 'server protection: not verified (project or protected branch is unknown)' };
  }
  const env = { ...io.env, GITLAB_TOKEN: io.env['GITLAB_TOKEN'] ?? io.env['GLAB_TOKEN'] };
  const projectResult = spawnSync('glab', ['api', `projects/${project}`], {
    cwd: io.cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const branchResult = spawnSync(
    'glab',
    ['api', `projects/${project}/protected_branches/${encodeURIComponent(branch)}`],
    { cwd: io.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (
    projectResult.error !== undefined ||
    projectResult.status !== 0 ||
    branchResult.error !== undefined ||
    branchResult.status !== 0
  ) {
    return { verified: false, detail: 'server protection: not verified (GitLab read-only protection probe failed)' };
  }
  try {
    const projectSettings = JSON.parse(projectResult.stdout ?? '') as {
      only_allow_merge_if_pipeline_succeeds?: unknown;
    };
    const protectedBranch = JSON.parse(branchResult.stdout ?? '') as {
      name?: unknown;
      allow_force_push?: unknown;
    };
    const verified =
      projectSettings.only_allow_merge_if_pipeline_succeeds === true &&
      protectedBranch.name === branch &&
      protectedBranch.allow_force_push === false;
    return verified
      ? { verified: true, detail: `server protection: verified protected branch and required passing pipeline on '${branch}'` }
      : { verified: false, detail: `server protection: branch '${branch}' is not verified to require a passing protected pipeline` };
  } catch {
    return { verified: false, detail: 'server protection: not verified (GitLab returned an unreadable protection response)' };
  }
}

/**
 * The playwright config's project naming, as the native
 * enumeration read it (the config is untrusted code — only
 * the runner can say which projects it declares). Test-gates
 * join catalog rows to planned projects by name, so a config
 * that declares no named project breaks the join (R1-5).
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   Promise<{ status, detail }>: the playwright-projects doctor result.
 */
async function playwrightProjectNaming(
  cwd: string,
): Promise<{ status: DoctorStatus; detail: string }> {
  let nativeList: NativeListResult;
  try {
    nativeList = await listNativePlaywrightTests({ cwd });
  } catch (error) {
    return {
      status: 'warn',
      detail: `playwright project naming could not be checked: ${(error as Error).message.split('\n')[0] ?? 'unknown'}`,
    };
  }
  const configPath = findPlaywrightConfig(cwd);
  const configLabel = configPath ?? '(unknown playwright config)';
  if (nativeList.status === 'unavailable') {
    return {
      status: 'ok',
      detail: 'no playwright config — not an error for non-playwright repos',
    };
  }
  if (declaresNoNamedProject(nativeList.projectNames)) {
    return { status: 'fail', detail: unnamedProjectConfigWarning(configLabel) };
  }
  if (nativeList.projectNames === undefined) {
    return {
      status: 'ok',
      detail: `playwright config '${configLabel}' ran, but this playwright version reports no project names`,
    };
  }
  const named = nativeList.projectNames
    .filter((name) => name.length > 0)
    .sort();
  return {
    status: 'ok',
    detail: `playwright config '${configLabel}' declares named project(s): ${named.join(', ')}`,
  };
}

/**
 * Builds the doctor report (all checks, honest statuses).
 *
 * Args:
 *   io: process context.
 *
 * Returns:
 *   Promise<DoctorReport>: deterministic report.
 */
export async function buildDoctorReport(io: Io): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  // 0. Config (all later checks degrade honestly when it fails).
  let mode: 'standard' | 'managed' = 'standard';
  let strictE2E = false;
  let strictnessMode: StrictnessMode = 'strict';
  let configOk = true;
  // The managed-run preconditions are an independent, read-only
  // section: they add no authority over the enforcement checks.
  const run = await buildRunPreflight(io);
  let configDetail = 'no .gateforge.yml — gateforge is not initialized in this repository';
  try {
    const config = loadConfigAt(io.cwd);
    mode = config.enforcement?.mode ?? 'standard';
    strictE2E = config.enforcement?.strictE2E === true;
    strictnessMode = resolveStrictnessMode(config);
    configOk = true;
    configDetail = `.gateforge.yml loaded (mode ${mode}, strictE2E ${String(strictE2E)})`;
  } catch (error) {
    configOk = false;
    configDetail = `.gateforge.yml could not be loaded: ${(error as Error).message.split('\n')[0] ?? 'unknown'}`;
  }
  checks.push({ id: 'config', status: configOk ? 'ok' : 'fail', detail: configDetail });

  // Gate strictness: a softened gate is not
  // a failure — it is an owner decision that must stay LOUD forever, so
  // it is never `ok` while it is not strict.
  checks.push({
    id: 'strictness-mode',
    status: strictnessMode === 'strict' ? 'ok' : 'warn',
    detail:
      strictnessMode === 'strict'
        ? `gate strictness: strict (the default; every unresolved obligation blocks)`
        : `gate strictness: ${strictnessMode} — the gate does NOT block everything it finds; ` +
          "in 'warn' it exits 0 with wouldBlock, in 'changed' it blocks only debt this change touches. " +
          'Set mode: strict (or remove the key) to restore full blocking.',
  });

  const keyExposure = verifierKeyExposure(io.cwd, io.env);
  const keyExposureDetail =
    keyExposure.paths.length > 0
      ? `verifier key material found in repository/state files: ${keyExposure.paths.join(', ')}; move it to the owner-only XDG key ring with \`gateforge key create\`, then remove the exposed copies`
      : keyExposure.scanError
        ? 'verifier-key safety scan could not verify every source; use an external owner-only key ring and inspect repository/state files'
        : keyExposure.configured
          ? 'active verifier key is external; no repository/state copy found'
          : 'no active external verifier key configured; create one with `gateforge key create --confirm` before witnessed receipt verification';
  checks.push({
    id: 'verifier-key-location',
    status: keyExposure.paths.length > 0 || keyExposure.scanError || !keyExposure.configured ? 'warn' : 'ok',
    detail: keyExposureDetail,
  });

  // 1. Hook presence + ACTIVATION (never reported as managed protection).
  const hook = inspectCommitHook(io.cwd, io.env);
  // A framework-managed hook is WIRED, not foreign: the gate lives in
  // `.pre-commit-config.yaml` and runs on every commit exactly like any
  // other framework hook. Reporting it as a non-gateforge hook Gateforge
  // "did not touch" contradicted what `init` had just said about the
  // very same file.
  const frameworkGate = frameworkHookGateWired(io.cwd, hook.hookPath);
  // R1-7: the framework config declares our hook, but no
  // framework-GENERATED hook exists in the hooks directory
  // yet — the commit gate is NOT active until the framework
  // installs its hook (`pre-commit install`), so the row
  // fails instead of all-clearing.
  const frameworkConfigPending =
    !frameworkGate &&
    !hook.verifyOk &&
    declaresGateforgeCheck(join(io.cwd, '.pre-commit-config.yaml'));
  checks.push({
    id: 'hook',
    status: frameworkGate || hook.verifyOk ? 'ok' : frameworkConfigPending ? 'fail' : hook.marker ? 'fail' : 'warn',
    detail: frameworkGate
      ? `the commit gate runs through the pre-commit framework: ${hook.hookPath} is framework-generated ` +
        'and .pre-commit-config.yaml declares gateforge-check, which runs on every commit — gateforge does not ' +
        'edit the generated hook file (a direct edit is wiped by the next framework install)'
      : frameworkConfigPending
        ? `the commit gate is NOT active: .pre-commit-config.yaml declares gateforge-check but no framework-generated ` +
          `hook exists in '${hook.hooksDir ?? 'the hooks directory'}' — run \`pre-commit install\` to activate the gate`
        : hook.detail,
  });
  const hookMutation = precommitMutationCheck(io.cwd, io.env);
  checks.push({ id: 'hook-mutation', ...hookMutation });
  const ciWired = hasWiredCi(io.cwd);
  checks.push({
    id: 'ci',
    status: ciWired ? 'ok' : 'warn',
    detail: ciWired ? 'a Gateforge CI template is present and included' : 'no wired Gateforge CI template was detected',
  });
  const githubWorkflow = join(io.cwd, '.github', 'workflows', 'gateforge.yml');
  const gitlabTemplate = join(io.cwd, '.gateforge', 'ci', 'gitlab-gateforge.yml');
  const protection = existsSync(githubWorkflow)
    ? probeGitHubProtection(io)
    : existsSync(gitlabTemplate)
      ? probeGitLabProtection(io)
      : { verified: false, detail: 'server protection: not verified (no supported read-only probe context)' };
  checks.push({
    id: 'server-protection',
    status: protection.verified ? 'ok' : 'warn',
    detail: protection.detail,
  });

  // 2. Runner readiness for the CONFIGURED runner (cheap probes only —
  //    nothing is launched; without a `runner:` key this is exactly the
  //    historical Playwright probe).
  checks.push({
    id: 'runner',
    ...(configOk
      ? runnerReadiness(io.cwd, loadConfigAt(io.cwd), io.env)
      : {
          status: 'fail' as DoctorStatus,
          detail: 'runner readiness was not checked: .gateforge.yml could not be loaded, so the configured runner is unknown',
        }),
  });

  // 2b. The ENGINE-OWNED browser, when this repository actually
  //     declares engine-controlled browser evidence. The `runner` line
  //     above reports the CONSUMER's builds and stays exactly as it was:
  //     a consumer on a different Playwright release is precisely the
  //     case where the two answers disagree, so collapsing them would
  //     reproduce the false all-clear this line exists to end.
  checks.push({
    id: 'engine-browser',
    ...(configOk
      ? engineBrowserReadiness(io.cwd, loadConfigAt(io.cwd), io.env)
      : {
          status: 'warn' as DoctorStatus,
          detail:
            'engine browser readiness was not checked: .gateforge.yml could not be loaded, so no engine-browser requirement is known',
        }),
  });

  // 2c. The playwright config's project naming (R1-5): the
  //     enumeration's own answer, so a config with no named
  //     project — which breaks the per-project identity join
  //     test-gates depend on — is a FAILING row with the fix.
  checks.push({ id: 'playwright-projects', ...(await playwrightProjectNaming(io.cwd)) });

  // 3. Observer capability (Phase 0 capability registry; witness probe
  //    only when the caller wired GATEFORGE_WITNESS_URL).
  const capabilities = allCapabilities();
  const available = capabilities.filter((capability) => capability.availability.status === 'available');
  const unavailable = capabilities.filter((capability) => capability.availability.status !== 'available');
  let observerDetail =
    capabilities.length === 0
      ? 'no capability records registered (the engine graded no contracts in this process)'
      : `capability registry: ${String(available.length)} available namespace(s) [${available
          .map((capability) => capability.namespace)
          .join(', ')}], ${String(unavailable.length)} fail-closed [${unavailable
          .map((capability) => capability.namespace)
          .join(', ')}]`;
  const witnessUrl = io.env['GATEFORGE_WITNESS_URL'];
  if (witnessUrl !== undefined && witnessUrl.length > 0) {
    observerDetail += `; witness '${witnessUrl}' configured — reachability probed at gate time (not launched by the doctor)`;
  } else {
    observerDetail += '; no external witness configured (the supervised run spawns a loopback witness)';
  }
  checks.push({ id: 'observer', status: 'ok', detail: observerDetail });

  // 3a. Evidence adapters: the connect-your-project half, as one line.
  // Diagnostic only — a missing or invalid adapter is the gate's own
  // business, and it already blocks there.
  try {
    const config = loadConfigAt(io.cwd);
    const reports = await auditAdapters(join(io.cwd, config.adapters ?? '.gateforge/adapters'));
    const invalid = reports.filter((report) => !report.ok);
    checks.push({
      id: 'adapters',
      status: invalid.length === 0 ? 'ok' : 'warn',
      detail:
        reports.length === 0
          ? 'no evidence adapter yet — `gateforge adapters scaffold` writes a starting point per business resource'
          : `${String(reports.length)} evidence adapter(s) in ${config.adapters ?? '.gateforge/adapters'}` +
            (invalid.length === 0
              ? '; all satisfy the contract'
              : `; ${String(invalid.length)} invalid (${invalid.map((report) => report.name).join(', ')}) — the witness refuses to start`),
    });
  } catch (error) {
    checks.push({
      id: 'adapters',
      status: 'warn',
      detail: `evidence adapters could not be audited: ${(error as Error).message.split('\n')[0] ?? 'unknown'}`,
    });
  }

  // 3b. Complete-behavior readiness (plan 2026-09-19 Phase 9 item 3):
  // when `behaviorPolicy` is configured the doctor reports the profile's
  // actual state — document presence, parseability, and whether endpoint
  // declarations exist (a scaffold is 'warn', never 'ok'; readiness
  // comes only from owner-declared cases proven through the witness).
  if (configOk) {
    try {
      const config = loadConfigAt(io.cwd);
      if (config.behaviorPolicy === undefined) {
        checks.push({
          id: 'behavior-profile',
          status: 'ok',
          detail: 'not configured (basic table/transport behavior only)',
        });
      } else {
        const behaviorPath = resolve(io.cwd, config.behaviorPolicy);
        if (!existsSync(behaviorPath)) {
          checks.push({
            id: 'behavior-profile',
            status: 'fail',
            detail: `behaviorPolicy '${config.behaviorPolicy}' points at a missing file — the complete-behavior profile fails closed`,
          });
        } else {
          const parsed = BehaviorPolicySchema.safeParse(
            JSON.parse(JSON.stringify(parseYaml(readFileSync(behaviorPath, 'utf8')))),
          );
          if (!parsed.success) {
            checks.push({
              id: 'behavior-profile',
              status: 'fail',
              detail: `behaviorPolicy '${config.behaviorPolicy}' is invalid: ${(parsed.error.issues[0]?.message ?? 'unknown').slice(0, 160)}`,
            });
          } else if (parsed.data.endpoints.length === 0 && parsed.data.resources.length === 0) {
            checks.push({
              id: 'behavior-profile',
              status: 'warn',
              detail: 'behavior document is a scaffold (no endpoint/resource declarations) — every endpoint blocks with ENDPOINT_BEHAVIOR_MISSING until the owner declares cases',
            });
          } else {
            checks.push({
              id: 'behavior-profile',
              status: 'ok',
              detail: `behavior document declares ${String(parsed.data.endpoints.length)} endpoint(s), ${String(parsed.data.resources.length)} resource(s) — readiness requires those cases proven through the witness`,
            });
          }
        }
      }
    } catch (error) {
      checks.push({
        id: 'behavior-profile',
        status: 'warn',
        detail: `behavior-profile readiness could not be evaluated: ${(error as Error).message.split('\n')[0] ?? 'unknown'}`,
      });
    }
  }

  // 4. Trusted binary/policy ownership.
  const binaryPath = process.argv[1] ?? '(unknown)';
  const resolvedBinary = resolve(binaryPath);
  const repoRoot = resolve(io.cwd);
  const binaryOrigin = resolvedBinary.startsWith(`${repoRoot}/`) ? 'repo-local' : 'external (PATH/global)';
  let policyDetail: string;
  let policyStatus: DoctorStatus;
  if (!configOk) {
    policyDetail = 'trusted policy digest not computed (config failed to load)';
    policyStatus = 'fail';
  } else {
    try {
      const config = loadConfigAt(io.cwd);
      const digest = trustedPolicyDigestForConfig(io.cwd, config);
      // Honest approved-policy surface (review 2026-09-13 P1 #5): the
      // candidate digest alone proves which revision ran, never that the
      // owner approved it. Report absence/mismatch plainly.
      const resolution = resolveApprovedPolicyDigest({
        env: io.env,
        candidateCwd: io.cwd,
        candidateConfig: config,
      });
      let matchNote = '';
      if (resolution.status === 'ok' && resolution.digest !== null) {
        matchNote = policyWeakenedCandidate(resolution.digest, digest).weakened
          ? ' — MISMATCHES the candidate policy revision (strict gates will block)'
          : ' — matches the candidate policy revision';
      }
      // R1-13: the FULL 64-hex digest (never a prefix) — the owner
      // copies it into the protected pin verbatim. An absent or
      // mismatched pin gets the exact owner action line.
      const pinMatches =
        resolution.status === 'ok' && resolution.digest !== null && resolution.digest === digest;
      const pinAction = pinMatches
        ? ''
        : `\nowner: pin this revision with ${APPROVED_POLICY_DIGEST_ENV}=${digest} ` +
          `(protected env, CI variable, or ${TRUSTED_CONFIG_ENV} outside the repo)`;
      policyDetail =
        `trusted policy digest present (${digest}); gateforge binary: ${binaryPath} (${binaryOrigin}); ` +
        `${describeApprovedPolicyResolution(resolution)}${matchNote}${pinAction}`;
      policyStatus = 'ok';
    } catch (error) {
      policyDetail = `trusted policy digest computation failed: ${(error as Error).message.split('\n')[0] ?? 'unknown'}`;
      policyStatus = 'fail';
    }
  }
  checks.push({ id: 'trusted-binary-policy', status: policyStatus, detail: policyDetail });

  // 5. Snapshot mode (inventory availability decides evidence binding).
  const inventory = probe(io.cwd, io.env, ['ls-files', '--stage', '-z']);
  checks.push({
    id: 'snapshot',
    status: inventory === null ? 'fail' : 'ok',
    detail:
      inventory === null
        ? 'snapshot mode: unavailable (no usable Git inventory) — evidence authorization fails closed'
        : 'snapshot mode: git-inventory (tracked + nonignored untracked bytes hashed into the input digest)',
  });

  // 6. Enforcement mode + the honest managed boundary.
  checks.push({
    id: 'enforcement-mode',
    status: 'ok',
    detail:
      mode === 'managed'
        ? 'enforcement mode: managed — commits go through `gateforge broker commit` (CAS ref update against a verified receipt)'
        : 'enforcement mode: standard — active local hook + mandatory trusted server check',
  });
  if (mode === 'managed') {
    const gitDir = probe(io.cwd, io.env, ['rev-parse', '--absolute-git-dir']);
    let agentWritable = true;
    let boundaryDetail = 'the authoritative Git directory could not be resolved';
    if (gitDir !== null && gitDir.length > 0) {
      try {
        accessSync(gitDir, fsConstants.W_OK);
        agentWritable = true;
        boundaryDetail = `authoritative Git directory '${gitDir}' is writable by the current user`;
      } catch {
        agentWritable = false;
        boundaryDetail = `authoritative Git directory '${gitDir}' is NOT writable by the current user`;
      }
    }
    checks.push({
      id: 'managed-guarantee',
      status: agentWritable ? 'fail' : 'ok',
      detail:
        agentWritable
          ? `managed guarantees NOT active: authoritative repository is agent-writable (${boundaryDetail}). ` +
            'The broker mechanism exists (`gateforge broker commit`) but the deployment boundary does not.'
          : `managed boundary plausible: ${boundaryDetail}; the broker deployment must ALSO keep the engine, policy authority, and verifier key outside the agent's process boundary`,
    });
  } else {
    checks.push({
      id: 'managed-guarantee',
      status: 'warn',
      detail:
        'managed guarantees NOT active: standard mode detects a local hook at most — ' +
        '`--no-verify`, an alternate core.hooksPath, direct plumbing, or an unrelated clone bypass it (ADR 0005 D1)',
    });
  }
  // A framework-wired gate is an ACTIVE local hook, exactly like a
  // Gateforge-owned one: the check runs on every commit either way.
  const hookActive = hook.verifyOk || frameworkGate;
  const level: DoctorReport['level'] =
    ciWired && protection.verified ? 3 : ciWired ? 2 : hookActive ? 1 : 0;

  return {
    mode,
    strictE2E,
    engine: engineIdentity(),
    level,
    checks: [...checks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ready: checks.every((check) => check.status !== 'fail'),
    run,
  };
}

/**
 * Runs the `enforcement doctor` subcommand (plan Phase 5 item 7).
 *
 * Args:
 *   io: process context.
 *   argv: flags after `enforcement`.
 *
 * Returns:
 *   Promise<number>: always 0 when the doctor runs (diagnostic);
 *   2 for usage errors.
 */
export async function enforcementCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options, positionals } = parseArgs(argv);
  const sub = positionals[0];
  if (sub === undefined || sub !== 'doctor') {
    throw new UsageError(`unknown enforcement subcommand '${sub ?? '(none)'}' (only 'doctor' exists)`);
  }
  if (options['help'] === true) {
    writeLine(io.stdout, ENFORCEMENT_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['json', 'help', 'strict-preflight'], ENFORCEMENT_USAGE);
  const report = await buildDoctorReport(io);
  if (options['json'] === true) {
    writeLine(io.stdout, canonicalJson(report as unknown as JsonValue));
    return strictExit(io, report.run, options['strict-preflight'] === true, 'json');
  }
  writeLine(io.stdout, `You are at level ${report.level}.`);
  writeLine(
    io.stdout,
    report.level === 3
      ? 'The protected branch requires the Gateforge status check.'
      : report.level === 2
        ? "To reach level 3, protect the branch and require the 'gateforge' status check."
        : report.level === 1
          ? 'To reach level 2, wire the generated Gateforge CI template into your provider.'
          : 'To reach level 1, run `gateforge init --blocking`.',
  );
  writeLine(io.stdout, `gateforge enforcement doctor (mode ${report.mode}, strictE2E ${String(report.strictE2E)})`);
  writeLine(io.stdout, engineSourceLine(report.engine, engineInstallProvenance(enginePackageRoot())));
  if (report.engine.unpublished) writeLine(io.stdout, 'unpublished engine: CI will not have this code');
  for (const check of report.checks) {
    writeLine(io.stdout, `  [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
  }
  writeLine(
    io.stdout,
    `overall: ${report.ready ? 'ready (no failing checks)' : 'NOT ready (failing checks above)'} — diagnostic only; exit 0 either way`,
  );
  writeLine(io.stdout, 'run preconditions (read-only; `gateforge run` consumes these)');
  for (const check of report.run.checks) {
    writeLine(io.stdout, `  [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
  }
  writeLine(
    io.stdout,
    `run preconditions: ${report.run.ready ? 'ready' : 'NOT ready (failing preconditions above)'} — report-only; exit 0 unless --strict-preflight`,
  );
  return strictExit(io, report.run, options['strict-preflight'] === true, 'text');
}

/**
 * Applies `--strict-preflight`: the default doctor is report-only and
 * exits 0 whenever it runs, so today's behavior is byte-identical;
 * with the flag the FIRST failing precondition ends the command with
 * exit 1 and names the fix on stderr.
 *
 * Args:
 *   io: process context.
 *   run: the managed-run preflight section.
 *   strict: whether `--strict-preflight` was given.
 *   format: the printed surface, for the diagnostic wording.
 *
 * Returns:
 *   number: 1 at the first failing precondition under the flag, else 0.
 */
function strictExit(
  io: Io,
  run: RunPreflightReport,
  strict: boolean,
  format: 'json' | 'text',
): number {
  if (!strict) return 0;
  const failure = firstFailingCheck(run);
  if (failure === null) return 0;
  writeLine(io.stderr, `run preconditions: [FAIL] ${failure.id}: ${failure.detail}`);
  if (format === 'json') writeLine(io.stderr, 'run preconditions: not ready (see the run section of the report above)');
  return 1;
}
