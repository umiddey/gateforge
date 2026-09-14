/**
 * Closed-world CRUD coverage evaluator tests (plan 2026-09-13 §3.6,
 * Phase 0 item 7, ADR 0005 D5): missing browser-e2e coverage blocks with
 * `CRUD_COVERAGE_MISSING`, a recorded owner disposition does not, an
 * unknown policy table is a CONFIG error (exit 2 at the call site), and a
 * silently dropped inventory table is a violation — the evaluator
 * requires the inventory so the drop is detectable.
 */
import { describe, expect, it } from 'vitest';
import {
  CoveragePolicySchema,
  evaluateCoveragePolicy,
  type CoverageInventoryTable,
  type CoverageTable,
  type MappedCoverage,
} from '../src/index.js';

const INVENTORY: readonly CoverageInventoryTable[] = [
  { name: 'accounts', operations: ['create', 'read', 'update', 'delete'] },
  { name: 'orders', operations: ['create', 'read', 'update', 'delete'] },
];

function table(name: string, overrides: Partial<CoverageTable> = {}): CoverageTable {
  return {
    name,
    requiredOperations: ['create', 'read', 'update', 'delete'],
    ...overrides,
  };
}

describe('coverage policy schema (strict, owner-owned)', () => {
  it('accepts tables with required operations and owner dispositions', () => {
    const parsed = CoveragePolicySchema.parse({
      tables: [
        { name: 'accounts', requiredOperations: ['create', 'delete'] },
        {
          name: 'orders',
          requiredOperations: ['read'],
          disposition: { kind: 'read-only-surface', note: 'UI never mutates orders' },
        },
      ],
    });
    expect(parsed.tables).toHaveLength(2);
  });

  it('rejects unknown operations, duplicate names, and note-less other dispositions', () => {
    expect(() =>
      CoveragePolicySchema.parse({ tables: [{ name: 'a', requiredOperations: ['upsert'] }] }),
    ).toThrow();
    expect(() =>
      CoveragePolicySchema.parse({
        tables: [
          { name: 'a', requiredOperations: ['read'] },
          { name: 'a', requiredOperations: ['read'] },
        ],
      }),
    ).toThrow(/duplicate coverage-policy table 'a'/);
    expect(() =>
      CoveragePolicySchema.parse({
        tables: [
          { name: 'a', requiredOperations: ['read'], disposition: { kind: 'other' } },
        ],
      }),
    ).toThrow(/requires 'note'/);
    expect(() => CoveragePolicySchema.parse({ tables: [{ name: 'a', requiredOperations: [] }] })).toThrow();
  });
});

describe('evaluateCoveragePolicy', () => {
  it('an uncovered, undispositioned required operation blocks with CRUD_COVERAGE_MISSING', () => {
    const result = evaluateCoveragePolicy([table('accounts')], INVENTORY, []);
    expect(result.configErrors).toEqual([]);
    // 4 uncovered account operations + the closed-world dropped-table
    // violation for 'orders' (in the inventory but not enumerated).
    expect(result.blocking).toHaveLength(5);
    const accountFindings = result.blocking.filter((finding) => finding.table === 'accounts');
    expect(accountFindings).toHaveLength(4);
    expect(accountFindings.every((finding) => finding.code === 'CRUD_COVERAGE_MISSING')).toBe(true);
    expect(accountFindings.every((finding) => finding.cause === 'CRUD_COVERAGE_MISSING')).toBe(true);
    const del = accountFindings.find((finding) => finding.operation === 'delete');
    expect(del?.detail).toContain("table 'accounts' has no mapped browser-e2e 'delete' coverage");
    expect(del?.nextAction).toContain('record an owner disposition');
  });

  it('a table with a recorded owner disposition does not block', () => {
    const result = evaluateCoveragePolicy(
      [
        table('accounts', {
          disposition: { kind: 'admin-plane-unreachable', note: 'no UI journey exists by design' },
        }),
        table('orders'),
      ],
      INVENTORY,
      [],
    );
    expect(result.configErrors).toEqual([]);
    expect(result.blocking.every((finding) => finding.table !== 'accounts')).toBe(true);
    expect(result.blocking.length).toBe(4);
    expect(result.blocking.every((finding) => finding.table === 'orders')).toBe(true);
  });

  it('mapped browser-e2e coverage satisfies a required operation', () => {
    const mapped: readonly MappedCoverage[] = [
      { table: 'accounts', operation: 'create', testKind: 'browser-e2e' },
    ];
    const result = evaluateCoveragePolicy(
      [table('accounts', { requiredOperations: ['create', 'delete'] }), table('orders', { requiredOperations: ['read'] })],
      INVENTORY,
      mapped,
    );
    expect(result.configErrors).toEqual([]);
    const accountFindings = result.blocking.filter((finding) => finding.table === 'accounts');
    expect(accountFindings.map((finding) => finding.operation)).toEqual(['delete']);
  });

  it('api-e2e and unit mappings never substitute for browser-e2e coverage', () => {
    const mapped: readonly MappedCoverage[] = [
      { table: 'accounts', operation: 'create', testKind: 'api-e2e' },
      { table: 'accounts', operation: 'delete', testKind: 'unit' },
    ];
    const result = evaluateCoveragePolicy(
      [table('accounts', { requiredOperations: ['create', 'delete'] }), table('orders', { requiredOperations: ['read'] })],
      INVENTORY,
      mapped,
    );
    const accountFindings = result.blocking.filter((finding) => finding.table === 'accounts');
    expect(accountFindings.map((finding) => finding.operation)).toEqual(['create', 'delete']);
  });

  it('a policy table absent from the inventory is a CONFIG error naming the table', () => {
    const result = evaluateCoveragePolicy(
      [table('ghosts'), table('accounts'), table('orders')],
      INVENTORY,
      [],
    );
    expect(result.configErrors).toHaveLength(1);
    expect(result.configErrors[0]?.code).toBe('COVERAGE_TABLE_UNKNOWN');
    expect(result.configErrors[0]?.table).toBe('ghosts');
    expect(result.configErrors[0]?.detail).toContain('silently dropped table is a violation');
    // The known tables still grade normally.
    expect(result.blocking.every((finding) => finding.table !== 'ghosts')).toBe(true);
  });

  it('an inventory table the policy drops is a violation, never silent coverage', () => {
    const result = evaluateCoveragePolicy(
      [table('accounts', { requiredOperations: ['read'] })],
      INVENTORY,
      [],
    );
    expect(result.configErrors).toEqual([]);
    const dropped = result.blocking.find((finding) => finding.table === 'orders');
    expect(dropped?.operation).toBeNull();
    expect(dropped?.code).toBe('CRUD_COVERAGE_MISSING');
    expect(dropped?.detail).toContain('does not enumerate it');
  });

  it('results are deterministic: identical inputs, identical output, sorted findings', () => {
    const first = evaluateCoveragePolicy([table('orders'), table('accounts')], INVENTORY, []);
    const second = evaluateCoveragePolicy([table('accounts'), table('orders')], INVENTORY, []);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const tables = first.blocking.map((finding) => finding.table);
    expect(tables).toEqual([...tables].sort());
  });
});
