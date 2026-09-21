/**
 * Staged-runtime supervision (plan 2026-09-21 witnessed pre-commit).
 *
 * Prepares a materialized staged candidate for execution and owns the
 * candidate's application/database/worker processes end to end:
 *
 * - `prepare` runs the tracked preparation command INSIDE the checkout
 *   (frozen/offline installs, builds) with a bounded timeout and
 *   captured logs; `prepare.reuse` names the dependency directories
 *   explicitly allowed to be LINKED from the user repository — the only
 *   sanctioned dependency bridge (the old unconditional node_modules
 *   symlink is gone).
 * - `services` start candidate-owned processes from the checkout bytes
 *   (never the worktree), each in its own process group, readiness-
 *   probed, log-captured, and cleaned up on every exit path.
 * - The attested target service is fronted by the gate's loopback
 *   attestation proxy (GF-13): the stamped environment marker binds the
 *   witnessed UI/adapter reads to ONE environment, and that environment
 *   is the one this module started from the frozen candidate.
 *
 * The document (`.gateforge/runtime.yml`) is security-sensitive: it is
 * hashed into the trusted policy digest and the authenticated input
 * snapshot, so a candidate cannot change its own runtime commands and
 * approve the change in the same commit.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_PREPARE_TIMEOUT_SECONDS,
  DEFAULT_READY_TIMEOUT_SECONDS,
  RuntimeConfigSchema,
  isNormalizedRepoRelativePath,
  sha256Canonical,
  type RuntimeConfig,
  type RuntimeService,
} from '@gate-forge/core';
import { startAttestationProxy, type AttestationProxyHandle } from '@gate-forge/pack-playwright';
import type { Io } from './io.js';
import { resolveStateDir } from './state.js';

/** Operator env vars always available to preparation commands and services. */
const RUNTIME_ENV_BASE = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'SHELL', 'TMPDIR'] as const;

/** Grace period between SIGTERM and SIGKILL when stopping a service group. */
const SERVICE_STOP_GRACE_MS = 5_000;

/** Delay between readiness probe iterations. */
const READY_POLL_INTERVAL_MS = 200;

/**
 * Every live child this module spawned (prepare + services). The registry
 * backs the interruption path: a SIGINT arriving BEFORE the services
 * handle exists still tears the detached process groups down.
 */
const activeChildren = new Set<ChildProcess>();

/**
 * Registers a spawned child for interruption teardown and forgets it
 * once it exits.
 *
 * Args:
 *   child: the freshly spawned child.
 */
function trackChild(child: ChildProcess): void {
  activeChildren.add(child);
  const forget = (): void => {
    activeChildren.delete(child);
  };
  child.once('exit', forget);
  child.once('error', forget);
}

/**
 * Tears down EVERY registered child's process group (interruption path).
 *
 * Returns:
 *   Promise<void>: resolved when all groups have been signalled.
 */
export async function stopRuntimeChildren(): Promise<void> {
  for (const child of [...activeChildren]) stopProcessGroup(child);
  activeChildren.clear();
}

/**
 * Promise-with-resolvers equivalent (the repo lib target predates
 * `Promise.withResolvers`): externally settleable one-shot slot.
 *
 * Args:
 *   T: the resolved value type.
 *
 * Returns:
 *   object: `promise` plus its `resolve`/`reject`.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A running candidate runtime: handles plus the attested target binding. */
export interface RunningRuntime {
  /** Base URL of the attested target service's proxy (when declared). */
  targetBaseUrl: string | null;
  /** The attested environment marker the target proxy stamps. */
  targetFingerprint: string | null;
  /** Stops every service and proxy (idempotent, safe after failures). */
  stop: () => Promise<void>;
}

/**
 * Typed runtime failure: preparation or readiness broke — the gate must
 * block with a precise cause and next action, never degrade to the
 * worktree runtime.
 */
export class RuntimeBlockError extends Error {
  /** The stable cause code rendered by the caller. */
  readonly causeCode: 'RUNTIME_PREPARATION_FAILED' | 'RUNTIME_READINESS_FAILED';

  /**
   * Builds one typed runtime block.
   *
   * Args:
   *   causeCode: preparation vs readiness failure class.
   *   message: precise, actionable detail (no stack dumps).
   */
  constructor(causeCode: 'RUNTIME_PREPARATION_FAILED' | 'RUNTIME_READINESS_FAILED', message: string) {
    super(message);
    this.name = 'RuntimeBlockError';
    this.causeCode = causeCode;
  }
}

/**
 * Loads and validates the tracked staged-runtime document.
 *
 * Args:
 *   runtimePath: repo-relative runtime document path from the
 *     validated `.gateforge.yml` (`runtime` key), or undefined when the
 *     owner declared none.
 *   cwd: absolute repository root (the candidate checkout when
 *     orchestrating a staged run — the candidate carries its own
 *     reviewed runtime bytes).
 *
 * Returns:
 *   RuntimeConfig | null: the parsed document, or null when no runtime
 *   document is configured (staged runtime off — fail closed).
 *
 * Throws:
 *   RuntimeBlockError: on a missing, unparsable, or schema-violating
 *   document that the config DOES declare (fail closed, never ignored).
 */
export function loadRuntimeConfigAt(cwd: string, runtimePath: string | undefined): RuntimeConfig | null {
  if (runtimePath === undefined) return null;
  const absolute = join(cwd, ...runtimePath.split('/'));
  if (!existsSync(absolute)) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `the staged-runtime document '${runtimePath}' is configured but missing from the candidate — ` +
        'the runtime commands are part of the trusted revision and cannot vanish',
    );
  }
  let document: unknown;
  try {
    document = parseYaml(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `the staged-runtime document '${runtimePath}' is not parsable YAML: ${(error as Error).message}`,
    );
  }
  const parsed = RuntimeConfigSchema.safeParse(document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first === undefined ? '(root)' : first.path.map(String).join('.');
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `the staged-runtime document '${runtimePath}' violates its schema at '${path}': ` +
        `${first?.message ?? 'unknown schema error'}`,
    );
  }
  return parsed.data;
}

/**
 * Builds the child environment for preparation commands and services:
 * a fixed safe base plus the owner-allowlisted operator names plus the
 * supervisor-injected service coordinates. Everything else (credentials,
 * orchestrator state, candidate-controlled names) stays out.
 *
 * Args:
 *   allowlist: owner-declared operator env names (`envAllowlist`).
 *   ioEnv: the operator process environment.
 *   injected: supervisor-computed variables (service ports/URLs).
 *
 * Returns:
 *   NodeJS.ProcessEnv: the child environment.
 */
function runtimeChildEnv(
  allowlist: readonly string[],
  ioEnv: NodeJS.ProcessEnv,
  injected: Record<string, string>,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of RUNTIME_ENV_BASE) {
    const value = ioEnv[name];
    if (value !== undefined) child[name] = value;
  }
  for (const name of allowlist) {
    const value = ioEnv[name];
    if (value !== undefined) child[name] = value;
  }
  return { ...child, ...injected };
}

/**
 * Substitutes `${service:<id>:port}` / `${service:<id>:url}` placeholders.
 *
 * Args:
 *   template: config string possibly containing placeholders.
 *   ports: assigned port per service id.
 *
 * Returns:
 *   string: the substituted string (a reference to an unknown service
 *   stays literal — the spawn/readiness then fails observably).
 */
function substitute(template: string, ports: ReadonlyMap<string, number>): string {
  return template.replace(/\$\{service:([a-z0-9-]+):(port|url)\}/g, (match, id: string, kind: string) => {
    const port = ports.get(id);
    if (port === undefined) return match;
    return kind === 'port' ? String(port) : `http://127.0.0.1:${String(port)}`;
  });
}

/**
 * Allocates one free loopback port by binding port 0 and releasing it.
 *
 * Returns:
 *   number: a port that was free at allocation time.
 *
 * Throws:
 *   RuntimeBlockError: when no port can be bound at all.
 */
async function allocatePort(): Promise<number> {
  const server = net.createServer();
  const listening = deferred<void>();
  server.once('listening', () => listening.resolve());
  server.once('error', (error) => listening.reject(error));
  server.listen(0, '127.0.0.1');
  try {
    await listening.promise;
  } catch {
    throw new RuntimeBlockError('RUNTIME_READINESS_FAILED', 'no free loopback port could be allocated');
  }
  const address = server.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 0;
  // Closing releases the port for the service to bind; the OS keeps
  // short-lived TIME_WAIT sockets from colliding on 127.0.0.1:0 reuse.
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (port === 0) {
    throw new RuntimeBlockError('RUNTIME_READINESS_FAILED', 'no free loopback port could be allocated');
  }
  return port;
}

/**
 * Links one explicitly sanctioned dependency directory from the user
 * repository into the checkout (junction on Windows, symlink elsewhere).
 * The link is RUNTIME identity (recorded in the candidate tree), never
 * candidate source.
 *
 * Args:
 *   sourceRoot: user repository root.
 *   checkoutRoot: materialized candidate root.
 *   relative: repo-relative dependency directory (`prepare.reuse` entry).
 *
 * Throws:
 *   RuntimeBlockError: when the source directory is missing (the
 *   declared reuse is part of the reviewed runtime contract).
 */
function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolves and validates one configured reuse path under both roots. */
function reusePaths(sourceRoot: string, checkoutRoot: string, path: string): { source: string; target: string } {
  if (!isNormalizedRepoRelativePath(path)) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare.reuse path '${path}' is not a normalized repository-relative path — ` +
        'absolute paths and traversal are rejected',
    );
  }
  const source = resolve(sourceRoot, ...path.split('/'));
  const target = resolve(checkoutRoot, ...path.split('/'));
  if (!pathInside(sourceRoot, source) || !pathInside(checkoutRoot, target)) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare.reuse path '${path}' resolves outside the source or candidate root — refusing the link`,
    );
  }
  return { source, target };
}

/**
 * Collects deterministic identity records for one reused dependency tree.
 * Symlinks are followed, including sanctioned links to an external
 * dependency store, so the digest covers the bytes a candidate can execute.
 *
 * Args:
 *   absolute: current filesystem entry.
 *   logicalPath: stable path label in the reuse manifest.
 *   active: real paths on the current recursion stack.
 *   entries: output records.
 */
function collectReuseEntries(
  absolute: string,
  logicalPath: string,
  active: Set<string>,
  entries: Array<Record<string, string | number>>,
): void {
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare.reuse cannot inspect '${logicalPath}': ${(error as Error).message}`,
    );
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    let resolvedTarget: string;
    try {
      target = readlinkSync(absolute);
      resolvedTarget = realpathSync(absolute);
    } catch (error) {
      throw new RuntimeBlockError(
        'RUNTIME_PREPARATION_FAILED',
        `runtime prepare.reuse cannot resolve symlink '${logicalPath}': ${(error as Error).message}`,
      );
    }
    entries.push({
      path: logicalPath,
      type: 'symlink',
      target,
    });
    if (active.has(resolvedTarget)) {
      entries.push({ path: `${logicalPath}=>cycle`, type: 'cycle' });
      return;
    }
    collectReuseEntries(
      resolvedTarget,
      `${logicalPath}=>${target.split('\\').join('/')}`,
      new Set([...active, resolvedTarget]),
      entries,
    );
    return;
  }
  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch (error) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare.reuse cannot resolve '${logicalPath}': ${(error as Error).message}`,
    );
  }
  if (active.has(resolved)) {
    entries.push({ path: logicalPath, type: 'cycle' });
    return;
  }
  if (stat.isDirectory()) {
    entries.push({ path: logicalPath, type: 'directory' });
    let children: string[];
    try {
      children = readdirSync(absolute).sort();
    } catch (error) {
      throw new RuntimeBlockError(
        'RUNTIME_PREPARATION_FAILED',
        `runtime prepare.reuse cannot read '${logicalPath}': ${(error as Error).message}`,
      );
    }
    for (const child of children) {
      collectReuseEntries(
        join(absolute, child),
        `${logicalPath}/${child}`,
        new Set([...active, resolved]),
        entries,
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare.reuse entry '${logicalPath}' is not a regular file, directory, or safe symlink`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (error) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare.reuse cannot read '${logicalPath}': ${(error as Error).message}`,
    );
  }
  entries.push({
    path: logicalPath,
    type: 'file',
    mode: stat.mode & 0o777,
    digest: createHash('sha256').update(bytes).digest('hex'),
  });
}

/**
 * Computes the deterministic digest bound to a staged run for reused
 * dependency bytes. A changed dependency therefore changes the run's input
 * identity even though the candidate checkout contains a symlink.
 *
 * Args:
 *   sourceRoot: user repository root that supplies reuse bytes.
 *   runtime: validated staged-runtime configuration.
 *
 * Returns:
 *   string | null: the reuse digest, or null when no reuse is configured.
 */
export function runtimeReuseDigest(sourceRoot: string, runtime: RuntimeConfig): string | null {
  const paths = runtime.prepare?.reuse ?? [];
  if (paths.length === 0) return null;
  let sourceRootReal: string;
  try {
    sourceRootReal = realpathSync(resolve(sourceRoot));
  } catch (error) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare.reuse cannot resolve the user repository root: ${(error as Error).message}`,
    );
  }
  const entries: Array<Record<string, string | number>> = [];
  for (const path of paths) {
    const { source } = reusePaths(sourceRootReal, sourceRootReal, path);
    if (!existsSync(source)) {
      // A staged candidate may carry its own dependency bytes. In that case
      // linkReuseDir leaves them in place and the candidate tree identity
      // binds those bytes; record the absent external source explicitly.
      entries.push({ path, type: 'source-absent' });
      continue;
    }
    collectReuseEntries(source, path, new Set(), entries);
  }
  return sha256Canonical({ domain: 'gateforge.runtime-reuse.v1', entries });
}

function linkReuseDir(sourceRoot: string, checkoutRoot: string, path: string): void {
  const { source, target } = reusePaths(sourceRoot, checkoutRoot, path);
  if (existsSync(target)) return; // candidate carries its own bytes — never overridden
  if (!existsSync(source)) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare.reuse names '${path}' but the user repository has no such directory — ` +
        'install dependencies in the user repository or fix the tracked runtime document',
    );
  }
  mkdirSync(join(target, '..'), { recursive: true });
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Stops one child's whole process group (POSIX) or the process tree
 * (Windows): SIGTERM first, SIGKILL after the grace period.
 *
 * Args:
 *   child: the spawned child (may already be dead — always safe).
 */
function stopProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return; // group already gone
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, SERVICE_STOP_GRACE_MS);
  timer.unref();
}

/**
 * Runs the tracked preparation command inside the checkout.
 *
 * Args:
 *   checkoutRoot: materialized candidate root (the command's cwd).
 *   runtime: the parsed staged-runtime document.
 *   io: process context (env allowlist source).
 *   logPath: absolute log file the command's output is captured to.
 *
 * Throws:
 *   RuntimeBlockError: on spawn error, nonzero exit, or timeout, with
 *   the log path named for debugging.
 */
async function runPrepareCommand(checkoutRoot: string, runtime: RuntimeConfig, io: Io, logPath: string): Promise<void> {
  const prepare = runtime.prepare;
  if (prepare === undefined || prepare.command === undefined) return;
  const timeoutSeconds = prepare.timeoutSeconds ?? DEFAULT_PREPARE_TIMEOUT_SECONDS;
  const logFd = openSync(logPath, 'w');
  const child = spawn(prepare.command, {
    cwd: checkoutRoot,
    env: runtimeChildEnv(runtime.envAllowlist ?? [], io.env, {}),
    shell: true,
    // Each invocation owns a fresh log. Appending would let a stale copied
    // readiness line authorize a new process before it emits anything.
    stdio: ['ignore', logFd, logFd],
    detached: process.platform !== 'win32',
  });
  trackChild(child);
  const exit = deferred<{ timedOut: boolean }>();
  const timer = setTimeout(() => {
    stopProcessGroup(child);
    exit.resolve({ timedOut: true });
  }, timeoutSeconds * 1_000);
  child.once('exit', () => exit.resolve({ timedOut: false }));
  child.once('error', () => exit.resolve({ timedOut: false }));
  const outcome = await exit.promise;
  clearTimeout(timer);
  if (outcome.timedOut) {
    // The SIGTERM grace is still running: wait for the group to die so
    // a failing gate never leaves grandchildren behind.
    const reaped = deferred<void>();
    child.once('exit', () => reaped.resolve());
    const reapTimer = setTimeout(() => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, SERVICE_STOP_GRACE_MS);
    await Promise.race([reaped.promise, new Promise((resolveGrace) => setTimeout(resolveGrace, SERVICE_STOP_GRACE_MS * 2))]);
    clearTimeout(reapTimer);
    reaped.resolve();
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare command exceeded ${String(timeoutSeconds)}s: '${prepare.command}' — full log: ${logPath}`,
    );
  }
  if (child.exitCode !== 0) {
    throw new RuntimeBlockError(
      'RUNTIME_PREPARATION_FAILED',
      `runtime prepare command failed (exit ${String(child.exitCode ?? 'error')}): '${prepare.command}' — ` +
        `full log: ${logPath}`,
    );
  }
}

/**
 * Waits for one service's readiness with a hard deadline: a log line
 * matching the declared regex source, an HTTP probe returning 2xx, or
 * the child's early exit (typed failure naming the log).
 *
 * Args:
 *   child: the spawned service process.
 *   service: the declaration (probe kind + budget).
 *   ports: assigned ports (placeholder substitution for http probes).
 *   logPath: the service's captured log.
 */
async function awaitReadiness(
  child: ChildProcess,
  service: RuntimeService,
  ports: ReadonlyMap<string, number>,
  logPath: string,
): Promise<void> {
  const timeoutSeconds = service.ready.timeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const logPattern = service.ready.log !== undefined ? new RegExp(service.ready.log, 'u') : null;
  let seenBytes = 0;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new RuntimeBlockError(
        'RUNTIME_READINESS_FAILED',
        `service '${service.id}' exited (code ${String(child.exitCode ?? child.signalCode)}) before becoming ` +
          `ready — full log: ${logPath}`,
      );
    }
    if (logPattern !== null && existsSync(logPath)) {
      const bytes = readFileSync(logPath);
      if (bytes.length > seenBytes) {
        seenBytes = bytes.length;
        if (logPattern.test(bytes.toString('utf8'))) return;
      }
    }
    if (service.ready.http !== undefined && (await probeHttp(substitute(service.ready.http, ports)))) return;
    if (Date.now() > deadline) {
      throw new RuntimeBlockError(
        'RUNTIME_READINESS_FAILED',
        `service '${service.id}' was not ready within ${String(timeoutSeconds)}s — full log: ${logPath}`,
      );
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, READY_POLL_INTERVAL_MS));
  }
}

/**
 * Performs one 2xx check against a readiness URL.
 *
 * Args:
 *   url: the (substituted) readiness URL.
 *
 * Returns:
 *   boolean: true when the fetch returned status 200–299.
 */
async function probeHttp(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Prepares the candidate checkout runtime: sanctioned dependency reuse
 * links, then the tracked preparation command. Logs land under the
 * run-state `runtime/` directory (audit artifacts the caller copies
 * back to the user repository).
 *
 * Args:
 *   sourceRoot: user repository root (reuse-link source).
 *   checkoutRoot: materialized candidate root.
 *   runtime: the parsed staged-runtime document.
 *   io: process context.
 *   stateDir: run-state directory for logs.
 *
 * Returns:
 *   object: the digest of reused dependency bytes, when configured.
 *
 * Throws:
 *   RuntimeBlockError: typed preparation failures.
 */
export async function prepareRuntime(
  sourceRoot: string,
  checkoutRoot: string,
  runtime: RuntimeConfig,
  io: Io,
  stateDir: string,
): Promise<{ reuseDigest: string | null }> {
  const logDir = join(stateDir, 'runtime');
  mkdirSync(logDir, { recursive: true });
  for (const relative of runtime.prepare?.reuse ?? []) {
    linkReuseDir(sourceRoot, checkoutRoot, relative);
  }
  await runPrepareCommand(checkoutRoot, runtime, io, join(logDir, 'prepare.log'));
  // Bind the bytes that the witnessed runtime will actually execute. A
  // trusted prepare command may materialize or update a reused dependency;
  // hashing after it completes prevents check/reuse from carrying a
  // pre-prepare digest over post-prepare bytes.
  const reuseDigest = runtimeReuseDigest(sourceRoot, runtime);
  return { reuseDigest };
}

/**
 * Starts the declared candidate-owned services from the checkout bytes,
 * probes readiness, and fronts the attested target with the gate's
 * attestation proxy. Services run in their own process groups; `stop`
 * tears everything down (reverse order, SIGTERM then SIGKILL) and is
 * idempotent — the caller MUST call it on every exit path.
 *
 * Args:
 *   checkoutRoot: materialized candidate root (services run from HERE).
 *   runtime: the parsed staged-runtime document.
 *   io: process context (env allowlist source).
 *   stateDir: run-state directory (runtime logs land under runtime/).
 *
 * Returns:
 *   RunningRuntime: handles + attested target binding (null target when
 *   no service declares `target: true`).
 *
 * Throws:
 *   RuntimeBlockError: when a service fails to spawn or readiness is
 *   not reached in time; every already-started service is stopped
 *   before the error propagates.
 */
export async function startRuntimeServices(
  checkoutRoot: string,
  runtime: RuntimeConfig,
  io: Io,
  stateDir: string,
): Promise<RunningRuntime> {
  const services = runtime.services ?? [];
  const logDir = join(stateDir, 'runtime');
  mkdirSync(logDir, { recursive: true });
  const ports = new Map<string, number>();
  for (const service of services) ports.set(service.id, await allocatePort());
  // Coordinates are injected into EVERY service's environment so a
  // database/worker peer can be addressed deterministically.
  const injected: Record<string, string> = {};
  for (const service of services) {
    const port = ports.get(service.id);
    if (port === undefined) continue;
    const key = service.id.toUpperCase().replace(/-/g, '_');
    injected[`GATEFORGE_SERVICE_PORT_${key}`] = String(port);
    injected[`GATEFORGE_SERVICE_URL_${key}`] = `http://127.0.0.1:${String(port)}`;
  }
  const children: ChildProcess[] = [];
  const proxies: AttestationProxyHandle[] = [];
  let targetBaseUrl: string | null = null;
  let targetFingerprint: string | null = null;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const proxy of proxies.reverse()) await proxy.stop().catch(() => undefined);
    for (const child of children.reverse()) stopProcessGroup(child);
  };
  try {
    for (const service of services) {
      const logPath = join(logDir, `${service.id}.log`);
      const logFd = openSync(logPath, 'w');
      const port = ports.get(service.id) as number;
      let baseUrl = `http://127.0.0.1:${String(port)}`;
      if (service.attested === true) {
        // The proxy fronts the service so EVERY response carries the
        // reviewed environment marker (GF-13); the runner env points at
        // the proxy, never at the raw service.
        const proxy = await startAttestationProxy(baseUrl, substitute(service.fingerprint as string, ports));
        proxies.push(proxy);
        baseUrl = proxy.url;
      }
      const child = spawn(substitute(service.command, ports), {
        cwd: checkoutRoot,
        env: runtimeChildEnv(
          runtime.envAllowlist ?? [],
          io.env,
          service.env === undefined
            ? injected
            : {
                ...injected,
                ...Object.fromEntries(
                  Object.entries(service.env).map(([key, value]) => [key, substitute(value, ports)]),
                ),
              },
        ),
        shell: true,
        // Readiness must observe this run's output only; stale copied logs
        // cannot satisfy a new service declaration.
        stdio: ['ignore', logFd, logFd],
        detached: process.platform !== 'win32',
      });
      children.push(child);
      trackChild(child);
      await awaitReadiness(child, service, ports, logPath);
      if (service.target === true && targetBaseUrl === null) {
        targetBaseUrl = baseUrl;
        targetFingerprint = substitute(service.fingerprint as string, ports);
      }
    }
    return { targetBaseUrl, targetFingerprint, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
