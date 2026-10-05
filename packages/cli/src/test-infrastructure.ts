/**
 * Which files are a repository's own TEST INFRASTRUCTURE, read from the
 * repository's own words rather than from what a file is named.
 *
 * Two independent sources, both data:
 *
 * - **Runner configurations.** The resolved config is only ONE of them. A
 *   repository legitimately keeps several (`playwright.config.ts` for the
 *   suite the gate reads, plus dev-stack / headed / demo wrappers), and a
 *   repository's `package.json` scripts name them. Only the first one
 *   resolved before, so every sibling was unattributable — a change the
 *   runner itself may pick up.
 * - **The staged runtime document's own commands and env files.** A
 *   `scripts/e2e/run.sh` or a compose override is test infrastructure
 *   because `runtime.yml` runs it, not because of where it sits. The same
 *   answer denies attribution to an UNDECLARED one: it can change what
 *   runs, so it stays `CHANGE_UNMAPPED`.
 *
 * Every path accepted here must already exist inside the repository — a
 * declaration is read as a fact, never as a candidate-supplied string.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RuntimeConfigSchema, type GateforgeConfig, type RuntimeConfig } from '@gate-forge/core';
import { existingRepoFile, runnerConfigPaths } from '@gate-forge/pack-playwright';
import { parse as parseYaml } from 'yaml';

/**
 * Every runner configuration the CONFIGURED runner can be pointed at.
 *
 * The enumeration lives in `@gate-forge/pack-playwright` (one list, one
 * rule): discovery roots the test-infrastructure import graph at exactly
 * these configurations, so a config that names a reporter and a config
 * the scope inputs attribute can never disagree about what exists. This
 * module re-exports it for the CLI's own callers.
 */
export { runnerConfigPaths };

/** Every argv list the staged runtime document declares, plus its shell commands. */
function runtimeArgvLists(runtime: {
  prepare?: {
    command?: string;
    commands?: string[][];
    preflight?: { name: string; command: string }[];
  };
  health?: { name: string; command?: string; logAbsent?: { command: string } }[];
  services_up?: { commands: string[][] };
  services_down?: { commands: string[][] };
  reset?: { commands: string[][] };
  seed?: { commands: string[][] };
  healthcheck?: { commands: string[][] };
}): string[][] {
  const lists: string[][] = [];
  const push = (value: string | undefined): void => {
    if (value === undefined) return;
    lists.push(value.split(/\s+/).filter((token) => token.length > 0));
  };
  push(runtime.prepare?.command);
  for (const command of runtime.prepare?.commands ?? []) lists.push(command);
  for (const probe of runtime.prepare?.preflight ?? []) push(probe.command);
  for (const probe of runtime.health ?? []) {
    push(probe.command);
    push(probe.logAbsent?.command);
  }
  for (const step of [runtime.services_up, runtime.services_down, runtime.reset, runtime.seed, runtime.healthcheck]) {
    for (const command of step?.commands ?? []) lists.push(command);
  }
  return lists;
}

/**
 * Parses the staged runtime document, or null when the repository
 * declares none, the file is absent, or it does not validate.
 *
 * Reads the document directly rather than through `runtime.ts`: this
 * module is imported by the input snapshot, and `runtime.ts` reaches
 * back into the snapshot through `state.ts`. A leaf reader keeps the
 * dependency graph acyclic, and attribution wants a plain "no document,
 * no declarations" answer anyway.
 *
 * Args:
 *   cwd: absolute repo root.
 *   config: the loaded configuration (its `runtime` key names the doc).
 *
 * Returns:
 *   RuntimeConfig | null: the validated document, or null.
 */
function readRuntimeDocument(cwd: string, config: GateforgeConfig): RuntimeConfig | null {
  if (config.runtime === undefined) return null;
  let document: unknown;
  try {
    document = parseYaml(readFileSync(join(cwd, ...config.runtime.split('/')), 'utf8'));
  } catch {
    return null;
  }
  const runtime = RuntimeConfigSchema.safeParse(document);
  return runtime.success ? runtime.data : null;
}

/**
 * Every path the staged runtime document NAMES — a command argument or an
 * `env_files` entry — whether or not the file exists yet.
 *
 * These are RUNTIME INPUTS, not owner-pinned policy: a stack script, a
 * compose override and the `.env` the run loads decide what runs and what
 * the suite sees. They expand the evaluation scope and they join the input
 * snapshot, so a change to any of them changes the receipt's identity.
 * They are deliberately NOT part of the owner-approved policy digest: a
 * port or a base URL changes far too often to justify a re-pin.
 *
 * Args:
 *   cwd: absolute repo root.
 *   config: the loaded configuration (its `runtime` key names the doc).
 *
 * Returns:
 *   string[]: normalized repo-relative posix paths, sorted.
 */
export function runtimeDeclaredInputs(cwd: string, config: GateforgeConfig): string[] {
  const runtime = readRuntimeDocument(cwd, config);
  if (runtime === null) return [];
  const found = new Set<string>();
  for (const argv of runtimeArgvLists(runtime)) {
    for (const token of argv) {
      const resolved = existingRepoFile(cwd, token);
      if (resolved !== null) found.add(resolved);
    }
  }
  for (const envFile of runtime.env_files ?? []) {
    found.add(envFile.split('\\').join('/'));
  }
  return [...found].sort();
}