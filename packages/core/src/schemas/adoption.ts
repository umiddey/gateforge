/**
 * Adoption record schema (phase 8 workstream C): the loud, one-time
 * record of `gateforge adopt` — the ONLY sanctioned bulk-add of baseline
 * fingerprints a repo will ever get. Lives beside the baseline as
 * `.gateforge/baselines/adoption.json`.
 *
 * Sibling-FILE decision (deliberate, vs. an `adoptedAt` field on the
 * baseline document): the baseline stays a pure
 * `{schemaVersion, fingerprints}` set. Folding adoption metadata into it
 * would (a) force every shrink — `baseline update` builds fresh
 * documents via `updateBaseline` — to carry adoption fields forward,
 * risking silent loss of the record on the first shrink, and (b) make
 * the invariant "the bulk-add happened exactly once" rest on a field a
 * hand-edit can delete to re-arm a second bulk-add. A separate record
 * inverts that: the check gate honors a baseline ONLY when its adoption
 * record is present and valid, so an unrecorded (or record-stripped)
 * baseline forgives nothing — fail closed. Absent file = pre-adoption
 * baseline (backward compatible with every repo initialized before this
 * schema existed, including empty init skeletons).
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';

/** The adoption record: who forgave how much, when, on what commit. */
export const AdoptionRecordSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Adoption instant, ISO-8601, from the run's injected clock. */
    adoptedAt: z.iso.datetime(),
    /** HEAD sha of the adopting commit, or null outside a git repo. */
    gitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'gitSha must be a 40-char lowercase sha1 hex')
      .nullable(),
    /** Fingerprints written into the baseline as forgiven (bulk-add size). */
    adopted: z.number().int().min(0),
    /** Obligations already satisfied/waived at adoption time (context). */
    proven: z.number().int().min(0),
    /**
     * The classification layer (two-layer adoption): resource ids that
     * were classification-blocked ([classification] entries with a
     * derived resource id — e.g. PLANE_UNRESOLVED) at adoption time and
     * are adopted as the sanctioned starting point. OPTIONAL for
     * backward compatibility: a receipt without the field was written by
     * a pre-layer engine and is simply NOT ADOPTED for this layer — the
     * check forgives nothing classification-shaped without it (fail
     * closed). Present or absent, the set is SHRINK-ONLY: a resource
     * leaves only through the explicit `baseline update` path once it
     * carries a real classification; NEW blocked resources never enter.
     */
    classificationBlocked: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const ids = record.classificationBlocked;
    if (ids === undefined) return;
    const sorted = [...ids].sort();
    for (let index = 0; index < ids.length; index += 1) {
      const current = ids[index];
      const expected = sorted[index];
      if (current !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['classificationBlocked', index],
          message:
            "classificationBlocked must be sorted; expected '" + expected +
            "' at index " + index + ", got '" + current + "'",
        });
        break;
      }
      if (index > 0 && current === ids[index - 1]) {
        ctx.addIssue({
          code: 'custom',
          path: ['classificationBlocked', index],
          message: `duplicate classification-blocked resource id '${current}'`,
        });
        break;
      }
    }
  });

/** Inferred adoption-record shape. */
export type AdoptionRecord = z.infer<typeof AdoptionRecordSchema>;
