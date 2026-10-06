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

/**
 * The classification layer's id list shape, NON-optional: the record
 * field wraps this in `.optional()` (absent = pre-layer receipt), while
 * the capture/shrink helpers validate against THIS schema so a present
 * list is always a sorted, duplicate-free, non-empty-string array.
 */
export const ClassificationBlockedIdsSchema = z.array(z.string().min(1));

/** One 64-char lowercase sha256 fingerprint (pin #2 obligation identity). */
const FamilyFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * One adopted family's permanent marker (0.13 pages rollout). A family
 * is a NAMED, dated, commit-referenced adoption SLICE inside the same
 * receipt: a post-adoption migration (`gateforge adopt --family pages`)
 * must never reopen the one bulk-add, so its sanction is a strictly
 * family-scoped receipt field instead of a second receipt file or a
 * baseline-document edit. The field is OPTIONAL for backward
 * compatibility exactly like `classificationBlocked`: a receipt without
 * it predates families and is simply not adopted for any of them (fail
 * closed — nothing family-shaped is forgiven without the recorded set).
 *
 * Shape: `fingerprintsById` records EVERY initial family obligation id
 * with its pin-#2 fingerprint at adoption time — proven obligations
 * included, so the marker explains the family's full starting point and
 * a later break of a never-forgiven page still grades against a
 * fingerprint the receipt can name. `forgiven` is the sanctioned subset
 * (what was actually missing/unproven and NOT already carried by the
 * baseline document — the plain initial adopt records the family with an
 * EMPTY `forgiven`, because its page debt rides the baseline bulk-add
 * under the ordinary shrink contract) — the ONLY part the evaluator
 * forgives, and the ONLY part `baseline update --family-pages`
 * may shrink. Both are sorted/duplicate-free; every forgiven fingerprint
 * must be one of the recorded ones. The marker itself (dates, ids,
 * recorded fingerprints) is permanent: shrinking rewrites `forgiven`
 * only, so a repeat migration can never re-arm, and a resolved debt can
 * never re-enter.
 */
export const AdoptionFamilySchema = z
  .object({
    /** Family marker shape version, independent of the receipt's. */
    schemaVersion: z.literal(1),
    /** Family adoption instant, ISO-8601, from the run's injected clock. */
    adoptedAt: z.iso.datetime(),
    /** HEAD sha of the adopting commit, or null outside a git repo. */
    gitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'gitSha must be a 40-char lowercase sha1 hex')
      .nullable(),
    /** EVERY initial family obligation id → its pin-#2 fingerprint (proven included). */
    fingerprintsById: z.record(z.string().min(1), FamilyFingerprintSchema),
    /** The sanctioned subset actually forgiven — sorted, unique, recorded. */
    forgiven: z.array(FamilyFingerprintSchema),
  })
  .strict()
  .superRefine((family, ctx) => {
    const ids = Object.keys(family.fingerprintsById);
    for (let index = 1; index < ids.length; index += 1) {
      if (!(ids[index - 1]! < ids[index]!)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fingerprintsById'],
          message:
            'fingerprintsById keys must be sorted; expected \'' + ids[index] +
            '\' after \'' + ids[index - 1] + '\'',
        });
        break;
      }
    }
    const recorded = new Set(Object.values(family.fingerprintsById));
    for (let index = 0; index < family.forgiven.length; index += 1) {
      const fingerprint = family.forgiven[index]!;
      if (index > 0 && fingerprint === family.forgiven[index - 1]) {
        ctx.addIssue({
          code: 'custom',
          path: ['forgiven', index],
          message: `duplicate forgiven fingerprint '${fingerprint}'`,
        });
        break;
      }
      if (!recorded.has(fingerprint)) {
        ctx.addIssue({
          code: 'custom',
          path: ['forgiven', index],
          message: `forgiven fingerprint '${fingerprint}' is not one of the recorded family fingerprints`,
        });
        break;
      }
    }
  });

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
    classificationBlocked: ClassificationBlockedIdsSchema.optional(),
    /** Baseline obligation fingerprints indexed by stable obligation id; absent on older records. */
    obligationFingerprintsById: z
      .record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/))
      .optional(),
    /** Source files for indexed obligations, used only to explain baseline drift. */
    obligationSourcesById: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
    /**
     * Adopted families (0.13): the named, dated, commit-referenced
     * family markers ({@link AdoptionFamilySchema}). OPTIONAL for
     * backward compatibility (a receipt without the field predates
     * families and is not adopted for any of them). The map keys are
     * family names; only a family this engine explicitly sanctions is
     * ever written (`pages`), and a family marker is permanent: the
     * shrink path rewrites the family's `forgiven` list only.
     */
    families: z.record(z.string().min(1), AdoptionFamilySchema).optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const familyNames = Object.keys(record.families ?? {});
    for (let index = 1; index < familyNames.length; index += 1) {
      if (!(familyNames[index - 1]! < familyNames[index]!)) {
        ctx.addIssue({
          code: 'custom',
          path: ['families'],
          message:
            'families keys must be sorted; expected \'' + familyNames[index] +
            '\' after \'' + familyNames[index - 1] + '\'',
        });
        break;
      }
    }
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

/** Inferred family-marker shape. */
export type AdoptionFamily = z.infer<typeof AdoptionFamilySchema>;
