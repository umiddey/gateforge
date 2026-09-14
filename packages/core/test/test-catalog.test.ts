/**
 * Test-catalog schema tests (plan 2026-09-13 §5.1 row 1 + §5.2):
 * versioning, logical-key derivation, uniqueness (duplicate keys are a
 * typed error listing both sources), unresolved-reason coupling, and
 * roll-up consistency. Engine class per docs/testing/TESTING_POLICY.md.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveLogicalKey,
  TestCatalogSchema,
  type TestCatalogEntry,
} from '../src/schemas/test-catalog.js';

/** One minimal valid catalog row (tests override single fields). */
function entry(overrides: Partial<TestCatalogEntry> & { logicalKey: string }): TestCatalogEntry {
  return {
    runner: 'playwright',
    project: 'chromium',
    file: 'e2e/accounts.spec.ts',
    titlePath: ['Accounts', 'creates an account'],
    title: 'creates an account',
    sourceLocation: { file: 'e2e/accounts.spec.ts', line: 3, col: 2 },
    parameterIdentity: null,
    sourceDigest: 'aa'.repeat(32),
    discoveryStatus: 'discovered',
    reconciliation: 'matched',
    inferredKind: 'browser-e2e',
    kindSignals: [],
    weakSignals: [],
    rulesFired: [],
    categorySignals: [],
    suppressionSignals: [],
    ...overrides,
  };
}

/** A catalog with the given rows (plus an empty roll-up unless told). */
function catalog(entries: TestCatalogEntry[], unresolved: Array<{ logicalKey: string }> = []) {
  return {
    schemaVersion: 1,
    entries,
    unresolved: unresolved.map((row) => ({
      logicalKey: row.logicalKey,
      code: 'x',
      detail: 'x',
      location: { file: 'e2e/accounts.spec.ts', line: 1, col: 0 },
    })),
    parseErrors: [],
    inventoryComplete: true,
    runnerSummaries: [],
  };
}

describe('test catalog schema', () => {
  it('accepts a minimal valid catalog', () => {
    const parsed = TestCatalogSchema.parse(catalog([entry({ logicalKey: 'k1' })]));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.inventoryComplete).toBe(true);
  });

  it('rejects an unknown schemaVersion (gateforge never migrates)', () => {
    const result = TestCatalogSchema.safeParse({ ...catalog([]), schemaVersion: 2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unsupported schemaVersion: got 2');
    }
  });

  it('derives deterministic logical keys; line numbers are never input', () => {
    const base = deriveLogicalKey({
      runner: 'playwright',
      project: 'chromium',
      file: 'e2e/accounts.spec.ts',
      titlePath: ['Accounts', 'deletes an account'],
    });
    expect(base).toBe('playwright:chromium:e2e/accounts.spec.ts:Accounts>deletes an account');
    // Unbound project (static-only rows) uses the `-` placeholder.
    expect(
      deriveLogicalKey({ runner: 'playwright', project: null, file: 'a.ts', titlePath: ['t'] }),
    ).toBe('playwright:-:a.ts:t');
  });

  it('rejects duplicate logical keys listing BOTH sources', () => {
    const first = entry({ logicalKey: 'dup' });
    const second = entry({
      logicalKey: 'dup',
      project: 'firefox',
      sourceLocation: { file: 'e2e/accounts.spec.ts', line: 9, col: 2 },
    });
    const result = TestCatalogSchema.safeParse(catalog([first, second]));
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('\n');
      expect(message).toContain("duplicate logical key 'dup'");
      expect(message).toContain('e2e/accounts.spec.ts:3');
      expect(message).toContain('e2e/accounts.spec.ts:9');
    }
  });

  it('requires unresolvedReason exactly when discoveryStatus is unresolved', () => {
    const missing = TestCatalogSchema.safeParse(
      catalog([entry({ logicalKey: 'k', discoveryStatus: 'unresolved' })]),
    );
    expect(missing.success).toBe(false);

    const extraneous = TestCatalogSchema.safeParse(
      catalog([
        entry({
          logicalKey: 'k',
          unresolvedReason: { code: 'c', detail: 'd' },
        }),
      ]),
    );
    expect(extraneous.success).toBe(false);

    const valid = TestCatalogSchema.safeParse(
      catalog(
        [
          entry({
            logicalKey: 'k',
            discoveryStatus: 'unresolved',
            unresolvedReason: { code: 'c', detail: 'd' },
          }),
        ],
        [{ logicalKey: 'k' }],
      ),
    );
    expect(valid.success).toBe(true);
  });

  it('requires the unresolved roll-up to mirror unresolved rows', () => {
    const row = entry({
      logicalKey: 'k',
      discoveryStatus: 'unresolved',
      unresolvedReason: { code: 'c', detail: 'd' },
    });
    const result = TestCatalogSchema.safeParse(catalog([row]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("entry 'k' is unresolved but missing from the unresolved roll-up");
    }
    const withRollup = TestCatalogSchema.safeParse(catalog([row], [{ logicalKey: 'k' }]));
    expect(withRollup.success).toBe(true);
  });

  it('requires title to equal the last titlePath segment', () => {
    const result = TestCatalogSchema.safeParse(catalog([entry({ logicalKey: 'k', title: 'other' })]));
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys (typos fail loud)', () => {
    const result = TestCatalogSchema.safeParse({
      ...catalog([entry({ logicalKey: 'k' })]),
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});
