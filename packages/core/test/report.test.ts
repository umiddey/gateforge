/**
 * Report tests (architecture contract 4, pin #10, invariant 8): canonical
 * JSON output, SARIF 2.1.0 structure, the human evidence-gap trace, and
 * exit-code mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  ObligationSchema,
  canonicalJson,
  fingerprint,
  renderRun,
  runExitCode,
  type BlockingEntry,
  type Obligation,
  type ObligationVerdict,
  type RunManifest,
  type Verdict,
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
    expect(report.blocking).toEqual(BLOCKING);
    const missing = report.verdicts.find((v: { obligationId: string }) =>
      v.obligationId === accounts.id,
    );
    expect(missing.fingerprint).toBe(fpFor(accounts));
    expect(missing.recordIds).toEqual([]);
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
    expect(text).toContain('[unclassified] tenant.widgets — no classification entry');
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

describe('renderRun — cause codes and next actions (plan 2026-09-13 §5.4, ADR 0005)', () => {
  const caused = entry(accounts, 'missing', {
    reason: "no claim declares 'tenant.accounts:crud:update'",
    cause: 'TEST_MAPPING_MISSING',
    nextAction:
      'Run `gateforge tests suggest`, mark the matching test (`gateforge tests mark` / .gateforge/test-map.yml), ' +
      'map backend-only tables server-e2e, or waive it (`gateforge waive`) — docs/guides/new-table-playbook.md',
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
    expect(text).toContain('(cause: CRUD_COVERAGE_MISSING → Connect/mark existing journeys');
    // Entries without a mapping render exactly as before.
    const plain = renderRun([], { format: 'text', blocking: BLOCKING });
    expect(plain).toContain('[unclassified] tenant.widgets — no classification entry\n');
    expect(plain).not.toContain('(cause:');
  });
});
