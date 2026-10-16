/**
 * Trusted-detector registry (red-team round 4, ADR 0003 D4/D6): the
 * ONLY detectors allowed to contribute scan-completeness evidence are
 * Gateforge's bundled packs, mapped here to their FIXED package entry
 * points. Policy coverage rules name detector IDs; this module binds the
 * ID to the genuine package and verifies the configured plugin actually
 * loads from it.
 *
 * Why: a coverage rule matches a configurable ID string, and A1 controls
 * the repository configuration. Without this binding, A1 could aim
 * `gateforge.pack-http` at `./evil.mjs` and report complete coverage
 * without examining anything. With it, arbitrary plugins are positive-
 * only: they can add exposure/lifecycle facts, but no plugin outside the
 * bundled packages can ever contribute scan completeness, whatever ID it
 * claims.
 *
 * Integrity model: the configured module (or spawn target) must resolve
 * INSIDE the trusted package's directory. Path strings are not
 * authenticated cryptographically — editing files under the installed
 * package is a supply-chain escalation outside the A1/A2 model — but a
 * repository-local module can no longer impersonate a bundled detector.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import type { GateforgeConfig } from '@gate-forge/core';
import { UsageError } from './errors.js';
/** Bundled detector id → the package that MUST provide it. Frozen trust base. */
export const TRUSTED_DETECTOR_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  'gateforge.pack-fastapi': '@gate-forge/pack-fastapi',
  'gateforge.pack-http': '@gate-forge/pack-http',
  'gateforge.pack-react-router': '@gate-forge/pack-react-router',
  'gateforge.pack-sqlalchemy': '@gate-forge/pack-sqlalchemy',
  'gateforge.pack-task': '@gate-forge/pack-task',
  'gateforge.pack-auth': '@gate-forge/pack-auth',
  'gateforge.pack-webhook': '@gate-forge/pack-webhook',
  'gateforge.pack-workflow': '@gate-forge/pack-workflow',
  'gateforge.pack-validation': '@gate-forge/pack-validation',
});

const SHORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'gateforge.pack-fastapi': 'pack-fastapi',
  'gateforge.pack-http': 'pack-http',
  'gateforge.pack-react-router': 'pack-react-router',
  'gateforge.pack-sqlalchemy': 'pack-sqlalchemy',
  'gateforge.pack-task': 'pack-task',
  'gateforge.pack-auth': 'pack-auth',
  'gateforge.pack-webhook': 'pack-webhook',
  'gateforge.pack-workflow': 'pack-workflow',
  'gateforge.pack-validation': 'pack-validation',
});

/**
 * Resolves a bundled pack's real installation directory WITHOUT module
 * resolution (the packs are ESM-only with strict `exports` maps, and
 * test runners may not provide `import.meta.resolve`). Walks up from
 * this module to the CLI package root, then probes the monorepo layout
 * (`packages/<short>`) and the installed layouts
 * (`node_modules/@gate-forge/<short>`). The candidate's package.json name
 * must match — a same-named directory is not enough.
 */
function packageDir(nameOrDetectorId: string): string {
  const short =
    SHORT_NAMES[nameOrDetectorId] ?? nameOrDetectorId.replace(/^@gateforge\//, '');
  if (!short) throw new UsageError(`unknown bundled detector '${nameOrDetectorId}'`);
  // Walk up from this file to the CLI package root (holds package.json
  // named @gate-forge/cli).
  const cliRoot = cliPackageRootOrNull(dirname(fileURLToPath(import.meta.url)));
  if (cliRoot === null) {
    throw new UsageError(`cannot locate the @gate-forge/cli package root for '${nameOrDetectorId}'`);
  }
  const candidates = [
    join(dirname(cliRoot), short), // monorepo: packages/<short>
    join(cliRoot, 'node_modules', '@gate-forge', short),
    join(cliRoot, '..', 'node_modules', '@gate-forge', short),
    join(cliRoot, '..', '..', 'node_modules', '@gate-forge', short),
  ];
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { name?: string };
      if (manifest.name === packageNameFor(nameOrDetectorId)) return real;
    } catch {
      // probe next
    }
  }
  throw new UsageError(
    `bundled detector '${nameOrDetectorId}' (${packageNameFor(nameOrDetectorId)}) is not installed; ` +
      'scan-completeness evidence requires the genuine package',
  );
}

/**
 * Walks up from `startDir` to the nearest `package.json` named
 * `@gate-forge/cli` (the CLI package root), or null when there is none.
 * Shared by the trusted-detector resolution and the executed-module
 * resolver so both anchor to the same installation.
 */
function cliPackageRootOrNull(startDir: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 8 && dir !== dirname(dir); depth++) {
    const manifest = join(dir, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === '@gate-forge/cli') return dir;
    } catch {
      // keep walking
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Resolves a bare specifier with Node's OWN resolution from this module's
 * CLI installation, to the entry file URL the loader must import. Bound
 * here (not `import.meta.resolve`) because that syntax is unavailable in
 * test runners (probe: `typeof import.meta.resolve` === undefined under
 * vitest) — `createRequire(<this module>).resolve` runs the same Node
 * resolution algorithm (node_modules walk + `exports`, `default`
 * condition) and works in every runner. The indirection is also the
 * tests' seam: fixtures inject a resolver anchored at their own layout.
 */
const resolveBareEntryFromCliInstall = (specifier: string): string =>
  pathToFileURL(createRequire(import.meta.url).resolve(specifier)).href;

/** Where an in-process plugin's module lives and what the loader must import. */
export interface ExecutedModuleResolution {
  /** Canonical file URL of the entry file — EXACTLY what the loader imports. */
  entryUrl: string;
  /**
   * Real directory of the package providing the entry (bare specifiers),
   * the tree the run-cache key digests; null for repo-relative modules
   * (the key digests the entry file itself).
   */
  packageDir: string | null;
}

/**
 * Resolves the module an in-process plugin will EXECUTE so the run-cache
 * key digests exactly those bytes (plan 20261016_0330). Repo-relative
 * specifiers resolve against the repository root. Anything else is a
 * package specifier: Node's own resolution (via
 * {@link resolveBareEntryFromCliInstall}) picks the entry from the CLI's
 * own installation, the entry is canonicalized with realpath (what ESM
 * loading does anyway, so importing this URL IS importing by name), and
 * the walk up to the `package.json` whose name matches the specifier
 * yields the executed package directory. There is ONE resolution: the
 * loader imports `entryUrl`, the key digests `packageDir` (or the entry
 * file for relative modules) — no second lookup to drift.
 *
 * Args:
 *   moduleSpecifier: configured in-process module (`./x.mjs` or package).
 *   cwd: repository root for relative resolution.
 *   resolveBareEntry: bare-specifier → entry file URL; defaults to the
 *     CLI installation's own Node resolution (test seam for fixtures).
 *
 * Returns:
 *   ExecutedModuleResolution | null: null when the specifier names no
 *   package, Node cannot resolve it, or the entry file is unreadable.
 */
export function resolveExecutedModule(
  moduleSpecifier: string,
  cwd: string,
  resolveBareEntry: (specifier: string) => string = resolveBareEntryFromCliInstall,
): ExecutedModuleResolution | null {
  if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
    return { entryUrl: pathToFileURL(resolve(cwd, moduleSpecifier)).href, packageDir: null };
  }
  // A bare specifier's package name: `@scope/pkg/sub` → `@scope/pkg`,
  // `pkg/sub` → `pkg`; a dangling `@scope` names no package.
  const segments = moduleSpecifier.split('/');
  const packageName = segments[0]!.startsWith('@')
    ? segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : null
    : segments[0]!;
  if (packageName === null || packageName.length === 0) return null;
  let entryPath: string;
  try {
    entryPath = fileURLToPath(resolveBareEntry(moduleSpecifier));
  } catch {
    return null; // unresolvable from the CLI installation → uncacheable
  }
  let realEntry: string;
  try {
    realEntry = realpathSync(entryPath);
  } catch {
    return null;
  }
  let dir = dirname(realEntry);
  for (let depth = 0; depth < 32 && dir !== dirname(dir); depth++) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (parsed.name === packageName) {
        return { entryUrl: pathToFileURL(realEntry).href, packageDir: dir };
      }
    } catch {
      // keep walking
    }
    dir = dirname(dir);
  }
  // The entry lives outside every package.json matching the specifier —
  // refuse to key bytes we cannot attribute (fail closed).
  return null;
}

/** The package name that must provide a bundled detector. */
function packageNameFor(nameOrDetectorId: string): string {
  return TRUSTED_DETECTOR_PACKAGES[nameOrDetectorId] ?? nameOrDetectorId;
}

/**
 * Validates that every policy coverage rule names a TRUSTED detector,
 * that the detector is configured, and that its implementation resolves
 * inside the trusted package. Any violation is a configuration error
 * (exit 2): coverage evidence from anywhere else is untrustworthy by
 * construction, so the run fails closed before discovery.
 *
 * Args:
 *   rules: the policy's declared coverage rules.
 *   plugins: the configured plugins.
 *   cwd: repo root (relative `module:` specifiers resolve against it).
 *
 * Throws:
 *   UsageError: naming the offending rule and the resolution path.
 */
export function validateCoverageTrust(
  rules: ReadonlyArray<{ detector: string }>,
  plugins: GateforgeConfig['plugins'],
  cwd: string,
): void {
  assertBundledDetectors(
    rules.map((rule) => rule.detector),
    plugins,
    cwd,
    'coverage rule',
  );
}

/**
 * Validates that every named detector is a bundled Gateforge detector,
 * configured, and loaded from its genuine package. Shared by coverage
 * rules (scan completeness) and trusted entry-point categories
 * (reachability evidence — red-team round 5).
 */
export function assertBundledDetectors(
  detectorIds: readonly string[],
  plugins: GateforgeConfig['plugins'],
  cwd: string,
  purpose: string,
): void {
  for (const detectorId of detectorIds) {
    const packageName = TRUSTED_DETECTOR_PACKAGES[detectorId];
    if (packageName === undefined) {
      throw new UsageError(
        `${purpose} names detector '${detectorId}', which is not a bundled Gateforge ` +
          'detector; evidence that can suppress obligations or prove completeness is ' +
          `accepted only from bundled detectors (${Object.keys(TRUSTED_DETECTOR_PACKAGES).sort().join(', ')}). ` +
          'Arbitrary plugins are positive-only',
      );
    }
    const plugin = plugins.find((candidate) => candidate.id === detectorId);
    if (plugin === undefined) {
      throw new UsageError(
        `${purpose} requires detector '${detectorId}' (${packageName}) to be configured ` +
          'in .gateforge.yml',
      );
    }
    // Integrity binding: the configured implementation must load from the
    // trusted package's real directory. The bundled in-process wrapper
    // also pins its own subprocess (python) to files inside that same
    // directory, so this one check covers both transports.
    if (plugin.transport === 'in-process') {
      if (plugin.module === undefined) {
        throw new UsageError(
          `${purpose} requires detector '${detectorId}' to declare its bundled module`,
        );
      }
      let configuredReal: string;
      try {
        const configured =
          isAbsolute(plugin.module) || plugin.module.startsWith('./') || plugin.module.startsWith('../')
            ? resolve(cwd, plugin.module)
            : plugin.module === packageName
              ? join(packageDir(detectorId), 'dist', 'index.js')
              : (() => {
                  throw new Error(`expected bundled package '${packageName}'`);
                })();
        configuredReal = realpathSync(configured);
      } catch {
        throw new UsageError(
          `${purpose} requires detector '${detectorId}' to load from its bundled package ` +
            `(${packageName}), but its module '${plugin.module}' does not resolve`,
        );
      }
      const trusted = packageDir(detectorId);
      if (!configuredReal.startsWith(`${trusted}/`)) {
        throw new UsageError(
          `${purpose} requires detector '${detectorId}' to load from its bundled package ` +
            `(${packageName}), but its module '${plugin.module}' resolves to '${configuredReal}' ` +
            'outside it; a repository-local module cannot contribute scan completeness',
        );
      }
    } else {
      // Subprocess transport is only trustworthy for completeness when it
      // is the bundled wrapper's own pinned invocation; require the
      // in-process bundled wrapper instead.
      throw new UsageError(
        `${purpose} requires detector '${detectorId}' to use the bundled in-process ` +
          `wrapper (${packageName}) so its implementation location can be verified; ` +
          "transport 'subprocess' cannot contribute scan completeness",
      );
    }
  }
}
