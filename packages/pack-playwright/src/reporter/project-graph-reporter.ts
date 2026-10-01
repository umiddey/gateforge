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
 * It records the project graph and, alongside it, the RESOLVED
 * `use.storageState` of each project — but only when that value is a
 * plain string path. That is DATA the runner already resolved from the
 * consumer config (a file location), not consumer code, and it is what
 * the standard auth pattern needs: a `setup` project signs in and saves
 * `playwright/.auth/user.json`, and the dependent project is the one
 * that must be handed that file. Every other project option is
 * consumer configuration a supervised run deliberately does not honor,
 * so none of it crosses this boundary — including a `storageState`
 * given as an inline `{cookies, origins}` document, which is a value
 * this boundary does not carry.
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

/** Minimal shape of the runner project objects this reporter reads. */
interface RunnerProject {
  name?: string;
  dependencies?: readonly string[];
  /** The RESOLVED per-project `use`; only its `storageState` is read. */
  use?: { storageState?: unknown };
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
}

/**
 * The Playwright reporter that records the resolved project dependency
 * graph and the storage states its projects declare. Written for the
 * v2 reporter protocol (`version()` returning `'v2'`), whose
 * `onConfigure` receives the resolved full config.
 */
export class ProjectGraphReporter {
  /** Opts into the v2 reporter protocol (config arrives in onConfigure). */
  public version(): string {
    return 'v2';
  }

  /**
   * Records the graph, and the declared storage states, the RUNNER
   * resolved.
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
    for (const project of config.projects ?? []) {
      if (typeof project.name !== 'string' || project.name.length === 0) continue;
      projectDependencies[project.name] = [
        ...new Set(
          (project.dependencies ?? []).filter(
            (name): name is string => typeof name === 'string' && name.length > 0,
          ),
        ),
      ].sort();
      // Only a plain path string crosses. An inline `{cookies, origins}`
      // document is a value this boundary does not carry, and a
      // function-valued state is consumer code, not data. Every STRING
      // crosses verbatim — an empty one included: a project that asked
      // for no state at all is a refusal the planner owes, not a
      // silently-dropped declaration that would run logged out.
      const storageState = project.use?.storageState;
      if (typeof storageState === 'string') {
        projectStorageStates[project.name] = storageState;
      }
    }
    const document: ProjectGraphDocument = {
      schemaVersion: 2,
      projectDependencies,
      ...(Object.keys(projectStorageStates).length > 0 ? { projectStorageStates } : {}),
    };
    writeFileSync(graphPath, `${JSON.stringify(document)}\n`, 'utf8');
  }
}

export default ProjectGraphReporter;
