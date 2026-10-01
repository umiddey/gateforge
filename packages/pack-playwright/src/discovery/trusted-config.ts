/**
 * Trusted Playwright config synthesis (execution-authority fix): the
 * supervised runner NEVER loads the consumer's `playwright.config.*`.
 * That file is arbitrary code running in the runner MAIN process — the
 * same process as the gateforge reporter — so a hostile config can
 * write fabricated lifecycle spool events and a fabricated outcomes
 * document, then exit 0 before any spec executes (the confirmed
 * execution bypass). Instead the supervisor synthesizes a minimal
 * trusted config into the excluded run-state dir and runs the runner
 * with `--config <trusted>`:
 *
 * - test files: the exact repo-relative files the supervisor selected
 *   (from the planned expected set), or the runner default when the
 *   caller selected nothing;
 * - projects: bare names carried as data (identity only — per-project
 *   code options are NOT honored), each with the files the plan
 *   attributed to it, the dependency EDGES the enumeration captured
 *   (names only), and the `use.storageState` PATH the enumeration
 *   captured for that project. The edges are what makes a `setup`-project
 *   config order correctly: Playwright runs a dependency project's tests
 *   before the dependent project, which is the only way the dependent
 *   test can read the artifact the setup test produced — and the state
 *   is what hands that project the session the setup test saved, while
 *   the setup project itself keeps running unauthenticated;
 * - storage states: a declared path is resolved from the NATIVE CONFIG
 *   DIRECTORY the runner child runs from (so the dependent project reads
 *   the very file its own setup project wrote from that same cwd) and is
 *   honored only while it lands INSIDE the candidate root, which stays
 *   the containment boundary for a nested project too; an
 *   operator-provided whole-run state still outranks every project
 *   declaration and keeps its own candidate-root meaning (see
 *   {@link resolveProjectStorageState});
 * - reporter: the engine's own reporter entry forced by absolute path
 *   with run-state paths as CONSTRUCTOR OPTIONS (never env — worker
 *   processes must not learn the spool/outcomes locations);
 * - workers: 1, fullyParallel: false (serial — one open session at a
 *   time, so a worker can never reach another test's open session);
 * - retries: 0, forbidOnly: true (required retries are zero; `.only`
 *   in a required run is a runner-level error);
 * - no globalSetup/globalTeardown, no webServer, no consumer reporters.
 *
 * Authority boundary after this fix:
 * - TRUSTED: the CLI process, the witness process, and the runner MAIN
 *   process (Playwright native + synthesized config + engine reporter).
 * - UNTRUSTED: worker processes (test files, helpers, page objects,
 *   and any code they import). Workers keep ONLY the witness URL + run
 *   token + app base in env — enough for the fixture, never enough to
 *   locate the spool or outcomes files.
 * - Worker forgery of another test's lifecycle always collides with the
 *   genuine reporter events for that test; the drain records the
 *   collision and supervision fails the run closed.
 *
 * Compatibility limits (honest, not transparent):
 * - consumer `globalSetup`/`globalTeardown` are NOT executed;
 * - consumer reporters, `webServer`, per-project `use` options other
 *   than the captured `storageState` PATH, `testDir`/`testIgnore`
 *   scoping, and sharding are NOT honored;
 * - consumer `testMatch` scoping is NOT honored as CONSUMER CODE. What IS
 *   honored is the SUPERVISOR'S OWN per-project file selection
 *   (`projectScopes`): project identity is the join key the whole pipeline
 *   speaks — catalog rows, the registered expected set, session opens, and
 *   the execution trace — so file scoping must be per project too. A single
 *   global `testMatch` collects every selected file under EVERY project,
 *   which is how a `setup`-dependency config (`{ name: 'setup', testMatch:
 *   /.*\.setup\.ts/ }` plus a dependent project) ran the whole suite once
 *   per project: identities the registered expected set never bound, so
 *   their sessions were refused and they lost every piece of evidence.
 * - per-project `teardown` is NOT honored; only `dependencies` is, as
 *   ordering data (names only).
 * - tests must be self-contained (app provided externally via the
 *   app-base env, as the fixture already requires).
 */

import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FREEZE_CONTROLLER_PROJECT } from './prepare-barrier.js';

/** File name of the synthesized trusted config inside the run-state dir. */
export const TRUSTED_CONFIG_FILE = 'trusted.playwright.config.mjs';

/** File name of the forced reporter options (diagnostic mirror of argv). */
export const TRUSTED_REPORTER_OPTIONS_FILE = 'trusted-reporter-options.json';

/** Options the synthesized trusted config carries for the engine reporter. */
export interface TrustedReporterOptions {
  /** Absolute run-state dir (spool, outcomes, injections, obligations). */
  stateDir: string;
  /** The run identity (spool path segment). */
  runId: string;
  /** Absolute runner-outcomes document path. */
  outcomesPath: string;
  /** Absolute obligations document path (reporter ledger; empty when none). */
  obligationsPath: string;
  /**
   * Absolute CANDIDATE ROOT the reporter anchors every file identity
   * to. Handed as trusted CONSTRUCTOR DATA (never worker env): the
   * runner child runs from the native config directory, while every
   * identity the supervisor registered is repo-relative — the reporter
   * must therefore relativize against the root, not against the cwd it
   * happens to run in.
   */
  candidateRoot: string;

  /**
   * ABSOLUTE path of the engine's own generated preparation-freeze
   * controller spec, when this run armed the global native freeze.
   *
   * The controller is a real Playwright test inside the runner, so the
   * reporter would otherwise report it as a native case: it would append
   * a lifecycle event (opening a witness session for a test the
   * registered expected set never contained), record an outcome row (so
   * the run's native count carries a non-native case), and collect its
   * claims. The exclusion is therefore by ABSOLUTE FILE IDENTITY — the
   * exact control bytes the trusted CLI pinned — never by title, never
   * by a project-name prefix, and never by anything the candidate
   * controls.
   */
  controlSpecPath?: string;
}

/** Inputs for one trusted config synthesis. */
export interface TrustedConfigInput {
  /** Absolute repo root (the runner's testDir, and the identity root). */
  cwd: string;
  /**
   * Absolute native config directory — the directory the runner child
   * runs from (the same one `listNativePlaywrightTests` enumerates
   * from). Relative per-project {@link ProjectScope.storageState}
   * declarations resolve from here, because that is the cwd the
   * project's own setup test wrote the file from. Undefined = the repo
   * root, which is exactly the config directory of a root-level config.
   */
  nativeConfigDir?: string;
  /** Absolute run-state dir (receives the synthesized config). */
  stateDir: string;
  /** The run identity. */
  runId: string;
  /** Absolute engine reporter entry (see {@link trustedReporterEntry}). */
  reporterEntry: string;
  /** Trusted operator-provided app proxy URL for relative browser navigation. */
  appBaseUrl?: string;
  /**
   * Operator-provided browser storage state, embedded only in trusted
   * config. This is the WHOLE-RUN state: when it is set it applies to
   * every project and outranks each project's declared
   * {@link ProjectScope.storageState}, exactly as it always has. A
   * relative value keeps its CANDIDATE-ROOT meaning — it is resolved
   * against {@link TrustedConfigInput.cwd} here, so moving the native
   * child's cwd can never re-point an operator's path.
   */
  storageState?: string;
  /** Exact repo-relative posix test files to run (undefined = default). */
  testFiles?: readonly string[];
  /** Bare project names to run (undefined = no project filter). */
  projects?: readonly string[];
  /**
   * The supervisor's OWN per-project file selection: each named project
   * carries exactly the files the plan attributed to it. A project with no
   * files is omitted (it would execute nothing). Files no project scope
   * claims (a project-less plan row) stay in the global `testMatch`, so
   * they still run. Empty = one global `testMatch` over `testFiles`, which
   * is byte-identical to the pre-scope behavior for a single-project run.
   */
  projectScopes?: readonly ProjectScope[];
  /**
   * ABSOLUTE path of the generated preparation-freeze controller spec,
   * when this run armed the global native freeze. It crosses to the
   * engine reporter as TRUSTED CONSTRUCTOR DATA (never env, never a
   * candidate-relative path) so the reporter can exclude exactly that one
   * file from its outcome rows, claims and lifecycle events. Unarmed, the
   * field is absent and the reporter records every test, exactly as
   * before.
   */
  controlSpecPath?: string;
  /** Per-test timeout ms (default 60_000). */
  testTimeoutMs?: number;
}

/** One named project and the repo-relative files the plan attributed to it. */
export interface ProjectScope {
  /** The project name — identity only; no consumer code options. */
  name: string;
  /** Repo-relative posix test files this project runs. */
  files: readonly string[];
  /**
   * Project names this project depends on, as the runner resolved them
   * (names only — never the consumer's per-project options). The
   * synthesized config emits them so Playwright runs a `setup` project's
   * tests BEFORE the dependent project that reads their artifact; an
   * edge naming a project the synthesized config omits is dropped,
   * because Playwright refuses to load such a config at all.
   */
  dependencies?: readonly string[];
  /**
   * The `use.storageState` PATH this project declared, as the runner
   * resolved it (data, never consumer code). The synthesized config
   * hands it to THIS project only, which is what lets a `setup` project
   * sign in and save `playwright/.auth/user.json` for the dependent
   * project that reads it while the setup project itself stays logged
   * out. Relative paths resolve against the RUNNER's cwd — the native
   * config directory the child runs from — exactly like the setup
   * test's own relative write, which is the very cwd that write is
   * resolved from. Containment stays the WHOLE candidate root, so a
   * valid `../shared/state.json` that lands back inside the candidate
   * is honored while anything reaching outside it is refused (see
   * {@link resolveProjectStorageState}).
   *
   * An operator-provided whole-run state (GATEFORGE_SESSION_STATE)
   * outranks every project declaration, so this field is not emitted at
   * all in that case.
   */
  storageState?: string;
  /**
   * This project's OWN `testDir` (absolute), when it collects files from
   * somewhere other than the config's `testDir`. Only the engine's freeze
   * controller uses it: its spec is GENERATED code inside the excluded
   * run-state subtree, which is not necessarily under the repo root the
   * config pins as `testDir`. A consumer project never gets one — the
   * files it runs are always repo-relative to the identity root.
   */
  testDir?: string;
}

/** Thrown when a project-declared browser state may not be read. */
export class ProjectStorageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStorageStateError';
  }
}

/** A declared state that names a URL scheme rather than a file path. */
const URL_LIKE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/**
 * True when a path exists as a directory entry — a file, a directory, or
 * a symlink of its own, including one that leads nowhere. Deliberately
 * not `existsSync`, which follows links and would report a dangling one
 * as absent.
 */
function isDirectoryEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves one project-declared `use.storageState` and refuses anything
 * a supervised run must not read.
 *
 * A relative path is resolved against the NATIVE CONFIG DIRECTORY —
 * the directory the runner child runs from, exactly the directory
 * `listNativePlaywrightTests` enumerated the suite from: the worker
 * reads the file relative to the process it runs in, which is that very
 * cwd, which is also where the project's own setup test wrote it from.
 * The file itself need not exist yet — the setup project writes it
 * during this run.
 *
 * Containment is the WHOLE CANDIDATE ROOT, not the config directory,
 * and it is PHYSICAL rather than lexical: a symlink inside the
 * candidate that points outside it is refused too, so the check follows
 * the real filesystem from the nearest existing ancestor. A nested
 * project's `../shared/state.json` therefore stays valid whenever it
 * lands back inside the candidate.
 *
 * @param value: the `use.storageState` string the runner resolved.
 * @param root: the candidate root (the containment boundary).
 * @param project: the declaring project, named in the error.
 * @param baseDir: the directory a relative declaration resolves from —
 *   the native config directory the runner child runs from.
 *
 * @returns
 *   string: the absolute path the declared state resolves to.
 *
 * @throws
 *   ProjectStorageStateError: when the value is empty, names a URL, or
 *   resolves outside the candidate root either directly or through a
 *   link. A requested state is never silently dropped — that would
 *   degrade into a logged-out run that looks green.
 */
export function resolveProjectStorageState(value: string, root: string, project: string, baseDir: string): string {
  const base = resolve(root);
  const from = resolve(base, baseDir);
  const refuse = (why: string): never => {
    throw new ProjectStorageStateError(
      `project '${project}' declares use.storageState '${value}', which ${why}. A supervised run reads a ` +
        `browser state only from inside the candidate (root '${base}'), resolving relative paths from the ` +
        `project's config directory '${from}': point the project at a path under the candidate — the ` +
        `standard pattern writes 'playwright/.auth/user.json' from its own setup project — or set ` +
        `GATEFORGE_SESSION_STATE to a whole-run state instead.`,
    );
  };
  if (value.length === 0) return refuse('is empty');
  if (URL_LIKE.test(value)) return refuse('is a URL, not a file path');
  const resolvedPath = resolve(from, value);
  if (resolvedPath !== base && !resolvedPath.startsWith(base + sep)) {
    return refuse(`resolves outside the candidate root ('${resolvedPath}')`);
  }
  // A path that only LOOKS contained is not contained: a symlink inside
  // the candidate can point anywhere on the host, and the worker would
  // follow it. So the check follows the real filesystem from the nearest
  // existing ancestor — the state file itself need not exist yet, the
  // setup project writes it during this run — and compares against the
  // real candidate root. Ancestor lookup uses lstat, NOT existsSync: a
  // link that leads nowhere must be FOUND here and refused below, never
  // stepped over as if it were absent.
  let probe = resolvedPath;
  while (!isDirectoryEntry(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return refuse('names no path this host can resolve');
    probe = parent;
  }
  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    return refuse('cannot be resolved against this host\'s filesystem');
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return refuse('is a link this host cannot resolve');
  }
  const physical = resolve(realProbe, relative(probe, resolvedPath));
  if (physical !== realBase && !physical.startsWith(realBase + sep)) {
    return refuse(`reaches outside the candidate through a link ('${physical}')`);
  }
  return resolvedPath;
}

/**
 * Resolves the engine reporter entry the trusted config forces: the
 * pack's own BUILT reporter (the same class the consumer config would
 * reference by package name). Never a repo-relative path — the entry
 * must be engine-owned, never candidate-controlled.
 *
 * Args:
 *   fromModule: module URL to resolve the pack from (default: this file).
 *
 * Returns:
 *   string: absolute `<pack>/dist/reporter/reporter.js` path.
 */
export function trustedReporterEntry(fromModule: string = import.meta.url): string {
  // Package-root relative (works for both src/ and dist/ layouts — the
  // package.json subpath is not in `exports`, so no self-name resolve).
  const pkgPath = fileURLToPath(new URL('../../package.json', fromModule));
  return join(pkgPath.slice(0, -'package.json'.length), 'dist', 'reporter', 'reporter.js');
}

/**
 * Synthesizes the trusted Playwright config into the run-state dir.
 *
 * Args:
 *   input: repo root, native config directory, run state, reporter
 *     entry, file/project selection, and the operator's whole-run state.
 *
 * Returns:
 *   { configPath, reporterOptions }: absolute config path for
 *   `--config`, plus the reporter options embedded in it.
 */
export function synthesizeTrustedConfig(input: TrustedConfigInput): {
  configPath: string;
  reporterOptions: TrustedReporterOptions;
} {
  const reporterOptions: TrustedReporterOptions = {
    stateDir: input.stateDir,
    runId: input.runId,
    outcomesPath: join(input.stateDir, 'runner-outcomes.json'),
    obligationsPath: join(input.stateDir, 'obligations.json'),
    candidateRoot: input.cwd,
    // The engine's own freeze controller is excluded by ABSOLUTE FILE
    // IDENTITY, handed here as trusted constructor data. Unarmed, the
    // field is absent and the reporter records every test as before.
    ...(input.controlSpecPath !== undefined ? { controlSpecPath: input.controlSpecPath } : {}),
  };
  const testFiles = [...new Set(input.testFiles ?? [])].sort();
  const projects = [...new Set(input.projects ?? [])].sort();
  // An operator's whole-run state is resolved HERE, against the candidate
  // root, and emitted absolute: a relative operator path keeps the
  // candidate-root meaning it always had, whatever cwd the native child
  // runs from. (An absolute value passes through unchanged — the
  // operator's own path, never re-anchored.)
  const operatorState = input.storageState === undefined ? undefined : resolve(input.cwd, input.storageState);
  // Every project-declared storage state is resolved and checked BEFORE
  // anything is written: a state a supervised run may not read refuses
  // the run outright, because silently dropping it would leave the
  // project logged out and still call the run green. Relative
  // declarations resolve from the NATIVE CONFIG DIRECTORY (the child's
  // cwd, where the setup test wrote the file), while containment stays
  // the whole candidate root. Under an operator's whole-run state the
  // declarations are not used at all, so they are neither read nor
  // checked — precedence means the losing value never reaches the
  // filesystem.
  if (operatorState === undefined) {
    for (const scope of input.projectScopes ?? []) {
      if (scope.storageState !== undefined) {
        resolveProjectStorageState(scope.storageState, input.cwd, scope.name, input.nativeConfigDir ?? input.cwd);
      }
    }
  }
  // Per-project file selection. Each project carries exactly the files the
  // plan attributed to it, so a project-scoped consumer config (the standard
  // `setup`-project auth pattern) does not have every selected file collected
  // under every project. Files no project scope claims stay in the global
  // `testMatch` — a project-less plan row must still execute. Scoping only
  // changes what runs when TWO or more projects share the config: with one
  // project the global `testMatch` selects the identical set, so a
  // single-project run keeps exactly the old one-global-`testMatch` config.
  // A project's declared state travels with it — except under an
  // operator-provided WHOLE-RUN state, which has always outranked
  // everything the config declared and keeps doing so: that state is
  // emitted once as the global `use`, and no per-project state is emitted
  // beside it. A project that declares nothing keeps no `use` at all and
  // therefore runs logged out, which is exactly what the `setup` project
  // of the standard pattern needs.
  const scopedProjects = (input.projectScopes ?? [])
    .map((scope) => ({
      name: scope.name,
      files: [...new Set(scope.files)].sort(),
      // Carried through so the synthesized project can actually collect
      // from it; a dropped field would make the engine's freeze controller
      // look for its spec under the repo root and find nothing.
      ...(scope.testDir === undefined ? {} : { testDir: scope.testDir }),
      dependencies: scope.dependencies ?? [],
      ...(operatorState === undefined && scope.storageState !== undefined
        ? { storageState: scope.storageState }
        : {}),
    }))
    .filter((scope) => scope.name.length > 0 && scope.files.length > 0)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const projectScopes = scopedProjects.length >= 2 ? scopedProjects : [];
  // One surviving scope runs its files under that project alone — a named
  // project that owns no file must not collect them a second time. Its
  // declared state still rides along: that path emits no per-project
  // `testMatch`, and dropping the state with it would log out the very
  // project a narrowed run kept.
  const loneScope = scopedProjects.length === 1 ? scopedProjects[0]! : undefined;
  const plainProjects = loneScope !== undefined ? [loneScope.name] : projects;
  const scopedFiles = new Set(projectScopes.flatMap((scope) => scope.files));
  const unscopedFiles = testFiles.filter((file) => !scopedFiles.has(file));
  // Dependency edges are carried as the runner resolved them (names
  // only) and filtered to the projects this config actually defines:
  // Playwright REFUSES to load a config whose `dependencies` names a
  // project it does not declare, so a dangling edge would fail the whole
  // run instead of merely losing an ordering. An edge to a project with
  // no files is dropped with it, for the same reason. Projects with no
  // edges at all emit no `dependencies` key, so a single-project run
  // stays byte-identical.
  const scopedNames = new Set(projectScopes.map((scope) => scope.name));
  // Whether this config carries the engine's preparation-freeze
  // controller. Its presence is what makes the dependency emission below
  // order-aware; every config without it emits exactly what it always did.
  const freezeArmed = projectScopes.some((scope) => scope.name === FREEZE_CONTROLLER_PROJECT);
  const synthesizedProjects = projectScopes.map((scope) => {
    const captured = [
      ...new Set(scope.dependencies.filter((name) => scopedNames.has(name) && name !== scope.name)),
    ].sort();
    // ARMED (the global preparation freeze is in this config): the
    // controller is emitted FIRST, explicitly, and the project's own
    // captured edges follow in their existing sorted order. Sorting the
    // whole array instead would silently move the controller behind any
    // prerequisite that sorts before it, and the extra-environment union
    // the native scheduler builds over `project.deps` is positional with
    // later entries winning — so where the controller lands decides which
    // environment a body actually starts with. UNARMED keeps the exact
    // pre-existing emission, so every run without the barrier stays
    // byte-identical.
    const edges = freezeArmed
      ? captured.includes(FREEZE_CONTROLLER_PROJECT)
        ? [FREEZE_CONTROLLER_PROJECT, ...captured.filter((name) => name !== FREEZE_CONTROLLER_PROJECT)]
        : captured
      : captured;
    return {
      name: scope.name,
      testMatch: scope.files,
      // A project with its OWN `testDir` (the engine's freeze controller)
      // collects from there; every consumer project stays on the config's
      // repo-root `testDir`, exactly as before.
      ...(scope.testDir === undefined ? {} : { testDir: scope.testDir }),
      ...(edges.length > 0 ? { dependencies: edges } : {}),
      // The declared state, for THIS project only. It rides in `use`
      // rather than at the top level so the `setup` project that writes
      // the file keeps running with no session at all.
      ...(scope.storageState === undefined ? {} : { use: { storageState: scope.storageState } }),
    };
  });
  const lines = [
    '// GENERATED by gateforge trusted supervision — do not edit. The',
    '// consumer config file is NEVER loaded for supervised runs: it is',
    '// arbitrary main-process code that could fabricate the lifecycle',
    '// spool and outcomes document this reporter writes.',
    'export default {',
    `  testDir: ${JSON.stringify(input.cwd)},`,
    ...(unscopedFiles.length > 0 ? [`  testMatch: ${JSON.stringify(unscopedFiles)},`] : []),
    ...(projectScopes.length > 0
      ? [
          `  projects: ${JSON.stringify(synthesizedProjects)},`,
        ]
      : plainProjects.length > 0
        ? [
            `  projects: ${JSON.stringify(
              plainProjects.map((name) => ({
                name,
                ...(loneScope?.name === name && loneScope.storageState !== undefined
                  ? { use: { storageState: loneScope.storageState } }
                  : {}),
              })),
            )},`,
          ]
        : []),
    '  workers: 1,',
    '  fullyParallel: false,',
    '  retries: 0,',
    '  forbidOnly: true,',
    `  timeout: ${String(input.testTimeoutMs ?? 60_000)},`,
    '  reporter: [',
    "    ['list'],",
    `    [${JSON.stringify(input.reporterEntry)}, ${JSON.stringify(reporterOptions)}],`,
    '  ],',
    `  use: ${JSON.stringify({
      headless: true,
      trace: 'off',
      ...(input.appBaseUrl !== undefined ? { baseURL: input.appBaseUrl } : {}),
      ...(operatorState !== undefined ? { storageState: operatorState } : {}),
    })},`,
    `  outputDir: ${JSON.stringify(join(input.stateDir, 'playwright-artifacts'))},`,
    '};',
    '',
  ];
  mkdirSync(input.stateDir, { recursive: true });
  const configPath = join(input.stateDir, TRUSTED_CONFIG_FILE);
  writeFileSync(configPath, `${lines.join('\n')}`, 'utf8');
  writeFileSync(
    join(input.stateDir, TRUSTED_REPORTER_OPTIONS_FILE),
    `${JSON.stringify({ configPath, reporterEntry: input.reporterEntry, reporterOptions, testFiles, projects, projectScopes }, null, 2)}\n`,
    'utf8',
  );
  return { configPath, reporterOptions };
}
