/**
 * Deterministic input snapshot (plan §11.2): the captured candidate
 * inventory plus gate context. Every captured file contributes to the
 * evidence digest. The exact candidate tree id remains a separate
 * receipt binding.
 *
 * The snapshot covers:
 * - all Git-tracked working-tree files (NUL-delimited inventory — never
 *   split on newlines),
 * - nonignored untracked files (new source counts before it is
 *   committed),
 * - configured scan inputs even when Git ignores them,
 * - `.gateforge.yml`, the resolved policy/classification-policy files,
 *   and the known pack configs (planes, HTTP clients, FastAPI roots),
 * - adapter modules and local (repo-relative) in-process plugin modules,
 *   with explicit absence entries for missing optional configuration,
 * - project dependency manifests/lockfiles (via the inventory plus an
 *   explicit well-known-name sweep),
 * - the effective obligations, effective classifications, and the
 *   complete HTTP route context, sorted canonically,
 * - the verification format constant and pinned plugin registrations.
 *
 * File identity is bytes + path + type: a deleted tracked file changes
 * the digest (explicit `deleted` entry). Symlink identity is preserved
 * (link target string plus target bytes); links escaping the repository,
 * unresolvable links, directory links, and submodules cannot be captured
 * and fail closed with {@link UnsupportedSnapshotError} — never a silent
 * omission. Only the actual resolved run-state directory (`--out`) is
 * excluded from the evidence digest; `.git` internals, absolute paths,
 * timestamps, run tokens, and verifier keys never enter it. There is no
 * "ignore source changes" flag.
 *
 * Repositories without usable Git inventory keep discovery working, but
 * evidence authorization fails with a `snapshot-unavailable` diagnostic
 * ({@link SnapshotUnavailableError}); a complete non-Git walker is out
 * of scope.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  compareStrings,
  sha256Canonical,
  type GateforgeConfig,
  type HttpRouteCandidate,
  type Obligation,
} from '@gate-forge/core';
import { UsageError } from './errors.js';
import { expandIncludePaths } from './glob.js';
import {
  isRuntimeReusePath,
  RuntimeReuseBoundaryError,
  type RuntimeReuseMount,
  validateRuntimeReuseMounts,
} from './runtime-reuse.js';

/** Snapshot format version hashed into every digest. */
export const INPUT_SNAPSHOT_VERSION = 3;

/**
 * Verification format bound into the digest: the verdict semantics this
 * digest authorizes evidence for. A future semantics change must mint a
 * new constant — never silently reauthorize old digests.
 */
export const GATEFORGE_VERIFIER_FORMAT = 'gateforge.verdict.v1';

/**
 * Domain tag separating environment-identity digests from every other
 * hash (plan Phase 4 item 3: the execution result binds the run's
 * environment identity — node/platform/arch/engine versions — so a
 * receipt-sealed run names the environment it actually ran in).
 */
export const ENVIRONMENT_IDENTITY_DOMAIN = 'gateforge.environment.v1';

/**
 * Computes the domain-separated environment identity for a run (plan
 * Phase 4 item 3): a canonical hash over the caller-supplied identity
 * parts (engine versions) plus the process platform/arch. Deterministic
 * for identical environments.
 *
 * Args:
 *   parts: named identity parts (e.g. `{node, playwright}` engine
 *     versions); values must be plain strings.
 *
 * Returns:
 *   string: 64-char lowercase hex environment identity.
 */
export function environmentIdentity(parts: Readonly<Record<string, string>>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(parts).sort(compareStrings)) {
    const value = parts[key];
    sorted[key] = value ?? '';
  }
  return sha256Canonical({
    domain: ENVIRONMENT_IDENTITY_DOMAIN,
    parts: sorted,
    platform: process.platform,
    arch: process.arch,
  });
}

/** Known pack configuration files (absence is an explicit entry). */
export const PACK_CONFIGS = ['.gateforge/planes.json', '.gateforge/endpoints.json', '.gateforge/http-clients.json', '.gateforge/fastapi.json'];

/**
 * Well-known dependency manifests/lockfiles: included explicitly when
 * present on disk (they can change detector/verifier behavior even when
 * a scan glob ignores them). Absent names produce no entry.
 *
 * Phase 7 reuses the basenames for changed-scope expansion (a manifest
 * at any depth is gate-defining), so this list is the single source of
 * truth — do not maintain a second manifest list elsewhere.
 */
export const MANIFEST_NAMES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pyproject.toml',
  'poetry.lock',
  'requirements.txt',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
];

/**
 * Git ignore/scope-control basenames: a change to any of these at any
 * depth can change the source inventory itself. The file bytes are
 * covered by the Git inventory above; Phase 7 reuses these basenames
 * for changed-scope expansion, so this list is the single source of
 * truth — do not maintain a second ignore-control list elsewhere.
 */
export const GIT_SCOPE_CONTROL_BASENAMES = ['.gitignore', '.gitattributes'];

/**
 * The input tree cannot be captured completely (submodule, escaping or
 * unresolvable symlink, unreadable required input). Evaluation must fail
 * closed with an explicit unsupported-snapshot block — never a partial
 * digest claimed complete.
 */
export class UnsupportedSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSnapshotError';
  }
}

/**
 * No usable Git inventory exists (non-Git checkout, missing binary).
 * Discovery may still work, but evidence authorization fails closed
 * with a snapshot-unavailable diagnostic.
 */
export class SnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotUnavailableError';
  }
}

/** One snapshotted input file. */
export interface SnapshotFileEntry {
  /** Repo-root-relative posix path (or config-relative label for absence). */
  path: string;
  /** `file` = regular bytes, `symlink` = link+target bytes, `absent` = missing optional config, `deleted` = tracked but gone. */
  type: 'file' | 'symlink' | 'absent' | 'deleted';
  /** Hex digest binding path + type + content (or absence marker). */
  contentDigest: string;
}

/** Canonical gate context hashed alongside the file inventory. */
export interface SnapshotGateContext {
  /** Curated config subset (paths, plugins, scan roots, witness/clock bounds). */
  config: unknown;
  /** Pinned plugin registrations, sorted by id. */
  plugins: Array<{ id: string; version: string }>;
  /** Effective classifications keyed by plane-qualified id, sorted keys. */
  classifications: Record<string, unknown>;
  /** Effective obligations, sorted by id. */
  obligations: Array<{
    id: string;
    resourceId: string;
    contract: string;
    policyId: string;
    lifecycle: unknown;
  }>;
  /** Complete HTTP route inventory, sorted by resourceId. */
  httpRoutes: HttpRouteCandidate[];
  /** Digest of bytes reused from outside the candidate checkout, when any. */
  runtimeReuseDigest?: string;
}

/** The complete snapshot: inventory + context + digest. */
export interface InputSnapshot {
  snapshotVersion: 3;
  files: SnapshotFileEntry[];
  gateContext: SnapshotGateContext;
  verifierFormat: string;
  /** 64-char lowercase digest over evidence-relevant files and gate context. */
  evidenceInputDigest: string;
  /** Compatibility name used by receipt and execution-result envelopes. */
  inputDigest: string;
}

/** Inputs for snapshot computation. */
export interface ComputeSnapshotInput {
  /** Absolute repo root. */
  cwd: string;
  /** Validated `.gateforge.yml`. */
  config: GateforgeConfig;
  /** Absolute run-state directory (the ONLY excluded tree). */
  stateDir: string;
  /** Effective classifications keyed by resource id (post-discovery). */
  classifications?: Record<string, unknown>;
  /** Generated obligations (post-discovery). */
  obligations?: readonly Obligation[];
  /** Complete HTTP route inventory (post-discovery). */
  httpRoutes?: readonly HttpRouteCandidate[];
  /** Pinned plugin registrations (post-discovery). */
  plugins?: Array<{ id: string; version: string }>;
  /** Deterministic digest of staged-runtime reuse bytes, when configured. */
  runtimeReuseDigest?: string | null;
  /** Exact owner-approved external dependency mounts in a staged checkout. */
  runtimeReuseMounts?: readonly RuntimeReuseMount[];
  /** Owner-declared documentation folders approved by the external policy pin. */
  docsExclusions?: readonly string[];
  /** Exact owner-approved Python bytecode files approved by the external policy pin. */
  cacheExclusions?: readonly string[];
}

/**
 * Runs one git command with NUL-delimited output.
 *
 * Args:
 *   cwd: repo root.
 *   args: git argument vector.
 *
 * Returns:
 *   string: raw stdout.
 *
 * Throws:
 *   SnapshotUnavailableError: git is missing or the directory is not a
 *   usable repository.
 */
function gitNul(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new SnapshotUnavailableError(
      `input snapshot requires usable Git inventory (git ${args.join(' ')} failed); ` +
        'evidence authorization is unavailable (snapshot-unavailable)',
    );
  }
  return result.stdout ?? '';
}

/**
 * Splits NUL-delimited git output into entries (never on newlines — a
 * filename may legally contain `\n`).
 *
 * Args:
 *   raw: git stdout with `\0` separators.
 *
 * Returns:
 *   string[]: entry list, trailing empty element dropped.
 */
function splitNul(raw: string): string[] {
  if (raw.length === 0) return [];
  const parts = raw.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.filter((part) => part.length > 0);
}

/**
 * Normalizes a repo-relative path to posix form.
 *
 * Args:
 *   path: candidate relative path.
 *
 * Returns:
 *   string: posix-normalized path.
 */
function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/**
 * Hashes one file's identity: bytes + path + type.
 *
 * Args:
 *   kind: entry type marker.
 *   path: repo-relative posix path.
 *   content: raw content bytes (file bytes, or link-target + target bytes).
 *
 * Returns:
 *   string: 64-char lowercase hex digest.
 */
function hashEntry(kind: string, path: string, content: Buffer | string): string {
  const hash = createHash('sha256');
  hash.update(kind, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(path, 'utf8');
  hash.update('\0', 'utf8');
  hash.update(typeof content === 'string' ? content : content);
  return hash.digest('hex');
}

/**
 * Reads one inventoried path's snapshot entry.
 *
 * Args:
 *   cwd: absolute repo root.
 *   path: repo-relative posix path.
 *
 * Returns:
 *   SnapshotFileEntry: the file, symlink, or deleted entry.
 *
 * Throws:
 *   UnsupportedSnapshotError: escaping/unresolvable/directory symlink,
 *   or a non-ENOENT filesystem failure (fail closed — required inputs
 *   must not silently vanish).
 */
function entryForPath(cwd: string, path: string): SnapshotFileEntry {
  const absolute = join(cwd, ...path.split('/'));
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Tracked but deleted from the working tree: an explicit entry so
      // the deletion changes the digest (never silently dropped).
      return { path, type: 'deleted', contentDigest: hashEntry('deleted', path, '') };
    }
    throw new UnsupportedSnapshotError(
      `input snapshot cannot inspect '${path}' (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'}); ` +
        'explicit unsupported-snapshot block',
    );
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = readlinkSync(absolute);
    } catch (error) {
      throw new UnsupportedSnapshotError(
        `input snapshot cannot read symlink '${path}' (${(error as Error).message}); ` +
          'explicit unsupported-snapshot block',
      );
    }
    const resolved = resolve(dirname(absolute), target);
    const root = resolve(cwd);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new UnsupportedSnapshotError(
        `input snapshot rejects symlink '${path}' escaping the repository; ` +
          'explicit unsupported-snapshot block',
      );
    }
    let targetStat: ReturnType<typeof lstatSync>;
    try {
      targetStat = lstatSync(resolved);
    } catch {
      throw new UnsupportedSnapshotError(
        `input snapshot rejects unresolvable symlink '${path}' -> '${target}'; ` +
          'explicit unsupported-snapshot block',
      );
    }
    if (!targetStat.isFile()) {
      throw new UnsupportedSnapshotError(
        `input snapshot rejects non-file symlink '${path}' -> '${target}'; ` +
          'explicit unsupported-snapshot block',
      );
    }
    let targetBytes: Buffer;
    try {
      targetBytes = readFileSync(resolved);
    } catch (error) {
      throw new UnsupportedSnapshotError(
        `input snapshot cannot read symlink target of '${path}' (${(error as Error).message}); ` +
          'explicit unsupported-snapshot block',
      );
    }
    // Identity = link location + link target string + target bytes: a
    // retargeted link and a changed target both move the digest.
    const combined = Buffer.concat([Buffer.from(`link:${target}\0`, 'utf8'), targetBytes]);
    return { path, type: 'symlink', contentDigest: hashEntry('symlink', path, combined) };
  }
  if (stat.isFile()) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch (error) {
      throw new UnsupportedSnapshotError(
        `input snapshot cannot read '${path}' (${(error as Error).message}); ` +
          'explicit unsupported-snapshot block',
      );
    }
    const mode = (stat.mode & 0o111) !== 0 ? 'executable\0' : 'regular\0';
    return {
      path,
      type: 'file',
      contentDigest: hashEntry('file', path, Buffer.concat([Buffer.from(mode, 'utf8'), bytes])),
    };
  }
  throw new UnsupportedSnapshotError(
    `input snapshot rejects non-file input '${path}'; explicit unsupported-snapshot block`,
  );
}

/**
 * Normalizes a repo-local in-process plugin module specifier to a
 * repo-relative posix path.
 *
 * Args:
 *   module: the configured module specifier (e.g. `./plugin.mjs`).
 *
 * Returns:
 *   string | null: the normalized in-repo path, or null when the
 *   specifier is not repo-local (`./`/`../` prefix absent) or escapes
 *   the repository root via `..`.
 */
export function normalizeRepoModule(module: string): string | null {
  if (!module.startsWith('./') && !module.startsWith('../')) return null;
  const normalized = toPosix(module.replace(/^\.\//, ''));
  // `../` escapes are normalized away only when they stay inside the
  // root; anything escaping is an external input that cannot be
  // captured — the plugin load itself will fail closed, but the
  // snapshot must not claim completeness over it.
  const segments = normalized.split('/');
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      if (kept.length === 0) return null;
      kept.pop();
    } else if (segment !== '.' && segment.length > 0) {
      kept.push(segment);
    }
  }
  return kept.join('/');
}

/**
 * Collects the DECLARED source/configuration inputs: configured scan
 * inputs (even gitignored) + explicit config/adapter/waiver/plugin/
 * manifest inputs. Only this set can trigger an unsafe `--out` overlap:
 * generated run-state files (untracked claims/records/manifests under
 * the state dir) are incidental inventory, never declared inputs.
 *
 * Args:
 *   cwd: absolute repo root.
 *   config: validated `.gateforge.yml`.
 *
 * Returns:
 *   string[]: deduplicated, codepoint-sorted posix paths plus explicit
 *   absence markers (`absent:<path>`).
 */
export function collectDeclaredInputs(cwd: string, config: GateforgeConfig): string[] {
  const paths = new Set<string>();

  // Configured scan inputs even when Git ignores them (the expansion
  // walks the tree directly and never consults .gitignore).
  for (const expanded of expandIncludePaths(
    config.project.paths.include,
    config.project.paths.exclude,
    cwd,
  )) {
    paths.add(toPosix(expanded));
  }

  // Explicit configuration inputs: .gateforge.yml itself, resolved
  // policy/classification files, the staged-runtime document, and known
  // pack configs.
  const explicitFiles = [
    '.gateforge.yml',
    toPosix(config.policies),
    toPosix(config.classificationPolicy),
    ...(config.behaviorPolicy === undefined ? [] : [toPosix(config.behaviorPolicy)]),
    ...(config.runtime === undefined ? [] : [toPosix(config.runtime)]),
    ...PACK_CONFIGS,
    ...(config.alembic === undefined
      ? []
      : [
          ...config.alembic.chains.flatMap((chain) => [
            chain.migrations,
            chain.alembicIni ?? 'alembic.ini',
            ...chain.models,
          ]),
          ...(config.alembic.seed === undefined ? [] : [config.alembic.seed.path]),
        ]),
  ];
  if (existsSync(join(cwd, '.gateforge/docs-exclusions.yml'))) {
    explicitFiles.push('.gateforge/docs-exclusions.yml');
  }
  if (existsSync(join(cwd, '.gateforge/cache-exclusions.yml'))) {
    explicitFiles.push('.gateforge/cache-exclusions.yml');
  }
  for (const candidate of explicitFiles) {
    if (candidate.length > 0) paths.add(candidate);
  }

  // Adapter modules (top-level .mjs, as the pipeline loads them) plus
  // every file under the waivers directory (gate decisions read them).
  // Missing optional directories are explicit absence markers, never
  // silent gaps.
  const adaptersDir = toPosix(config.adapters);
  try {
    const entries = readdirSync(join(cwd, ...adaptersDir.split('/')));
    let seen = false;
    for (const entry of entries) {
      if (entry.endsWith('.mjs')) {
        paths.add(`${adaptersDir}/${entry}`);
        seen = true;
      }
    }
    if (!seen) paths.add(`absent:${adaptersDir}/(no .mjs adapters)`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      paths.add(`absent:${adaptersDir}/(missing adapters dir)`);
    } else {
      throw new UnsupportedSnapshotError(
        `input snapshot cannot read adapters dir '${adaptersDir}' (${(error as Error).message}); ` +
          'explicit unsupported-snapshot block',
      );
    }
  }
  const waiversDir = toPosix(config.waivers);
  try {
    const walk = (dir: string, prefix: string): void => {
      const entries = readdirSync(join(cwd, dir), { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isFile()) {
          paths.add(rel);
          count += 1;
        } else if (entry.isDirectory()) {
          walk(`${dir}/${entry.name}`, rel);
          count += 1;
        }
      }
      if (count === 0) paths.add(`absent:${prefix}/(empty)`);
    };
    walk(waiversDir, waiversDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      paths.add(`absent:${waiversDir}/(missing waivers dir)`);
    } else {
      throw new UnsupportedSnapshotError(
        `input snapshot cannot read waivers dir '${waiversDir}' (${(error as Error).message}); ` +
          'explicit unsupported-snapshot block',
      );
    }
  }

  // Local in-process plugin modules (repo-relative specifiers only):
  // implementation inputs the pipeline imports.
  for (const plugin of config.plugins) {
    const module = plugin.module;
    if (typeof module !== 'string') continue;
    if (!module.startsWith('./') && !module.startsWith('../')) continue;
    const normalized = normalizeRepoModule(module);
    if (normalized === null) {
      throw new UnsupportedSnapshotError(
        `input snapshot cannot capture plugin module '${module}' outside the repository; ` +
          'explicit unsupported-snapshot block',
      );
    }
    paths.add(normalized);
  }

  // Dependency manifests/lockfiles present on disk (they can change
  // detector/verifier behavior even when no scan glob covers them).
  for (const name of MANIFEST_NAMES) {
    try {
      const stat = lstatSync(join(cwd, name));
      if (stat.isFile() || stat.isSymbolicLink()) paths.add(name);
    } catch {
      // Absent: no entry (ecosystem-dependent absence stays out of the
      // digest; tracked manifests are already inventoried below).
    }
  }

  return [...paths].sort(compareStrings);
}

/**
 * Collects the incidental Git inventory: tracked working-tree files plus
 * nonignored untracked files (both NUL-delimited). Generated run-state
 * files living under the state directory are part of this set and are
 * excluded silently — they are outputs, not declared inputs, so they
 * never trigger the overlap check.
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   inventory: deduplicated, codepoint-sorted posix paths; tracked: the
 *   index-tracked subset (classifies ENOENT as `deleted` vs `absent`).
 *
 * Throws:
 *   SnapshotUnavailableError: no usable Git inventory.
 *   UnsupportedSnapshotError: uncapturable submodule input.
 */
function collectGitInventory(cwd: string): { inventory: string[]; tracked: Set<string> } {
  const paths = new Set<string>();
  const tracked = new Set<string>();
  // Tracked working-tree files, with submodule detection via --stage
  // (mode 160000 = gitlink: implementation bytes live outside this
  // checkout and cannot be captured).
  const staged = splitNul(gitNul(cwd, ['ls-files', '--stage', '-z']));
  for (const line of staged) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab);
    const name = line.slice(tab + 1);
    const mode = meta.split(' ')[0] ?? '';
    if (mode === '160000') {
      throw new UnsupportedSnapshotError(
        `input snapshot cannot capture submodule '${name}'; explicit unsupported-snapshot block`,
      );
    }
    if (name.length > 0) {
      paths.add(toPosix(name));
      tracked.add(toPosix(name));
    }
  }
  // Nonignored untracked files: new source counts before it is committed.
  for (const name of splitNul(gitNul(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))) {
    paths.add(toPosix(name));
  }
  return { inventory: [...paths].sort(compareStrings), tracked };
}

/**
 * Builds snapshot file entries for inventory paths, excluding only the
 * actual resolved run-state directory.
 *
 * Args:
 *   cwd: absolute repo root.
 *   inventory: deduplicated sorted inventory paths (absence markers
 *     included).
 *   tracked: the index-tracked subset — an ENOENT hit on a tracked path
 *     is an explicit `deleted` entry (the deletion moves the digest),
 *     while a never-present optional config is `absent`.
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   SnapshotFileEntry[]: sorted entries; absence markers become
 *   `absent` entries with a fixed digest.
 */
function buildFileEntries(
  cwd: string,
  inventory: readonly string[],
  tracked: ReadonlySet<string>,
  stateDir: string,
): SnapshotFileEntry[] {
  const prefix = toPosix(relative(cwd, stateDir));
  const underState = (path: string): boolean =>
    prefix !== '' && (path === prefix || path.startsWith(`${prefix}/`));
  const entries: SnapshotFileEntry[] = [];
  for (const item of inventory) {
    if (item.startsWith('absent:')) {
      const label = item.slice('absent:'.length);
      entries.push({ path: label, type: 'absent', contentDigest: hashEntry('absent', label, '') });
      continue;
    }
    if (underState(item)) continue;
    const entry = entryForPath(cwd, item);
    // A missing path that was never tracked is a missing OPTIONAL
    // config, not a deletion: label it `absent` so deleted-tracked
    // files stay distinguishable from never-present optionals.
    if (entry.type === 'deleted' && !tracked.has(item)) {
      entries.push({ path: item, type: 'absent', contentDigest: hashEntry('absent', item, '') });
      continue;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => compareStrings(a.path, b.path));
  return entries;
}

/**
 * Rejects an unsafe output/source overlap: any declared input that would
 * hide under the run-state directory (and thus be excluded from the
 * digest) is a hole, not an exclusion. Also rejects the state directory
 * aliasing the repo root itself (including through a symlink).
 *
 * Args:
 *   cwd: absolute repo root.
 *   stateDir: absolute run-state directory.
 *   declaredInputs: repo-relative posix paths the snapshot hashes
 *     (pre-exclusion inventory, absence markers excluded).
 *
 * Throws:
 *   UsageError: overlap detected — the run must pick a disjoint `--out`.
 */
export function assertOutputDisjoint(
  cwd: string,
  stateDir: string,
  declaredInputs: readonly string[],
): void {
  const root = resolve(cwd);
  const out = resolve(stateDir);
  let realRoot: string = root;
  let realOut: string = out;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  try {
    realOut = realpathSync(out);
  } catch {
    // The state dir may not exist yet: resolve the nearest existing
    // parent so symlink aliases of source directories still compare.
    let cursor = out;
    while (cursor !== dirname(cursor)) {
      try {
        realOut = join(realpathSync(dirname(cursor)), cursor.slice(dirname(cursor).length + 1));
        break;
      } catch {
        cursor = dirname(cursor);
      }
    }
  }
  if (realOut === realRoot) {
    throw new UsageError(
      `refusing to run: --out '${stateDir}' overlaps the repository root; ` +
        'generated run state must live in a disjoint directory (e.g. .gateforge/test-gates)',
    );
  }
  // Committed source hiding under --out is an unsafe overlap even when
  // no scan glob covers it: unlike generated untracked state files, a
  // tracked file is deliberate source that must never be excluded from
  // the digest. (Unborn HEAD or non-Git: no committed set to check.)
  // The prefix compares through RESOLVED paths, so an --out that is a
  // symlink alias of a source directory hides exactly like the
  // directory itself.
  const prefix = toPosix(relative(realRoot, realOut));
  if (prefix !== '' && !prefix.startsWith('..')) {
    const tree = spawnSync('git', ['ls-tree', '-r', 'HEAD', '--name-only', '-z'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (tree.error === undefined && tree.status === 0) {
      const committed = splitNul(tree.stdout ?? '')
        .map(toPosix)
        .filter((item) => item === prefix || item.startsWith(`${prefix}/`))
        .sort(compareStrings);
      if (committed.length > 0) {
        throw new UsageError(
          `refusing to run: --out '${stateDir}' overlaps committed source inputs ` +
            `(${committed.slice(0, 5).join(', ')}${committed.length > 5 ? ', …' : ''}); ` +
            'generated run state must not hide tested inputs from the digest',
        );
      }
    }
  }
  if (prefix === '' || prefix.startsWith('..')) return;
  const hidden = declaredInputs
    .filter((item) => !item.startsWith('absent:'))
    .filter((item) => item === prefix || item.startsWith(`${prefix}/`))
    .sort(compareStrings);
  if (hidden.length > 0) {
    throw new UsageError(
      `refusing to run: --out '${stateDir}' overlaps declared source/configuration inputs ` +
        `(${hidden.slice(0, 5).join(', ')}${hidden.length > 5 ? ', …' : ''}); ` +
        'generated run state must not hide tested inputs from the digest',
    );
  }
}

/**
 * Builds the canonical gate context hashed into the digest.
 *
 * Args:
 *   config: validated `.gateforge.yml`.
 *   plugins: pinned plugin registrations (defaults to the config order).
 *   classifications: effective classifications by resource id.
 *   obligations: generated obligations.
 *   httpRoutes: complete HTTP route inventory.
 *
 * Returns:
 *   SnapshotGateContext: canonical, deterministically sorted context.
 */
export function buildGateContext(
  config: GateforgeConfig,
  plugins: Array<{ id: string; version: string }> = config.plugins.map((plugin) => ({
    id: plugin.id,
    version: plugin.version,
  })),
  classifications: Record<string, unknown> = {},
  obligations: readonly Obligation[] = [],
  httpRoutes: readonly HttpRouteCandidate[] = [],
  runtimeReuseDigest?: string | null,
): SnapshotGateContext {
  const sortedClassifications: Record<string, unknown> = {};
  for (const key of Object.keys(classifications).sort(compareStrings)) {
    sortedClassifications[key] = classifications[key];
  }
  return {
    config: {
      policies: config.policies,
      classificationPolicy: config.classificationPolicy,
      adapters: config.adapters,
      waivers: config.waivers,
      baselines: config.baselines,
      project: config.project,
      plugins: config.plugins,
      changed: config.changed,
      witness: config.witness,
      clock: config.clock,
    },
    plugins: [...plugins].sort((a, b) => compareStrings(a.id, b.id)),
    classifications: sortedClassifications,
    obligations: [...obligations]
      .map((obligation) => ({
        id: obligation.id,
        resourceId: obligation.resourceId,
        contract: obligation.contract,
        policyId: obligation.policyId,
        lifecycle: obligation.lifecycle,
        ...(obligation.requirementsDigest === undefined
          ? {}
          : { requirementsDigest: obligation.requirementsDigest }),
      }))
      .sort((a, b) => compareStrings(a.id, b.id)),
    httpRoutes: [...httpRoutes].sort((a, b) => compareStrings(a.resourceId, b.resourceId)),
    ...(runtimeReuseDigest === undefined || runtimeReuseDigest === null ? {} : { runtimeReuseDigest }),
  };
}

/**
 * Hashes the canonical snapshot body (never the random manifest UUID:
 * identical inputs in two invocations produce identical digests).
 *
 * Args:
 *   files: sorted snapshot file entries.
 *   gateContext: canonical gate context.
 *
 * Returns:
 *   string: 64-char lowercase hex evidence-input digest.
 */
export function digestSnapshot(files: readonly SnapshotFileEntry[], gateContext: SnapshotGateContext): string {
  return sha256Canonical({
    snapshotVersion: INPUT_SNAPSHOT_VERSION,
    files: files.map((entry) => ({
      path: entry.path,
      type: entry.type,
      contentDigest: entry.contentDigest,
    })),
    gateContext: gateContext as unknown as Record<string, never>,
    verifierFormat: GATEFORGE_VERIFIER_FORMAT,
  });
}

/**
 * Computes the full input snapshot: inventory, overlap rejection,
 * entries, canonical context, and digest.
 *
 * Args:
 *   input: repository root, config, run state, optional post-discovery
 *   classification context, and approved documentation/cache exclusions.
 *
 * Returns:
 *   InputSnapshot: full inventory, gate context, verifier format, and
 *   evidenceInputDigest (also exposed as the legacy inputDigest name).
 *
 * Throws:
 *   SnapshotUnavailableError: no usable Git inventory.
 *   UnsupportedSnapshotError: uncapturable input (submodule, escaping
 *   symlink, unreadable required file).
 *   UsageError: unsafe output overlap (exit 2).
 */
export function computeInputSnapshot(input: ComputeSnapshotInput): InputSnapshot {
  const files = collectInputFiles(
    input.cwd,
    input.config,
    input.stateDir,
    input.runtimeReuseMounts,
    input.docsExclusions,
    input.cacheExclusions,
  );
  const gateContext = buildGateContext(
    input.config,
    input.plugins,
    input.classifications ?? {},
    input.obligations ?? [],
    input.httpRoutes ?? [],
    input.runtimeReuseDigest,
  );
  const evidenceInputDigest = digestSnapshot(files, gateContext);
  return {
    snapshotVersion: INPUT_SNAPSHOT_VERSION,
    files,
    gateContext,
    verifierFormat: GATEFORGE_VERIFIER_FORMAT,
    evidenceInputDigest,
    inputDigest: evidenceInputDigest,
  };
}

/**
 * Collects only the file entries (pre-discovery inventory): the
 * discovery-stability check compares these before and after the pipeline
 * runs — the gate context does not exist yet before discovery.
 *
 * Args:
 *   cwd: absolute repo root.
 *   config: validated `.gateforge.yml`.
 *   stateDir: absolute run-state directory.
 *   runtimeReuseMounts: externally prepared dependencies bound by digest.
 *   docsExclusions: owner-approved documentation folders to omit.
 *   cacheExclusions: exact owner-approved Python bytecode files to omit.
 *
 * Returns:
 *   SnapshotFileEntry[]: sorted file entries (overlap-checked).
 *
 * Throws:
 *   UsageError: an exclusion overlaps run state or a configured input.
 *   SnapshotUnavailableError: no usable Git inventory.
 *   UnsupportedSnapshotError: a required file cannot be captured.
 */
export function collectInputFiles(
  cwd: string,
  config: GateforgeConfig,
  stateDir: string,
  runtimeReuseMounts: readonly RuntimeReuseMount[] = [],
  docsExclusions: readonly string[] = [],
  cacheExclusions: readonly string[] = [],
): SnapshotFileEntry[] {
  const declared = collectDeclaredInputs(cwd, config);
  assertOutputDisjoint(cwd, stateDir, declared);
  const statePrefix = toPosix(relative(resolve(cwd), resolve(stateDir)));
  for (const folder of docsExclusions) {
    const segments = folder.split('/');
    if (
      folder.length === 0 || folder.startsWith('/') || folder.includes('\\') ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
      throw new UsageError(`invalid approved documentation exclusion '${folder}' (fail closed)`);
    }
    if (
      statePrefix !== '' &&
      (statePrefix === folder || statePrefix.startsWith(`${folder}/`) || folder.startsWith(`${statePrefix}/`))
    ) {
      throw new UsageError(`documentation exclusion '${folder}' overlaps the run-state directory (fail closed)`);
    }
    if (declared.some((path) => !path.startsWith('absent:') && (path === folder || path.startsWith(`${folder}/`)))) {
      throw new UsageError(`documentation exclusion '${folder}' overlaps a configured scan or gate input (fail closed)`);
    }
  }
  for (const file of cacheExclusions) {
    const segments = file.split('/');
    const cacheIndex = segments.lastIndexOf('__pycache__');
    if (
      file.length === 0 || file.startsWith('/') || file.includes('\\') ||
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
      cacheIndex !== segments.length - 2 || !/\.(?:pyc|pyo)$/.test(segments.at(-1) ?? '')
    ) {
      throw new UsageError(`invalid approved Python bytecode exclusion '${file}' (fail closed)`);
    }
    if (
      statePrefix !== '' &&
      (statePrefix === file || statePrefix.startsWith(`${file}/`) || file.startsWith(`${statePrefix}/`))
    ) {
      throw new UsageError(`Python bytecode exclusion '${file}' overlaps the run-state directory (fail closed)`);
    }
    if (declared.some((path) => !path.startsWith('absent:') && path === file)) {
      throw new UsageError(`Python bytecode exclusion '${file}' overlaps a configured scan or gate input (fail closed)`);
    }
  }
  try {
    validateRuntimeReuseMounts(cwd, runtimeReuseMounts);
  } catch (error) {
    if (error instanceof RuntimeReuseBoundaryError) {
      throw new UnsupportedSnapshotError(`${error.message}; explicit unsupported-snapshot block`);
    }
    throw error;
  }
  const git = collectGitInventory(cwd);
  const inventory = [...new Set([...declared, ...git.inventory])]
    .filter((path) => !isRuntimeReusePath(path.replace(/^absent:/, ''), runtimeReuseMounts))
    .filter((path) => path.startsWith('absent:') || !docsExclusions.some((folder) => path === folder || path.startsWith(`${folder}/`)))
    .filter((path) => path.startsWith('absent:') || !cacheExclusions.includes(path))
    .sort(compareStrings);
  return buildFileEntries(cwd, inventory, git.tracked, stateDir);
}

/**
 * Compares two file inventories for the discovery-stability check.
 *
 * Args:
 *   before: pre-discovery entries.
 *   after: post-discovery entries.
 *
 * Returns:
 *   string[]: human-readable differences (empty when stable).
 */
export function diffInputFiles(before: readonly SnapshotFileEntry[], after: readonly SnapshotFileEntry[]): string[] {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const differences: string[] = [];
  for (const [path, entry] of beforeByPath) {
    const next = afterByPath.get(path);
    if (next === undefined) {
      differences.push(`removed during discovery: ${path}`);
    } else if (next.contentDigest !== entry.contentDigest || next.type !== entry.type) {
      differences.push(`changed during discovery: ${path}`);
    }
  }
  for (const [path] of afterByPath) {
    if (!beforeByPath.has(path)) differences.push(`added during discovery: ${path}`);
  }
  return differences.sort(compareStrings);
}
