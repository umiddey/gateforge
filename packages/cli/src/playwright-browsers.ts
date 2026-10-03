/**
 * Browser-build readiness for the resolved Playwright runner.
 *
 * A supervised run launches the CONSUMER's Playwright — the package that
 * resolves next to its own config (see `findRunnerManifest`), often a
 * different release from the one Gateforge hoists. Every release pins
 * its own browser revisions in the `browsers.json` of the package it
 * will launch, so a cache holding ANOTHER release's builds satisfies
 * "the directory is nonempty" while every test still dies with
 * `Executable doesn't exist at .../chromium_headless_shell-<rev>/…`.
 *
 * This module reads the resolved runner's own registry and reports the
 * builds the config's own projects would launch, whether each is
 * installed in the browser cache, and — on Linux, for an INSTALLED
 * chromium-family build — whether this machine can actually start it.
 * The launch probe executes the browser's own binary with `--version`
 * and nothing else: it never writes to the cache, never opens a
 * browser, and never touches a browser that is not there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** One browser build a Playwright release pins. */
export interface BrowserBuild {
  /** Registry browser name (e.g. `chromium-headless-shell`). */
  name: string;
  /** The revision this release pins for that browser. */
  revision: string;
}

/** The outcome of one browser-build inspection. */
export interface BrowserBuildReadiness {
  /** The registry file the facts came from, or null when there is none. */
  registry: string | null;
  /** Browser cache directory the check looked in. */
  browsersPath: string;
  /** Every build the resolved runner pins. */
  required: BrowserBuild[];
  /** The subset that is installed in the cache. */
  installed: BrowserBuild[];
  /** The subset that is missing (the run cannot launch these). */
  missing: BrowserBuild[];
}

/** The npm packages whose `browsers.json` pins a Playwright release. */
const REGISTRY_PACKAGES = ['playwright-core', 'playwright', '@playwright/test'] as const;

/** The browser a Playwright project uses when its config names none. */
const DEFAULT_BROWSER = 'chromium';

/** The cache directory Playwright installs browsers into by default. */
export function defaultBrowsersPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['PLAYWRIGHT_BROWSERS_PATH'] ?? join(homedir(), '.cache', 'ms-playwright');
}

/**
 * The on-disk directory name Playwright gives one browser build: the
 * registry name with dashes replaced by underscores, then the revision
 * (`chromium_headless_shell-1208`).
 *
 * Args:
 *   build: one pinned browser build.
 *
 * Returns:
 *   string: the cache directory name for that build.
 */
export function browserDirectoryName(build: BrowserBuild): string {
  return `${build.name.replace(/-/g, '_')}-${build.revision}`;
}

/** Milliseconds allowed for one browser `--version` launch probe. */
const LAUNCH_PROBE_TIMEOUT_MS = 10_000;

/** Maximum bytes read from the probe's own streams. */
const LAUNCH_PROBE_BUFFER = 64 * 1024;

/**
 * Where each chromium-family build keeps its executable inside the
 * build directory, as the installed Playwright's own registry lays it
 * out (`playwright-core/lib/server/registry/index.js`,
 * `EXECUTABLE_PATHS`). x64 first, then arm64: the first entry that
 * exists is the one this machine installed, and a build with neither is
 * not probed at all.
 */
const CHROMIUM_LINUX_EXECUTABLES: Record<string, readonly string[]> = {
  chromium: ['chrome-linux64/chrome', 'chrome-linux/chrome'],
  'chromium-headless-shell': [
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-linux/headless_shell',
  ],
  'chromium-tip-of-tree': ['chrome-linux64/chrome', 'chrome-linux/chrome'],
  'chromium-tip-of-tree-headless-shell': [
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-linux/headless_shell',
  ],
};

/** The outcome of launching one installed browser build. */
export interface BrowserLaunchProbe {
  /** The build that was launched. */
  build: BrowserBuild;
  /** The build directory inside the browser cache. */
  directory: string;
  /** The executable that was launched. */
  executable: string;
  /** True when the build started and reported a version. */
  started: boolean;
  /** The first non-empty stderr line, when the build did not start. */
  reason: string;
}

/** Injection points for {@link probeBrowserLaunch} (tests supply both). */
export interface BrowserLaunchProbeOptions {
  /** Platform the probe runs on; the loader diagnosis is a Linux one. */
  platform?: string;
  /** Millisecond budget for the launch. */
  timeoutMs?: number;
}

/**
 * Launches one INSTALLED chromium-family build with `--version` and
 * reports whether this machine can actually start it.
 *
 * Installed is not startable: a bare Linux image (a container, a CI
 * image, WSL) has no browser system libraries, and the dynamic loader
 * then fails before `main` — the browser's own output is empty, the
 * exit code is 127, and the only diagnostic anywhere is the loader's
 * own line. The probe reads that one line so the operator is told the
 * cause instead of a downstream "Target page, context or browser has
 * been closed".
 *
 * It claims NOTHING it did not observe: a non-Linux platform, a
 * non-chromium-family build, and a build with no executable file all
 * return `null`, which every caller reports as silence, never as a
 * failure.
 *
 * Args:
   build: the installed build to launch.
   browsersPath: the browser cache directory.
   options: platform and deadline overrides.
 *
 * Returns:
   BrowserLaunchProbe | null: the observed launch, or null when there
   is nothing to claim.
 */
export function probeBrowserLaunch(
  build: BrowserBuild,
  browsersPath: string,
  options: BrowserLaunchProbeOptions = {},
): BrowserLaunchProbe | null {
  if ((options.platform ?? process.platform) !== 'linux') return null;
  const candidates = CHROMIUM_LINUX_EXECUTABLES[build.name];
  if (candidates === undefined) return null;
  const directory = join(browsersPath, browserDirectoryName(build));
  for (const candidate of candidates) {
    const executable = join(directory, ...candidate.split('/'));
    if (!existsSync(executable)) continue;
    const result = spawnSync(executable, ['--version'], {
      // No shell: the executable is a path inside a browser cache, not
      // something an operator's config could shape into a command.
      shell: false,
      env: process.env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? LAUNCH_PROBE_TIMEOUT_MS,
      maxBuffer: LAUNCH_PROBE_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const reason =
      (result.stderr ?? '')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? '';
    return {
      build,
      directory,
      executable,
      started: result.error === undefined && result.status === 0,
      reason,
    };
  }
  return null;
}

/**
 * The builds that are installed but cannot start on this machine.
 *
 * Args:
   readiness: the inspection result.
   options: platform and deadline overrides.
 *
 * Returns:
   BrowserLaunchProbe[]: one entry per unlaunchable build, in registry
   order; empty when every installed build starts (or is unprobeable).
 */
export function unlaunchableBuilds(
  readiness: BrowserBuildReadiness,
  options: BrowserLaunchProbeOptions = {},
): BrowserLaunchProbe[] {
  return readiness.installed
    .map((build) => probeBrowserLaunch(build, readiness.browsersPath, options))
    .filter((probe): probe is BrowserLaunchProbe => probe !== null && !probe.started);
}

/**
 * The one-line summary for builds that are installed but cannot start:
 * the loader's own first line plus the exact `npx playwright
 * install-deps` that installs the browser's system libraries (which
 * needs root or sudo — the reason a bare container is red out of the
 * box).
 *
 * Args:
   probes: the unlaunchable builds.
   installCwd: the directory the fix command must run in.
 *
 * Returns:
   string: the sentence for the runner's readiness line; '' when
   nothing was observed.
 */
export function browserLaunchSummary(probes: readonly BrowserLaunchProbe[], installCwd: string): string {
  const first = probes[0];
  if (first === undefined) return '';
  // ONE build is named, with its own loader line: a second broken build
  // of the same browser fails for the same reason, and repeating the
  // sentence per build buries the fix. The fix still covers every one.
  const named =
    `'${first.directory}' is installed but cannot start on this machine` +
    (first.reason === '' ? '' : `: ${first.reason}`);
  return (
    `the browser build ${named}; ` +
    `fix: run \`npx playwright install-deps ${installArguments(probes.map((probe) => probe.build))}\` in '${installCwd}' ` +
    "(installs the browser's system libraries; needs root or sudo)"
  );
}

/**
 * Finds the `browsers.json` of the Playwright release a resolved runner
 * package will launch: the `playwright-core` registry it resolves to
 * (its own nested install first, then the owning `node_modules`
 * upward), else a registry the package ships itself.
 *
 * Args:
 *   manifest: absolute path of the resolved runner's `package.json`.
 *
 * Returns:
 *   string | null: the absolute registry path, or null when the runner
 *   ships no readable registry (an unresolvable install never invents
 *   revisions).
 */
export function findBrowsersRegistry(manifest: string): string | null {
  let cursor = dirname(manifest);
  for (let depth = 0; depth < 6; depth += 1) {
    for (const name of REGISTRY_PACKAGES) {
      const candidate = join(cursor, 'node_modules', name, 'browsers.json');
      if (existsSync(candidate)) return candidate;
    }
    const own = join(cursor, 'browsers.json');
    if (existsSync(own)) return own;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * Parses a Playwright `browsers.json` into the builds it pins.
 *
 * Args:
 *   registry: absolute path of the registry file.
 *
 * Returns:
 *   BrowserBuild[]: the pinned builds in file order; empty when the file
 *   is unreadable or names no browser.
 */
export function readBrowserBuilds(registry: string): BrowserBuild[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registry, 'utf8')) as unknown;
  } catch {
    return [];
  }
  const entries =
    typeof parsed === 'object' && parsed !== null && 'browsers' in parsed
      ? (parsed as { browsers: unknown }).browsers
      : [];
  if (!Array.isArray(entries)) return [];
  const builds: BrowserBuild[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = (entry as { name?: unknown }).name;
    const revision = (entry as { revision?: unknown }).revision;
    if (typeof name === 'string' && typeof revision === 'string') builds.push({ name, revision });
  }
  return builds;
}

/**
 * The browsers a Playwright config's own projects launch: every
 * `browserName` it names, or chromium when it names none. A config is
 * TypeScript, so this reads its text — the cheapest honest source for
 * "which browser will this suite open".
 *
 * Args:
 *   configText: the Playwright config's source.
 *
 * Returns:
 *   {browsers, headless}: the browser names in first-declaration order,
 *   and whether the config leaves headless mode on (the default).
 */
export function configBrowsers(configText: string): { browsers: string[]; headless: boolean } {
  const browsers: string[] = [];
  for (const match of configText.matchAll(/browserName\s*:\s*['"]([a-z]+)['"]/g)) {
    const name = match[1];
    if (name !== undefined && !browsers.includes(name)) browsers.push(name);
  }
  return {
    browsers: browsers.length > 0 ? browsers : [DEFAULT_BROWSER],
    headless: !/headless\s*:\s*false/.test(configText),
  };
}

/**
 * Selects the builds one config would launch from a registry: each
 * named browser's own build, plus its headless shell while the config
 * leaves headless mode on (that is the build a headless launch opens).
 *
 * Args:
 *   builds: every build the registry pins.
 *   wanted: the browsers the config launches.
 *   headless: whether headless mode stays on.
 *
 * Returns:
 *   BrowserBuild[]: the builds to require, in registry order.
 */
export function requiredBuilds(
  builds: readonly BrowserBuild[],
  wanted: readonly string[],
  headless: boolean,
): BrowserBuild[] {
  return builds.filter(
    (build) =>
      wanted.includes(build.name) || (headless && wanted.includes(build.name.replace(/-headless-shell$/, ''))),
  );
}

/**
 * Inspects whether every build the resolved runner needs for the
 * config's projects is present in the browser cache. A runner without a
 * readable registry is reported as `registry: null` with no required
 * builds: the caller then keeps its historical wording rather than
 * inventing revisions.
 *
 * Args:
 *   manifest: absolute path of the resolved runner's `package.json`.
 *   configText: the Playwright config's source ('' when there is none).
 *   env: operator environment (`PLAYWRIGHT_BROWSERS_PATH`).
 *
 * Returns:
 *   BrowserBuildReadiness: the needed builds, present and missing.
 */
export function inspectBrowserBuilds(
  manifest: string,
  configText: string,
  env: NodeJS.ProcessEnv = process.env,
): BrowserBuildReadiness {
  const browsersPath = defaultBrowsersPath(env);
  const registry = findBrowsersRegistry(manifest);
  if (registry === null) {
    return { registry: null, browsersPath, required: [], installed: [], missing: [] };
  }
  const { browsers, headless } = configBrowsers(configText);
  const required = requiredBuilds(readBrowserBuilds(registry), browsers, headless);
  const installed: BrowserBuild[] = [];
  const missing: BrowserBuild[] = [];
  for (const build of required) {
    if (existsSync(join(browsersPath, browserDirectoryName(build)))) installed.push(build);
    else missing.push(build);
  }
  return { registry, browsersPath, required, installed, missing };
}

/**
 * The `npx playwright install` argument that installs every missing
 * build: the browser names behind them (chromium covers its headless
 * shell), in first-appearance order.
 *
 * Args:
 *   missing: the builds the run cannot launch.
 *
 * Returns:
 *   string: the space-separated install arguments ('' when empty).
 */
export function installArguments(missing: readonly BrowserBuild[]): string {
  const names: string[] = [];
  for (const build of missing) {
    const name = build.name.replace(/-headless-shell$/, '');
    if (!names.includes(name)) names.push(name);
  }
  return names.join(' ');
}

/**
 * The one-line summary of a readiness inspection, naming the exact
 * `npx playwright install` a missing build needs — run from the
 * directory whose config resolves this runner, which is where the
 * consumer's Playwright lives.
 *
 * Args:
 *   readiness: the inspection result.
 *   installCwd: the directory the fix command must run in.
 *
 * Returns:
 *   string: the sentence appended to the runner's readiness line; ''
 *   when the runner pins no readable registry.
 */
export function browserBuildSummary(readiness: BrowserBuildReadiness, installCwd: string): string {
  if (readiness.registry === null) return '';
  if (readiness.required.length === 0) {
    return `its browser registry names no build this configuration launches (nothing to install)`;
  }
  if (readiness.missing.length === 0) {
    return (
      `every browser build this runner pins for these projects is installed ` +
      `(${readiness.required.map((build) => browserDirectoryName(build)).join(', ')}) under '${readiness.browsersPath}'`
    );
  }
  const missing = readiness.missing.map((build) => browserDirectoryName(build)).join(', ');
  return (
    `the browser builds this runner pins for these projects are NOT installed: ${missing} — the cache holds ` +
    'other Playwright revisions, so every supervised test would fail with "Executable doesn\'t exist"; ' +
    `fix: run \`npx playwright install ${installArguments(readiness.missing)}\` in '${installCwd}'`
  );
}
