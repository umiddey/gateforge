/**
 * Baselines (pin #3, invariant 4): `.gateforge/baselines/obligations.json`
 * — `{schemaVersion: 1, fingerprints: string[]}` storing forgiven
 * obligation fingerprints (pin #2). Baselines may only ever SHRINK to a
 * strict subset: `[A, B] → [A, NEW]` is rejected (GF-07), `[A, B] → [A]`
 * passes (GF-08). Loading and writing are synchronous, matching
 * `loadConfig`'s convention.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareStrings } from '../graph/util.js';
import { BaselineSchema, type Baseline } from '../schemas/baseline.js';

/**
 * Error raised for any fail-closed baseline problem: missing file,
 * unparsable JSON, schema violation, or a non-strict-subset update
 * (GF-07's count-preserving debt laundering).
 */
export class GateforgeBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateforgeBaselineError';
  }
}

/**
 * Loads and validates a baseline document. Fail-closed: a missing,
 * unparsable, or schema-violating file throws — callers decide whether
 * that means "no baseline yet" for their flow.
 *
 * Args:
 *   path: baseline file path (default `.gateforge/baselines/obligations.json`).
 *
 * Returns:
 *   Baseline: the validated document (sorted, duplicate-free fingerprints).
 *
 * Throws:
 *   GateforgeBaselineError: on any load or validation failure.
 */
export function loadBaseline(path: string): Baseline {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new GateforgeBaselineError(
      `baseline '${path}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = BaselineSchema.safeParse(document);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<baseline>'}: ${issue.message}`)
      .join('; ');
    throw new GateforgeBaselineError(`baseline '${path}' failed validation: ${issues}`);
  }
  return result.data;
}

/**
 * Whether a baseline update is a strict subset (invariant 4): every
 * fingerprint in `next` exists in `current` AND at least one fingerprint
 * is removed. `[A, B] → [A, B]` is not an update (nothing was resolved)
 * and `[A, B] → [A, NEW]` fails (GF-07); `[A, B] → [A]` passes (GF-08).
 *
 * Args:
 *   current: the baseline on disk.
 *   next: the proposed replacement.
 *
 * Returns:
 *   boolean: true only for a non-empty proper subset.
 */
export function canUpdate(current: Baseline, next: Baseline): boolean {
  if (next.fingerprints.length >= current.fingerprints.length) return false;
  const known: Record<string, true> = {};
  for (const fingerprint of current.fingerprints) known[fingerprint] = true;
  return next.fingerprints.every((fingerprint) => fingerprint in known);
}

/**
 * Builds the next baseline from raw fingerprints, enforcing the strict-
 * subset rule (invariant 4) against `current`. Input order is irrelevant:
 * the result is sorted; duplicates in the input are an error.
 *
 * Args:
 *   current: the baseline on disk.
 *   fingerprints: the resolved fingerprints to keep.
 *
 * Returns:
 *   Baseline: the validated next document.
 *
 * Throws:
 *   GateforgeBaselineError: on duplicates or a non-strict-subset update
 *   (naming the added fingerprints — GF-07's laundering attempt).
 */
export function updateBaseline(current: Baseline, fingerprints: readonly string[]): Baseline {
  const seen: Record<string, true> = {};
  const unique: string[] = [];
  for (const fingerprint of fingerprints) {
    if (fingerprint in seen) continue;
    seen[fingerprint] = true;
    unique.push(fingerprint);
  }
  if (unique.length !== fingerprints.length) {
    throw new GateforgeBaselineError('baseline update input contains duplicate fingerprints');
  }
  unique.sort(compareStrings);
  const next = BaselineSchema.parse({ schemaVersion: 1, fingerprints: unique });
  if (!canUpdate(current, next)) {
    const known: Record<string, true> = {};
    for (const fingerprint of current.fingerprints) known[fingerprint] = true;
    const added = unique.filter((fingerprint) => !(fingerprint in known));
    throw new GateforgeBaselineError(
      `baseline update rejected: not a strict subset of the current baseline ` +
        `(invariant 4) — added ${added.length} new fingerprint(s): ` +
        `${added.join(', ') || '<none>'}`,
    );
  }
  return next;
}

/**
 * Serializes a baseline for on-disk storage: sorted 2-space JSON with a
 * trailing newline (reviewable in diffs; canonical hashing is a separate
 * pin-#1 concern and does not apply to this file's formatting).
 *
 * Args:
 *   baseline: the document to serialize.
 *
 * Returns:
 *   string: the file content.
 */
export function serializeBaseline(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

/**
 * Writes a baseline to disk, creating parent directories as needed.
 *
 * Args:
 *   path: destination file path.
 *   baseline: the document to write.
 *
 * Throws:
 *   GateforgeBaselineError: when the file cannot be written.
 */
export function writeBaseline(path: string, baseline: Baseline): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeBaseline(baseline), 'utf8');
  } catch (error) {
    throw new GateforgeBaselineError(
      `baseline '${path}' could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
