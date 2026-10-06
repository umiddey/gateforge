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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareStrings } from '../graph/util.js';
import { GateforgeBaselineError } from './index.js';
import {
  AdoptionFamilySchema,
  AdoptionRecordSchema,
  ClassificationBlockedIdsSchema,
  type AdoptionFamily,
  type AdoptionRecord,
} from '../schemas/adoption.js';

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
 * The receipt is the ONE sanction record a repository cannot regenerate,
 * so the write is validated BEFORE any filesystem mutation and then
 * ATOMIC: the serialized bytes go to a same-directory temporary file and
 * `rename` over the destination. A crash or a failed write can never
 * leave the receipt truncated or half-written — the previous receipt
 * stays intact and in force, and the temporary file is removed on any
 * failure (cleanup errors never mask the write error).
 *
 * Args:
 *   path: destination file path.
 *   record: the adoption record to persist.
 *
 * Throws:
 *   GateforgeBaselineError: when the record fails validation or the file
 *   cannot be written (the previous receipt, if any, is untouched).
 */
export function writeAdoptionRecord(path: string, record: AdoptionRecord): void {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(AdoptionRecordSchema.parse(record), null, 2)}\n`;
  } catch (error) {
    throw new GateforgeBaselineError(
      `adoption record '${path}' failed validation before write: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, serialized, 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // A failed cleanup must never mask the write failure itself.
    }
    throw new GateforgeBaselineError(
      `adoption record '${path}' could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The classification layer of the sanctioned bulk-add (two-layer
 * adoption): normalizes the classification-blocked resource ids captured
 * at adoption time into the receipt's canonical form — sorted, duplicate-
 * free, schema-validated. Input order is irrelevant; duplicates are
 * collapsed (the ids are collected from blocking entries, so exact
 * duplicates are expected to be absent, not an error).
 *
 * Args:
 *   resourceIds: the classification-blocked resource ids captured at
 *     adoption time (entries with kind 'classification' and a derived id).
 *
 * Returns:
 *   string[]: the validated, sorted, unique id list for the receipt.
 *
 * Throws:
 *   GateforgeBaselineError: when any id fails schema validation.
 */
export function adoptClassificationBlocked(resourceIds: readonly string[]): string[] {
  const seen: Record<string, true> = {};
  const unique: string[] = [];
  for (const id of resourceIds) {
    if (id in seen) continue;
    seen[id] = true;
    unique.push(id);
  }
  unique.sort(compareStrings);
  const result = ClassificationBlockedIdsSchema.safeParse(unique);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<classificationBlocked>'}: ${issue.message}`)
      .join('; ');
    throw new GateforgeBaselineError(
      `adoption classification set failed validation: ${issues}`,
    );
  }
  return result.data;
}

/**
 * The classification set's ONLY mutation after adoption (the shrink path,
 * mirroring `updateBaseline`'s GF-07/08 semantics): replaces the receipt's
 * `classificationBlocked` with the given ids, which must be a STRICT
 * SUBSET of the current set — every id kept must exist today AND at least
 * one id must be removed. A resource leaves the set only when it gained a
 * real classification; adding or re-listing ids fails closed (the adopted
 * set can never grow, so new classification debt can never be laundered
 * into the sanctioned starting point).
 *
 * Args:
 *   current: the adopted record on disk (its effective classification set,
 *     [] when the field is absent).
 *   resourceIds: the ids to keep (duplicates are an error, as in
 *     `updateBaseline`).
 *
 * Returns:
 *   AdoptionRecord: the next record — identical to `current` except for
 *   the (always-present, possibly empty) shrunk `classificationBlocked`.
 *
 * Throws:
 *   GateforgeBaselineError: on duplicate input, schema-invalid ids, or a
 *   non-strict-subset update (naming the added ids).
 */
export function shrinkClassificationBlocked(
  current: AdoptionRecord,
  resourceIds: readonly string[],
): AdoptionRecord {
  const seen: Record<string, true> = {};
  const unique: string[] = [];
  for (const id of resourceIds) {
    if (id in seen) continue;
    seen[id] = true;
    unique.push(id);
  }
  if (unique.length !== resourceIds.length) {
    throw new GateforgeBaselineError(
      'classification shrink input contains duplicate resource ids',
    );
  }
  const currentSet = current.classificationBlocked ?? [];
  const known: Record<string, true> = {};
  for (const id of currentSet) known[id] = true;
  const unknown = unique.filter((id) => !(id in known));
  if (unique.length >= currentSet.length || unknown.length > 0) {
    throw new GateforgeBaselineError(
      `classification shrink rejected: not a strict subset of the adopted set ` +
        `(the adopted classification set is shrink-only) — unknown or added id(s): ` +
        `${(unknown.length > 0 ? unknown : unique).join(', ') || '<none>'}`,
    );
  }
  const validated = adoptClassificationBlocked(unique);
  const next: AdoptionRecord =
    validated.length > 0
      ? { ...current, classificationBlocked: validated }
      : { ...current, classificationBlocked: [] };
  return AdoptionRecordSchema.parse(next);
}

/**
 * Builds one family's permanent marker (0.13): the named, dated,
 * commit-referenced slice a post-adoption migration records in the
 * EXISTING receipt. `fingerprintsById` must already contain EVERY
 * initial family obligation id — proven obligations included — keyed by
 * obligation id with its pin-#2 fingerprint; `forgiven` names the
 * sanctioned subset (only what was missing/unproven). Input order is
 * irrelevant: the marker is normalized to sorted keys and a sorted,
 * duplicate-free `forgiven` list, so the receipt bytes are deterministic
 * (and with them the trusted-policy digest that binds the marker).
 *
 * Args:
 *   input.adoptedAt: the family adoption instant (run's injected clock).
 *   input.gitSha: HEAD sha of the adopting commit, or null outside git.
 *   input.fingerprintsById: every initial family obligation id → fingerprint.
 *   input.forgiven: the sanctioned (missing/unproven) subset to forgive.
 *
 * Returns:
 *   AdoptionFamily: the validated marker for the receipt's `families` map.
 *
 * Throws:
 *   GateforgeBaselineError: when a forgiven fingerprint is not one of the
 *   recorded ones, a fingerprint is malformed, or an id is empty (fail
 *   closed — a marker that forgives beyond its own record is never built).
 */
export function adoptFamily(input: {
  adoptedAt: string;
  gitSha: string | null;
  fingerprintsById: Record<string, string>;
  forgiven: readonly string[];
}): AdoptionFamily {
  const seen: Record<string, true> = {};
  const unique: string[] = [];
  for (const fingerprint of input.forgiven) {
    if (fingerprint in seen) continue;
    seen[fingerprint] = true;
    unique.push(fingerprint);
  }
  unique.sort(compareStrings);
  const recorded: Record<string, string> = {};
  for (const id of Object.keys(input.fingerprintsById).sort(compareStrings)) {
    recorded[id] = input.fingerprintsById[id]!;
  }
  const candidate = {
    schemaVersion: 1 as const,
    adoptedAt: input.adoptedAt,
    gitSha: input.gitSha,
    fingerprintsById: recorded,
    forgiven: unique,
  };
  const result = AdoptionFamilySchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<family>'}: ${issue.message}`)
      .join('; ');
    throw new GateforgeBaselineError(`adoption family marker failed validation: ${issues}`);
  }
  return result.data;
}

/**
 * A family's ONLY mutation after adoption (the shrink path, mirroring
 * `updateBaseline`'s GF-07/08 semantics and the classification set's):
 * replaces the named family's `forgiven` list with the given
 * fingerprints, which must be a STRICT SUBSET of the current ones —
 * every fingerprint kept must exist today AND at least one must be
 * removed. The marker itself is retained untouched (adoptedAt, gitSha,
 * every recorded fingerprint), so a repeat migration can never re-arm
 * and a resolved debt can never re-enter: the sanctioned set can only
 * shrink.
 *
 * Args:
 *   current: the adopted record on disk.
 *   name: the family to shrink (only `pages` exists today).
 *   fingerprints: the fingerprints to KEEP (duplicates are an error, as
 *     in `updateBaseline`; an empty list keeps none).
 *
 * Returns:
 *   AdoptionRecord: the next record — identical to `current` except for
 *   the named family's shrunk `forgiven` list.
 *
 * Throws:
 *   GateforgeBaselineError: when the record carries no such family
 *   marker, on duplicate input, on schema-invalid fingerprints, or on a
 *   non-strict-subset update (naming the unknown or added fingerprints).
 */
export function shrinkFamilyForgiven(
  current: AdoptionRecord,
  name: string,
  fingerprints: readonly string[],
): AdoptionRecord {
  const family = current.families?.[name];
  if (family === undefined) {
    throw new GateforgeBaselineError(
      `family shrink rejected: the adoption record carries no '${name}' family marker ` +
        '(the family is adopted exactly once, by `gateforge adopt --family <name> --confirm`) — ' +
        'there is nothing to shrink',
    );
  }
  const seen: Record<string, true> = {};
  const unique: string[] = [];
  for (const fingerprint of fingerprints) {
    if (fingerprint in seen) continue;
    seen[fingerprint] = true;
    unique.push(fingerprint);
  }
  if (unique.length !== fingerprints.length) {
    throw new GateforgeBaselineError(`family '${name}' shrink input contains duplicate fingerprints`);
  }
  const known: Record<string, true> = {};
  for (const fingerprint of family.forgiven) known[fingerprint] = true;
  const unknown = unique.filter((fingerprint) => !(fingerprint in known));
  if (unique.length >= family.forgiven.length || unknown.length > 0) {
    throw new GateforgeBaselineError(
      `family '${name}' shrink rejected: not a strict subset of the forgiven set ` +
        '(the family set is shrink-only) — unknown or added fingerprint(s): ' +
        `${(unknown.length > 0 ? unknown : unique).join(', ') || '<none>'}`,
    );
  }
  const families: Record<string, AdoptionFamily> = {};
  for (const key of Object.keys(current.families ?? {}).sort(compareStrings)) {
    families[key] = key === name ? { ...family, forgiven: unique.sort(compareStrings) } : current.families![key]!;
  }
  const next: AdoptionRecord = { ...current, families };
  return AdoptionRecordSchema.parse(next);
}
