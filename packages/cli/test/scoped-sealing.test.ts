/**
 * Scoped supervised sealing (Goal 2, opt-in `test-gates --changed
 * --scope changed`): the CLI-side affected-set planner — changed files →
 * resources → obligations → declared-claiming tests, file-grained and
 * never guessing — plus the receipt scope extension (schema coherence,
 * MAC round-trip over the new fields) and the scope-aware reuse
 * expectations in receipts.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExecutionResultSchema,
  GateReceiptSchema,
  executionResultDigestOf,
  fingerprint,
  sha256Canonical,
  type Obligation,
  type ResolvedMappings,
  type ResourceGraph,
  type TestCatalog,
  type TestCatalogEntry,
} from '@gate-forge/core';
import { planScopedExpectedSet, issueGateReceipt } from '../src/execution.js';
import { testReceiptV2Bindings } from './gate-receipts.js';
import { loadReceiptFor, receiptScope, tryReuseReceipt } from '../src/receipts.js';
import { writeExecutionResult, writeGateReceipt } from '../src/state.js';
import { FIXED_AT, POLICY_ID } from './helpers.js';

const VERIFIER_KEY = 'scope-verifier-key';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const INVOCATION_ID = '66666666-7777-4888-8999-000000000000';
const HEX = (seed: number): string => String(seed).repeat(64);

const LIFECYCLE = { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' } as const;

/** One schema-valid obligation (same identity shape the pipeline emits). */
function obligation(resourceId: string, contract = 'persistence:read'): Obligation {
  return {
    schemaVersion: 1,
    id: `${resourceId}:${contract}`,
    resourceId,
    contract,
    policyId: POLICY_ID,
    lifecycle: { ...LIFECYCLE },
  };
}

/** Pin-#2 fingerprint of a fixture obligation (the identity receipts seal). */
function fp(resourceId: string, contract = 'persistence:read'): string {
  return fingerprint({ resourceId, contract, policyId: POLICY_ID, lifecycle: LIFECYCLE });
}

/** One catalog row (playwright, overrides allowed). */
function row(overrides: Partial<TestCatalogEntry> = {}): TestCatalogEntry {
  const file = overrides.file ?? 'e2e/accounts.spec.ts';
  const titlePath = overrides.titlePath ?? ['Accounts', 'deletes an account'];
  return {
    logicalKey: overrides.logicalKey ?? `playwright:chromium:${file}:${titlePath.join('>')}`,
    runner: 'playwright',
    project: 'chromium',
    file,
    titlePath,
    title: titlePath[titlePath.length - 1] ?? 'case',
    sourceLocation: { file, line: 3, col: 0 },
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

function catalog(entries: TestCatalogEntry[]): TestCatalog {
  return { schemaVersion: 1, entries, unresolved: [], parseErrors: [], inventoryComplete: true, runnerSummaries: [] };
}

/** Minimal graph: only what `sourcesByResourceId` joins on. */
function graph(resources: Array<{ id: string; source: string; callSources?: string[] }>): ResourceGraph {
  return {
    resources: resources.map((resource) => ({
      id: resource.id,
      source: resource.source,
      attributes: resource.callSources !== undefined ? { callSources: resource.callSources } : {},
    })),
  } as unknown as ResourceGraph;
}

/** One sidecar-origin binding for an obligation. */
function sidecarBinding(instances: TestCatalogEntry[]): ResolvedMappings['obligations'][number]['bindings'][number] {
  return {
    logicalKey: instances[0]?.logicalKey ?? 'k',
    origin: 'sidecar',
    instances: instances.map((entry) => ({
      runner: entry.runner,
      project: entry.project,
      file: entry.file,
      titlePath: [...entry.titlePath],
      parameterIdentity: entry.parameterIdentity,
    })),
    sourceDigest: null,
    declaredKind: 'browser-e2e',
    categories: [],
    reason: null,
    sourceLocation: null,
    caseIds: [],
  };
}

/** Native-claim binding, as the resolver builds it from claims.json. */
function nativeBinding(testId: string, instances: TestCatalogEntry[]): ResolvedMappings['obligations'][number]['bindings'][number] {
  return {
    logicalKey: testId,
    origin: 'native',
    instances: instances.map((entry) => ({
      runner: entry.runner,
      project: entry.project,
      file: entry.file,
      titlePath: [...entry.titlePath],
      parameterIdentity: entry.parameterIdentity,
    })),
    sourceDigest: null,
    declaredKind: null,
    categories: [],
    reason: null,
    sourceLocation: null,
    caseIds: [],
  };
}

describe('planScopedExpectedSet (affected set joined, never guessed)', () => {
  const accountsRow = row();
  const ordersRow = row({ file: 'e2e/orders.spec.ts', titlePath: ['Orders', 'reads an order'] });
  const theCatalog = catalog([accountsRow, ordersRow]);
  const theGraph = graph([
    { id: 'tenant.accounts', source: 'src/accounts.txt' },
    { id: 'tenant.orders', source: 'src/orders.txt' },
  ]);

  it('plans exactly the slice claiming affected obligations; untouched files stay out', () => {
    const resolution: ResolvedMappings = {
      obligations: [
        {
          obligationId: 'tenant.accounts:persistence:read',
          bindings: [sidecarBinding([accountsRow])],
        },
        {
          obligationId: 'tenant.accounts:persistence:delete',
          bindings: [sidecarBinding([accountsRow])],
        },
        {
          obligationId: 'tenant.orders:persistence:read',
          bindings: [sidecarBinding([ordersRow])],
        },
      ],
      problems: [],
    };
    const plan = planScopedExpectedSet({
      catalog: theCatalog,
      resolution,
      obligations: [
        obligation('tenant.accounts'),
        obligation('tenant.orders'),
        obligation('tenant.accounts', 'persistence:delete'),
      ],
      graph: theGraph,
      changedFiles: ['src/accounts.txt'],
    });
    // Only the accounts obligations are affected; the untouched orders
    // file is NOT planned — that is the whole point of the slice.
    expect(plan.affected.map((entry) => entry.id)).toEqual([
      'tenant.accounts:persistence:delete',
      'tenant.accounts:persistence:read',
    ]);
    expect(plan.plannedRows.map((entry) => entry.planned.file)).toEqual(['e2e/accounts.spec.ts']);
    expect(plan.coveredFingerprints).toEqual(
      [fp('tenant.accounts', 'persistence:delete'), fp('tenant.accounts')].sort(),
    );
    expect(plan.unclaimed).toEqual([]);
  });

  it('is join-aware: a changed frontend call source affects the joined resource', () => {
    const joinedGraph = graph([
      { id: 'tenant.accounts', source: 'backend/accounts.py', callSources: ['frontend/client.ts:12:3'] },
    ]);
    const plan = planScopedExpectedSet({
      catalog: theCatalog,
      resolution: { obligations: [], problems: [] },
      obligations: [obligation('tenant.accounts', 'transport:call')],
      graph: joinedGraph,
      changedFiles: ['frontend/client.ts'],
    });
    expect(plan.affected.map((entry) => entry.id)).toEqual(['tenant.accounts:transport:call']);
  });

  it('a slice is FILE-grained: every catalog row of a claimed file is planned (over-selection is safe)', () => {
    const sibling = row({ file: 'e2e/accounts.spec.ts', titlePath: ['Accounts', 'creates an account'] });
    const plan = planScopedExpectedSet({
      catalog: catalog([accountsRow, sibling]),
      resolution: {
        obligations: [
          { obligationId: 'tenant.accounts:persistence:read', bindings: [sidecarBinding([accountsRow])] },
        ],
        problems: [],
      },
      obligations: [obligation('tenant.accounts')],
      graph: theGraph,
      changedFiles: ['src/accounts.txt'],
    });
    // The supervised adapter executes whole spec files: both rows of the
    // claimed file are planned (and must pass), never only the claiming
    // row — under-selection is the one direction that can never happen.
    expect(plan.plannedRows.map((entry) => entry.planned.logicalKey).sort()).toEqual(
      [accountsRow.logicalKey, sibling.logicalKey].sort(),
    );
  });

  it('native annotations count as testable claims; inferred bindings never do', () => {
    const nativePlan = planScopedExpectedSet({
      catalog: theCatalog,
      resolution: {
        obligations: [
          { obligationId: 'tenant.accounts:persistence:read', bindings: [nativeBinding('annotated-test', [accountsRow])] },
        ],
        problems: [],
      },
      obligations: [obligation('tenant.accounts')],
      graph: theGraph,
      changedFiles: ['src/accounts.txt'],
    });
    expect(nativePlan.unclaimed).toEqual([]);
    expect(nativePlan.plannedRows.map((entry) => entry.planned.file)).toEqual(['e2e/accounts.spec.ts']);

    const inferredBinding = { ...sidecarBinding([accountsRow]), origin: 'inferred' as const };
    const inferredPlan = planScopedExpectedSet({
      catalog: theCatalog,
      resolution: {
        obligations: [{ obligationId: 'tenant.accounts:persistence:read', bindings: [inferredBinding] }],
        problems: [],
      },
      obligations: [obligation('tenant.accounts')],
      graph: theGraph,
      changedFiles: ['src/accounts.txt'],
    });
    // Inferred rows are suggestion data: an obligation claimed only by
    // inference has no testable claim and is reported UNCLAIMED (the
    // caller blocks; narrower selection is never guessed).
    expect(inferredPlan.plannedRows).toEqual([]);
    expect(inferredPlan.unclaimed.map((entry) => entry.obligationId)).toEqual([
      'tenant.accounts:persistence:read',
    ]);
  });

  it('a stale sidecar binding (instance gone from the catalog) is unclaimed — fail closed', () => {
    const deletedRow = row({ file: 'e2e/deleted.spec.ts', titlePath: ['gone'] });
    const plan = planScopedExpectedSet({
      catalog: theCatalog,
      resolution: {
        obligations: [{ obligationId: 'tenant.accounts:persistence:read', bindings: [sidecarBinding([deletedRow])] }],
        problems: [],
      },
      obligations: [obligation('tenant.accounts')],
      graph: theGraph,
      changedFiles: ['src/accounts.txt'],
    });
    expect(plan.plannedRows).toEqual([]);
    expect(plan.unclaimed).toHaveLength(1);
    expect(plan.unclaimed[0]?.detail).toContain('never guessed');
  });

  it('changed files affecting no resources yield an empty slice (the caller refuses to run it)', () => {
    const plan = planScopedExpectedSet({
      catalog: theCatalog,
      resolution: { obligations: [], problems: [] },
      obligations: [obligation('tenant.accounts')],
      graph: theGraph,
      changedFiles: ['docs/notes.md'],
    });
    expect(plan.affected).toEqual([]);
    expect(plan.plannedRows).toEqual([]);
    expect(plan.coveredFingerprints).toEqual([]);
    expect(plan.unclaimed).toEqual([]);
  });
});

describe('scoped gate receipts (schema coherence + MAC over the new fields)', () => {
  /** Issue helper with the shared binding values. */
  function issue(overrides: Partial<Parameters<typeof issueGateReceipt>[0]> = {}) {
    return issueGateReceipt({
      verifierKey: VERIFIER_KEY,
      runId: RUN_ID,
      invocationId: INVOCATION_ID,
      inputDigest: HEX(1),
      gitSha: null,
      parentSha: null,
      trustedPolicyDigest: HEX(2),
      invocation: 'test-gates --changed',
      selectionDigest: HEX(3),
      catalogDigest: HEX(4),
      executionResultDigest: HEX(5),
      evidenceAttestationDigest: null,
      ...testReceiptV2Bindings(HEX(2)),
      verdictSummary: { total: 1, satisfied: 1, waived: 0, blocking: 0 },
      issuedAt: FIXED_AT,
      ...overrides,
    });
  }

  const covered = [fp('tenant.orders'), fp('tenant.accounts')].sort();

  it('a changed-scope receipt carries scope + sorted covered fingerprints and parses', () => {
    const receipt = issue({ scope: 'changed', coveredObligationFingerprints: covered });
    expect(receipt.scope).toBe('changed');
    expect(receipt.coveredObligationFingerprints).toEqual([...covered].sort());
    expect(receiptScope(receipt)).toBe('changed');
    expect(GateReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it('the MAC binds the covered set and the scope: any post-signing edit breaks the slice identity', () => {
    const receipt = issue({ scope: 'changed', coveredObligationFingerprints: covered });
    const sealedSet = receipt.coveredObligationFingerprints ?? [];
    // A receipt signed over a DIFFERENT slice carries a different
    // signature — the two receipts are distinct authenticated objects.
    const reSigned = issue({
      scope: 'changed',
      coveredObligationFingerprints: sealedSet.slice(1),
    });
    expect(reSigned.coveredObligationFingerprints).not.toEqual(sealedSet);
    expect(reSigned.mac).not.toBe(receipt.mac);
    // Editing the scope post-signing is a body change: the schema also
    // refuses the incoherent shape (full receipt carrying a slice).
    const tampered = { ...receipt, scope: 'full' as const };
    expect(GateReceiptSchema.safeParse(tampered).success).toBe(false);
  });

  it('issuance refuses a slice-less changed receipt and a covered full receipt', () => {
    expect(() => issue({ scope: 'changed' })).toThrow(/coveredObligationFingerprints/);
    expect(() => issue({ coveredObligationFingerprints: covered })).toThrow(/full-scope/);
  });

  it('the schema enforces sorted, duplicate-free covered sets and changed-slice presence', () => {
    const sealed = issue({ scope: 'changed', coveredObligationFingerprints: covered });
    const unsorted = { ...sealed, coveredObligationFingerprints: [...covered].reverse() };
    expect(GateReceiptSchema.safeParse(unsorted).success).toBe(false);
    const duplicated = {
      ...sealed,
      coveredObligationFingerprints: [fp('tenant.accounts'), fp('tenant.accounts')],
    };
    expect(GateReceiptSchema.safeParse(duplicated).success).toBe(false);
    const changedWithoutCovered: Record<string, unknown> = { ...sealed };
    delete changedWithoutCovered['coveredObligationFingerprints'];
    expect(GateReceiptSchema.safeParse(changedWithoutCovered).success).toBe(false);
  });

  it('legacy receipts without the scope fields stay valid and read as full', () => {
    const receipt = issue();
    expect(receipt.scope).toBeUndefined();
    expect(receiptScope(receipt)).toBe('full');
    expect(GateReceiptSchema.safeParse(receipt).success).toBe(true);
  });
});

describe('scope-aware receipt load/reuse (identical-digest + identical-scope only)', () => {
  const INPUT = HEX(1);
  const POLICY = HEX(2);
  const EXPECTED = { inputDigest: INPUT, trustedPolicyDigest: POLICY };

  /** Builds a complete execution result for the given scope. */
  function executionResult(scope: 'full' | 'changed') {
    const selection = {
      runner: 'playwright',
      mode: scope === 'changed' ? ('mapped-selection' as const) : ('full-relevant-suite' as const),
      logicalKeys: scope === 'changed' ? ['k'] : [],
    };
    return ExecutionResultSchema.parse({
      schemaVersion: 1,
      runId: RUN_ID,
      invocationId: INVOCATION_ID,
      inputDigest: INPUT,
      trustedPolicyDigest: POLICY,
      selection,
      selectionDigest: sha256Canonical({ domain: 'test', selection }),
      catalogDigest: HEX(4),
      planned: [],
      outcomes: [],
      runnerExit: 0,
      complete: true,
      causes: [],
      fixtureOutcome: 'passed',
      shardCompleteness: { complete: true, detail: '' },
      maxAttemptObserved: 1,
      engines: {},
      browsers: {},
      environmentIdentity: HEX(6),
      startedAt: FIXED_AT,
      finishedAt: FIXED_AT,
    });
  }

  /** Writes a complete-run execution result + receipt into a fresh state dir. */
  function sealState(scope: 'full' | 'changed', coveredFingerprints?: string[]): string {
    const stateDir = mkdtempSync(join(tmpdir(), 'gateforge-scope-'));
    const result = executionResult(scope);
    writeExecutionResult(stateDir, result);
    const receipt = issueGateReceipt({
      verifierKey: VERIFIER_KEY,
      runId: RUN_ID,
      invocationId: INVOCATION_ID,
      inputDigest: INPUT,
      gitSha: null,
      parentSha: null,
      trustedPolicyDigest: POLICY,
      invocation: 'test-gates --changed',
      selectionDigest: result.selectionDigest,
      catalogDigest: HEX(4),
      ...(scope === 'changed'
        ? { scope: 'changed' as const, coveredObligationFingerprints: coveredFingerprints ?? [] }
        : {}),
      executionResultDigest: executionResultDigestOf(result),
      evidenceAttestationDigest: null,
      ...testReceiptV2Bindings(POLICY),
      verdictSummary: { total: 0, satisfied: 0, waived: 0, blocking: 0 },
      issuedAt: FIXED_AT,
    });
    writeGateReceipt(stateDir, receipt);
    return stateDir;
  }

  it('loadReceiptFor demands the exact scope and covered set; mismatches are typed stale', () => {
    const covered = [fp('tenant.accounts')];
    const stateDir = sealState('changed', covered);

    // Same scope + identical covered set → ok.
    expect(
      loadReceiptFor(stateDir, VERIFIER_KEY, {
        ...EXPECTED,
        scope: 'changed',
        coveredObligationFingerprints: covered,
      }),
    ).toMatchObject({ status: 'ok' });

    // A different demanded slice → stale (reuse only over identical).
    expect(
      loadReceiptFor(stateDir, VERIFIER_KEY, {
        ...EXPECTED,
        scope: 'changed',
        coveredObligationFingerprints: [fp('tenant.orders')],
      }),
    ).toMatchObject({ status: 'stale' });

    // A full demand against a changed receipt → stale.
    expect(loadReceiptFor(stateDir, VERIFIER_KEY, { ...EXPECTED, scope: 'full' })).toMatchObject({
      status: 'stale',
    });

    // No scope expectation → unchanged legacy behavior (ok).
    expect(loadReceiptFor(stateDir, VERIFIER_KEY, EXPECTED)).toMatchObject({ status: 'ok' });
  });

  it('tryReuseReceipt never reuses a slice receipt as a full seal (and vice versa)', () => {
    const covered = [fp('tenant.accounts')];
    const scopedDir = sealState('changed', covered);
    expect(
      tryReuseReceipt(scopedDir, VERIFIER_KEY, {
        ...EXPECTED,
        scope: 'changed',
        coveredObligationFingerprints: covered,
      }),
    ).toMatchObject({ reuse: true });
    expect(tryReuseReceipt(scopedDir, VERIFIER_KEY, { ...EXPECTED, scope: 'full' })).toMatchObject({
      reuse: false,
    });

    const fullDir = sealState('full');
    expect(tryReuseReceipt(fullDir, VERIFIER_KEY, { ...EXPECTED, scope: 'full' })).toMatchObject({
      reuse: true,
    });
    expect(
      tryReuseReceipt(fullDir, VERIFIER_KEY, {
        ...EXPECTED,
        scope: 'changed',
        coveredObligationFingerprints: [fp('tenant.accounts')],
      }),
    ).toMatchObject({ reuse: false });
  });
});
