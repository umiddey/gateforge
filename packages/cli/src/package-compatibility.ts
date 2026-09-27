/** Package-contract checks for the supervised Playwright protocol. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPERVISED_FIXTURE_PROTOCOL = 'gateforge.supervised-playwright.v1';

/** Minimal package metadata used by the compatibility rule. */
export interface GateforgePackageIdentity {
  name: string;
  version: string;
  supervisedFixtureProtocol?: string;
}

/** Checks the declared protocol contract without comparing version strings.
 *
 * Args:
 *   cliPackage: installed CLI package metadata.
 *   packPackage: installed Playwright pack metadata.
 *
 * Returns:
 *   string | null: actionable incompatibility detail, or null when the contract matches.
 */
export function packageCompatibilityError(
  cliPackage: GateforgePackageIdentity,
  packPackage: GateforgePackageIdentity,
): string | null {
  const expected = SUPERVISED_FIXTURE_PROTOCOL;
  if (
    cliPackage.supervisedFixtureProtocol === expected &&
    packPackage.supervisedFixtureProtocol === cliPackage.supervisedFixtureProtocol
  ) {
    return null;
  }
  return (
    `GATEFORGE_PACKAGE_INCOMPATIBLE: ${cliPackage.name} ${cliPackage.version} requires ` +
    `${packPackage.name} contract '${expected}', but installed ${packPackage.name} ${packPackage.version} ` +
    `declares '${packPackage.supervisedFixtureProtocol ?? 'missing'}'. Package version text does not prove compatibility. ` +
    `Install matching Gateforge packages with the '${expected}' supervised-fixture contract.`
  );
}

/** Reads the installed CLI and Playwright manifests and checks their protocol contract.
 *
 * Args:
 *   none.
 *
 * Returns:
 *   string | null: actionable incompatibility detail, or null when the installed contract matches.
 */
export function installedPlaywrightCompatibilityError(): string | null {
  const cliManifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const cliPackage = readPackageIdentity(cliManifestPath, '@gate-forge/cli');
  const packPackage = findInstalledPackageIdentity(
    dirname(fileURLToPath(import.meta.url)),
    '@gate-forge/pack-playwright',
  );
  return packageCompatibilityError(cliPackage, packPackage);
}

/** Reads package identity fields while treating missing or invalid files as unknown metadata.
 *
 * Args:
 *   path: package manifest path.
 *   expectedName: fallback package name.
 *
 * Returns:
 *   GateforgePackageIdentity: parsed identity with absent fields left unknown.
 */
function readPackageIdentity(path: string, expectedName: string): GateforgePackageIdentity {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return packageIdentityFromRecord(raw, expectedName);
  } catch {
    return { name: expectedName, version: 'unknown' };
  }
}

/** Finds the nearest package manifest from the CLI module directory.
 *
 * Args:
 *   startDirectory: directory of the CLI compatibility module.
 *   expectedName: installed package name.
 *
 * Returns:
 *   GateforgePackageIdentity: found manifest identity, or unknown metadata when absent.
 */
function findInstalledPackageIdentity(startDirectory: string, expectedName: string): GateforgePackageIdentity {
  let directory = startDirectory;
  for (let depth = 0; depth < 12; depth += 1) {
    for (const manifestPath of [
      join(directory, 'node_modules', '@gate-forge', 'pack-playwright', 'package.json'),
      join(directory, '@gate-forge', 'pack-playwright', 'package.json'),
    ]) {
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        if (raw['name'] === expectedName) return packageIdentityFromRecord(raw, expectedName);
      } catch {
        // Continue at this or the parent directory when the package is not here.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { name: expectedName, version: 'missing' };
}

/** Converts one parsed package manifest into the contract fields used by this check.
 *
 * Args:
 *   raw: parsed package manifest object.
 *   expectedName: fallback package name.
 *
 * Returns:
 *   GateforgePackageIdentity: normalized package identity.
 */
function packageIdentityFromRecord(raw: Record<string, unknown>, expectedName: string): GateforgePackageIdentity {
  const compatibility = raw['gateforgeCompatibility'];
  const compatibilityRecord = typeof compatibility === 'object' && compatibility !== null
    ? compatibility as Record<string, unknown>
    : {};
  return {
    name: typeof raw['name'] === 'string' ? raw['name'] : expectedName,
    version: typeof raw['version'] === 'string' ? raw['version'] : 'unknown',
    ...(typeof compatibilityRecord['supervisedFixtureProtocol'] === 'string'
      ? { supervisedFixtureProtocol: compatibilityRecord['supervisedFixtureProtocol'] }
      : {}),
  };
}
