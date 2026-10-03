/**
 * Flaky-test quarantine schema: an
 * owner-approved, ALWAYS-EXPIRING removal of one test from the required
 * set.
 *
 * All four attribution fields are mandatory — a quarantine without an
 * owner, an approver or a reason is a fail-closed configuration error,
 * never a partially-applied exception (the waiver trust pattern). A
 * quarantined test NEVER proves anything and NEVER blocks: it is
 * removed from the required set before the run, and an obligation only
 * it covered stays `missing`.
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';

/** One owner's quarantine of exactly one test (logical key). */
export const QuarantineSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /**
     * The quarantined test's stable logical key
     * (`<file>#<title path>`), exactly as the test catalog reports it.
     */
    testKey: z.string().min(1),
    /** Person/team accountable for the flaky test. */
    owner: z.string().min(1),
    /** Named approver who accepted the flake. */
    approver: z.string().min(1),
    /** Why the test is quarantined (flake evidence, tracking issue). */
    reason: z.string().min(1),
    /** Expiry instant (ISO-8601); after this the quarantine blocks. */
    expiresAt: z.iso.datetime(),
  })
  .strict();

/** Inferred quarantine shape. */
export type Quarantine = z.infer<typeof QuarantineSchema>;
