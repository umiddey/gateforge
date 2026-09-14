/**
 * Test-map sidecar schema tests (plan 2026-09-13 §5.3): versioning, the
 * one-declaration-model constraints (claims non-empty, supported kind,
 * required reason), wildcard prohibition (`'*'` is not an obligation id),
 * and duplicate-key rejection naming BOTH entries. Engine class per
 * docs/testing/TESTING_POLICY.md.
 */
import { describe, expect, it } from 'vitest';
import { TestMapSchema, type TestMapEntry } from '../src/schemas/test-map.js';

const KEY = 'playwright:chromium:e2e/accounts.spec.js:deletes an account';

/** One valid sidecar entry (tests override single fields). */
function entry(overrides: Partial<TestMapEntry> = {}): TestMapEntry {
  return {
    key: KEY,
    selector: {
      runner: 'playwright',
      project: 'chromium',
      file: 'e2e/accounts.spec.js',
      titlePath: ['deletes an account'],
    },
    kind: 'browser-e2e',
    claims: ['tenant.accounts:persistence:read'],
    reason: 'The existing journey deletes the selected account.',
    ...overrides,
  };
}

describe('test map sidecar schema', () => {
  it('accepts a minimal valid document', () => {
    const parsed = TestMapSchema.parse({ schemaVersion: 1, tests: [entry()] });
    expect(parsed.tests).toHaveLength(1);
    expect(parsed.tests[0]?.key).toBe(KEY);
  });

  it('rejects an unknown schemaVersion (gateforge never migrates)', () => {
    const result = TestMapSchema.safeParse({ schemaVersion: 2, tests: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unsupported schemaVersion: got 2');
    }
  });

  it('rejects an entry whose claims list is empty (a declaration claims something)', () => {
    const result = TestMapSchema.safeParse({ schemaVersion: 1, tests: [entry({ claims: [] })] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('at least one obligation');
    }
  });

  it('rejects an unsupported kind (§5.3: kind is a supported TestKind value)', () => {
    const result = TestMapSchema.safeParse({
      schemaVersion: 1,
      tests: [entry({ kind: 'e2e' as unknown as TestMapEntry['kind'] })],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing or too-short reason (a declaration must be reviewable)', () => {
    for (const reason of [undefined, 'nope', '      ']) {
      const document = {
        schemaVersion: 1,
        tests: [entry(reason === undefined ? { reason: undefined as unknown as string } : { reason })],
      };
      const result = TestMapSchema.safeParse(document);
      expect(result.success, `reason=${String(reason)}`).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0];
        expect(issue?.path.map(String).join('.')).toBe('tests.0.reason');
      }
    }
  });

  it('rejects a "*" wildcard claim: it is not an obligation id', () => {
    const result = TestMapSchema.safeParse({ schemaVersion: 1, tests: [entry({ claims: ['*'] })] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("<resourceId>:<contract>");
    }
  });

  it('rejects unknown keys (strict document)', () => {
    const result = TestMapSchema.safeParse({
      schemaVersion: 1,
      tests: [entry()],
      bogus: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate keys naming BOTH entries (never bind the first match)', () => {
    const duplicate = entry({
      selector: { runner: 'playwright', project: 'firefox', file: 'e2e/accounts.spec.js', titlePath: ['deletes an account'] },
      reason: 'A different selector under the same key.',
    });
    const result = TestMapSchema.safeParse({ schemaVersion: 1, tests: [entry(), duplicate] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? '';
      expect(message).toContain("duplicate sidecar key '");
      expect(message).toContain('tests[0]');
      expect(message).toContain('tests[1]');
      expect(message).toContain('e2e/accounts.spec.js');
    }
  });
});
