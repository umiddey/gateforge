/**
 * Setup text for the opt-in Alembic block. Init prints it. It does not
 * enable the pack.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads `script_location` from an alembic.ini, when the file is present.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   string | null: versions directory guess, or null when alembic.ini is absent.
 */
export function detectAlembicVersionsDir(cwd: string): string | null {
  const iniPath = join(cwd, 'alembic.ini');
  if (!existsSync(iniPath)) return null;
  const text = readFileSync(iniPath, 'utf8');
  const match = text.match(/^\s*script_location\s*=\s*(\S+)/m);
  const script = match?.[1]?.replace(/\\/g, '/') ?? 'migrations';
  return script.endsWith('/versions') ? script : `${script}/versions`;
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
  const versions = detectAlembicVersionsDir(cwd);
  if (versions === null) return null;
  return [
    'alembic detected: alembic.ini. Migration obligations are opt-in and are not enabled.',
    'alembic-opt-in: begin',
    'alembic:',
    '  chains:',
    '    - name: default',
    `      migrations: ${versions}`,
    '      models:',
    '        - models.py',
    '      alembicIni: alembic.ini',
    '  scratch:',
    '    # Trusted admin URL. The engine creates and drops only gf_tmp_<id> databases.',
    '    adminUrl: postgresql://gateforge:gateforge@127.0.0.1:5432/postgres',
    '  irreversible: []',
    'alembic-opt-in: end',
    'command: gateforge check',
  ].join('\n');
}
