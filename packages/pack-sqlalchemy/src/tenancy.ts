/**
 * The owner-declared tenant scope channel (plan 2026-09-25 Phase 4b
 * item 3a).
 *
 * The per-tenant-singleton tag needs to know which column carries the
 * tenant scope. The pack ships a FIXED default list of the usual
 * spellings (`tenant_id`, `tenant`, ...), but scope columns differ per
 * application — the incident's ledger table is scoped by
 * `contractor_id`. The owner therefore declares them in `.gateforge.yml`:
 *
 * ```yaml
 * tenancy:
 *   scopeColumns: [contractor_id]
 * ```
 *
 * The declaration REPLACES the default list (never extends it), so the
 * recognized scope is exactly what the owner said and nothing else. A
 * missing file, a missing key, and a config that says nothing about
 * tenancy all read as `null` — absence, byte-identical to today. A
 * present but MALFORMED `tenancy` block throws (fail closed, a typo must
 * not silently disable the tag).
 *
 * SCOPE: this reader validates the `tenancy` block only. The pack is a
 * detector, not the config authority — the CLI loads `.gateforge.yml`
 * fail-closed before any pack runs, and a detector must keep working
 * (byte-identically) in a repository whose config carries an unrelated
 * problem it has no opinion about.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/** Repo-relative path of the owner config this channel reads. */
export const CONFIG_PATH = '.gateforge.yml';

/**
 * Reads the owner-declared tenant scope columns out of a config file.
 *
 * Args:
 *   path: Absolute or cwd-relative config path; null disables the
 *     channel entirely (today's behavior, byte-identical).
 *
 * Returns:
 *   readonly string[] | null: the declared columns, or null when the
 *     file is absent/unreadable or declares no tenancy scope.
 *
 * Raises:
 * Error: for unparsable YAML or a malformed `tenancy` block.
 */
export function readTenancyScopeColumnsOrNull(path: string | null): readonly string[] | null {
  if (path === null) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // absence is normal; malformed is not (below)
  }
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (cause) {
    throw new Error(
      `invalid config ${path}: invalid YAML: ${(cause as Error).message.split('\n')[0] ?? 'parse error'}`,
    );
  }
  if (document === null || document === undefined) return null;
  if (typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`invalid config ${path}: expected a mapping at the document root`);
  }
  const tenancy = (document as Record<string, unknown>)['tenancy'];
  if (tenancy === undefined) return null;
  if (typeof tenancy !== 'object' || tenancy === null || Array.isArray(tenancy)) {
    throw new Error(`invalid config ${path}: 'tenancy' must be a mapping`);
  }
  const block = tenancy as Record<string, unknown>;
  const unknownKeys = Object.keys(block).filter((key) => key !== 'scopeColumns');
  if (unknownKeys.length > 0) {
    throw new Error(
      `invalid config ${path}: unknown key(s) ${unknownKeys.sort().join(', ')} under 'tenancy'`,
    );
  }
  const declared = block['scopeColumns'];
  if (declared === undefined) return null; // the block exists but says nothing
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`invalid config ${path}: 'tenancy.scopeColumns' must be a nonempty list of column names`);
  }
  for (const column of declared) {
    if (typeof column !== 'string' || column.length === 0) {
      throw new Error(`invalid config ${path}: 'tenancy.scopeColumns' must be a nonempty list of column names`);
    }
  }
  return Object.freeze([...(declared as string[])]);
}
