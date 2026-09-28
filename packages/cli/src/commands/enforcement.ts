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
import { join, relative, resolve, sep } from 'node:path';
import { BehaviorPolicySchema } from '@gate-forge/core';
import { parse as parseYaml } from 'yaml';
import {
  allCapabilities,
  canonicalJson,
  policyWeakenedCandidate,
  type JsonValue,
} from '@gate-forge/core';
import { parseArgs } from '../args.js';
import { trustedPolicyDigestForConfig } from '../execution.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { TEST_MAP_RELATIVE } from '../mapping.js';
import { inspectCommitHook } from '../git-hooks.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { resolveStateDir } from '../state.js';
import { resolveVerifierKeyring } from '../verifier-keys.js';
import { describeApprovedPolicyResolution, resolveApprovedPolicyDigest } from '../trusted-policy.js';
import { engineIdentity, type EngineIdentity } from '../engine-identity.js';

export const ENFORCEMENT_USAGE = 'usage: gateforge enforcement doctor [--json]';

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
 * Hashes copied workspace files while excluding Git metadata.
 *
 * Args:
 *   root: isolated hook-check checkout.
 *
 * Returns:
 *   Map<string, string>: relative file paths mapped to content or symlink digests.
 */
function snapshotHookWorkspace(root: string): Map<string, string> {
  const files = new Map<string, string>();
  /**
   * Adds one directory's files and links to the content snapshot.
   *
   * Args:
   *   directory: directory to enumerate recursively.
   *
   * Returns:
   *   void: adds relative path digests to the enclosing snapshot.
   */
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.set(relative(root, path).split(sep).join('/'), createHash('sha256').update(readFileSync(path)).digest('hex'));
      } else if (entry.isSymbolicLink()) {
        files.set(relative(root, path).split(sep).join('/'), createHash('sha256').update(readlinkSync(path)).digest('hex'));
      }
    }
  };
  visit(root);
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
  const pathEnv = env['PATH'] ?? process.env['PATH'] ?? '';
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: pathEnv,
    HOME: scratchRoot,
    TMPDIR: scratchRoot,
    LANG: env['LANG'] ?? 'C.UTF-8',
    PRE_COMMIT_HOME: join(scratchRoot, 'cache'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
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
      const before = snapshotHookWorkspace(checkout);
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
      const after = snapshotHookWorkspace(checkout);
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(path) !== after.get(path)) mutations.add(path);
      }
      if (result.error !== undefined || result.status !== 0) {
        failures.push(`run ${pass + 1}: ${(result.stderr || result.stdout || result.error?.message || `exit ${String(result.status)}`).trim()}`);
      }
    }
    if (mutations.size > 0) {
      const recommendation =
        hookIds[0] === 'gateforge-check'
          ? ''
          : '; put gateforge-check first so later file-mutating hooks cannot invalidate its receipt';
      return {
        status: 'warn',
        detail: `pre-commit hooks modified workspace files on repeated runs: ${[...mutations].sort().join(', ')}${recommendation}`,
      };
    }
    if (failures.length > 0) {
      return { status: 'warn', detail: `pre-commit hooks did not complete cleanly twice: ${failures.join('; ')}` };
    }
    return { status: 'ok', detail: 'pre-commit hooks ran twice without workspace file mutations' };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
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
 * Cheap playwright readiness probe: package resolvable in the repo's
 * node_modules and a nonempty browser registry (default cache or
 * PLAYWRIGHT_BROWSERS_PATH). Never launches anything.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   {status, detail}: ok / warn (no browsers) / fail (no package).
 */
function playwrightReadiness(cwd: string): { status: DoctorStatus; detail: string } {
  let packageJson: string | null = null;
  let cursor = resolve(cwd);
  // Walk up like Node resolution: the CLI may run from a workspace root.
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(cursor, 'node_modules', 'playwright', 'package.json');
    if (existsSync(candidate)) {
      packageJson = candidate;
      break;
    }
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  if (packageJson === null) {
    return {
      status: 'fail',
      detail: 'playwright is not installed (no node_modules/playwright found from the repo root); the supervised E2E runner cannot execute',
    };
  }
  const browsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? join(homedir(), '.cache', 'ms-playwright');
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
  return { status: 'ok', detail: `playwright installed; browsers ${browsers} under '${browsersPath}'` };
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
  let configOk = true;
  let configDetail = 'no .gateforge.yml — gateforge is not initialized in this repository';
  try {
    const config = loadConfigAt(io.cwd);
    mode = config.enforcement?.mode ?? 'standard';
    strictE2E = config.enforcement?.strictE2E === true;
    configOk = true;
    configDetail = `.gateforge.yml loaded (mode ${mode}, strictE2E ${String(strictE2E)})`;
  } catch (error) {
    configOk = false;
    configDetail = `.gateforge.yml could not be loaded: ${(error as Error).message.split('\n')[0] ?? 'unknown'}`;
  }
  checks.push({ id: 'config', status: configOk ? 'ok' : 'fail', detail: configDetail });

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
  checks.push({
    id: 'hook',
    status: hook.verifyOk ? 'ok' : hook.marker ? 'fail' : 'warn',
    detail: hook.detail,
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

  // 2. Runner readiness (cheap probes only — nothing is launched).
  checks.push({ id: 'runner', ...playwrightReadiness(io.cwd) });

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
      policyDetail =
        `trusted policy digest present (${digest.slice(0, 12)}…); gateforge binary: ${binaryPath} (${binaryOrigin}); ` +
        `${describeApprovedPolicyResolution(resolution)}${matchNote}`;
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
  const level: DoctorReport['level'] =
    ciWired && protection.verified ? 3 : ciWired ? 2 : hook.verifyOk ? 1 : 0;

  return {
    mode,
    strictE2E,
    engine: engineIdentity(),
    level,
    checks: [...checks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ready: checks.every((check) => check.status !== 'fail'),
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
  rejectUnknownFlags(options, ['json', 'help'], ENFORCEMENT_USAGE);
  const report = await buildDoctorReport(io);
  if (options['json'] === true) {
    writeLine(io.stdout, canonicalJson(report as unknown as JsonValue));
    return 0;
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
  writeLine(io.stdout, `engine: ${report.engine.version} from ${report.engine.source}`);
  if (report.engine.unpublished) writeLine(io.stdout, 'unpublished engine: CI will not have this code');
  for (const check of report.checks) {
    writeLine(io.stdout, `  [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
  }
  writeLine(
    io.stdout,
    `overall: ${report.ready ? 'ready (no failing checks)' : 'NOT ready (failing checks above)'} — diagnostic only; exit 0 either way`,
  );
  return 0;
}
