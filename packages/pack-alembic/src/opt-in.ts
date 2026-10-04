/**
 * Setup text for the opt-in Alembic block. Init prints it. It does not
 * enable the pack.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * Directory names that never hold the project's alembic.ini:
 * dependency trees, VCS state, and test fixtures are not
 * migration roots.
 */
const ALEMBIC_INI_PRUNED_DIRS: Readonly<Record<string, true>> = {
  node_modules: true,
  '.git': true,
  test: true,
  tests: true,
};

/**
 * Finds the alembic.ini the opt-in block describes: at the
 * repository root, or in ONE first-level subdirectory (the
 * backend/ monorepo layout). The root file always wins;
 * subdirectory ties break alphabetically so the answer is
 * deterministic.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   string | null: absolute ini path, or null when no alembic.ini
 *     exists at the root or one level down.
 */
function findAlembicIni(cwd: string): string | null {
  const rootIni = join(cwd, 'alembic.ini');
  if (existsSync(rootIni)) return rootIni;
  const found: string[] = [];
  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (ALEMBIC_INI_PRUNED_DIRS[entry.name] === true) continue;
    if (existsSync(join(cwd, entry.name, 'alembic.ini'))) found.push(entry.name);
  }
  found.sort();
  const [first] = found;
  return first !== undefined ? join(cwd, first, 'alembic.ini') : null;
}

/** Repo-root-relative posix form of an absolute path. */
function toRepoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

/**
 * Resolves the alembic.ini and its versions directory, both
 * relative to the repository root. `%(here)s` in
 * `script_location` anchors to the ini's OWN directory
 * (alembic's idiom for configs that move with their package);
 * a plain relative location stays root-relative, and an
 * absolute location is taken verbatim.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   { ini, versions } | null: root-relative paths, or null when
 *     no alembic.ini exists.
 */
function resolveAlembicLocations(cwd: string): { ini: string; versions: string } | null {
  const iniPath = findAlembicIni(cwd);
  if (iniPath === null) return null;
  const text = readFileSync(iniPath, 'utf8');
  const match = text.match(/^\s*script_location\s*=\s*(\S+)/m);
  const script = match?.[1]?.replace(/\\/g, '/') ?? 'migrations';
  const located = script.includes('%(here)s')
    ? script.replaceAll('%(here)s', dirname(iniPath))
    : isAbsolute(script)
      ? script
      : join(cwd, script);
  const versions = located.endsWith('/versions') ? located : `${located}/versions`;
  return { ini: toRepoRelative(cwd, iniPath), versions: toRepoRelative(cwd, versions) };
}

/**
 * Reads `script_location` from the alembic.ini discovery finds
 * (root or first-level subdirectory).
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   string | null: root-relative versions directory, or null when
 *     alembic.ini is absent.
 */
export function detectAlembicVersionsDir(cwd: string): string | null {
  return resolveAlembicLocations(cwd)?.versions ?? null;
}

/**
 * Prints the commented opt-in block and the command that proves it.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   string | null: text to print, or null when no alembic.ini exists.
 */
export function renderAlembicOptIn(cwd: string): string | null {
  const locations = resolveAlembicLocations(cwd);
  if (locations === null) return null;
  return [
    'alembic detected: alembic.ini. Migration obligations are opt-in and are not enabled.',
    'alembic-opt-in: begin',
    'alembic:',
    '  chains:',
    '    - name: default',
    `      migrations: ${locations.versions}`,
    '      models:',
    '        - models.py',
    `      alembicIni: ${locations.ini}`,
    '  scratch:',
    '    # Trusted admin URL. The engine creates and drops only gf_tmp_<id> databases.',
    '    adminUrl: postgresql://gateforge:gateforge@127.0.0.1:5432/postgres',
    '  irreversible: []',
    'alembic-opt-in: end',
    'command: gateforge check',
  ].join('\n');
}
