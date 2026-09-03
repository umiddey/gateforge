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
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import type { GateforgeConfig } from '@gateforge/core';
import { UsageError } from './errors.js';
/** Bundled detector id → the package that MUST provide it. Frozen trust base. */
export const TRUSTED_DETECTOR_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  'gateforge.pack-fastapi': '@gateforge/pack-fastapi',
  'gateforge.pack-http': '@gateforge/pack-http',
  'gateforge.pack-sqlalchemy': '@gateforge/pack-sqlalchemy',
  'gateforge.pack-task': '@gateforge/pack-task',
  'gateforge.pack-auth': '@gateforge/pack-auth',
  'gateforge.pack-webhook': '@gateforge/pack-webhook',
  'gateforge.pack-workflow': '@gateforge/pack-workflow',
  'gateforge.pack-validation': '@gateforge/pack-validation',
});

const SHORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'gateforge.pack-fastapi': 'pack-fastapi',
  'gateforge.pack-http': 'pack-http',
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
 * (`node_modules/@gateforge/<short>`). The candidate's package.json name
 * must match — a same-named directory is not enough.
 */
function packageDir(nameOrDetectorId: string): string {
  const short =
    SHORT_NAMES[nameOrDetectorId] ?? nameOrDetectorId.replace(/^@gateforge\//, '');
  if (!short) throw new UsageError(`unknown bundled detector '${nameOrDetectorId}'`);
  // Walk up from this file to the CLI package root (holds package.json
  // named @gateforge/cli).
  let dir = dirname(dirname(fileURLToPath(import.meta.url))); // src/ -> package root
  let cliRoot: string | null = null;
  for (let depth = 0; depth < 8 && dir !== dirname(dir); depth++) {
    const manifest = join(dir, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === '@gateforge/cli') {
        cliRoot = dir;
        break;
      }
    } catch {
      // keep walking
    }
    dir = dirname(dir);
  }
  if (cliRoot === null) {
    throw new UsageError(`cannot locate the @gateforge/cli package root for '${nameOrDetectorId}'`);
  }
  const candidates = [
    join(dirname(cliRoot), short), // monorepo: packages/<short>
    join(cliRoot, 'node_modules', '@gateforge', short),
    join(cliRoot, '..', 'node_modules', '@gateforge', short),
    join(cliRoot, '..', '..', 'node_modules', '@gateforge', short),
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
      const configured = isAbsolute(plugin.module)
        ? plugin.module
        : resolve(cwd, plugin.module);
      let configuredReal: string;
      try {
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
