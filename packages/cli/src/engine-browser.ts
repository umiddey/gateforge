/**
 * Engine-owned browser readiness (the engine's OWN Chromium).
 *
 * The consumer's Playwright is not the only browser a supervised run
 * launches. `@gate-forge/pack-playwright` pins its OWN `playwright`
 * dependency, and the engine's browser — the one
 * `EngineBrowserManager` drives for every `engine-browser` channel case,
 * every `ui.action` / `visible.confirm` fixture primitive and every
 * engine surface drive — is that pinned release's Chromium, never the
 * consumer's.
 *
 * A consumer whose Playwright is a DIFFERENT release therefore proves
 * nothing about the engine browser: the consumer's readiness inspection
 * reads the consumer's registry, answers "every pinned build is
 * installed", and the run still dies in the witness with `Executable
 * doesn't exist at .../chromium_headless_shell-<engine-rev>/…`. That is
 * the real consumer this module exists for: `@playwright/test` 1.62.1
 * with Chromium 1234 installed and correct, while the pack's pinned
 * 1.58.2 wants 1208 and the cache never held it. The consumer check said
 * `ok`; the engine check said `Executable doesn't exist`.
 *
 * Two properties this module keeps, both load-bearing:
 *
 * - It NEVER loads the consumer's Playwright. Resolution is a
 *   filesystem walk from the INSTALLED engine package (its realpath, so
 *   a linked workspace resolves the same release it actually loads at
 *   runtime), reading only `package.json` / `browsers.json`. Nothing
 *   from the repository is imported into the trusted process.
 * - The remedy is the EXACT installed engine's own CLI, not `npx
 *   playwright install`. `npx` resolves whatever Playwright the CWD
 *   reaches — the consumer's release — so it installs the very revision
 *   the cache already holds and the engine stays broken. The command
 *   names the engine's resolved `cli.js` by absolute path instead.
 *
 * The engine's browser requirement is CONSERVATIVE and explicit, and has
 * exactly two producers: the configured runner is `playwright` (its
 * `ui.action` / `visible.confirm` / `persistence.verify` receipts are all
 * served by the engine's own Chromium), or the behavior policy declares a
 * case on the `engine-browser` channel (runner-neutral, so a pytest
 * surface case needs it too). A pytest / API-only repository, and a
 * non-playwright repository whose cases run on `engine-http` /
 * `engine-task`, never need an engine Chromium and are never told to
 * install one.
 */
import { BehaviorPolicySchema } from '@gate-forge/core';
import { parse as parseYaml } from 'yaml';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browserDirectoryName,
  defaultBrowsersPath,
  findBrowsersRegistry,
  installArguments,
  readBrowserBuilds,
  requiredBuilds,
  unlaunchableBuilds,
  type BrowserBuild,
  type BrowserBuildReadiness,
  type BrowserLaunchProbe,
} from './playwright-browsers.js';

/** The behavior-case channel the witness drives through the engine browser. */
const ENGINE_BROWSER_CHANNEL = 'engine-browser';

/** The engine package whose pinned Playwright drives the engine browser. */
const ENGINE_PACKAGE = '@gate-forge/pack-playwright';

/** Directory levels the engine-package walk covers (npm hoisting depth). */
const RESOLUTION_DEPTH = 6;

/**
 * The browsers the engine-owned launcher opens: Chromium, headless
 * (`EngineBrowserManager` launches `{headless: true}`), so its headless
 * shell is required alongside the full build.
 */
const ENGINE_BROWSERS = ['chromium'] as const;

/** How the engine's own browser installation was located. */
export interface EngineBrowserInstall {
  /** Absolute path of the installed engine package's root (realpath). */
  packageRoot: string;
  /** Absolute path of that package's `package.json`. */
  manifest: string;
  /** Absolute path of the pinned `playwright` release's `package.json`. */
  playwrightManifest: string;
  /** The pinned Playwright version, as its manifest states it. */
  playwrightVersion: string;
  /** Absolute path of that release's own install CLI (`cli.js`). */
  installCli: string | null;
}

/** Why the engine's browser could not be located. */
export type EngineBrowserResolution =
  | { kind: 'resolved'; install: EngineBrowserInstall }
  | { kind: 'not-installed' }
  | { kind: 'no-pinned-playwright'; packageRoot: string; manifest: string };

/**
 * Walks up from `start` for `node_modules/<name>/package.json`, the same
 * order Node itself resolves a bare specifier through.
 */
function findInstalledPackageManifest(start: string, name: string): string | null {
  let cursor = start;
  for (let depth = 0; depth < RESOLUTION_DEPTH; depth += 1) {
    const candidate = join(cursor, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(cursor, '..');
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/**
 * Locates the installed engine package and the pinned Playwright release
 * its own browser driver loads.
 *
 * The engine package root is resolved to its REALPATH on purpose: a
 * linked workspace (npm link, a monorepo `file:` install) makes the
 * engine load its sibling `node_modules` beside the real directory, not
 * the consumer's hoisted tree. Reading the link path instead would
 * inspect a release the engine never launches.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   EngineBrowserResolution: the resolved install, or the honest reason
 *   there is none. Never a guess.
 */
export function resolveEngineBrowserInstall(cwd: string): EngineBrowserResolution {
  // The repository first, then the RUNNING engine's own tree: a global
  // or dev-linked CLI has no copy under the repository, and the pack it
  // actually loaded is the one whose pin matters.
  const manifest =
    findInstalledPackageManifest(resolve(cwd), ENGINE_PACKAGE) ??
    findInstalledPackageManifest(dirname(fileURLToPath(import.meta.url)), ENGINE_PACKAGE);
  if (manifest === null) return { kind: 'not-installed' };
  let packageRoot: string;
  try {
    packageRoot = realpathSync(dirname(manifest));
  } catch {
    return { kind: 'not-installed' };
  }
  const pinned = findInstalledPackageManifest(packageRoot, 'playwright');
  if (pinned === null) return { kind: 'no-pinned-playwright', packageRoot, manifest };
  // The pin is read from the manifest the engine actually resolves;
  // `realpathSync` again so a linked Playwright is inspected where it
  // lives, matching what `import { chromium } from 'playwright'` loads.
  let playwrightManifest: string;
  try {
    playwrightManifest = realpathSync(pinned);
  } catch {
    return { kind: 'no-pinned-playwright', packageRoot, manifest };
  }
  // A manifest the engine resolves but that states no readable version
  // never invents a revision: the caller keeps its historical wording.
  let version: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(playwrightManifest, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string') version = parsed.version;
  } catch {
    version = null;
  }
  if (version === null) return { kind: 'no-pinned-playwright', packageRoot, manifest };
  const cli = join(dirname(playwrightManifest), 'cli.js');
  return {
    kind: 'resolved',
    install: {
      packageRoot,
      manifest,
      playwrightManifest,
      playwrightVersion: version,
      installCli: existsSync(cli) ? cli : null,
    },
  };
}

/** The engine-owned Chromium builds an inspected release pins. */
function engineRequiredBuilds(playwrightManifest: string): BrowserBuild[] {
  const registry = findBrowsersRegistry(playwrightManifest);
  if (registry === null) return [];
  // The engine browser is always headless Chromium and never reads a
  // consumer Playwright config, so the consumer's `browserName` /
  // `headless: false` scan never applies here.
  return requiredBuilds(readBrowserBuilds(registry), [...ENGINE_BROWSERS], true);
}

/** The engine-owned build readiness against the cache the run will read. */
export interface EngineBrowserReadiness {
  /** The resolved install the facts came from (null when unresolved). */
  install: EngineBrowserInstall | null;
  /** Browser cache directory — the same one the witness child reads. */
  browsersPath: string;
  /** Builds the engine-owned launcher opens. */
  required: BrowserBuild[];
  /** The subset installed in the cache. */
  installed: BrowserBuild[];
  /** The subset missing: the engine browser cannot open these. */
  missing: BrowserBuild[];
  /** Installed builds this machine cannot start. */
  unlaunchable: BrowserLaunchProbe[];
}

/**
 * Inspects whether the engine-owned Chromium builds are installed in the
 * cache and can start on this machine.
 *
 * The cache directory comes from the SAME
 * `PLAYWRIGHT_BROWSERS_PATH`-first resolution the supervised run and the
 * consumer check use (`RUNNER_SYSTEM_ALLOWLIST` forwards that variable to
 * the witness child), so this never reports ready against one directory
 * while the engine launches from another.
 *
 * Args:
 *   install: the resolved engine install.
 *   env: operator environment (`PLAYWRIGHT_BROWSERS_PATH`).
 *
 * Returns:
 *   EngineBrowserReadiness: required, installed, missing and unlaunchable
 *   builds. An empty `required` means the pinned release ships no
 *   readable registry — the caller keeps its historical wording rather
 *   than inventing revisions.
 */
export function inspectEngineBrowserBuilds(
  install: EngineBrowserInstall,
  env: NodeJS.ProcessEnv = process.env,
): EngineBrowserReadiness {
  const browsersPath = defaultBrowsersPath(env);
  const required = engineRequiredBuilds(install.playwrightManifest);
  const installed: BrowserBuild[] = [];
  const missing: BrowserBuild[] = [];
  for (const build of required) {
    if (existsSync(join(browsersPath, browserDirectoryName(build)))) installed.push(build);
    else missing.push(build);
  }
  const readiness: BrowserBuildReadiness = {
    registry: findBrowsersRegistry(install.playwrightManifest),
    browsersPath,
    required,
    installed,
    missing,
  };
  return {
    install,
    browsersPath,
    required,
    installed,
    missing,
    unlaunchable: unlaunchableBuilds(readiness),
  };
}

/**
 * The install command for the engine's OWN pinned release, by absolute
 * path.
 *
 * `npx playwright install chromium` is wrong here and the operator must
 * not be told it: `npx` resolves the Playwright the command's directory
 * reaches — the CONSUMER's release — so it installs the revision the
 * cache already holds and the engine browser stays exactly as broken.
 * Naming the engine's own resolved `cli.js` installs the release the
 * engine actually launches.
 *
 * Two variables ride along, and both are load-bearing:
 *
 * - `PLAYWRIGHT_BROWSERS_PATH` writes into the cache this inspection
 *   actually read, so the operator never ends up with the build in one
 *   directory and the run looking in another.
 * - `PLAYWRIGHT_SKIP_BROWSER_GC=1` is not optional. Playwright's
 *   installer garbage-collects every build its OWN registry does not
 *   list, so without it the engine's `install` DELETES the consumer's
 *   Chromium 1234 out of the shared default cache and the remedy trades
 *   one broken run for another. This was observed, not assumed: running
 *   the command without the guard printed
 *   `Removing unused browser at <cache>/chromium-1234` and left the
 *   consumer's `runner` line failing.
 *
 * Args:
 *   install: the resolved engine install.
 *   arguments: the install arguments (browser names).
 *   browsersPath: the cache the install must write into.
 *
 * Returns:
 *   string: the exact command, or '' when the pinned release ships no
 *   install CLI to name.
 */
export function engineInstallCommand(
  install: EngineBrowserInstall,
  arguments_: string,
  browsersPath: string,
): string {
  if (install.installCli === null) return '';
  return (
    `PLAYWRIGHT_BROWSERS_PATH='${browsersPath}' PLAYWRIGHT_SKIP_BROWSER_GC=1 ` +
    `node '${install.installCli}' install ${arguments_}`
  );
}

/**
 * The `install-deps` command for the engine's own release: the system
 * libraries a bare Linux image lacks.
 *
 * Args:
 *   install: the resolved engine install.
 *   arguments: the install arguments (browser names).
 *
 * Returns:
 *   string: the exact command, or '' when the pinned release ships no
 *   install CLI to name.
 */
export function engineInstallDepsCommand(install: EngineBrowserInstall, arguments_: string): string {
  if (install.installCli === null) return '';
  return `node '${install.installCli}' install-deps ${arguments_}`;
}

/**
 * The one-line summary for an engine-owned browser that is missing or
 * cannot start, naming the EXACT engine install command.
 *
 * It is deliberately explicit about whose browser it is: the sentence
 * leads with the engine's pinned release, because the consumer's runner
 * line already reported its own builds as installed and the operator
 * would otherwise conclude nothing is wrong.
 *
 * Args:
 *   readiness: the engine-owned inspection result.
 *
 * Returns:
 *   string: the sentence for the readiness line; '' when nothing was
 *   observed, or when the pinned release ships no readable registry.
 */
export function engineBrowserSummary(readiness: EngineBrowserReadiness): string {
  const install = readiness.install;
  if (install === null) return '';
  const who = `the engine-owned browser (playwright ${install.playwrightVersion} pinned by ${ENGINE_PACKAGE})`;
  if (readiness.missing.length > 0) {
    const missing = readiness.missing.map((build) => browserDirectoryName(build)).join(', ');
    const command = engineInstallCommand(install, installArguments(readiness.missing), readiness.browsersPath);
    const remedy =
      command === ''
        ? `install the ${missing} build(s) of playwright ${install.playwrightVersion} into '${readiness.browsersPath}'`
        : `fix: run \`${command}\``;
    return (
      `${who} is NOT ready: its pinned builds ${missing} are missing from '${readiness.browsersPath}' — ` +
      `your test runner's own Chromium is a different Playwright release and cannot serve it, so every engine-browser ` +
      `case fails with "Executable doesn't exist"; ${remedy}`
    );
  }
  const launch = readiness.unlaunchable[0];
  if (launch !== undefined) {
    const command = engineInstallDepsCommand(install, installArguments([launch.build]));
    const reason = launch.reason === '' ? '' : `: ${launch.reason}`;
    const remedy = command === '' ? '' : `; fix: run \`${command}\` (needs root or sudo)`;
    return (
      `${who} is NOT ready: '${launch.directory}' is installed but cannot start on this machine${reason}${remedy}`
    );
  }
  if (readiness.required.length === 0) {
    return `${who} ships no readable browser registry (nothing to install)`;
  }
  return (
    `${who} is ready: ${readiness.required.map((build) => browserDirectoryName(build)).join(', ')} ` +
    `installed under '${readiness.browsersPath}'`
  );
}

/**
 * Whether the repository requires ENGINE-controlled browser evidence.
 *
 * Two producers exist, and both are explicit — never inferred from
 * "this project has a browser somewhere":
 *
 * - the CONFIGURED RUNNER is `playwright`. Its evidence primitives
 *   (`evidence.ui.action`, `evidence.visible.confirm`,
 *   `evidence.persistence.verify`) are Playwright-only — they take the
 *   suite's own `Page` — and the witness serves every one of them by
 *   driving the ENGINE's Chromium through `EngineBrowserManager`. That
 *   is the real consumer this check exists for: a witnessed Playwright
 *   suite with no behavior policy at all still opens the engine browser
 *   the moment it confirms a receipt.
 * - the behavior policy declares a case on the `engine-browser` channel.
 *   That channel is runner-neutral, so a pytest / vitest / cypress
 *   repository with a surface case needs the engine browser too.
 *
 * Everything else needs nothing: a pytest or API-only repository, a
 * non-playwright repository whose policy drives only `engine-http` /
 * `engine-task`, and a repository with no policy at all are reported as
 * not requiring it. None of them is ever told to install a Chromium it
 * will never launch.
 *
 * A policy that cannot be read or parsed never manufactures a
 * requirement on its own: the `behavior-profile` doctor line already
 * fails such a document closed.
 *
 * Args:
 *   cwd: repository root.
 *   runner: the configured runner (`playwright`, `pytest`, …).
 *   behaviorPolicy: the configured policy path (undefined when unset).
 *
 * Returns:
 *   {required, reason}: whether engine-controlled browser evidence is
 *   required, and the honest sentence either way.
 */
export function engineBrowserRequirement(
  cwd: string,
  runner: string,
  behaviorPolicy: string | undefined,
): { required: boolean; reason: string } {
  const playwrightReason =
    `the configured runner 'playwright' serves every ui.action / visible.confirm / persistence.verify ` +
    "receipt through the engine's own browser";
  if (behaviorPolicy !== undefined) {
    try {
      const document = BehaviorPolicySchema.safeParse(
        JSON.parse(JSON.stringify(parseYaml(readFileSync(resolve(cwd, behaviorPolicy), 'utf8')))),
      );
      if (document.success) {
        const cases = [
          ...document.data.endpoints.flatMap((endpoint) => endpoint.cases),
          ...document.data.resources.flatMap((resource) => resource.cases),
        ];
        const declaring = cases.filter((entry) => entry.channel === ENGINE_BROWSER_CHANNEL).length;
        if (declaring > 0) {
          return {
            required: true,
            reason: `${String(declaring)} declared behavior case(s) drive the 'engine-browser' channel`,
          };
        }
        return {
          required: runner === 'playwright',
          reason:
            runner === 'playwright'
              ? playwrightReason
              : `no declared behavior case drives the 'engine-browser' channel (${String(cases.length)} case(s) declared) and the configured runner '${runner}' proves its cases without an engine browser`,
        };
      }
    } catch {
      // Unreadable YAML: fall through to the runner-based answer, which
      // needs no document at all. The behavior-profile check owns that
      // document's own failure.
    }
  }
  return runner === 'playwright'
    ? { required: true, reason: playwrightReason }
    : {
        required: false,
        reason: `the configured runner '${runner}' proves its cases without an engine browser, and no declared case drives the 'engine-browser' channel`,
      };
}