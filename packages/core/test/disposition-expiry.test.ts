/**
 * Expiring owner dispositions (plan 2026-10-17): schema acceptance of
 * the optional `expiresAt`/`extensions` fields, the shared injected-clock
 * expiry judgment, and the coverage evaluator's expired/over-max
 * behavior. The behavior compiler reuses the same `dispositionExpiry`
 * judgment, so these tests pin the shared semantics both evaluators run.
 */
import { describe, expect, it } from 'vitest';
import {
  CoverageDispositionSchema,
  CoveragePolicySchema,
  DISPOSITION_MAX_DAYS,
  DISPOSITION_MAX_DURATION_MS,
  coverageDispositionDeprecations,
  dispositionExpiry,
  evaluateCoveragePolicy,
  type CoverageDisposition,
  type CoverageInventoryTable,
  type CoverageTable,
} from '../src/index.js';
import { BehaviorDispositionSchema } from '../src/schemas/behavior-policy.js';

const NOW = '2026-10-17T00:00:00.000Z';
const IN_DAYS = (days: number): string =>
  new Date(Date.parse(NOW) + days * 86_400_000).toISOString();

const INVENTORY: CoverageInventoryTable[] = [
  { name: 'invoices', operations: ['create', 'read'] },
];

function policyWithDisposition(disposition: CoverageDisposition): CoverageTable[] {
  return [
    {
      name: 'invoices',
      requiredOperations: ['create', 'read'],
      disposition,
    },
  ];
}

describe('disposition schemas', () => {
  it('accepts an optional expiresAt and extensions on both disposition shapes', () => {
    const expiresAt = IN_DAYS(10);
    const extensions = [
      { at: NOW, by: 'owner', reason: 'still unreachable', previousExpiresAt: IN_DAYS(5) },
    ];
    expect(
      CoverageDispositionSchema.safeParse({ kind: 'other', note: 'n', expiresAt, extensions })
        .success,
    ).toBe(true);
    expect(
      BehaviorDispositionSchema.safeParse({
        kind: 'out-of-scope',
        reason: 'r',
        expiresAt,
        extensions,
      }).success,
    ).toBe(true);
  });

  it('still accepts the pre-feature shapes (timer fields absent)', () => {
    // The coverage `note` alias keeps the legacy note-only shape loading
    // (plan 2026-10-19); a coverage disposition with NEITHER reason nor
    // note is rejected (reason is required — see "one disposition shape").
    expect(CoverageDispositionSchema.safeParse({ kind: 'not-user-facing', note: 'n' }).success).toBe(
      true,
    );
    expect(BehaviorDispositionSchema.safeParse({ kind: 'operational-only', reason: 'r' }).success).toBe(
      true,
    );
  });

  it('rejects a non-ISO expiresAt and unknown extension fields', () => {
    expect(
      CoverageDispositionSchema.safeParse({ kind: 'not-user-facing', expiresAt: 'soon' }).success,
    ).toBe(false);
    expect(
      BehaviorDispositionSchema.safeParse({
        kind: 'out-of-scope',
        reason: 'r',
        extensions: [{ at: NOW, by: 'o', reason: 'r', previousExpiresAt: NOW, extra: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe('dispositionExpiry (injected clock)', () => {
  it('no-expiry dispositions never expire', () => {
    expect(dispositionExpiry({}, { now: NOW })).toEqual({ state: 'no-expiry' });
  });

  it('future expiry is active; the exact instant and beyond are expired', () => {
    const expiresAt = IN_DAYS(30);
    expect(dispositionExpiry({ expiresAt }, { now: NOW })).toEqual({ state: 'active', expiresAt });
    expect(dispositionExpiry({ expiresAt }, { now: expiresAt })).toEqual({
      state: 'expired',
      expiresAt,
    });
  });

  it('an expiry further out than the maximum is over-max with an actionable detail', () => {
    const expiresAt = IN_DAYS(DISPOSITION_MAX_DAYS + 1);
    const result = dispositionExpiry({ expiresAt }, { now: NOW });
    expect(result.state).toBe('over-max');
    if (result.state === 'over-max') {
      expect(result.detail).toContain('30 days');
    }
  });

  it('maxDurationMs is configurable; the default is the documented 30 days', () => {
    const expiresAt = IN_DAYS(DISPOSITION_MAX_DAYS + 1);
    expect(dispositionExpiry({ expiresAt }, { now: NOW, maxDurationMs: DISPOSITION_MAX_DURATION_MS + 86_400_000 }).state).toBe(
      'active',
    );
  });

  it('rejects a non-ISO injected clock instead of silently honouring the disposition', () => {
    expect(() => dispositionExpiry({ expiresAt: IN_DAYS(1) }, { now: 'not-a-time' })).toThrow();
  });
});

describe('evaluateCoveragePolicy disposition expiry', () => {
  it('honours a not-yet-expired disposition exactly as an untimed one', () => {
    const result = evaluateCoveragePolicy(
      policyWithDisposition({ kind: 'not-user-facing', reason: 'owner excuse', expiresAt: IN_DAYS(1) }),
      INVENTORY,
      [],
      { now: NOW },
    );
    expect(result.configErrors).toEqual([]);
    expect(result.blocking).toEqual([]);
  });

  it('an expired disposition is void: the table grades as undispositioned AND DISPOSITION_EXPIRED blocks', () => {
    const expiresAt = IN_DAYS(-1);
    const result = evaluateCoveragePolicy(
      policyWithDisposition({ kind: 'not-user-facing', reason: 'owner excuse', expiresAt }),
      INVENTORY,
      [],
      { now: NOW },
    );
    expect(result.configErrors).toEqual([]);
    const expired = result.blocking.filter((finding) => finding.code === 'DISPOSITION_EXPIRED');
    expect(expired).toHaveLength(1);
    expect(expired[0]?.table).toBe('invoices');
    expect(expired[0]?.detail).toContain(expiresAt);
    expect(expired[0]?.detail).toContain('gateforge disposition extend');
    expect(expired[0]?.nextAction).toContain('disposition extend');
    // Graded as if it had no disposition: every uncovered operation blocks.
    const missing = result.blocking.filter((finding) => finding.code === 'CRUD_COVERAGE_MISSING');
    expect(missing.map((finding) => finding.operation).sort()).toEqual(['create', 'read']);
  });

  it('an over-max expiry is a config error, never coverage', () => {
    const result = evaluateCoveragePolicy(
      policyWithDisposition({ kind: 'not-user-facing', reason: 'owner excuse', expiresAt: IN_DAYS(DISPOSITION_MAX_DAYS + 1) }),
      INVENTORY,
      [],
      { now: NOW },
    );
    expect(result.blocking).toEqual([]);
    expect(result.configErrors).toHaveLength(1);
    expect(result.configErrors[0]?.code).toBe('DISPOSITION_MAX_DURATION');
    expect(result.configErrors[0]?.table).toBe('invoices');
  });

  it('a configured maxDays overrides the 30-day default', () => {
    const result = evaluateCoveragePolicy(
      policyWithDisposition({ kind: 'not-user-facing', reason: 'owner excuse', expiresAt: IN_DAYS(DISPOSITION_MAX_DAYS + 1) }),
      INVENTORY,
      [],
      { now: NOW, maxDurationMs: (DISPOSITION_MAX_DAYS + 1) * 86_400_000 },
    );
    expect(result.configErrors).toEqual([]);
    expect(result.blocking).toEqual([]);
  });

  it('the schema still accepts a policy section carrying expiring dispositions', () => {
    expect(
      CoveragePolicySchema.safeParse({
        tables: [{ name: 'invoices', requiredOperations: ['read'], disposition: { kind: 'other', note: 'n', expiresAt: IN_DAYS(3) } }],
      }).success,
    ).toBe(true);
  });
});

describe('one disposition shape (plan 2026-10-19)', () => {
  it('reason is REQUIRED on behavior, and on coverage kind other', () => {
    const behavior = BehaviorDispositionSchema.safeParse({ kind: 'out-of-scope' });
    expect(behavior.success).toBe(false);
    if (!behavior.success) {
      expect(behavior.error.issues[0]?.path.join('.')).toBe('reason');
    }
    // Coverage `other` still requires a recorded reason (the pre-shape
    // rule). A non-other kind with neither reason nor note is a pre-shape
    // config and must still load — note was optional for those kinds.
    const other = CoverageDispositionSchema.safeParse({ kind: 'other' });
    expect(other.success).toBe(false);
    if (!other.success) {
      expect(other.error.issues[0]?.path.join('.')).toBe('reason');
    }
    expect(CoverageDispositionSchema.safeParse({ kind: 'not-user-facing' }).success).toBe(true);
    // A blank reason is no reason (fail closed on both surfaces).
    expect(BehaviorDispositionSchema.safeParse({ kind: 'out-of-scope', reason: '' }).success).toBe(false);
    expect(CoverageDispositionSchema.safeParse({ kind: 'other', reason: '' }).success).toBe(false);
  });

  it('each surface accepts only its own kind subset', () => {
    // Endpoint dispositions never carry a table kind...
    expect(
      BehaviorDispositionSchema.safeParse({ kind: 'not-user-facing', reason: 'r' }).success,
    ).toBe(false);
    expect(
      BehaviorDispositionSchema.safeParse({ kind: 'admin-plane-unreachable', reason: 'r' }).success,
    ).toBe(false);
    // ...and table dispositions never carry an endpoint kind.
    expect(
      CoverageDispositionSchema.safeParse({ kind: 'out-of-scope', reason: 'r' }).success,
    ).toBe(false);
    expect(
      CoverageDispositionSchema.safeParse({ kind: 'operational-only', reason: 'r' }).success,
    ).toBe(false);
    // The documented subsets stay valid.
    expect(BehaviorDispositionSchema.safeParse({ kind: 'operational-only', reason: 'r' }).success).toBe(true);
    expect(
      CoverageDispositionSchema.safeParse({ kind: 'read-only-surface', reason: 'r' }).success,
    ).toBe(true);
  });

  it("the deprecated coverage 'note' alias still loads and maps onto 'reason'", () => {
    const parsed = CoverageDispositionSchema.parse({ kind: 'other', note: 'legacy note' });
    expect(parsed.reason).toBe('legacy note');
    // The alias survives on the parsed value only so the check advisory
    // can name the tables that still use it.
    expect(parsed.note).toBe('legacy note');
  });

  it("a disposition carrying both 'note' and 'reason' with different values is refused", () => {
    const mismatch = CoverageDispositionSchema.safeParse({
      kind: 'other',
      reason: 'one truth',
      note: 'another',
    });
    expect(mismatch.success).toBe(false);
    if (!mismatch.success) {
      expect(mismatch.error.issues[0]?.path.join('.')).toBe('note');
    }
    // Agreeing values stay acceptable (redundant, not ambiguous).
    expect(
      CoverageDispositionSchema.safeParse({ kind: 'other', reason: 'same', note: 'same' }).success,
    ).toBe(true);
  });

  it('the parsed coverage disposition always exposes the shared shape fields', () => {
    const parsed = CoverageDispositionSchema.parse({ kind: 'read-only-surface', reason: 'r' });
    expect(parsed).toEqual({ kind: 'read-only-surface', reason: 'r' });
  });

  it('a coverage disposition with no reason loads and warns that reason will be required', () => {
    const parsed = CoveragePolicySchema.parse({
      tables: [
        {
          name: 'invoices',
          requiredOperations: ['read'],
          disposition: { kind: 'not-user-facing' },
        },
      ],
    });
    expect(parsed.tables[0]?.disposition?.reason).toBeUndefined();
    expect(coverageDispositionDeprecations(parsed.tables)).toEqual([
      "coveragePolicy table 'invoices' disposition records no 'reason' — 'reason' will be required",
    ]);
    const withReason = CoveragePolicySchema.parse({
      tables: [
        {
          name: 'invoices',
          requiredOperations: ['read'],
          disposition: { kind: 'not-user-facing', reason: 'kept' },
        },
      ],
    });
    expect(coverageDispositionDeprecations(withReason.tables)).toEqual([]);
    const viaNote = CoveragePolicySchema.parse({
      tables: [
        {
          name: 'invoices',
          requiredOperations: ['read'],
          disposition: { kind: 'not-user-facing', note: 'legacy' },
        },
      ],
    });
    const noteWarnings = coverageDispositionDeprecations(viaNote.tables);
    expect(noteWarnings.some((line) => line.includes('will be required'))).toBe(false);
    expect(noteWarnings.some((line) => line.includes("deprecated 'note' alias"))).toBe(true);
  });
});
