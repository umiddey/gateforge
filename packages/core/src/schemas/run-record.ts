/**
 * Run record schema (plan 2026-09-29, re-seal design rule 1): what a
 * COMPLETE whole-suite supervised run leaves behind when it did NOT
 * seal a gate receipt — the consumer's 563-tests-562-passed case.
 *
 * A gate receipt is a VERDICT: it is issued only for a clean run, and a
 * run with one failing test issues none (it also clears the old one).
 * Without a run record the exact case a test-only re-seal exists for
 * could never re-seal. A run record binds exactly the material a
 * receipt binds — execution result, evidence attestation, candidate
 * tree, input snapshot, approved policy, engine bundle, execution
 * boundary, catalog, per-test outcomes — and carries NO verdict at all.
 *
 * It is a DIFFERENT envelope, not a weaker receipt: its own domain tag
 * (`gateforge.run-record.v1`), its own file (`run-record.json`), its own
 * strict schema, and no field any receipt consumer reads. `check`,
 * pre-commit and the broker therefore never see it: a run record alone
 * leaves `check --require-e2e` exactly as blocked as it was. Only the
 * test-only re-seal path reads it, and only as a PARENT to recompute
 * from, never as proof on its own.
 */
import { z } from 'zod';
import { SchemaVersionField } from './common.js';

/** Hex pattern shared by every digest field. */
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The run record. Unsigned fields first, `mac` last; the signed body is
 * exactly `{domain, ...everything except mac}`.
 */
export const RunRecordSchema = z
  .object({
    schemaVersion: SchemaVersionField,
    /** Envelope version; only `1` exists today. */
    recordVersion: z.literal(1),
    /** Record identity (UUID). */
    recordId: z.string().uuid(),
    /** Non-secret verifier-key id used for safe key-ring rotation. */
    verifierKeyId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional(),
    /** Run manifest identity of the run that produced the record. */
    runId: z.string().uuid(),
    /** Fresh trusted invocation identity of that run. */
    invocationId: z.string().uuid(),
    /** 64-hex digest of the canonical input snapshot the run tested. */
    inputDigest: z.string().regex(HEX64, 'inputDigest must be 64-char lowercase hex'),
    /** Candidate HEAD sha, or null when unavailable (base identity). */
    gitSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'gitSha must be a 40-char lowercase sha1 hex')
      .nullable(),
    /** Parent commit sha, or null when unavailable (parent identity). */
    parentSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'parentSha must be a 40-char lowercase sha1 hex')
      .nullable(),
    /** 64-hex trusted policy/config revision digest (ADR 0005 D6). */
    trustedPolicyDigest: z.string().regex(HEX64, 'trustedPolicyDigest must be 64-char lowercase hex'),
    /** 64-hex owner-approved policy revision the run was pinned to. */
    approvedPolicyDigest: z.string().regex(HEX64, 'approvedPolicyDigest must be 64-char lowercase hex'),
    /** Normalized invocation that produced the record (e.g. `test-gates --changed`). */
    invocation: z.string().min(1),
    /** 64-hex selection digest (the expected test set, fixed pre-run). */
    selectionDigest: z.string().regex(HEX64, 'selectionDigest must be 64-char lowercase hex'),
    /** 64-hex digest of the catalog the selection was planned from. */
    catalogDigest: z.string().regex(HEX64, 'catalogDigest must be 64-char lowercase hex'),
    /** 64-hex digest of the supervision execution result (ADR 0005 D2). */
    executionResultDigest: z.string().regex(HEX64, 'executionResultDigest must be 64-char lowercase hex'),
    /**
     * 64-hex digest over the run's per-test outcomes. It is recomputed
     * from the execution result the record names, so the record can
     * never claim a cleaner run than the one that happened.
     */
    testOutcomesDigest: z.string().regex(HEX64, 'testOutcomesDigest must be 64-char lowercase hex'),
    /** How many tests the whole-suite run planned. */
    plannedTests: z.number().int().min(0),
    /** How many of them the run reported as passed. */
    passedTests: z.number().int().min(0),
    /**
     * 64-hex digest of the v2 evidence attestation envelope that run
     * sealed, or null when it carried none. It binds no verdict: the
     * attestation is evidence, and the gate grading is what the record
     * deliberately omits.
     */
    evidenceAttestationDigest: z.string().regex(HEX64, 'evidenceAttestationDigest must be 64-char lowercase hex').nullable(),
    /** Immutable Git tree actually tested (40-char sha1, or null). */
    candidateTreeId: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'candidateTreeId must be a 40-char lowercase sha1 hex')
      .nullable(),
    /** 64-hex digest binding the approved engine/policy bundle version. */
    engineBundleDigest: z.string().regex(HEX64, 'engineBundleDigest must be 64-char lowercase hex'),
    /** 64-hex digest binding the controller-issued execution-profile record. */
    executionBoundaryDigest: z.string().regex(HEX64, 'executionBoundaryDigest must be 64-char lowercase hex'),
    /** Issuance instant (ISO-8601). */
    issuedAt: z.string().datetime(),
    /** HMAC-SHA256 over the record body, domain `gateforge.run-record.v1`. */
    mac: z.string().regex(HEX64, 'mac must be a 64-char lowercase hex HMAC'),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.passedTests > record.plannedTests) {
      ctx.addIssue({
        code: 'custom',
        path: ['passedTests'],
        message: 'passedTests cannot exceed plannedTests',
      });
    }
  });

/** Inferred run-record shape. */
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** The unsigned run-record body (everything the MAC covers). */
export type RunRecordBody = Omit<RunRecord, 'mac'>;
