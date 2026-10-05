/**
 * Every runner configuration the CONFIGURED runner can be pointed at.
 *
 * The resolved configuration is only ONE of them. A repository
 * legitimately keeps several — `playwright.config.ts` for the suite the
 * gate reads, plus `dev-stack` / `headed` / `demo` wrappers — and a
 * repository's `package.json` scripts name them. Every one of them
 * declares how tests run, so every one of them is attributable, and
 * what a configuration NAMES (its reporter, global setup and teardown)
 * is test infrastructure exactly like what the suite's own tests import.
 *
 * This module is the ONE enumeration: discovery roots the
 * test-infrastructure import graph here, and the CLI's scope inputs read
 * the same list, so the two can never disagree about which
 * configurations exist.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { findPlaywrightConfig } from './reconcile.js';

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
export function existingRepoFile(cwd: string, token: string): string | null {
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