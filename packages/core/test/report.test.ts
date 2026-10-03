/**
 * Report tests (architecture contract 4, pin #10, invariant 8): canonical
 * JSON output, SARIF 2.1.0 structure, the human evidence-gap trace, and
 * exit-code mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  BASELINE_VERDICT_REASON,
  ObligationSchema,
  canonicalJson,
  fingerprint,
  renderRun,
  runExitCode,
  CAUSE_NEXT_ACTIONS,
  repositoryDebtOf,
  humanMessage,
  type BlockingEntry,
  type Obligation,
  type ObligationVerdict,
  type RunManifest,
  type Verdict,
  type RunExecutionSummary,
} from '../src/index.js';

const LIFECYCLE = {
  create: true,
  read: true,
  update: true,
  delete: true,
  deleteSemantics: 'archive', archiveFields: { status: 'archived' },
} as const;

function makeObligation(resourceId: string, contract = 'crud:update'): Obligation {
  return ObligationSchema.parse({
    schemaVersion: 1,
    id: `${resourceId}:${contract}`,
    resourceId,
    contract,
    policyId: 'user-facing-sqlalchemy-lifecycle',
    lifecycle: LIFECYCLE,
  });
}

function fpFor(obligation: Obligation): string {
  return fingerprint({
    resourceId: obligation.resourceId,
    contract: obligation.contract,
    policyId: obligation.policyId,
    lifecycle: obligation.lifecycle,
  });
}

const accounts = makeObligation('tenant.accounts');
const orders = makeObligation('tenant.orders');

function entry(
  obligation: Obligation,
  verdict: Verdict,
  overrides: Partial<ObligationVerdict> = {},
): ObligationVerdict {
  return {
    obligation,
    verdict,
    reason: verdict === 'satisfied' ? null : `${verdict}: evidence gap for ${obligation.id}`,
    recordIds: verdict === 'satisfied' ? ['a'.repeat(64)] : [],
    trustTier: verdict === 'satisfied' ? 'witnessed' : null,
    ...overrides,
  };
}

const WDIOR_COUNTS = { total: 3, active: 2, expired: 1, staleOwner: 0 };
const BLOCKING: BlockingEntry[] = [
  {
    kind: 'unclassified',
    resourceId: 'tenant.widgets',
    name: 'widgets',
    detail: 'no classification entry',
    location: null,
  },
];

const ADVISORY: BlockingEntry = {
  kind: 'finding',
  resourceId: 'tenant.accounts',
  name: 'accounts',
  detail: 'test annotation claims changed',
  location: { file: 'e2e/accounts.spec.ts', line: 2, col: 1 },
  cause: 'TEST_MAP_OUT_OF_SYNC',
  nextAction: 'gateforge tests sync',
};

describe('renderRun — json format', () => {
  it('emits GF-canonical JSON that round-trips through canonicalJson', () => {
    const verdicts = [entry(accounts, 'missing'), entry(orders, 'satisfied')];
    const output = renderRun(verdicts, { format: 'json', waiverCounts: WDIOR_COUNTS });
    const parsed = JSON.parse(output);
    // Reason text contains spaces; canonicality means the serialization
    // is exactly canonicalJson of its own parsed value (key-sorted, no
    // structural whitespace) — not that string values contain none.
    expect(output).toBe(canonicalJson(parsed));
  });

  it('is byte-identical across renders regardless of input order', () => {
    const a = renderRun([entry(accounts, 'missing'), entry(orders, 'satisfied')], { format: 'json' });
    const b = renderRun([entry(orders, 'satisfied'), entry(accounts, 'missing')], { format: 'json' });
    expect(b).toBe(a);
  });

  it('summarizes verdicts and includes per-verdict fingerprints', () => {
    const verdicts = [
      entry(accounts, 'missing'),
      entry(orders, 'satisfied'),
      entry(makeObligation('tenant.audit', 'crud:delete'), 'waived'),
    ];
    const report = JSON.parse(
      renderRun(verdicts, { format: 'json', waiverCounts: WDIOR_COUNTS, blocking: BLOCKING }),
    );
    expect(report.schemaVersion).toBe(1);
    expect(report.summary).toMatchObject({
      obligations: 3,
      satisfied: 1,
      missing: 1,
      waived: 1,
      // The blocking total covers BOTH sources of red: the blocking
      // verdict AND the blocking entry (audit remediation: a
      // finding/stale entry must never coexist with "0 blocking").
      blocking: 2,
      blockingEntries: 1,
    });
    expect(report.waiverCounts).toEqual(WDIOR_COUNTS);
    expect(report.blocking[0]).toMatchObject({
      ...BLOCKING[0],
      message: expect.stringContaining('[UNCLASSIFIED]'),
    });
    const missing = report.verdicts.find((v: { obligationId: string }) =>
      v.obligationId === accounts.id,
    );
    expect(missing.fingerprint).toBe(fpFor(accounts));
    expect(missing.recordIds).toEqual([]);
  });
  it('shows the changed paths that brought a verdict into scope', () => {
    const scoped = entry(accounts, 'missing', { inScopeBecause: ['src/accounts.ts'] });
    const json = JSON.parse(renderRun([scoped], { format: 'json' }));
    expect(json.verdicts[0]).toMatchObject({ inScopeBecause: ['src/accounts.ts'] });
    const text = renderRun([scoped], { format: 'text' });
    expect(text).toContain('in scope because: src/accounts.ts');
  });

  it('attaches bounded run provenance to blocking predicates', () => {
    const provenance = {
      scope: 'changed',
      candidateTreeId: 'a'.repeat(40),
      inputDigest: 'b'.repeat(64),
      evidenceState: 'attested',
      authority: 'authoritative',
    };
    const options = {
      format: 'json',
      blocking: BLOCKING,
      diagnosticContext: provenance,
    } as unknown as Parameters<typeof renderRun>[1];
    const output = renderRun([entry(accounts, 'invalid', { cause: 'EVIDENCE_VALUE_MISMATCH' })], options);
    const report = JSON.parse(output);
    expect(report.diagnosticContext).toEqual(provenance);
    expect(report.verdicts[0]).toMatchObject({
      obligationId: accounts.id,
      verdict: 'invalid',
      cause: 'EVIDENCE_VALUE_MISMATCH',
      reason: `invalid: evidence gap for ${accounts.id}`,
    });
    expect(report.blocking[0]).toMatchObject({
      ...BLOCKING[0],
      message: expect.stringContaining('[UNCLASSIFIED]'),
    });
  });

  it('names baselined debt apart from new debt, in the text and in the JSON', () => {
    // A run whose debt is part baselined and part new: the line and the
    // JSON must report the SAME two numbers, and "new blocking" must be
    // what the gate blocks on — never a subtraction that reaches zero
    // while the gate still blocks.
    const verdicts = [
      entry(makeObligation('tenant.accounts'), 'satisfied'),
      entry(makeObligation('tenant.orders'), 'missing'),
      entry(makeObligation('tenant.widgets'), 'missing'),
      entry(makeObligation('tenant.invoices'), 'waived', {
        reason: `${BASELINE_VERDICT_REASON} adopted as forgiven (was missing); baseline is shrink-only`,
      }),
      entry(makeObligation('tenant.ledger'), 'waived', {
        reason: `${BASELINE_VERDICT_REASON} adopted as forgiven (was missing); baseline is shrink-only`,
      }),
      entry(makeObligation('tenant.audit'), 'waived', { reason: 'GF-17: owner-stale waiver' }),
    ];
    const debt = repositoryDebtOf({
      verdicts,
      findings: [],
      gradedVerdicts: verdicts,
      gradedFindings: [],
      unclaimed: 4,
    });
    expect(debt).toEqual({
      obligations: 6,
      blocking: 2,
      blockingEntries: 0,
      unclaimed: 4,
      baselined: 2,
      newlyBlocking: 2,
      notGradedBlocking: 0,
    });
    const execution: RunExecutionSummary = {
      scope: 'full',
      mode: 'executed',
      testsPerformedThisInvocation: 0,
      selectedTests: { selected: 0, passed: 0, failed: 0, skipped: 0, expectedFailures: 0 },
      selectedClaims: { selected: 0, satisfied: 0, blocking: 0, blockingEntries: 0, waived: 0 },
      repositoryDebt: debt,
    };
    const text = renderRun(verdicts, { format: 'text', execution });
    expect(text).toContain('repository debt: 2 known (baselined), 2 new blocking');
    const json = JSON.parse(renderRun(verdicts, { format: 'json', execution }));
    expect(json.execution.repositoryDebt).toEqual(debt);
  });

  it('counts every repository finding as debt the gate blocks on', () => {
    const verdicts = [entry(makeObligation('tenant.accounts'), 'satisfied')];
    const debt = repositoryDebtOf({
      verdicts,
      findings: BLOCKING,
      gradedVerdicts: verdicts,
      gradedFindings: BLOCKING,
      unclaimed: 0,
    });
    expect(debt).toMatchObject({ obligations: 1, blocking: 1, blockingEntries: 1, newlyBlocking: 1 });
  });

  it('a slice run blocks on nothing it did not grade, and names that debt apart', () => {
    // A changed-scope run whose own slice is clean exits 0. Calling the
    // repository's untouched blocking debt "new blocking" would put a
    // non-zero number next to a zero exit code.
    const slice = [
      entry(makeObligation('tenant.accounts'), 'satisfied'),
      entry(makeObligation('tenant.orders'), 'waived', {
        reason: `${BASELINE_VERDICT_REASON} adopted as forgiven (was missing); baseline is shrink-only`,
      }),
    ];
    const repository = [...slice, entry(makeObligation('tenant.widgets'), 'missing')];
    const debt = repositoryDebtOf({
      verdicts: repository,
      findings: [],
      gradedVerdicts: slice,
      gradedFindings: [],
      unclaimed: 2,
    });
    expect(debt).toEqual({
      obligations: 3,
      blocking: 1,
      blockingEntries: 0,
      unclaimed: 2,
      baselined: 1,
      newlyBlocking: 0,
      notGradedBlocking: 1,
    });
    const execution: RunExecutionSummary = {
      scope: 'changed',
      mode: 'executed',
      testsPerformedThisInvocation: 1,
      selectedTests: { selected: 1, passed: 1, failed: 0, skipped: 0, expectedFailures: 0 },
      selectedClaims: { selected: 1, satisfied: 1, blocking: 0, blockingEntries: 0, waived: 0 },
      repositoryDebt: debt,
    };
    const text = renderRun(slice, { format: 'text', execution });
    expect(text).toContain('repository debt: 1 known (baselined), 0 new blocking');
    expect(text).toContain('not graded by this changed-scope run: 1 blocking obligation(s)');
  });

  it('labels a selected result as partial and leaves the receipt explicitly unsealed', () => {
    const execution: RunExecutionSummary = {
      scope: 'changed',
      mode: 'executed',
      testsPerformedThisInvocation: 4,
      selectedTests: { selected: 4, passed: 4, failed: 0, skipped: 0, expectedFailures: 0 },
      selectedClaims: { selected: 26, satisfied: 26, blocking: 0, blockingEntries: 0, waived: 0 },
      repositoryDebt: {
        obligations: 30,
        blocking: 4,
        blockingEntries: 0,
        unclaimed: 2,
        baselined: 2,
        newlyBlocking: 4,
        notGradedBlocking: 0,
      },
    };
    const verdicts = [entry(accounts, 'satisfied')];
    const text = renderRun(verdicts, { format: 'text', execution, outcome: 'partial-selection' });
    expect(text.endsWith(
      'Tests: 4 passed.\nClaims: 26 satisfied.\nReceipt: not sealed — partial selection (expected)\n',
    )).toBe(true);
    const json = JSON.parse(
      renderRun(verdicts, { format: 'json', execution, outcome: 'partial-selection' }),
    );
    expect(json.outcome).toBe('partial-selection');
  });
  it('includes the run manifest when provided', () => {
    const run = {
      schemaVersion: 1,
      runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      startedAt: '2026-08-30T12:00:00.000Z',
      gitSha: null,
      provider: 'local-staged',
      plugins: [],
      attestationScope: null,
    } as const satisfies RunManifest;
    const report = JSON.parse(renderRun([entry(accounts, 'missing')], { format: 'json', run }));
    expect(report.run).toEqual(run);
  });
  it('includes engine identity in JSON and warns about an unpublished install in text', () => {
    const engine = { version: '0.7.1', source: 'local path /workspace/gateforge', unpublished: true };
    const json = JSON.parse(renderRun([entry(accounts, 'missing')], { format: 'json', engine }));
    expect(json.engine).toEqual(engine);
    const text = renderRun([entry(accounts, 'missing')], { format: 'text', engine });
    expect(text).toContain('engine: 0.7.1 from local path /workspace/gateforge');
    expect(text).toContain('unpublished engine: CI will not have this code');
  });
});

describe('renderRun — non-blocking advisories', () => {
  it('includes advisories in canonical JSON without adding to the blocking count', () => {
    const report = JSON.parse(
      renderRun([entry(accounts, 'satisfied')], { format: 'json', advisories: [ADVISORY] }),
    );
    expect(report.advisories).toEqual([ADVISORY]);
    expect(report.summary.blocking).toBe(0);
  });

  it('projects advisories as SARIF warning notifications', () => {
    const report = JSON.parse(
      renderRun([entry(accounts, 'satisfied')], { format: 'sarif', advisories: [ADVISORY] }),
    ) as {
      runs: Array<{
        invocations: Array<{
          toolExecutionNotifications: Array<{ level: string; properties: Record<string, unknown> }>;
        }>;
      }>;
    };
    const notifications = report.runs[0]?.invocations[0]?.toolExecutionNotifications ?? [];
    expect(notifications).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        properties: expect.objectContaining({
          cause: 'TEST_MAP_OUT_OF_SYNC',
          nextAction: 'gateforge tests sync',
        }),
      }),
    );
  });

  it('prints advisories separately from blocking entries in text output', () => {
    const text = renderRun([entry(accounts, 'satisfied')], {
      format: 'text',
      advisories: [ADVISORY],
    });
    expect(text).toContain('advisories (non-blocking):');
    expect(text).toContain('test annotation claims changed');
    expect(text).not.toContain('blocking entries (unclassified/unresolved/findings/stale references):');
  });
});

describe('renderRun — SARIF 2.1.0 projection (pin #10)', () => {
  const verdicts = [
    entry(accounts, 'missing'),
    entry(orders, 'satisfied'),
    entry(makeObligation('tenant.audit', 'crud:delete'), 'waived', {
      reason: "waived by 'team-audit' until '2026-09-30' (approver 'alice', https://t/1)",
    }),
  ];
  const sarif = JSON.parse(renderRun(verdicts, { format: 'sarif', toolVersion: '9.9.9' })) as {
    version: string;
    $schema: string;
    runs: Array<{
      tool: { driver: { name: string; version: string; rules: Array<{ ruleId: string }> } };
      results: Array<{
        ruleId: string;
        ruleIndex: number;
        level: string;
        message: { text: string };
        properties: Record<string, unknown>;
        partialFingerprints: Record<string, string>;
        suppressions?: Array<{ kind: string; status: string; justification: string }>;
      }>;
    }>;
  };

  it('declares SARIF 2.1.0 with the official schema location', () => {
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-schema-2.1.0');
  });

  it('maps one rule per unique policyId (ruleId = policyId)', () => {
    const driver = sarif.runs[0]?.tool.driver;
    expect(driver?.name).toBe('gateforge');
    expect(driver?.version).toBe('9.9.9');
    expect(driver?.rules).toEqual([{ ruleId: 'user-facing-sqlalchemy-lifecycle' }]);
  });

  it('emits blocking verdicts at level error with partialFingerprints', () => {
    const missing = sarif.runs[0]?.results.find(
      (result) => result.properties['verdict'] === 'missing',
    );
    expect(missing?.level).toBe('error');
    expect(missing?.ruleId).toBe('user-facing-sqlalchemy-lifecycle');
    expect(missing?.ruleIndex).toBe(0);
    expect(missing?.partialFingerprints.gateforgeFingerprint).toBe(fpFor(accounts));
    expect(missing?.message.text).toContain('missing: evidence gap');
  });

  it('emits satisfied results at level none', () => {
    const satisfied = sarif.runs[0]?.results.find(
      (result) => result.properties['verdict'] === 'satisfied',
    );
    expect(satisfied?.level).toBe('none');
    expect(satisfied?.properties).toMatchObject({
      resourceId: orders.resourceId,
      contract: orders.contract,
      trustTier: 'witnessed',
    });
  });

  it('emits waived results suppressed with properties.verdict (pin #10)', () => {
    const waived = sarif.runs[0]?.results.find(
      (result) => result.properties['verdict'] === 'waived',
    );
    expect(waived?.level).toBe('none');
    expect(waived?.suppressions).toHaveLength(1);
    const suppression = waived?.suppressions?.[0];
    expect(suppression?.kind).toBe('external');
    expect(suppression?.status).toBe('accepted');
    expect(suppression?.justification).toContain('team-audit');
  });

  it('projects blocking entries as error-level tool-execution notifications (audit remediation)', () => {
    const withBlocking = JSON.parse(
      renderRun([entry(accounts, 'waived')], {
        format: 'sarif',
        blocking: [
          {
            kind: 'finding',
            resourceId: null,
            name: null,
            detail: 'PARSE_ERROR: failed to read src/broken.py: EACCES (detector d)',
            location: { file: 'src/broken.py', line: 1, col: 0 },
          },
          {
            kind: 'stale-reference',
            resourceId: null,
            name: null,
            detail: "stale classification reference 'tenant.ghosts': gone",
            location: null,
          },
        ],
      }),
    ) as {
      runs: Array<{
        invocations?: Array<{
          toolExecutionNotifications?: Array<{
            level: string;
            message: { text: string };
            properties: Record<string, unknown>;
          }>;
        }>;
      }>;
    };
    const notifications = withBlocking.runs[0]?.invocations?.[0]?.toolExecutionNotifications;
    expect(notifications).toHaveLength(2);
    expect(notifications?.every((notification) => notification.level === 'error')).toBe(true);
    expect(notifications?.[0]?.message.text).toContain('PARSE_ERROR');
    expect(notifications?.[1]?.properties).toMatchObject({ kind: 'stale-reference' });
  });
});

describe('renderRun — text trace (invariant 8)', () => {
  it('traces detector → policy → obligation → evidence gap for failures', () => {
    const verdicts = [
      entry(accounts, 'missing', { detector: { id: 'gateforge.sqlalchemy', version: '1.0.0' } }),
    ];
    const text = renderRun(verdicts, {
      format: 'text',
      waiverCounts: WDIOR_COUNTS,
      blocking: BLOCKING,
    });
    expect(text).toContain('[missing] tenant.accounts:crud:update');
    expect(text).toContain('detector: gateforge.sqlalchemy@1.0.0');
    expect(text).toContain('policy: user-facing-sqlalchemy-lifecycle');
    expect(text).toContain('obligation: tenant.accounts:crud:update');
    expect(text).toContain(`fingerprint: ${fpFor(accounts)}`);
    expect(text).toContain('evidence gap: missing: evidence gap');
    expect(text).toContain('waivers: 3 total, 2 active, 1 expired, 0 stale-owner');
  });

  it('lists blocking entries and consulted record ids', () => {
    const verdicts = [entry(accounts, 'invalid', { recordIds: ['b'.repeat(64)] })];
    const text = renderRun(verdicts, { format: 'text', blocking: BLOCKING });
    expect(text).toContain('blocking entries (unclassified/unresolved/findings/stale references):');
    expect(text).toContain('no classification entry. Run `gateforge explain tenant.widgets`. [UNCLASSIFIED]');
    expect(text).toContain(`records: ${'b'.repeat(64)}`);
    expect(text).toContain('exit code: 1');
  });

  it('reports clean runs and omits satisfied obligations from the trace', () => {
    const text = renderRun([entry(accounts, 'satisfied'), entry(orders, 'waived')], {
      format: 'text',
    });
    expect(text).toContain('1 satisfied, 1 waived, 0 blocking');
    expect(text).not.toContain('[satisfied]');
    expect(text).toContain('[waived]');
    expect(text).toContain('exit code: 0');
  });

  it('is deterministic across renders', () => {
    const verdicts = [entry(accounts, 'missing'), entry(orders, 'satisfied')];
    expect(renderRun(verdicts, { format: 'text' })).toBe(
      renderRun([...verdicts].reverse(), { format: 'text' }),
    );
  });
});

describe('runExitCode — contract 4 mapping', () => {
  it('returns 0 for clean runs and waived-only runs', () => {
    expect(runExitCode({ verdicts: [entry(accounts, 'satisfied')] })).toBe(0);
    expect(runExitCode({ verdicts: [entry(accounts, 'waived')] })).toBe(0);
    expect(runExitCode({ verdicts: [entry(accounts, 'satisfied'), entry(orders, 'waived')] })).toBe(0);
  });

  it('returns 1 for every blocking verdict', () => {
    for (const verdict of ['missing', 'invalid', 'unclassified', 'unresolved', 'stale'] as const) {
      expect(runExitCode({ verdicts: [entry(accounts, verdict)] })).toBe(1);
    }
  });

  it('returns 1 when blocking entries exist even with clean verdicts', () => {
    expect(runExitCode({ verdicts: [entry(accounts, 'satisfied')], blocking: BLOCKING })).toBe(1);
  });

  it('returns 2 for config errors, taking precedence over everything', () => {
    expect(
      runExitCode({
        verdicts: [entry(accounts, 'missing')],
        blocking: BLOCKING,
        configError: true,
      }),
    ).toBe(2);
    expect(runExitCode({ verdicts: [], configError: true })).toBe(2);
  });
});

describe('humanMessage', () => {
  it('places the plain explanation first, a runnable command next, and the code last', () => {
    expect(
      humanMessage({
        cause: 'TEST_MAPPING_MISSING',
        detail: 'Resource widgets need a classification',
        id: 'tenant.widgets',
        nextAction: CAUSE_NEXT_ACTIONS.TEST_MAPPING_MISSING,
      }),
    ).toBe('Resource widgets need a classification. Run `gateforge tests suggest`. [TEST_MAPPING_MISSING]');
  });

  it('a detail that ends in a period still prints one sentence end, not `..`', () => {
    expect(
      humanMessage({
        cause: 'EVIDENCE_STALE',
        detail: 'require-e2e: the sealed run is not this run. changed inputs: src/app.ts.',
        nextAction: 'gateforge test-gates --changed',
      }),
    ).toBe(
      'require-e2e: the sealed run is not this run. changed inputs: src/app.ts. Run `gateforge test-gates --changed`. [EVIDENCE_STALE]',
    );
  });
});
describe('renderRun — cause codes and next actions (plan 2026-09-13 §5.4, ADR 0005)', () => {
  const caused = entry(accounts, 'missing', {
    reason: "no claim declares 'tenant.accounts:crud:update'",
    cause: 'TEST_MAPPING_MISSING',
    nextAction: CAUSE_NEXT_ACTIONS['TEST_MAPPING_MISSING'],
  });

  it('json verdicts carry cause and nextAction (null when unmapped)', () => {
    const report = JSON.parse(
      renderRun([caused, entry(orders, 'satisfied')], { format: 'json' }),
    ) as { verdicts: Array<{ obligationId: string; cause: string | null; nextAction: string | null }> };
    const mapped = report.verdicts.find((v) => v.obligationId === accounts.id);
    const clean = report.verdicts.find((v) => v.obligationId === orders.id);
    expect(mapped?.cause).toBe('TEST_MAPPING_MISSING');
    expect(mapped?.nextAction).toBe(caused.nextAction);
    expect(clean?.cause).toBeNull();
    expect(clean?.nextAction).toBeNull();
  });
  it('adds the same human message to JSON verdict records', () => {
    const report = JSON.parse(renderRun([caused], { format: 'json' })) as {
      verdicts: Array<{ obligationId: string; message?: string }>;
    };
    expect(report.verdicts[0]?.message).toBe(
      "no claim declares 'tenant.accounts:crud:update'. Run `gateforge tests suggest`. [TEST_MAPPING_MISSING]",
    );
  });

  it('sarif properties carry cause and nextAction', () => {
    const sarif = JSON.parse(renderRun([caused], { format: 'sarif' })) as {
      runs: Array<{ results: Array<{ properties: Record<string, unknown> }> }>;
    };
    const properties = sarif.runs[0]?.results[0]?.properties;
    expect(properties?.['cause']).toBe('TEST_MAPPING_MISSING');
    expect(properties?.['nextAction']).toBe(caused.nextAction);
  });

  it('text trace prints the cause and next action lines', () => {
    const text = renderRun([caused], { format: 'text' });
    expect(text).toContain('cause: TEST_MAPPING_MISSING');
    expect(text).toContain(`next action: ${caused.nextAction}`);
    const unmapped = renderRun([entry(orders, 'invalid')], { format: 'text' });
    expect(unmapped).not.toContain('cause:');
  });

  it('blocking entries carry their cause through json, sarif, and text', () => {
    const coverageEntry: BlockingEntry = {
      kind: 'finding',
      resourceId: null,
      name: 'accounts',
      detail: "coverage policy: table 'accounts' has no mapped browser-e2e 'delete' coverage and no owner disposition",
      location: null,
      cause: 'CRUD_COVERAGE_MISSING',
      nextAction: 'Connect/mark existing journeys, add the missing journey, or record an owner disposition',
    };
    const json = JSON.parse(
      renderRun([], { format: 'json', blocking: [coverageEntry] }),
    ) as { blocking: Array<{ cause?: string | null; nextAction?: string | null }> };
    expect(json.blocking[0]?.cause).toBe('CRUD_COVERAGE_MISSING');
    const sarif = JSON.parse(
      renderRun([], { format: 'sarif', blocking: [coverageEntry] }),
    ) as {
      runs: Array<{
        invocations?: Array<{
          toolExecutionNotifications?: Array<{ properties: Record<string, unknown> }>;
        }>;
      }>;
    };
    const notification = sarif.runs[0]?.invocations?.[0]?.toolExecutionNotifications?.[0];
    expect(notification?.properties['cause']).toBe('CRUD_COVERAGE_MISSING');
    expect(notification?.properties['nextAction']).toContain('owner disposition');
    const text = renderRun([], { format: 'text', blocking: [coverageEntry] });
    expect(text).toContain(
      "coverage policy: table 'accounts' has no mapped browser-e2e 'delete' coverage and no owner disposition. " +
        'Run `gateforge explain accounts`. [CRUD_COVERAGE_MISSING]',
    );
    const plain = renderRun([], { format: 'text', blocking: BLOCKING });
    expect(plain).toContain('no classification entry. Run `gateforge explain tenant.widgets`. [UNCLASSIFIED]');
    expect(plain).not.toContain('(cause:');
  });
});

describe('renderRun — lifecycle derivation visibility', () => {
  it('surfaces one ordered derivation line per resource in json, sarif, and text', () => {
    const lifecycleDerivation = [
      {
        resourceId: 'tenant.accounts',
        resourceName: 'accounts',
        operation: 'update',
        disposition: 'disabled',
        reason: 'no-updateable-fields',
        detail: 'The model declares no updateable fields.',
      },
      {
        resourceId: 'tenant.accounts',
        resourceName: 'accounts',
        operation: 'read',
        disposition: 'not-observable',
        reason: 'no-read-route',
        detail: 'No linked GET or HEAD route was detected.',
      },
    ] as const;
    const json = JSON.parse(
      renderRun([entry(accounts, 'satisfied')], { format: 'json', lifecycleDerivation }),
    ) as { lifecycleDerivation: Array<{ operation: string; disposition: string }> };
    expect(json.lifecycleDerivation.map((item) => item.operation)).toEqual(['read', 'update']);
    expect(json.lifecycleDerivation[0]).toMatchObject({
      operation: 'read',
      disposition: 'not-observable',
    });

    const sarif = JSON.parse(
      renderRun([entry(accounts, 'satisfied')], { format: 'sarif', lifecycleDerivation }),
    ) as { runs: Array<{ properties: Record<string, unknown> }> };
    expect(sarif.runs[0]?.properties['lifecycleDerivation']).toEqual(json.lifecycleDerivation);

    const text = renderRun([entry(accounts, 'satisfied')], { format: 'text', lifecycleDerivation });
    const resourceLines = text
      .split('\n')
      .filter((line) => line.startsWith('  tenant.accounts:'));
    expect(resourceLines).toHaveLength(1);
    expect(resourceLines[0]).toContain('read: not-observable');
    expect(resourceLines[0]).toContain('update: disabled');
  });
});

describe('renderRun — Python cache exclusion visibility', () => {
  it('includes exact paths and the owner pin status in every report format', () => {
    const diagnosticContext = {
      scope: 'full' as const,
      candidateTreeId: 'a'.repeat(40),
      inputDigest: 'b'.repeat(64),
      evidenceState: 'attested',
      authority: 'authoritative' as const,
      cacheExclusions: {
        files: ['src/__pycache__/accounts.cpython-313.pyc'],
        approvalDigest: 'c'.repeat(64),
        approvalStatus: 'matched' as const,
        guarantee: 'owner assertion only',
      },
    };
    const json = JSON.parse(
      renderRun([entry(accounts, 'satisfied')], { format: 'json', diagnosticContext }),
    ) as { diagnosticContext: typeof diagnosticContext };
    expect(json.diagnosticContext.cacheExclusions).toEqual(diagnosticContext.cacheExclusions);

    const sarif = JSON.parse(
      renderRun([entry(accounts, 'satisfied')], { format: 'sarif', diagnosticContext }),
    ) as { runs: Array<{ properties: { diagnosticContext: typeof diagnosticContext } }> };
    expect(sarif.runs[0]?.properties.diagnosticContext.cacheExclusions).toEqual(
      diagnosticContext.cacheExclusions,
    );

    const text = renderRun([entry(accounts, 'satisfied')], { format: 'text', diagnosticContext });
    expect(text).toContain(
      'Python cache exclusions: files=src/__pycache__/accounts.cpython-313.pyc approvalStatus=matched',
    );
    expect(text).toContain(diagnosticContext.cacheExclusions.approvalDigest);
  });
});
describe('renderRun — adopted-baseline age', () => {
  it('reports adoption age and never-witnessed obligations additively', () => {
    const baseline = {
      obligations: 2,
      blockingEntries: 0,
      adoptedAt: '2026-09-01T00:00:00.000Z',
      ageDays: 16,
      neverWitnessed: 1,
    };
    const json = JSON.parse(
      renderRun([entry(accounts, 'satisfied')], { format: 'json', baseline }),
    ) as { summary: Record<string, unknown> };
    expect(json.summary).toMatchObject({
      baselinedObligations: 2,
      adoptedBaselineAt: baseline.adoptedAt,
      adoptedBaselineAgeDays: 16,
      neverWitnessedBaselinedObligations: 1,
    });

    const text = renderRun([entry(accounts, 'satisfied')], { format: 'text', baseline });
    expect(text).toContain('age: 16 day(s); never witnessed: 1');
  });
});

describe('renderRun — local failure reasons when the progress stream is off', () => {
  const executionWith = (failed: number): RunExecutionSummary => ({
    scope: 'full',
    mode: 'executed',
    testsPerformedThisInvocation: 5,
    selectedTests: { selected: 5, passed: 5 - failed, failed, skipped: 0, expectedFailures: 0 },
    selectedClaims: { selected: 0, satisfied: 0, blocking: 0, blockingEntries: 0, waived: 0 },
    repositoryDebt: {
      obligations: 0,
      blocking: 0,
      blockingEntries: 0,
      baselined: 0,
      newlyBlocking: 0,
      unclaimed: 0,
      notGradedBlocking: 0,
    },
  });
  const failed = (title: string, message: string): { title: string; message: string } => ({ title, message });

  it('names the first error line of up to three failures, then how to see the rest', () => {
    const text = renderRun([entry(accounts, 'missing')], {
      format: 'text',
      execution: executionWith(4),
      failedTests: [
        failed('checkout > pays with a card', 'Error: browserType.launch: Target page, context or browser has been closed'),
        failed('checkout > pays with a voucher', 'Error: expect(received).toBe(expected)\n  at line 12'),
        failed('cart > empties', ''),
        failed('cart > merges', 'Error: timeout of 5000ms exceeded'),
      ],
    });
    expect(text).toContain(
      'failed test: checkout > pays with a card — Error: browserType.launch: Target page, context or browser has been closed',
    );
    expect(text).toContain('failed test: checkout > pays with a voucher — Error: expect(received).toBe(expected)');
    // A failure the runner reported no message for is still named.
    expect(text).toContain('failed test: cart > empties');
    // The fourth is NOT printed inline, and the line that replaces it is
    // the exact command that prints every failure as it happens.
    expect(text).not.toContain('cart > merges');
    expect(text).toContain(
      '… 1 more — run with `--progress stderr` to print every failure as it happens',
    );
  });

  it('adds nothing to a run that failed no test, and never touches the json document', () => {
    const green = renderRun([entry(accounts, 'satisfied')], { format: 'text', execution: executionWith(0) });
    expect(green).not.toContain('failed test:');
    expect(green).not.toContain('--progress stderr');
    // The json document is the machine contract: the local hint is text
    // only, so a consumer's parsed report keeps exactly its old shape.
    const withHint = JSON.parse(
      renderRun([entry(accounts, 'missing')], {
        format: 'json',
        execution: executionWith(1),
        failedTests: [failed('checkout > pays', 'Error: nope')],
      }),
    ) as Record<string, unknown>;
    const withoutHint = JSON.parse(
      renderRun([entry(accounts, 'missing')], { format: 'json', execution: executionWith(1) }),
    ) as Record<string, unknown>;
    expect(Object.keys(withHint).sort()).toEqual(Object.keys(withoutHint).sort());
  });
});

describe('renderRun — a declared mapping is visible (0.9.0 adoption fix)', () => {
  const DECLARED_KEY = 'playwright:chromium:e2e/accounts.spec.ts:Accounts>updates an account';
  const declared = entry(accounts, 'missing', {
    reason: "no claim declares 'tenant.accounts:crud:update'",
    cause: 'ENFORCEMENT_UNTRUSTED',
    nextAction: CAUSE_NEXT_ACTIONS['ENFORCEMENT_UNTRUSTED'],
    recordIds: [],
    declaredTests: [DECLARED_KEY],
  });

  it('prints the declared test and the command that collects its evidence', () => {
    // On 0.8.x this obligation printed exactly as before `tests mark`: the
    // declaration was invisible and the action said "repair enforcement".
    const text = renderRun([declared], { format: 'text' });
    expect(text).toContain(`mapped to: ${DECLARED_KEY} (not yet witnessed)`);
    expect(text).toContain('next action: the mapping is declared; run `gateforge test-gates --changed`');
    expect(text).not.toContain(`next action: ${CAUSE_NEXT_ACTIONS['ENFORCEMENT_UNTRUSTED']}`);
    // The cause code itself is unchanged — only the advice is.
    expect(text).toContain('cause: ENFORCEMENT_UNTRUSTED');
  });

  it('names the declared ids and their mapping state in json', () => {
    const json = JSON.parse(renderRun([declared], { format: 'json' })) as {
      verdicts: Array<{ declaredTests?: string[]; mappingState?: string }>;
    };
    expect(json.verdicts[0]?.declaredTests).toEqual([DECLARED_KEY]);
    expect(json.verdicts[0]?.mappingState).toBe('declared-not-witnessed');
  });

  it('reports a witnessed declaration as declared, never as not yet witnessed', () => {
    const witnessed = entry(accounts, 'satisfied', {
      recordIds: ['a'.repeat(64)],
      declaredTests: [DECLARED_KEY],
    });
    const text = renderRun([witnessed], { format: 'text' });
    expect(text).not.toContain('not yet witnessed');
  });

  it('adds no mapping line for an obligation with no declaration', () => {
    const json = JSON.parse(renderRun([entry(accounts, 'missing')], { format: 'json' })) as {
      verdicts: Array<Record<string, unknown>>;
    };
    expect(json.verdicts[0]?.['declaredTests']).toBeUndefined();
    expect(json.verdicts[0]?.['mappingState']).toBeUndefined();
    expect(renderRun([entry(accounts, 'missing')], { format: 'text' })).not.toContain('mapped to:');
  });
});
