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
/**
 * The classification layer's id list shape, NON-optional: the record
 * field wraps this in `.optional()` (absent = pre-layer receipt), while
 * the capture/shrink helpers validate against THIS schema so a present
 * list is always a sorted, duplicate-free, non-empty-string array.
 */
export declare const ClassificationBlockedIdsSchema: z.ZodArray<z.ZodString>;
/** The adoption record: who forgave how much, when, on what commit. */
export declare const AdoptionRecordSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    adoptedAt: z.ZodISODateTime;
    gitSha: z.ZodNullable<z.ZodString>;
    adopted: z.ZodNumber;
    proven: z.ZodNumber;
    classificationBlocked: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
/** Inferred adoption-record shape. */
export type AdoptionRecord = z.infer<typeof AdoptionRecordSchema>;
//# sourceMappingURL=adoption.d.ts.map