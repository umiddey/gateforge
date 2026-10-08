/**
 * Project-graph reporter: the ONLY trustworthy source of a Playwright
 * config's per-project `dependencies`.
 *
 * The json reporter Gateforge enumerates with does NOT carry the edge:
 * `config.projects[]` there is rebuilt field by field (outputDir,
 * repeatEach, retries, metadata, id, name, testDir, testIgnore,
 * testMatch, timeout) and `dependencies` is simply absent — verified
 * against the pack's pinned playwright 1.58.2 and against a consumer's
 * own 1.62.1. Reading the edge from the consumer config file instead
 * would mean parsing arbitrary candidate code, which the trusted
 * supervision boundary exists to avoid.
 *
 * So the enumeration adds this ENGINE-OWNED reporter next to the json
 * one (`--reporter=json,<this file>`). The runner hands every reporter
 * the resolved FullConfig in `onConfigure` — the same object the runner
 * itself schedules from — so the graph is the runner's own truth, not
 * the candidate's claim about it.
 *
 * It records the project graph, alongside it the RESOLVED
 * `use.storageState` of each project (only when that value is a plain
 * string path), and each project's own resolved TEST-FILE selection
 * (`testDir`/`testMatch`/`testIgnore`) — the runner's answer to "which
 * files would you collect at all?". A test file outside every
 * project's selection is not that runner's test, however test-shaped
 * it looks, and the catalog must say so from the runner's own words
 * rather than from a guess about the consumer's glob syntax.
 *
 * Every other project option is consumer configuration a supervised run
 * deliberately does not honor, so none of it crosses this boundary —
 * including a `storageState` given as an inline `{cookies, origins}`
 * document, which is a value this boundary does not carry.
 *
 * The output path arrives in the environment, exactly like the json
 * reporter's own `PLAYWRIGHT_JSON_OUTPUT_FILE`: the reporter list a CLI
 * accepts cannot carry per-reporter options, and this reporter runs in
 * the ENUMERATION child (`--list`, no test ever executes), never in the
 * supervised run whose run-state paths must stay out of worker hands.
 */

import { writeFileSync } from 'node:fs';

/** Environment variable naming the graph document to write. */
export const PROJECT_GRAPH_PATH_ENV = 'PLAYWRIGHT_GATEFORGE_PROJECT_GRAPH_FILE';

/**
 * The placeholder project name for the runner's IMPLICIT project — the one
 * a config with no `projects` array resolves to, reported with an empty
 * name. It is the same placeholder the enumerated test ids carry, so a
 * project-less configuration joins cleanly.
 */
export const IMPLICIT_PROJECT_NAME = '-';

/** A runner test-file selection value: a glob string or a RegExp. */
type SelectionValue = string | RegExp;

/** Minimal shape of the runner project objects this reporter reads. */
interface RunnerProject {
  name?: string;
  dependencies?: readonly string[];
  /** The RESOLVED per-project `use`; only its `storageState`, `browserName`, and `defaultBrowserType` are read. */
  use?: { storageState?: unknown; browserName?: unknown; defaultBrowserType?: unknown };
  /** The RESOLVED per-project test root (absolute). */
  testDir?: string;
  testMatch?: SelectionValue | readonly SelectionValue[];
  testIgnore?: SelectionValue | readonly SelectionValue[];
}

/** Minimal shape of the runner's resolved full config. */
interface RunnerFullConfig {
  projects?: readonly RunnerProject[];
}

/**
 * The document this reporter writes: the resolved project graph plus
 * each project's declared storage state.
 *
 * `schemaVersion` is 2 since the storage-state field was added. It is a
 * clean cutover, never a partial accept: a reader that does not
 * understand version 2 must take the whole document as absent, because
 * half a graph orders projects wrongly and half a state set
 * authenticates the wrong ones.
 */
export interface ProjectGraphDocument {
  schemaVersion: 2;
  /** Project name to the (sorted, deduplicated) names it depends on. */
  projectDependencies: Record<string, string[]>;
  /**
   * Project name to the `use.storageState` STRING the runner resolved
   * for it. Absent when no project declares one — never an empty map
   * that would read as "every project has an empty state".
   */
  projectStorageStates?: Record<string, string>;
  /**
   * Per project, the runner's OWN resolved test-file selection: the
   * absolute `testDir` plus its `testMatch`/`testIgnore` globs
   * (serialized with `String()`, exactly as the runner's own json
   * reporter serializes them). A project is ABSENT when one of its
   * selection values is not a plain glob/RegExp — absent means "this
   * project narrows nothing", never "this project collects nothing".
   */
  testFileScope?: ProjectTestFileScope[];
  /**
   * Project name → the RESOLVED `use.browserName` the runner will run it
   * with (devices already merged by the runner itself). Absent when no
   * project resolves one, or the document predates the field: absence
   * means "the browser is undetermined" and every downstream rule fails
   * closed — never a guessed default.
   */
  projectBrowsers?: Record<string, string>;
}

/** One project's runner-resolved test-file selection. */
export interface ProjectTestFileScope {
  /** The runner project name. */
  name: string;
  /** Absolute test root; the selection globs are relative to it. */
  testDir: string;
  /** Globs a file must match (relative to {@link testDir}). */
  testMatch: string[];
  /** Globs that exclude a file (relative to {@link testDir}). */
  testIgnore: string[];
}

/**
 * Normalizes one resolved `testMatch`/`testIgnore` value to its globs.
 *
 * @param value: the runner's resolved value (string, RegExp, or array).
 *
 * @returns
 *   string[]: the globs in source order; empty when the runner resolved
 *   nothing. `null` when any element is not a plain string/RegExp — the
 *   caller then treats that project's whole selection as unknown.
 */
function selectionGlobs(value: RunnerProject['testMatch']): string[] | null {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  const globs: string[] = [];
  for (const element of values) {
    if (typeof element === 'string') globs.push(element);
    else if (element instanceof RegExp) globs.push(element.toString());
    else return null;
  }
  return globs;
}

/**
 * The Playwright reporter that records the resolved project dependency
 * graph, the storage states its projects declare, and each project's
 * resolved test-file selection. Written for the v2 reporter protocol
 * (`version()` returning `'v2'`), whose `onConfigure` receives the
 * resolved full config.
 */
export class ProjectGraphReporter {
  /** Opts into the v2 reporter protocol (config arrives in onConfigure). */
  public version(): string {
    return 'v2';
  }

  /**
   * Records the graph, the declared storage states, and the test-file
   * selection the RUNNER resolved.
   *
   * @param config: the resolved full config, exactly as the runner has it.
   */
  public onConfigure(config: RunnerFullConfig): void {
    const graphPath = process.env[PROJECT_GRAPH_PATH_ENV];
    if (graphPath === undefined || graphPath.length === 0) return;
    // Null-prototype: a project NAME is candidate data and `__proto__` is
    // a legal one, so a map keyed by it must not inherit anything.
    const projectDependencies = Object.create(null) as Record<string, string[]>;
    const projectStorageStates = Object.create(null) as Record<string, string>;
    const projectBrowsers = Object.create(null) as Record<string, string>;
    const testFileScope: ProjectTestFileScope[] = [];
    for (const project of config.projects ?? []) {
      // A config with no `projects` array (or a declared one without a
      // name) resolves to the runner's IMPLICIT project, reported with an
      // empty name. Its resolved selection is real: skipping it left the
      // catalog with no scope at all, so every statically found file
      // looked like this runner's own test. The placeholder is the one the
      // test ids already use for such rows. An implicit project is NOT a
      // plannable project, so it adds no node to the dependency graph.
      const named = typeof project.name === 'string' && project.name.length > 0;
      const name = named ? (project.name as string) : IMPLICIT_PROJECT_NAME;
      if (named) {
        projectDependencies[name] = [
        ...new Set(
          (project.dependencies ?? []).filter(
            (name): name is string => typeof name === 'string' && name.length > 0,
          ),
        ),
        ].sort();
      }
      // Only a plain path string crosses. An inline `{cookies, origins}`
      // document is a value this boundary does not carry, and a
      // function-valued state is consumer code, not data. Every STRING
      // crosses verbatim — an empty one included: a project that asked
      // for no state at all is a refusal the planner owes, not a
      // silently-dropped declaration that would run logged out.
      const storageState = project.use?.storageState;
      if (typeof storageState === 'string') {
        projectStorageStates[name] = storageState;
      }
      // The RESOLVED browser the runner will use for this project — its
      // own answer, with devices already merged, never a parse of the
      // consumer config. Playwright 1.58 materializes `use.browserName`;
      // 1.63 materializes the device-derived browser as
      // `use.defaultBrowserType` instead. Either is the runner's own
      // answer; only a plain non-empty string crosses. A project that
      // resolves NEITHER (no declared browser, no device) has an
      // undetermined browser and is left out: every downstream
      // browser-dependent rule fails closed.
      const resolvedUse = project.use ?? {};
      const browser = resolvedUse.browserName ?? resolvedUse.defaultBrowserType;
      if (typeof browser === 'string' && browser.length > 0) {
        projectBrowsers[name] = browser;
      }
      // The runner's own file selection. Only plain globs and RegExps
      // cross; a function-valued selector is consumer CODE, and a
      // project with a non-data value is left out so it narrows nothing
      // instead of narrowing wrongly.
      const testDir = project.testDir;
      const testMatch = selectionGlobs(project.testMatch);
      const testIgnore = selectionGlobs(project.testIgnore);
      if (typeof testDir === 'string' && testDir.length > 0 && testMatch !== null && testIgnore !== null) {
        testFileScope.push({ name, testDir, testMatch, testIgnore });
      }
    }
    const document: ProjectGraphDocument = {
      schemaVersion: 2,
      projectDependencies,
      ...(Object.keys(projectStorageStates).length > 0 ? { projectStorageStates } : {}),
      ...(Object.keys(projectBrowsers).length > 0 ? { projectBrowsers } : {}),
      ...(testFileScope.length > 0 ? { testFileScope } : {}),
    };
    writeFileSync(graphPath, `${JSON.stringify(document)}\n`, 'utf8');
  }
}

export default ProjectGraphReporter;
