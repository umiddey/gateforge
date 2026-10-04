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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { RuntimeConfigSchema, type GateforgeConfig, type RuntimeConfig } from '@gate-forge/core';
import { findPlaywrightConfig } from '@gate-forge/pack-playwright';
import { parse as parseYaml } from 'yaml';



/**
 * A Playwright configuration at the repository root, including the
 * suffixed WRAPPERS a repository legitimately keeps beside the suite
 * config (`playwright.config.dev-stack.ts`, `.headed-run.ts`, …).
 * Playwright resolves only the first of them, but every one of them
 * declares how tests run, so every one of them is attributable.
 */
const PLAYWRIGHT_CONFIG_PATTERN = /^playwright\.config(?:\.[^.]+)*\.[cm]?[jt]sx?$/;

/** Candidate config file names per non-Playwright runner (probe order). */
const RUNNER_CONFIG_CANDIDATES: Record<string, readonly string[]> = {
  vitest: [
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.js',
    'vitest.config.mjs',
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.js',
  ],
  cypress: [
    'cypress.config.ts',
    'cypress.config.mts',
    'cypress.config.js',
    'cypress.config.cjs',
    'cypress.config.mjs',
  ],
};


/**
 * Whether one token names a file that exists inside the repository.
 *
 * Args:
 *   cwd: absolute repo root.
 *   token: one argv token or shell word.
 *
 * Returns:
 *   string | null: the normalized repo-relative posix path, or null when
 *   the token is a flag, a URL, an absolute path outside the repository,
 *   or names nothing that exists (a `${service:id:port}` placeholder, a
 *   binary on PATH, a directory the repository does not have).
 */
function existingRepoFile(cwd: string, token: string): string | null {
  if (token.length === 0 || token.startsWith('-')) return null;
  if (token.includes('://') || token.includes('${')) return null;
  const absolute = isAbsolute(token) ? token : resolve(cwd, token);
  const repoRelative = relative(cwd, absolute).split('\\').join('/');
  if (repoRelative.length === 0 || repoRelative.startsWith('../')) return null;
  if (!existsSync(absolute)) return null;
  return repoRelative;
}

/**
 * The config paths a repository's `package.json` scripts name.
 *
 * Only the three spellings npm/playwright actually accept are read
 * (`--config=<path>`, `--config <path>`, `-c <path>`), and only tokens
 * that resolve to an existing file inside the repository survive — a
 * script naming a path that does not exist contributes nothing.
 *
 * Args:
 *   cwd: absolute repo root.
 *
 * Returns:
 *   string[]: normalized repo-relative config paths, sorted.
 */
function scriptNamedConfigs(cwd: string): string[] {
  const manifest = join(cwd, 'package.json');
  if (!existsSync(manifest)) return [];
  let scripts: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    scripts = 'scripts' in parsed ? parsed.scripts : undefined;
  } catch {
    // An unreadable manifest is not this function's finding: the gate's
    // own manifest handling reports it.
    return [];
  }
  if (typeof scripts !== 'object' || scripts === null) return [];
  const found = new Set<string>();
  for (const command of Object.values(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string') continue;
    const tokens = command.split(/\s+/).filter((token) => token.length > 0);
    for (const [index, token] of tokens.entries()) {
      const inline = token.startsWith('--config=') ? token.slice('--config='.length) : null;
      const separate =
        token === '--config' || token === '-c' ? (tokens[index + 1] ?? null) : null;
      for (const candidate of [inline, separate]) {
        if (candidate === null) continue;
        const resolved = existingRepoFile(cwd, candidate);
        if (resolved !== null) found.add(resolved);
      }
    }
  }
  return [...found].sort();
}

/**
 * Every runner configuration the CONFIGURED runner can be pointed at:
 * the resolved one first, then every sibling config name at the
 * repository root, then every config a `package.json` script names.
 *
 * Args:
 *   cwd: absolute repo root.
 *   runner: the configured runner name (`config.runner`).
 *
 * Returns:
 *   string[]: normalized repo-relative posix paths, sorted, always
 *   including the resolved configuration when one exists.
 */
export function runnerConfigPaths(cwd: string, runner: string): string[] {
  const found = new Set<string>();
  if (runner === 'playwright') {
    const resolved = findPlaywrightConfig(cwd);
    if (resolved !== null) found.add(resolved);
    let entries: string[] = [];
    try {
      entries = readdirSync(cwd);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (PLAYWRIGHT_CONFIG_PATTERN.test(name) && existsSync(join(cwd, name))) {
        found.add(name);
      }
    }
  } else {
    for (const name of RUNNER_CONFIG_CANDIDATES[runner] ?? []) {
      if (existsSync(join(cwd, name))) found.add(name);
    }
  }
  for (const name of scriptNamedConfigs(cwd)) found.add(name);
  return [...found].sort();
}

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