/**
 * Content-addressed run cache: reuse
 * unchanged detector and pytest-collection work at commit time.
 *
 * Invariants (the plan's hard rules):
 * - The cache is a SPEED-UP, never proof. Receipts, attestations, and
 *   `--require-e2e` keep their exact checks; a cached contribution is
 *   ordinary detector input, re-validated by the same schemas.
 * - Every key covers every input that can change the result: plugin
 *   id/version/config, the plugin module's bytes (repo-relative module or
 *   the whole installed package), the scanned input bytes, and the
 *   interpreter identity (absolute path, version, installed-package
 *   digest). Pytest keys add the collector argv and suite config.
 * - Any doubt → full scan. An unreadable input, an unresolvable or
 *   non-python interpreter, a corrupt/foreign cache entry, a version or
 *   format mismatch — all degrade to running the work again.
 * - The cache lives under the EXCLUDED run-state directory, never enters
 *   the input digest, and is never used as evidence.
 *   `GATEFORGE_NO_CACHE=1` (or `--no-cache`, or a recognized CI provider)
 *   forces a full scan: no reads, no writes.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readdirSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  DetectorOutputSchema,
  canonicalJson,
  type DetectorOutput,
  type JsonValue,
} from '@gate-forge/core';
import { VERSION } from './commands/common.js';

/** Cache entry format version; a mismatch is a miss (never a parse of foreign bytes). */
export const PLUGIN_CACHE_FORMAT_VERSION = 1;

/** Domain tag keeping plugin-cache keys separate from every other digest. */
export const PLUGIN_CACHE_DOMAIN = 'gateforge.plugin-cache.v1';

/** Directory under the run-state dir holding all Gateforge run caches. */
export const RUN_CACHE_DIR = 'cache';

/** Directory under the run-state dir holding plugin cache entries. */
export const PLUGIN_CACHE_DIR = `${RUN_CACHE_DIR}/plugin`;

/** Directory under the run-state dir holding pytest collection entries. */
export const PYTEST_CACHE_DIR = `${RUN_CACHE_DIR}/pytest`;

/** Beyond this many files a package tree is treated as uncacheable (fail closed). */
const PACKAGE_DIGEST_FILE_BUDGET = 5000;

/** Pytest config documents hashed into the collection cache key. */
const PYTEST_CONFIG_BASENAMES: Record<string, true> = {
  'pytest.ini': true,
  'pyproject.toml': true,
  'setup.cfg': true,
  'tox.ini': true,
};

/** Memoized interpreter identities per resolved interpreter path (one probe per run). */
const INTERPRETER_IDENTITY_CACHE = new Map<string, InterpreterIdentity | null>();

/** Where the cache lives and whether it may be used at all. */
export interface CacheControl {
  /** Absolute run-state directory (excluded from the input snapshot). */
  stateDir: string;
  /** True forces a full scan: no cache reads and no cache writes. */
  disabled: boolean;
}

/** Hit/miss accounting for one run's cache use (additive report key). */
export interface CacheCounts {
  hits: number;
  misses: number;
}

/** Identity of the interpreter a plugin's result depends on. */
export interface InterpreterIdentity {
  /** Absolute interpreter path as resolved for this run. */
  path: string;
  /** Interpreter version string (python `sys.version`). */
  version: string;
  /** Digest over the sorted site-packages entries (name, mtime, size). */
  packagesDigest: string;
  /** Digest of the entry script bytes when argv[0] is a python entry script (e.g. a venv `pytest`). */
  entryScriptDigest?: string;
}

/** Everything one plugin's cached result depends on. */
export interface PluginCacheIdentity {
  /** Plugin id/version/config and Gateforge engine version. */
  plugin: {
    id: string;
    version: string;
    transport: string;
    command?: readonly string[];
    module?: string;
  };
  /** Gateforge engine version, invalidating cache on engine upgrades. */
  engineVersion: string;
  /** Import-resolution environment inherited by Python children. */
  pythonEnvironment: Pick<NodeJS.ProcessEnv, 'PYTHONPATH' | 'PYTHONHOME' | 'VIRTUAL_ENV'>;
  /** Digest of plugin source bytes (file or package tree); null = uncacheable. */
  moduleBytesDigest: string | null;
  /** Digest over the sorted scanned input bytes; null = uncacheable. */
  inputsDigest: string | null;
  /**
   * Interpreter identity; null = uncacheable (probe failed). Subprocess
   * plugins carry their own interpreter; in-process plugins carry the
   * running Node plus the machine's python3 (`'absent'` is itself stable
   * key material — python appearing later changes the key).
   */
  interpreter: InterpreterIdentity | { node: InterpreterIdentity; python: InterpreterIdentity | 'absent' } | null;
}

/** One persisted plugin cache document. */
interface PluginCacheEntry {
  formatVersion: number;
  key: string;
  result: DetectorOutput;
}

/**
 * Resolves the cache control for one gate run.
 *
 * Args:
 *   env: process environment (kill switches and CI detection).
 *   stateDir: absolute run-state directory for cache storage.
 *   noCacheFlag: `--no-cache` presence.
 *
 * Returns:
 *   CacheControl: disabled when `--no-cache`, `GATEFORGE_NO_CACHE` is set,
 *   or a recognized CI-provider marker is present.
 */
export function resolveCacheControl(
  env: NodeJS.ProcessEnv,
  stateDir: string,
  noCacheFlag: boolean,
): CacheControl {
  const ciDetected = [
    'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD',
  ].some((name) => Boolean(env[name]));
  const noCacheEnv = env['GATEFORGE_NO_CACHE'] === '1' || env['GATEFORGE_NO_CACHE'] === 'true';
  return { stateDir: resolve(stateDir), disabled: noCacheFlag || noCacheEnv || ciDetected };
}

/** sha256 of a string or buffer as lowercase hex. */
function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Resolves a command name to an absolute executable path the way a child
 * spawn would (PATH scan), or returns the input when already absolute.
 *
 * Args:
 *   command: the argv[0] of a configured plugin command.
 *   env: process environment providing PATH.
 *
 * Returns:
 *   string | null: absolute executable path, or null when not resolvable.
 */
function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes('/')) return resolve(command);
  const pathEntries = (env['PATH'] ?? '').split(':').filter((entry) => entry.length > 0);
  for (const dir of pathEntries) {
    const candidate = join(dir, command);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this PATH entry; keep scanning.
    }
  }
  return null;
}

/**
 * Digests a directory's direct entries (name, mtimeMs, size — sorted) so
 * installed-package changes (version bumps, reinstalls, in-place edits)
 * invalidate interpreter identity cheaply. A missing directory digests as
 * empty — deterministic, not an error.
 *
 * Args:
 *   directory: absolute directory to summarize.
 *
 * Returns:
 *   string: lowercase hex digest of the sorted entry summary.
 */
function digestDirectoryEntries(directory: string): string {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return sha256Hex('');
  }
  const summary: string[] = [];
  for (const name of entries.sort()) {
    try {
      const stat = statSync(join(directory, name));
      summary.push(`${name}:${stat.mtimeMs.toString(36)}:${stat.size.toString(36)}`);
    } catch {
      summary.push(`${name}:gone`);
    }
  }
  return sha256Hex(summary.join('\n'));
}

/**
 * Probes one python-style interpreter for cache identity: absolute path,
 * `sys.version`, and a site-packages (purelib) digest. Any failure returns
 * null — the caller must then run the work uncached (fail closed).
 *
 * Args:
 *   interpreter: the configured interpreter command (e.g. `python3`).
 *   env: process environment for PATH resolution and the probe child.
 *
 * Returns:
 *   InterpreterIdentity | null: identity, or null when the interpreter
 *   cannot be probed as python.
 */
export function interpreterIdentity(
  interpreter: string,
  env: NodeJS.ProcessEnv,
): InterpreterIdentity | null {
  const resolved = resolveExecutable(interpreter, env);
  if (resolved === null) return null;
  const target = pythonTargetOf(resolved, env);
  if (target === null) return null;
  let base = INTERPRETER_IDENTITY_CACHE.get(target.python);
  if (base === undefined) {
    base = probeInterpreter(target.python, env);
    INTERPRETER_IDENTITY_CACHE.set(target.python, base);
  }
  if (base === null) return null;
  return target.entryScriptDigest === undefined ? base : { ...base, entryScriptDigest: target.entryScriptDigest };
}

/** Matches python interpreter basenames: python, python3, python3.12. */
const PYTHON_BASENAME = /^python(\d+(\.\d+)*)?$/;

/**
 * Finds the python interpreter behind a command WITHOUT executing it.
 * A python binary (or python-named shim) is probed directly. Any other
 * program is only accepted when it is a python entry script: its shebang
 * (or pip's `/bin/sh` + `'''exec' "<python>"` long-path form) names a
 * python interpreter; the script's own bytes then join the key. Anything
 * else is uncacheable, because running an unknown program with `-c` can
 * do real work (a `pytest` entry script treats `-c` as a config file and
 * collects the whole suite).
 *
 * Args:
 *   resolved: absolute path of argv[0].
 *   env: process environment for PATH resolution of `env`-style shebangs.
 *
 * Returns:
 *   { python, entryScriptDigest? } | null: interpreter to probe, or null.
 */
function pythonTargetOf(
  resolved: string,
  env: NodeJS.ProcessEnv,
): { python: string; entryScriptDigest?: string } | null {
  if (PYTHON_BASENAME.test(basename(resolved))) return { python: resolved };
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch {
    return null;
  }
  if (bytes.length > 1024 * 1024 || bytes[0] !== 0x23 || bytes[1] !== 0x21) return null;
  const lines = bytes.subarray(0, 4096).toString('utf8').split('\n');
  const shebang = (lines[0] ?? '').slice(2).trim().split(/\s+/);
  let program = shebang[0] ?? '';
  if (basename(program) === 'env') {
    program = shebang.slice(1).find((token) => !token.startsWith('-')) ?? '';
  }
  if (!PYTHON_BASENAME.test(basename(program))) {
    const execLine = /^'''exec' "([^"]+)" "\$0" "\$@"/.exec(lines[1] ?? '');
    if (!['sh', 'bash'].includes(basename(program)) || execLine === null) return null;
    program = execLine[1] ?? '';
    if (!PYTHON_BASENAME.test(basename(program))) return null;
  }
  const python = resolveExecutable(program, env);
  if (python === null) return null;
  return { python, entryScriptDigest: sha256Hex(bytes) };
}

/**
 * Builds the Node interpreter identity without spawning (the probe above
 * is python-specific): the running executable and version are exact, and
 * the repo's `node_modules` top-level entries stand in for the
 * installed-package digest (an install, upgrade, or removal changes an
 * entry). A missing `node_modules` digests deterministically as empty.
 *
 * Args:
 *   cwd: repo root whose `node_modules` is summarized.
 *
 * Returns:
 *   InterpreterIdentity: identity of the running Node installation.
 */
function nodeIdentityFor(cwd: string): InterpreterIdentity {
  return {
    path: process.execPath,
    version: process.version,
    packagesDigest: digestDirectoryEntries(join(resolve(cwd), 'node_modules')),
  };
}

/**
 * Runs the actual interpreter probe (spawn + purelib digest). Separated
 * from {@link interpreterIdentity} so the memoization boundary stays clear.
 *
 * Args:
 *   resolved: absolute interpreter path.
 *   env: process environment for the probe child.
 *
 * Returns:
 *   InterpreterIdentity | null: identity, or null on any probe failure.
 */
function probeInterpreter(resolved: string, env: NodeJS.ProcessEnv): InterpreterIdentity | null {
  const probe =
    "import json, sys, sysconfig; print(json.dumps({'executable': sys.executable, 'version': sys.version, 'purelib': sysconfig.get_paths().get('purelib', '')}))";
  const result = spawnSync(resolved, ['-c', probe], {
    env: { ...env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  let parsed: { executable?: unknown; version?: unknown; purelib?: unknown };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch {
    return null;
  }
  if (
    typeof parsed.executable !== 'string' ||
    typeof parsed.version !== 'string' ||
    typeof parsed.purelib !== 'string'
  ) {
    return null;
  }
  return {
    path: parsed.executable,
    version: parsed.version,
    packagesDigest: digestDirectoryEntries(parsed.purelib),
  };
}

/**
 * Digests one file's bytes with its repo-relative identity.
 *
 * Args:
 *   absolutePath: file to read.
 *   repoRelativePath: posix-relative identity mixed into the digest.
 *
 * Returns:
 *   string | null: hex digest, or null when the file is unreadable.
 */
function fileDigest(absolutePath: string, repoRelativePath: string): string | null {
  try {
    return sha256Hex(`${repoRelativePath}\0${readFileSync(absolutePath)}`);
  } catch {
    return null;
  }
}

/**
 * Resolves a package specifier to its installed package directory via the
 * repo's require context (no module execution).
 *
 * Args:
 *   specifier: bare package specifier (e.g. `@gate-forge/pack-fastapi`).
 *   cwd: repo root owning node_modules resolution.
 *
 * Returns:
 *   string | null: absolute package directory, or null when unresolvable.
 */
function packageDirOf(specifier: string, cwd: string): string | null {
  try {
    const require = createRequire(join(cwd, 'package.json'));
    const manifestPath = require.resolve(`${specifier}/package.json`);
    return dirname(manifestPath);
  } catch {
    return null;
  }
}

/**
 * Digests a whole file tree recursively (relative path + bytes, sorted).
 * Skips nested `node_modules` directories; exceeds the file budget → null
 * (the caller treats the plugin as uncacheable instead of truncating).
 *
 * Args:
 *   root: absolute directory to digest.
 *
 * Returns:
 *   string | null: hex digest, or null when unreadable or over budget.
 */
function digestTree(root: string): string | null {
  const parts: string[] = [];
  let count = 0;
  const walk = (directory: string, relative: string): boolean => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === 'node_modules') continue;
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const childAbsolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!walk(childAbsolute, childRelative)) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      if (count > PACKAGE_DIGEST_FILE_BUDGET) return false;
      const digest = fileDigest(childAbsolute, childRelative);
      if (digest === null) return false;
      parts.push(digest);
    }
    return true;
  };
  return walk(root, '') ? sha256Hex(parts.join('\n')) : null;
}

/**
 * Digests the plugin module's bytes: a repo-relative module file's bytes,
 * or (for package specifiers) the whole installed package tree — the
 * detector's python sources live inside the package, so a pack update
 * must invalidate cached results.
 *
 * Args:
 *   moduleSpecifier: configured in-process module (`./x.mjs` or package).
 *   cwd: repo root for relative resolution and package lookup.
 *
 * Returns:
 *   string | null: hex digest, or null when unresolvable/unreadable.
 */
function moduleBytesDigestOf(moduleSpecifier: string, cwd: string): string | null {
  if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
    return fileDigest(resolve(cwd, moduleSpecifier), moduleSpecifier);
  }
  const packageDir = packageDirOf(moduleSpecifier, cwd);
  if (packageDir === null) return null;
  return digestTree(packageDir);
}

/**
 * Digests the plugin input bytes: every expanded scan path with its
 * content, sorted by path (order-insensitive like the detectors' view),
 * plus the owner SECTIONS the host handed every detector — a detector's
 * facts depend on the plane / client-scan / import-root declarations, so
 * the same bytes under a different declaration are a cache MISS, never a
 * stale hit. Before 0.11 those bytes were separate files and were NOT
 * part of this key; the sections join it for exactly that reason.
 *
 * Args:
 *   cwd: repo root the relative paths resolve against.
 *   paths: repo-relative scanned paths handed to every plugin.
 *   sections: the parsed owner sections handed to every plugin.
 *
 * Returns:
 *   string | null: hex digest, or null when any input is unreadable.
 */
export function digestPathListInputs(
  cwd: string,
  paths: readonly string[],
  sections: unknown = null,
): string | null {
  const sorted = [...paths].sort();
  const parts: string[] = [];
  for (const relativePath of sorted) {
    const digest = fileDigest(resolve(cwd, relativePath), relativePath);
    if (digest === null) return null;
    parts.push(digest);
  }
  return sha256Hex([JSON.stringify(sections ?? null), ...parts].join('\n'));
}

/**
 * Resolves and digests subprocess plugin source using its configured Python.
 * Script invocations and `-m` imports are supported; unknown forms are
 * uncacheable rather than reusing results without source identity.
 *
 * Args:
 *   command: configured subprocess argv.
 *   cwd: repository root used by the plugin process.
 *   env: inherited environment used for import resolution.
 *
 * Returns:
 *   string | null: source digest, or null when source resolution fails.
 */
function subprocessModuleBytesDigestOf(
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const python = command[0];
  const mode = command[1];
  if (python === undefined || mode === undefined) return null;
  if (mode === '-m') {
    const moduleName = command[2];
    const resolved = resolveExecutable(python, env);
    if (moduleName === undefined || resolved === null) return null;
    const probe = [
      'import importlib.util, json',
      `spec = importlib.util.find_spec(${JSON.stringify(moduleName)})`,
      "print(json.dumps({'origin': None if spec is None else spec.origin, 'locations': [] if spec is None or spec.submodule_search_locations is None else list(spec.submodule_search_locations)}))",
    ].join('; ');
    const result = spawnSync(resolved, ['-c', probe], {
      cwd,
      env: { ...env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error !== undefined || result.status !== 0) return null;
    try {
      const found = JSON.parse(result.stdout) as { origin?: unknown; locations?: unknown };
      if (Array.isArray(found.locations) && found.locations.length > 0) {
        const digests = found.locations.map((location) =>
          typeof location === 'string' ? digestTree(location) : null,
        );
        return digests.every((digest): digest is string => digest !== null)
          ? sha256Hex(digests.join('\n'))
          : null;
      }
      if (typeof found.origin === 'string' && found.origin !== 'built-in' && found.origin !== 'frozen') {
        const stat = statSync(found.origin);
        return stat.isDirectory()
          ? digestTree(found.origin)
          : fileDigest(found.origin, `python-module:${moduleName}`);
      }
    } catch {
      return null;
    }
    return null;
  }
  if (mode.startsWith('-')) return null;
  return fileDigest(resolve(cwd, mode), `python-script:${mode}`);
}

/**
 * Builds the full cache identity for one plugin run, or null when ANY
 * component cannot be established (then the plugin must run fresh).
 *
 * Args:
 *   plugin: the configured plugin (id/version/transport/command/module).
 *   inputsDigest: precomputed digest of the expanded scan path bytes.
 *   cwd: repo root (module resolution).
 *   env: process environment for interpreter resolution.
 *
 * Returns:
 *   PluginCacheIdentity | null: identity, or null when uncacheable.
 */
export function pluginCacheIdentity(
  plugin: {
    id: string;
    version: string;
    transport: string;
    command?: readonly string[];
    module?: string;
  },
  inputsDigest: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  engineVersion = VERSION,
): PluginCacheIdentity | null {
  let interpreter: PluginCacheIdentity['interpreter'];
  if (plugin.transport === 'subprocess') {
    const command = plugin.command ?? [];
    interpreter = command.length > 0 ? interpreterIdentity(command[0] ?? '', env) : null;
  } else {
    // In-process plugins run under Node, but the bundled detectors spawn
    // python3 internally, so the machine's python3 identity rides the key
    // too. A truly absent python is STABLE key material ('absent') — a
    // python appearing later changes the key; a python that exists but
    // cannot be probed is doubt → uncacheable (fail closed).
    const pythonResolved = resolveExecutable('python3', env);
    const python =
      pythonResolved === null ? ('absent' as const) : interpreterIdentity(pythonResolved, env);
    interpreter = python === null ? null : { node: nodeIdentityFor(cwd), python };
  }
  if (interpreter === null) return null;
  const moduleBytesDigest =
    plugin.transport === 'in-process' && plugin.module !== undefined
      ? moduleBytesDigestOf(plugin.module, cwd)
      : plugin.transport === 'subprocess'
        ? subprocessModuleBytesDigestOf(plugin.command ?? [], cwd, env)
        : null;
  if (moduleBytesDigest === null) return null;
  return {
    plugin: {
      id: plugin.id,
      version: plugin.version,
      transport: plugin.transport,
      ...(plugin.command !== undefined ? { command: plugin.command } : {}),
      ...(plugin.module !== undefined ? { module: plugin.module } : {}),
    },
    engineVersion,
    pythonEnvironment: {
      PYTHONPATH: env['PYTHONPATH'],
      PYTHONHOME: env['PYTHONHOME'],
      VIRTUAL_ENV: env['VIRTUAL_ENV'],
    },
    moduleBytesDigest,
    inputsDigest,
    interpreter,
  };
}

/**
 * Looks up one plugin's cached discovery result. Null means "run fresh"
 * — either the identity is uncacheable or any validation step doubted.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   plugin: the configured plugin.
 *   inputsDigest: digest of the expanded scan path bytes.
 *   cwd: repo root.
 *   env: process environment for interpreter resolution.
 *
 * Returns:
 *   DetectorOutput | null: the cached validated output, or null.
 */
export function lookupPluginCache(
  stateDir: string,
  plugin: {
    id: string;
    version: string;
    transport: string;
    command?: readonly string[];
    module?: string;
  },
  inputsDigest: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): DetectorOutput | null {
  const identity = pluginCacheIdentity(plugin, inputsDigest, cwd, env);
  if (identity === null) return null;
  return readPluginCache(stateDir, pluginCacheKey(identity));
}

/**
 * Stores one fresh plugin result under its content key. Uncacheable
 * identities skip silently — the result was already computed, and
 * skipping storage only costs a future miss.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   plugin: the configured plugin.
 *   inputsDigest: digest of the expanded scan path bytes.
 *   cwd: repo root.
 *   env: process environment for interpreter resolution.
 *   result: the validated discovery output.
 *
 * Returns:
 *   void.
 */
export function storePluginResult(
  stateDir: string,
  plugin: {
    id: string;
    version: string;
    transport: string;
    command?: readonly string[];
    module?: string;
  },
  inputsDigest: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  result: DetectorOutput,
): void {
  const identity = pluginCacheIdentity(plugin, inputsDigest, cwd, env);
  if (identity === null) return;
  writePluginCache(stateDir, pluginCacheKey(identity), result);
}

/**
 * Computes the cache key for one plugin identity (domain-separated,
 * canonical JSON so key order never matters).
 *
 * Args:
 *   identity: the plugin cache identity.
 *
 * Returns:
 *   string: 64-char lowercase hex cache key.
 */
export function pluginCacheKey(identity: PluginCacheIdentity): string {
  // canonicalJson takes JsonValue; the identity is a closed internal shape.
  const payload = { domain: PLUGIN_CACHE_DOMAIN, identity } as unknown as JsonValue;
  return sha256Hex(canonicalJson(payload));
}

/** Absolute cache entry path for one key. */
function pluginCachePath(stateDir: string, key: string): string {
  return join(resolve(stateDir), ...PLUGIN_CACHE_DIR.split('/'), `${key}.json`);
}

/**
 * Reads one plugin cache entry, validating format, key, and the pinned
 * discovery shape. ANY doubt (missing file, corrupt JSON, foreign key,
 * schema drift) is a miss — never a guess.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   key: the computed cache key.
 *
 * Returns:
 *   DetectorOutput | null: the cached validated output, or null on any doubt.
 */
export function readPluginCache(stateDir: string, key: string): DetectorOutput | null {
  let raw: string;
  try {
    raw = readFileSync(pluginCachePath(stateDir, key), 'utf8');
  } catch {
    return null;
  }
  let entry: PluginCacheEntry;
  try {
    entry = JSON.parse(raw) as PluginCacheEntry;
  } catch {
    return null;
  }
  if (
    entry.formatVersion !== PLUGIN_CACHE_FORMAT_VERSION ||
    entry.key !== key ||
    typeof entry.result !== 'object' ||
    entry.result === null ||
    DetectorOutputSchema.safeParse(entry.result).success === false
  ) {
    return null;
  }
  return entry.result;
}

/**
 * Persists one validated plugin result under its key (atomic tmp+rename,
 * so a concurrent reader never sees a partial document).
 *
 * Args:
 *   stateDir: absolute run-state directory (cache lives inside, excluded).
 *   key: the computed cache key.
 *   result: the validated discovery output to store.
 *
 * Returns:
 *   void.
 */
export function writePluginCache(stateDir: string, key: string, result: DetectorOutput): void {
  const entry: PluginCacheEntry = {
    formatVersion: PLUGIN_CACHE_FORMAT_VERSION,
    key,
    result,
  };
  const target = pluginCachePath(stateDir, key);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, canonicalJson(entry as unknown as Record<string, never>), 'utf8');
  renameSync(tmp, target);
}

/**
 * Computes the pytest collection cache key for one suite (Phase 3 domain).
 *
 * Args:
 *   suite: configured suite and the exact collector argv.
 *   pythonFilesDigest: digest over all Python and pytest configuration bytes.
 *   interpreter: collector interpreter identity (null = uncacheable).
 *   environmentDigest: digest over the collector's effective environment.
 *
 * Returns:
 *   string: 64-character lowercase hexadecimal cache key.
 */
export function pytestCacheKey(
  suite: {
    name: string;
    cwd: string;
    argv: readonly string[];
    collectorArgv: readonly string[];
    testPaths: readonly string[];
    timeoutMs: number;
  },
  pythonFilesDigest: string,
  interpreter: InterpreterIdentity,
  environmentDigest: string,
  engineVersion = VERSION,
): string {
  const payload = {
    domain: 'gateforge.pytest-cache.v1',
    engineVersion,
    suite,
    pythonFilesDigest,
    interpreter,
    environmentDigest,
  } as unknown as JsonValue;
  return sha256Hex(canonicalJson(payload));
}

/** Absolute pytest cache entry path for one key. */
export function pytestCachePath(stateDir: string, key: string): string {
  return join(resolve(stateDir), ...PYTEST_CACHE_DIR.split('/'), `${key}.json`);
}

/**
 * Reads a persisted pytest collection document (nodes + summary pieces).
 * Validates the domain envelope; any doubt is a miss.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   key: the computed pytest cache key.
 *
 * Returns:
 *   unknown | null: the stored document, or null on any doubt.
 */
export function readPytestCache(stateDir: string, key: string): unknown | null {
  let raw: string;
  try {
    raw = readFileSync(pytestCachePath(stateDir, key), 'utf8');
  } catch {
    return null;
  }
  let entry: { domain?: unknown; formatVersion?: unknown; key?: unknown; result?: unknown };
  try {
    entry = JSON.parse(raw) as typeof entry;
  } catch {
    return null;
  }
  if (
    entry.domain !== 'gateforge.pytest-cache.v1' ||
    entry.formatVersion !== PLUGIN_CACHE_FORMAT_VERSION ||
    entry.key !== key
  ) {
    return null;
  }
  return entry.result;
}

/**
 * Persists one pytest collection document under its key (atomic rename).
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *   key: the computed pytest cache key.
 *   result: the collection document to store.
 *
 * Returns:
 *   void.
 */
export function writePytestCache(stateDir: string, key: string, result: unknown): void {
  const target = pytestCachePath(stateDir, key);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    canonicalJson({
      domain: 'gateforge.pytest-cache.v1',
      formatVersion: PLUGIN_CACHE_FORMAT_VERSION,
      key,
      result: result as Record<string, never>,
    }),
    'utf8',
  );
  renameSync(tmp, target);
}

/**
 * Digests Python and pytest-config files from Git's tracked and nonignored
 * untracked inventory, excluding run-state directories.
 *
 * Args:
 *   cwd: absolute repository root.
 *   stateDirs: absolute run-state directories to exclude.
 *
 * Returns:
 *   string | null: digest, or null when inventory or an input is unreadable.
 */
export function digestPytestInputs(cwd: string, ...stateDirs: string[]): string | null {
  const root = resolve(cwd);
  const stateRoots = stateDirs.map((directory) => resolve(directory));
  let inventory: string[];
  try {
    const bytes = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    inventory = bytes.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
  const parts: string[] = [];
  for (const name of inventory) {
    const absolute = resolve(root, name);
    if (!absolute.startsWith(`${root}${sep}`)) return null;
    if (stateRoots.some((stateRoot) => absolute === stateRoot || absolute.startsWith(`${stateRoot}${sep}`))) continue;
    const basename = name.slice(name.lastIndexOf('/') + 1);
    if (!basename.endsWith('.py') && PYTEST_CONFIG_BASENAMES[basename] !== true) continue;
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return null;
    const digest = fileDigest(absolute, name);
    if (digest === null) return null;
    parts.push(digest);
  }
  return sha256Hex(parts.sort().join('\n'));
}
