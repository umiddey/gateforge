/**
 * Reporter ledger computation (pure helpers).
 *
 * Per-claim verdicts are computed with the REAL verdict engine
 * (`evaluateObligation`, G3 pin #9) — the reporter never trusts a test's
 * own conclusion. Per-claim isolation: each row evaluates exactly that
 * test's claim against the run's witness ledger; the engine attributes
 * records by (obligationId, testId), so a claim cannot borrow another
 * test's evidence.
 *
 * The ledger needs the run's obligations (from `GATEFORGE_OBLIGATIONS`)
 * and each resource's classification (primaryKey etc.) from the witness
 * (`GET /classifications`). When either is unavailable the row carries
 * `verdict: null` and the reason says exactly what is missing.
 */
import {
  evaluateObligation,
  type Classification,
  type Obligation,
  type Verdict,
} from '@gateforge/core';
import type { IssuedLedgerRecord } from '../fixture/witness-client.js';

/** One suite-visible obligation from `obligations.json` (state contract). */
export interface StateObligationEntry {
  id: string;
  resourceId: string;
  contract: string;
  policyId: string;
  lifecycle: {
    create: boolean;
    read: boolean;
    update: boolean;
    delete: boolean;
    deleteSemantics?: 'hard' | 'archive';
  };
  fingerprint: string;
  source: string;
  location: { file: string; line: number; col: number } | null;
}

/** The obligations document the CLI writes (`{schemaVersion, obligations}`). */
export interface ObligationsDocument {
  schemaVersion: number;
  obligations: StateObligationEntry[];
}

/** A claim extracted from one test's annotations. */
export interface LedgerClaim {
  obligationId: string;
  testId: string;
  testFile: string;
  location: { file: string; line: number; col: number } | null;
}

/** One ledger row: one test's claim judged by the engine. */
export interface LedgerRow {
  claim: string;
  testId: string;
  testFile: string;
  verdict: Verdict | null;
  reason: string | null;
  recordIds: string[];
  trustTier: 'witnessed' | 'claimed' | null;
}

/** Load a valid claim-shaped object from the annotation source. */
export function claimOf(
  obligationId: string,
  test: { id: string; location?: { file: string; line: number; column: number } | null },
): LedgerClaim {
  const location =
    test.location === undefined || test.location === null
      ? null
      : { file: test.location.file, line: test.location.line, col: test.location.column };
  return {
    obligationId,
    testId: test.id,
    testFile: location === null ? '' : location.file,
    location,
  };
}

/** Reads a lifecycle object leniently (absent booleans → false). */
function lifecycleOf(value: unknown): {
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
  deleteSemantics?: 'hard' | 'archive';
} {
  if (typeof value !== 'object' || value === null) {
    return { create: false, read: false, update: false, delete: false };
  }
  const entry = value as Record<string, unknown>;
  return {
    create: entry['create'] === true,
    read: entry['read'] === true,
    update: entry['update'] === true,
    delete: entry['delete'] === true,
    ...(entry['deleteSemantics'] === 'hard' || entry['deleteSemantics'] === 'archive'
      ? { deleteSemantics: entry['deleteSemantics'] }
      : {}),
  };
}

/** Parses the obligations document (fail-lenient: missing → null). */
export function parseObligationsDocument(raw: string): ObligationsDocument | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const entry = parsed as Record<string, unknown>;
    if (!Array.isArray(entry['obligations'])) return null;
    const obligations = (entry['obligations'] as unknown[]).flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const candidate = item as Record<string, unknown>;
      if (typeof candidate['id'] !== 'string' || typeof candidate['contract'] !== 'string') {
        return [];
      }
      return [
        {
          id: candidate['id'],
          resourceId: typeof candidate['resourceId'] === 'string' ? candidate['resourceId'] : '',
          contract: candidate['contract'],
          policyId: typeof candidate['policyId'] === 'string' ? candidate['policyId'] : '',
          lifecycle: lifecycleOf(candidate['lifecycle']),
          fingerprint: typeof candidate['fingerprint'] === 'string' ? candidate['fingerprint'] : '',
          source: typeof candidate['source'] === 'string' ? candidate['source'] : '',
          location:
            typeof candidate['location'] === 'object' && candidate['location'] !== null
              ? (candidate['location'] as { file: string; line: number; col: number })
              : null,
        },
      ];
    });
    return { schemaVersion: 1, obligations };
  } catch {
    return null;
  }
}

/**
 * Computes one ledger row for a claim.
 *
 * Args:
 *   claim: the claim under judgment.
 *   obligations: the run's obligations (state doc).
 *   classifications: per-resource classification map (witness surface).
 *   records: the full run ledger.
 *   now: injected instant for the verdict engine.
 *
 * Returns:
 *   LedgerRow: verdict + reason + considered record ids. `verdict:
 *   null` (with reason) when required context is missing.
 */
export function ledgerRowFor(
  claim: LedgerClaim,
  obligations: ObligationsDocument | null,
  classifications: Record<string, Classification>,
  records: readonly IssuedLedgerRecord[],
  now: string,
): LedgerRow {
  if (obligations === null) {
    return {
      claim: claim.obligationId,
      testId: claim.testId,
      testFile: claim.testFile,
      verdict: null,
      reason: 'obligations document unavailable; per-claim verdicts need the run obligations',
      recordIds: [],
      trustTier: null,
    };
  }
  const obligation = obligations.obligations.find((entry) => entry.id === claim.obligationId);
  if (obligation === undefined) {
    return {
      claim: claim.obligationId,
      testId: claim.testId,
      testFile: claim.testFile,
      verdict: null,
      reason: `claim references '${claim.obligationId}' which is not in the run's obligations`,
      recordIds: [],
      trustTier: null,
    };
  }
  const classification = classifications[obligation.resourceId] ?? null;
  const engineObligation: Obligation = {
    schemaVersion: 1,
    id: obligation.id,
    resourceId: obligation.resourceId,
    contract: obligation.contract,
    policyId: obligation.policyId,
    lifecycle: obligation.lifecycle,
  };
  const outcome = evaluateObligation(engineObligation, {
    claims: [
      {
        schemaVersion: 1,
        obligationId: claim.obligationId,
        testId: claim.testId,
        testFile: claim.testFile,
        ...(claim.location === null ? {} : { location: claim.location }),
      },
    ],
    records: records as unknown[],
    waivers: [],
    classification,
    now,
  });
  const mine = records.filter((record) => record.testId === claim.testId);
  const trustTier: LedgerRow['trustTier'] = mine.some((record) => record.trust === 'witnessed')
    ? 'witnessed'
    : mine.length > 0
      ? 'claimed'
      : null;
  return {
    claim: claim.obligationId,
    testId: claim.testId,
    testFile: claim.testFile,
    verdict: outcome.verdict,
    reason: outcome.reason,
    recordIds: outcome.recordIds,
    trustTier,
  };
}

/** Blocks the run? (satisfied/waived are clean.) */
export function isBlocking(verdict: Verdict | null): boolean {
  return (
    verdict !== null &&
    verdict !== 'satisfied' &&
    verdict !== 'waived'
  );
}