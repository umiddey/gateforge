/**
 * The trusted CLI's half of the GLOBAL native preparation freeze.
 *
 * The pack (`@gate-forge/pack-playwright`) owns the barrier's runner-side
 * shape — the controller project, the request/release documents, the
 * per-invocation Ed25519 signature and the environment projection. This
 * module owns the AUTHORITY half, and every one of its decisions is made
 * here, in the one process that holds the witness credentials, the frozen
 * baseline and the input snapshot:
 *
 * 1. {@link planNativeFreeze} classifies the PLANNED captured graph into
 *    the full upstream prerequisite closure and the bodies, and refuses an
 *    unavailable or ambiguous graph BEFORE anything is spawned — a
 *    half-known graph would order the run wrongly while looking complete.
 * 2. {@link classifyGeneratedTargets} decides which paths native
 *    preparation may legitimately create or modify. A declared
 *    `use.storageState` is a READ declaration first: it only becomes a
 *    generated-output target when it is also untracked and outside the
 *    input inventory. A tracked or input-bound state stays a perfectly
 *    valid read declaration and stays IMMUTABLE — changing it is refused
 *    at the freeze, by name, exactly like any other unsafe write.
 * 3. {@link preparedCandidateViolations} runs the raw symmetric diff
 *    baseline → prepared and admits nothing but admissible target
 *    additions and modifications. Removals, non-target writes, tracked
 *    writes, input writes and excluded writes all fail, naming the path.
 * 4. {@link unfrozenPrerequisiteState} proves, from the AUTHENTICATED
 *    witness execution trace, that every prerequisite identity really
 *    passed under supervision — exactly one sealed session, no retry, no
 *    duplicate, no confused identity — and separates what is still
 *    PENDING from what is TERMINAL, so a permanent refusal fails at once
 *    instead of waiting out the barrier's bound.
 *
 * None of this weakens a binding: the input digest, the trusted policy,
 * the catalog and the witness context stay the ones the run pinned, and
 * the prepared candidate identity never leaves this process.
 */
import type { TracedTestInput } from '@gate-forge/core';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { CandidateTreeEntry } from './candidate-tree.js';
import {
  FREEZE_CONTROLLER_PROJECT,
  resolveProjectStorageState,
  type FreezeRequest,
  type ProjectScope,
} from '@gate-forge/pack-playwright';

/** The prepared candidate identity — CLI memory, never a state document. */
export interface PreparedCandidateIdentity {
  /** The immutable tree the prepared candidate froze at. */
  preparedTreeId: string;
  /** The run identity this freeze belongs to. */
  runId: string;
  /** The invocation identity this freeze belongs to. */
  invocationId: string;
  /** The per-invocation nonce a replayed release can never match. */
  nonce: string;
  /** ISO timestamp of the freeze (diagnostic, inside the signature). */
  sealedAt: string;
}

/** How the planned captured graph splits into prerequisites and bodies. */
export interface NativeFreezePlan {
  /** The engine-owned controller project name. */
  controllerProject: string;
  /**
   * The FULL upstream closure of the planned captured graph — every
   * project a planned project transitively depends on, never just the
   * roots. These keep their captured edges exactly as they were.
   */
  prerequisiteProjects: string[];
  bodyProjects: string[];
}

/**
 * Splits the planned project scopes into prerequisites and bodies, or
 * explains why the captured graph cannot be trusted to order this run.
 *
 * The closure is walked from every PLANNED project (not from the
 * dependency roots the plan happens to reach): a body project with no
 * edges of its own still has to be frozen, which is why the barrier also
 * arms for an independent, empty-edge project.
 *
 * @param projectScopes: the planned per-project file selection.
 * @param projectDependencies: the graph the RUNNER resolved, or undefined
 *   when the enumeration could not read it.
 *
 * @returns
 *   `{plan}` | `{problem}`: the split, or one plain refusal.
 */
export function planNativeFreeze(input: {
  projectScopes: readonly ProjectScope[];
  projectDependencies: Record<string, string[]> | undefined;
}): { plan: NativeFreezePlan } | { problem: string } {
  const { projectScopes, projectDependencies } = input;
  if (projectScopes.length === 0) {
    return { problem: 'this run planned no project scope, so there is nothing to freeze before' };
  }
  if (projectDependencies === undefined) {
    return {
      problem:
        'the runner\'s resolved project graph could not be read, so the prerequisite stage cannot be ' +
        'ordered against the bodies — a global freeze is only honest on a known graph',
    };
  }
  const planned: string[] = [];
  for (const scope of projectScopes) {
    if (planned.includes(scope.name)) {
      return { problem: `project '${scope.name}' was planned twice, so its execution order is ambiguous` };
    }
    if (scope.name === FREEZE_CONTROLLER_PROJECT) {
      return {
        problem: `a project is named '${FREEZE_CONTROLLER_PROJECT}', which the engine reserves for its own ` +
          'preparation-freeze controller',
      };
    }
    if (!Object.prototype.hasOwnProperty.call(projectDependencies, scope.name)) {
      return {
        problem:
          `project '${scope.name}' was planned but the runner's own resolved graph never recorded it — the ` +
          'captured graph and the captured tests disagree, so no ordering may be derived from either',
      };
    }
    planned.push(scope.name);
  }
  const prerequisites = new Set<string>();
  const queue = [...planned];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependency of projectDependencies[current] ?? []) {
      if (prerequisites.has(dependency)) continue;
      prerequisites.add(dependency);
      queue.push(dependency);
    }
  }
  return {
    plan: {
      controllerProject: FREEZE_CONTROLLER_PROJECT,
      prerequisiteProjects: [...prerequisites].sort(),
      bodyProjects: planned.filter((name) => !prerequisites.has(name)),
    },
  };
}

/** Which paths native preparation may write, and why the others may not. */
export interface GeneratedTargetClass {
  /** Repo-relative posix paths preparation may add or modify. */
  eligible: ReadonlySet<string>;
  /** Repo-relative posix path → the plain reason it stays immutable. */
  refused: ReadonlyMap<string, string>;
}

/**
 * Decides, per captured `use.storageState` declaration, whether native
 * preparation may CREATE or MODIFY that path.
 *
 * The declaration itself is only a READ path — it says where a project
 * reads browser state, not which bytes preparation owns. A declaration
 * therefore becomes a generated-output target only when all of these hold:
 *
 * - it resolves inside the candidate root (already enforced physically by
 *   {@link resolveProjectStorageState}, repeated here so the classification
 *   can never disagree with the containment rule);
 * - it is NOT tracked by git — a tracked file is source, and no setup may
 *   redefine it as "generated";
 * - it is NOT part of the input inventory — a file the run's digest binds
 *   is authority, not output;
 * - it is not an owner-approved excluded documentation or cache path.
 *
 * Everything else stays a valid, immutable read declaration. This is what
 * keeps a repository that ships a committed fixture session working: its
 * state is read, unchanged, and any actual write to it is refused by name
 * at the global diff.
 *
 * @param root: the absolute candidate root (containment boundary).
 * @param nativeConfigDir: the directory relative declarations resolve from.
 * @param storageStates: project → declared `use.storageState`, as captured.
 * @param tracked: repo-relative paths git tracks.
 * @param inputFiles: repo-relative paths the run's input snapshot binds.
 * @param docsExclusions: approved documentation folders.
 * @param cacheExclusions: approved bytecode files.
 *
 * @returns
 *   GeneratedTargetClass: the writable set and the named refusals.
 */
export function classifyGeneratedTargets(input: {
  root: string;
  nativeConfigDir: string;
  storageStates: Readonly<Record<string, string>>;
  tracked: ReadonlySet<string>;
  inputFiles: ReadonlySet<string>;
  docsExclusions: readonly string[];
  cacheExclusions: readonly string[];
}): GeneratedTargetClass {
  const eligible = new Set<string>();
  const refused = new Map<string, string>();
  const root = resolve(input.root);
  const excluded = (relativePath: string): boolean =>
    input.docsExclusions.some((folder) => relativePath === folder || relativePath.startsWith(`${folder}/`)) ||
    input.cacheExclusions.includes(relativePath);
  for (const [project, declared] of Object.entries(input.storageStates)) {
    let absolute: string;
    try {
      absolute = resolveProjectStorageState(declared, root, project, input.nativeConfigDir);
    } catch (error) {
      refused.set(declared, (error as Error).message);
      continue;
    }
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (relativePath.length === 0 || relativePath.startsWith('..')) {
      refused.set(relativePath, 'the declared state resolves outside the candidate root');
      continue;
    }
    if (excluded(relativePath)) {
      refused.set(relativePath, 'it is an owner-approved excluded path, which no run may write');
      continue;
    }
    if (input.tracked.has(relativePath)) {
      refused.set(
        relativePath,
        'it is tracked by git, so it is source: a declared storage state is a READ path and never a ' +
          'write permission over tracked bytes',
      );
      continue;
    }
    if (input.inputFiles.has(relativePath)) {
      refused.set(
        relativePath,
        'it is bound by this run\'s input snapshot, so preparation may not redefine what the run tested',
      );
      continue;
    }
    eligible.add(relativePath);
  }
  return { eligible, refused };
}

/**
 * The RAW symmetric difference between the frozen baseline candidate tree
 * and the prepared one, reduced to the writes that must fail.
 *
 * An entry that exists in both trees with the same blob and mode is not a
 * change at all. Anything else must be an admissible generated target
 * ADDITION or MODIFICATION; a REMOVAL always fails, eligible target or
 * not — deleting the artifact a body needs is never preparation.
 *
 * @param baseline: the frozen pre-run candidate tree entries.
 * @param prepared: the candidate tree entries at the freeze.
 * @param targets: the writable classification (see
 *   {@link classifyGeneratedTargets}).
 *
 * @returns
 *   string[]: one refusal per offending path, naming the path, sorted.
 */
export function preparedCandidateViolations(input: {
  /** Absolute candidate root: the physical containment boundary. */
  root: string;
  baseline: readonly CandidateTreeEntry[];
  prepared: readonly CandidateTreeEntry[];
  targets: GeneratedTargetClass;
}): string[] {
  const before = new Map(input.baseline.map((entry) => [entry.path, entry]));
  const after = new Map(input.prepared.map((entry) => [entry.path, entry]));
  const violations: string[] = [];
  for (const path of [...after.keys()].sort()) {
    const now = after.get(path) as CandidateTreeEntry;
    const then = before.get(path);
    const change = then === undefined ? 'created' : `${then.sha} → ${now.sha}`;
    if (then !== undefined && then.sha === now.sha && then.mode === now.mode) continue;
    if (input.targets.eligible.has(path)) {
      // An admissible target is admitted as an ORDINARY FILE INSIDE THE
      // CANDIDATE, re-checked HERE and not at nomination time. The
      // nomination happened before the prerequisites ran, so a setup test
      // could replace its own state file with a symbolic link in between;
      // the snapshot records links as `120000` entries rather than
      // rejecting them. An admitted write that is a link, or whose real
      // path leaves the candidate, is refused BY NAME here.
      if (now.mode === SYMLINK_MODE) {
        violations.push(
          `native preparation ${change} '${path}' into a symbolic link — a generated target must be an ` +
            'ordinary file inside the candidate, never a link',
        );
        continue;
      }
      const escape = physicalEscapeOf(input.root, path);
      if (escape !== null) {
        violations.push(
          `native preparation ${change} '${path}', which reaches outside the candidate ('${escape}') — ` +
            'a generated target is admitted only while it physically stays inside',
        );
      }
      continue;
    }
    violations.push(
      `native preparation ${change} '${path}', which is not an admissible generated target` +
        (input.targets.refused.has(path) ? ` (${input.targets.refused.get(path) as string})` : ''),
    );
  }
  for (const path of [...before.keys()].sort()) {
    if (after.has(path)) continue;
    violations.push(
      `native preparation removed '${path}' — a removal is never admissible, whatever the path is`,
    );
  }
  return violations;
}

/** The Git mode a recorded symbolic link carries in a candidate tree. */
const SYMLINK_MODE = '120000';

/**
 * Whether a repo-relative path is not an ordinary file inside the
 * candidate once links are followed. Null means it is (or no longer
 * exists on disk, which the seal-time drift check settles separately).
 *
 * This answers the PHYSICAL question the lexical one cannot: a link, or a
 * chain of links, that leaves the tree — exactly the shape a setup test
 * could produce after its target was nominated.
 *
 * @param root: absolute candidate root.
 * @param path: repo-relative posix path.
 *
 * @returns
 *   string | null: what escapes, or null.
 */
function physicalEscapeOf(root: string, path: string): string | null {
  const base = resolve(root);
  const absolute = resolve(base, path);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink()) return readlinkSync(absolute);
  if (!stats.isFile()) return `${path} is not an ordinary file`;
  let real: string;
  let realBase: string;
  try {
    real = realpathSync(absolute);
    realBase = realpathSync(base);
  } catch {
    return `${path} cannot be resolved on this host`;
  }
  if (real === realBase || real.startsWith(realBase + sep)) return null;
  return real;
}

/** One prerequisite identity the freeze must find passed under supervision. */
export interface PrerequisiteIdentity {
  /** Repo-relative posix file (identity join key). */
  file: string;
  /** Full catalog-identity title path. */
  titlePath: string[];
}

/**
 * Proves, from the AUTHENTICATED witness execution trace, that every
 * prerequisite identity really passed before the candidate is frozen.
 *
 * The trace is the supervisor's own record, not the suite's: a
 * prerequisite counts only when the witness minted EXACTLY ONE session
 * for it, sealed that session, and recorded `passed` on it.
 *
 * The distinction that matters is PENDING versus TERMINAL. A
 * prerequisite with no session YET is pending: the runner may still be
 * executing it, so the trusted side waits. A prerequisite that already
 * sealed as anything but `passed`, that opened more than one session
 * (a retry or a confused lifecycle), or whose trace is unreadable, is
 * TERMINAL — waiting cannot change it, so waiting would only turn a
 * permanent refusal into a slow one.
 *
 * @param trace: the witness execution trace, or null when it is unreadable.
 * @param prerequisites: every prerequisite identity the plan executed.
 *
 * @returns
 *   {pending, refused}: pending reasons worth waiting for (empty when
 *   everything passed), and terminal reasons that end the wait at once.
 */
export function unfrozenPrerequisiteState(input: {
  trace: readonly TracedTestInput[] | null;
  prerequisites: readonly PrerequisiteIdentity[];
}): { pending: string[]; refused: string[] } {
  if (input.trace === null) {
    return {
      pending: [],
      refused: [
        'the witness execution trace could not be read, so no prerequisite can be proven to have passed ' +
          'before the candidate is frozen',
      ],
    };
  }
  const pending: string[] = [];
  const refused: string[] = [];
  for (const prerequisite of input.prerequisites) {
    const key = prerequisite.titlePath.join('>');
    const matches = input.trace.filter(
      (traced) => traced.file === prerequisite.file && traced.titlePath.join('>') === key,
    );
    if (matches.length === 0) {
      pending.push(`prerequisite '${prerequisite.file}#${key}' has no witness session yet`);
      continue;
    }
    const sessions = matches.flatMap((traced) => traced.sessions);
    if (sessions.length === 0) {
      pending.push(`prerequisite '${prerequisite.file}#${key}' recorded no session yet`);
      continue;
    }
    if (sessions.length > 1) {
      refused.push(
        `prerequisite '${prerequisite.file}#${key}' opened ${String(sessions.length)} sessions — a retry or a ` +
          'duplicated lifecycle is never a prerequisite this run may freeze over',
      );
      continue;
    }
    const session = sessions[0];
    if (session === undefined || session.sealedTick === null) {
      pending.push(`prerequisite '${prerequisite.file}#${key}' has not sealed its session yet`);
      continue;
    }
    if (session.outcome !== 'passed') {
      refused.push(
        `prerequisite '${prerequisite.file}#${key}' sealed as '${session.outcome ?? 'unknown'}' — only a ` +
          'genuine pass may precede a frozen candidate',
      );
    }
  }
  return { pending, refused };
}

/**
 * Checks the controller's request against the identities THIS run armed.
 * A request is data the controller wrote into a file the suite can also
 * write, so it is only accepted when it names this run, this invocation
 * and this exact per-invocation nonce.
 *
 * @param request: the parsed controller request (unknown shape allowed).
 * @param armed: the identities the CLI minted for this invocation.
 *
 * @returns
 *   FreezeRequest | string: the accepted request, or the plain refusal.
 */
export function acceptedFreezeRequest(
  request: unknown,
  armed: { runId: string; invocationId: string; nonce: string; project: string },
): FreezeRequest | string {
  if (typeof request !== 'object' || request === null) {
    return 'the controller request is not an object';
  }
  const row = request as Record<string, unknown>;
  if (row['project'] !== armed.project) {
    return `the controller request names project '${String(row['project'])}', not this run's controller`;
  }
  if (row['runId'] !== armed.runId || row['invocationId'] !== armed.invocationId) {
    return 'the controller request belongs to another run or invocation';
  }
  if (row['nonce'] !== armed.nonce) {
    return 'the controller request carries another nonce (a replayed or forged request)';
  }
  return row as unknown as FreezeRequest;
}
