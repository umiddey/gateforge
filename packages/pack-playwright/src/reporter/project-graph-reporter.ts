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
 * It records NAMES ONLY: the project name and the names it depends on.
 * Every other project option is consumer configuration a supervised run
 * deliberately does not honor, so none of it crosses this boundary.
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
}

/** Minimal shape of the runner's resolved full config. */
interface RunnerFullConfig {
  projects?: readonly RunnerProject[];
}

/** The document this reporter writes: project name → dependency names. */
export interface ProjectGraphDocument {
  schemaVersion: 1;
  /** Project name to the (sorted, deduplicated) names it depends on. */
  projectDependencies: Record<string, string[]>;
}

/**
 * The Playwright reporter that records the resolved project dependency
 * graph. Written for the v2 reporter protocol (`version()` returning
 * `'v2'`), whose `onConfigure` receives the resolved full config.
 */
export class ProjectGraphReporter {
  /** Opts into the v2 reporter protocol (config arrives in onConfigure). */
  public version(): string {
    return 'v2';
  }

  /**
   * Records the graph the RUNNER resolved.
   *
   * @param config: the resolved full config, exactly as the runner has it.
   */
  public onConfigure(config: RunnerFullConfig): void {
    const graphPath = process.env[PROJECT_GRAPH_PATH_ENV];
    if (graphPath === undefined || graphPath.length === 0) return;
    const projectDependencies: Record<string, string[]> = {};
    for (const project of config.projects ?? []) {
      if (typeof project.name !== 'string' || project.name.length === 0) continue;
      projectDependencies[project.name] = [
        ...new Set(
          (project.dependencies ?? []).filter(
            (name): name is string => typeof name === 'string' && name.length > 0,
          ),
        ),
      ].sort();
    }
    const document: ProjectGraphDocument = { schemaVersion: 1, projectDependencies };
    writeFileSync(graphPath, `${JSON.stringify(document)}\n`, 'utf8');
  }
}

export default ProjectGraphReporter;
