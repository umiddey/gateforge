import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './commands/common.js';

/** Public identity of the engine installation that produced a report. */
export interface EngineIdentity {
  /** Package version. */
  version: string;
  /** Registry package or the local package path. */
  source: string;
  /** True when CI will not install the local workspace code automatically. */
  unpublished: boolean;
}

/**
 * How the installed engine reached `node_modules`, as far as npm's own
 * install metadata can prove it.
 *
 * - `registry`: the hidden lockfile resolves the package to a registry URL.
 * - `file`: a tarball/directory (`file:`) specifier — an install npm
 *   performed from bytes on disk, which a CI `npm install
 *   @gate-forge/cli@<version>` would NOT reproduce.
 * - `local-path`: a checkout used directly (no `node_modules` install).
 * - `unknown`: installed, but no install metadata is readable (a package
 *   manager that writes no hidden lockfile, a pruned install).
 */
export type EngineInstallKind = 'registry' | 'file' | 'local-path' | 'unknown';

/** Provenance of the installed engine, with the specifier that proves it. */
export interface EngineInstallProvenance {
  kind: EngineInstallKind;
  specifier: string | null;
}

/** Minimal shape of the hidden npm lockfile entries discovery reads. */
interface HiddenLockEntry {
  resolved?: unknown;
}

/**
 * Classifies one npm `resolved` specifier: a registry URL is the
 * registry, everything else that names a local artifact is a file
 * install.
 *
 * Args:
 *   resolved: the `resolved` string from the install metadata.
 *
 * Returns:
 *   EngineInstallKind: `registry` or `file`.
 */
function kindOfResolved(resolved: string): EngineInstallKind {
  return /^https?:\/\/registry\./.test(resolved) ? 'registry' : 'file';
}

/**
 * Reads npm's install metadata for the installed engine package.
 *
 * Two sources, in npm's own order of reliability: the hidden
 * `node_modules/.package-lock.json` of the OWNING `node_modules`
 * directory (the one whose key path is this package), then the legacy
 * `_resolved`/`_from` keys npm writes into the installed manifest. No
 * metadata means `unknown`, never an assumed registry.
 *
 * Args:
 *   packageRoot: absolute path of the installed `@gate-forge/cli`.
 *
 * Returns:
 *   EngineInstallProvenance: the install kind and the proving specifier.
 */
export function engineInstallProvenance(packageRoot: string | null): EngineInstallProvenance {
  if (packageRoot === null || !packageRoot.split('\\').join('/').includes('/node_modules/')) {
    return { kind: 'local-path', specifier: null };
  }
  // The hidden lockfile lives in the `node_modules` that OWNS the
  // package: `<...>/node_modules/@gate-forge/cli` is described by
  // `<...>/node_modules/.package-lock.json`. Walk up through nested
  // installs and read the first lockfile that describes this package.
  const normalized = packageRoot.split('\\').join('/');
  const packageKey = normalized.slice(normalized.lastIndexOf('node_modules/') + 'node_modules/'.length);
  for (let current = dirname(packageRoot); ; current = dirname(current)) {
    if (basename(current) === 'node_modules') {
      const lock = join(current, '.package-lock.json');
      if (existsSync(lock)) {
        try {
          const parsed = JSON.parse(readFileSync(lock, 'utf8')) as { packages?: Record<string, HiddenLockEntry> };
          const packages = parsed.packages ?? {};
          const entry = packages[packageKey] ?? Object.entries(packages).find(([key]) => key.endsWith(packageKey))?.[1];
          if (typeof entry?.resolved === 'string' && entry.resolved !== '') {
            return { kind: kindOfResolved(entry.resolved), specifier: entry.resolved };
          }
        } catch {
          // Unreadable or foreign lockfile: fall through to the manifest.
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
  }
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      _resolved?: unknown;
      _from?: unknown;
    };
    const declared = typeof manifest._resolved === 'string' ? manifest._resolved : manifest._from;
    if (typeof declared === 'string' && declared !== '') {
      return { kind: kindOfResolved(declared), specifier: declared };
    }
  } catch {
    // No readable manifest metadata: provenance stays unproven.
  }
  return { kind: 'unknown', specifier: null };
}

/**
 * Formats the doctor's one engine line, adding ONLY what the install
 * metadata can prove. The receipt's `engine.source` is receipt-bound
 * (a receipt is only valid for the engine that sealed it), so its
 * meaning is unchanged; this is the human-readable line.
 *
 * Args:
 *   identity: the receipt-bound engine identity.
 *   provenance: the install provenance read from npm's metadata.
 *
 * Returns:
 *   string: the printed line.
 */
export function engineSourceLine(identity: EngineIdentity, provenance: EngineInstallProvenance): string {
  // A `node_modules` install is the only case where the receipt-bound
  // `source` says less than the truth: npm unpacks a tarball exactly
  // where it unpacks a registry release, so the line names the
  // directory and lets the install metadata supply the provenance.
  const base =
    provenance.kind === 'file' || (provenance.kind === 'unknown' && identity.source === 'registry')
      ? `engine: ${identity.version} from node_modules`
      : `engine: ${identity.version} from ${identity.source}`;
  if (provenance.kind === 'file') {
    return (
      `${base} (tarball or directory install: ${provenance.specifier ?? 'file source'} — not the ` +
      `published registry release, so CI installing @gate-forge/cli@${identity.version} would NOT run ` +
      'this code)'
    );
  }
  if (provenance.kind === 'unknown') {
    return `${base} (registry or tarball install — no install metadata found, so the provenance is unproven)`;
  }
  return base;
}

/**
 * Locates the installed engine's package root by walking up from this
 * module to the nearest `@gate-forge/cli` manifest.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   string | null: the resolved package root, or null when no manifest
 *   identifies it.
 */
export function enginePackageRoot(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const value = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
        if (value.name === '@gate-forge/cli') {
          return realpathSync(current);
        }
      } catch {
        // Continue upward; a malformed unrelated manifest is not this package's identity.
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Identifies the installed engine without executing package code from the project.
 *
 * `source` is receipt-bound (a receipt is only valid for the engine
 * that sealed it) and keeps its exact meaning: a `node_modules`
 * install reads `registry` whether npm fetched it from the registry or
 * unpacked a tarball. The install provenance npm's metadata can prove
 * is reported separately by {@link engineInstallProvenance} and
 * {@link engineSourceLine}.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   EngineIdentity: version, source, and whether the engine is unpublished.
 */
export function engineIdentity(): EngineIdentity {
  const packageRoot = enginePackageRoot();
  if (packageRoot === null) {
    return { version: VERSION, source: 'registry', unpublished: false };
  }
  const normalized = packageRoot.split('\\').join('/');
  const fromRegistry = normalized.includes('/node_modules/');
  return fromRegistry
    ? { version: VERSION, source: 'registry', unpublished: false }
    : { version: VERSION, source: `local path ${packageRoot}`, unpublished: true };
}

/**
 * The engine line a human-readable REPORT prints: the same provenance
 * the enforcement doctor's engine line uses, so one install never
 * produces two contradictory claims. The receipt-bound
 * `engine.source` keeps its exact meaning and is untouched.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   string: the printed line.
 */
export function reportEngineLine(): string {
  return engineSourceLine(engineIdentity(), engineInstallProvenance(enginePackageRoot()));
}
