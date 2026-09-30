/**
 * Engine install provenance (install rehearsal F3): a tarball or
 * directory install lands in `node_modules` exactly like a registry
 * install, so the doctor used to print `from registry` for a release
 * that was never published. The receipt's `engine.source` is
 * receipt-bound and therefore frozen; only the doctor's line changes,
 * and it says what the install metadata can actually prove.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { engineInstallProvenance, engineSourceLine } from '../src/engine-identity.js';

/** Temp dirs to remove after each test. */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Builds a fake installed engine under `<root>/node_modules/@gate-forge/cli`
 * with the given install metadata.
 *
 * Args:
 *   lockEntry: the hidden lockfile entry for the package, or null to
 *     write no `node_modules/.package-lock.json` at all.
 *   manifestExtras: extra keys merged into the installed package.json
 *     (npm's legacy `_resolved`/`_from`).
 *
 * Returns:
 *   string: the fake package root.
 */
function installedEngine(
  lockEntry: Record<string, unknown> | null,
  manifestExtras: Record<string, unknown> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'gateforge-engine-'));
  tempDirs.push(root);
  const packageRoot = join(root, 'node_modules', '@gate-forge', 'cli');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: '@gate-forge/cli', version: '0.7.1', ...manifestExtras })}\n`,
  );
  if (lockEntry !== null) {
    writeFileSync(
      join(root, 'node_modules', '.package-lock.json'),
      `${JSON.stringify({
        name: 'consumer',
        lockfileVersion: 3,
        packages: { 'node_modules/@gate-forge/cli': lockEntry },
      })}\n`,
    );
  }
  return packageRoot;
}

describe('engine install provenance (tarball installs are not the registry)', () => {
  it('reads the hidden lockfile: a registry URL is the registry', () => {
    const packageRoot = installedEngine({
      version: '0.7.1',
      resolved: 'https://registry.npmjs.org/@gate-forge/cli/-/cli-0.7.1.tgz',
      integrity: 'sha512-abc',
    });
    expect(engineInstallProvenance(packageRoot)).toEqual({
      kind: 'registry',
      specifier: 'https://registry.npmjs.org/@gate-forge/cli/-/cli-0.7.1.tgz',
    });
  });

  it('reports a tarball install as a file source, with the specifier', () => {
    const packageRoot = installedEngine({
      version: '0.7.1',
      resolved: 'file:vendor/gate-forge-cli-0.7.1.tgz',
    });
    expect(engineInstallProvenance(packageRoot)).toEqual({
      kind: 'file',
      specifier: 'file:vendor/gate-forge-cli-0.7.1.tgz',
    });
  });

  it('falls back to the installed manifest `_resolved` when there is no hidden lockfile', () => {
    const packageRoot = installedEngine(null, { _resolved: 'file:../packs/gate-forge-cli-0.7.1.tgz' });
    expect(engineInstallProvenance(packageRoot)).toEqual({
      kind: 'file',
      specifier: 'file:../packs/gate-forge-cli-0.7.1.tgz',
    });
  });

  it('never guesses: an install with no metadata is unproven', () => {
    expect(engineInstallProvenance(installedEngine(null))).toEqual({ kind: 'unknown', specifier: null });
  });

  it('reads the innermost node_modules lockfile of a nested install', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateforge-engine-nested-'));
    tempDirs.push(root);
    const packageRoot = join(root, 'packages', 'app', 'node_modules', '@gate-forge', 'cli');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{"name":"@gate-forge/cli","version":"0.7.1"}\n');
    writeFileSync(
      join(root, 'packages', 'app', 'node_modules', '.package-lock.json'),
      `${JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/@gate-forge/cli': { version: '0.7.1', resolved: 'file:../../../vendor/cli.tgz' } },
      })}\n`,
    );
    expect(engineInstallProvenance(packageRoot)).toEqual({ kind: 'file', specifier: 'file:../../../vendor/cli.tgz' });
  });
});

describe('doctor engine line (provenance it can prove)', () => {
  it('keeps the historical line for a registry install', () => {
    expect(
      engineSourceLine(
        { version: '0.7.1', source: 'registry', unpublished: false },
        { kind: 'registry', specifier: null },
      ),
    ).toBe('engine: 0.7.1 from registry');
  });

  it('names the tarball/directory install instead of claiming the registry', () => {
    expect(
      engineSourceLine(
        { version: '0.7.1', source: 'registry', unpublished: false },
        { kind: 'file', specifier: 'file:vendor/gate-forge-cli-0.7.1.tgz' },
      ),
    ).toBe(
      'engine: 0.7.1 from node_modules (tarball or directory install: file:vendor/gate-forge-cli-0.7.1.tgz ' +
        '— not the published registry release, so CI installing @gate-forge/cli@0.7.1 would NOT run this code)',
    );
  });

  it('says the provenance is unproven rather than all-clear when no metadata exists', () => {
    expect(
      engineSourceLine(
        { version: '0.7.1', source: 'registry', unpublished: false },
        { kind: 'unknown', specifier: null },
      ),
    ).toBe(
      'engine: 0.7.1 from node_modules (registry or tarball install — no install metadata found, ' +
        'so the provenance is unproven)',
    );
  });

  it('leaves a local path (monorepo) engine line exactly as it was', () => {
    expect(
      engineSourceLine(
        { version: '0.7.1', source: 'local path /work/gateforge', unpublished: true },
        { kind: 'local-path', specifier: null },
      ),
    ).toBe('engine: 0.7.1 from local path /work/gateforge');
  });
});
