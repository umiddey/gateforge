/**
 * Adoption record persistence (phase 8 workstream C): load/write
 * `.gateforge/baselines/adoption.json` — the one-time, loud record that
 * sanctions the baseline's initial bulk-add (see schemas/adoption.ts for
 * the sibling-file decision). Loading and writing are synchronous,
 * matching `loadBaseline`'s convention.
 *
 * Trust semantics (fail closed): a MISSING record is the legitimate
 * pre-adoption state and loads as `null`; a PRESENT but unparsable or
 * schema-violating record throws — the gate must never guess whether an
 * unreadable adoption record does or does not sanction the baseline.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GateforgeBaselineError } from './index.js';
import { AdoptionRecordSchema, type AdoptionRecord } from '../schemas/adoption.js';

/** The adoption record's fixed file name, beside the baseline document. */
export const ADOPTION_RECORD_FILENAME = 'adoption.json';

/**
 * Loads the adoption record for a repo.
 *
 * Args:
 *   path: adoption-record file path (`.gateforge/baselines/adoption.json`).
 *
 * Returns:
 *   AdoptionRecord | null: the validated record, or null when absent
 *   (pre-adoption repo).
 *
 * Throws:
 *   GateforgeBaselineError: when the file exists but is unparsable or
 *   fails schema validation (fail closed — never silently unsanctioned).
 */
export function loadAdoptionRecord(path: string): AdoptionRecord | null {
  if (!existsSync(path)) return null;
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new GateforgeBaselineError(
      `adoption record '${path}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = AdoptionRecordSchema.safeParse(document);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<adoption>'}: ${issue.message}`)
      .join('; ');
    throw new GateforgeBaselineError(`adoption record '${path}' failed validation: ${issues}`);
  }
  return result.data;
}

/**
 * Writes an adoption record to disk, creating parent directories as
 * needed. Serialized sorted 2-space JSON with a trailing newline
 * (reviewable in diffs, like the baseline document).
 *
 * Args:
 *   path: destination file path.
 *   record: the validated adoption record.
 *
 * Throws:
 *   GateforgeBaselineError: when the file cannot be written.
 */
export function writeAdoptionRecord(path: string, record: AdoptionRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new GateforgeBaselineError(
      `adoption record '${path}' could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
