/**
 * Active dispositions excuse policies.yml rule obligations (plan
 * 2026-10-19 P5). An active out-of-scope endpoint gets no rule
 * obligations. An active coverage disposition gets no persistence:*
 * obligations for that table. Expired dispositions excuse nothing and
 * still block with DISPOSITION_EXPIRED. Other targets are unchanged.
 * operational-only does not excuse rule obligations.
 */
import { describe, expect, it } from 'vitest';
import {
  GraphResourceSchema,
  activeRuleExcuses,
  compileBehaviorPolicy,
  evaluateCoveragePolicy,
  evaluatePolicies,
  type GraphResource,
  type ResourceGraph,
} from '../src/index.js';

const NOW = '2026-06-15T00:00:00.000Z';
const ACTIVE = '2026-07-01T00:00:00.000Z';
const EXPIRED = '2026-05-01T00:00:00.000Z';
const LIFECYCLE = { create: false, read: true, update: false, delete: false };

function resource(
  kind: string,
  id: string,
  name: string,
  claimsLane: boolean,
  attributes: Record<string, unknown> = {},
): GraphResource {
  return GraphResourceSchema.parse({
    schemaVersion: 1,
    id,
    name,
    plane: 'tenant',
    kind,
    source: 'src/fixture.py',
    location: { file: 'src/fixture.py', line: 1, col: 0 },
    exposure: 'user-facing',
    classification: {
      exposure: 'user-facing',
      plane: 'tenant',
      lifecycle: LIFECYCLE,
      primaryKey: ['id'],
      ...(claimsLane ? { evidenceLane: 'claims' } : { evidenceAdapter: 'accounts' }),
    },
    classificationTrace: null,
    detector: { id: 'fixture', version: '1' },
    attributes,
  });
}

function graphOf(resources: GraphResource[]): ResourceGraph {
  return { schemaVersion: 1, resources, unresolved: [], findings: [], stale: [] };
}

const SCOPED = resource('http.endpoint', 'tenant.http-get-scoped', 'http-get-scoped', true);
const EXPIRED_EP = resource('http.endpoint', 'tenant.http-get-expired', 'http-get-expired', true);
const OPEN = resource('http.endpoint', 'tenant.http-get-open', 'http-get-open', true);
const OPS = resource('http.endpoint', 'tenant.http-get-health', 'http-get-health', true, {
  method: 'GET',
  canonicalPath: '/health/live',
  capabilities: ['health-operations'],
});
const INVOICES = resource('sql.table', 'tenant.invoices', 'invoices', false);
const PAYMENTS = resource('sql.table', 'tenant.payments', 'payments', false);
const ACCOUNTS = resource('sql.table', 'tenant.accounts', 'accounts', false);

const POLICIES = {
  schemaVersion: 1 as const,
  policies: [
    { id: 'endpoints', when: { kind: 'http.endpoint' }, require: ['http:request-observed'] },
    {
      id: 'tables',
      when: { kind: 'sql.table' },
      require: ['persistence:read', 'crud:read', 'audit:noted'],
    },
  ],
};

const BEHAVIOR = {
  schemaVersion: 1 as const,
  resources: [],
  endpoints: [
    {
      resourceId: SCOPED.id ?? '',
      effects: [],
      cases: [],
      disposition: { kind: 'out-of-scope' as const, reason: 'vendor screen', expiresAt: ACTIVE },
    },
    {
      resourceId: EXPIRED_EP.id ?? '',
      effects: [],
      cases: [],
      disposition: { kind: 'out-of-scope' as const, reason: 'lapsed vendor screen', expiresAt: EXPIRED },
    },
    {
      resourceId: OPS.id ?? '',
      effects: [],
      cases: [],
      disposition: { kind: 'operational-only' as const, reason: 'infra probe' },
    },
  ],
};

const COVERAGE = [
  {
    name: 'invoices',
    requiredOperations: ['read' as const],
    disposition: { kind: 'read-only-surface' as const, reason: 'no writes', expiresAt: ACTIVE },
  },
  {
    name: 'payments',
    requiredOperations: ['read' as const],
    disposition: { kind: 'not-user-facing' as const, reason: 'lapsed', expiresAt: EXPIRED },
  },
  { name: 'accounts', requiredOperations: ['read' as const] },
];

function idsOf(result: { obligations: readonly { id: string }[] }): string[] {
  return result.obligations.map((obligation) => obligation.id).sort();
}

describe('active dispositions excuse rule obligations (plan 2026-10-19 P5)', () => {
  const excuses = activeRuleExcuses({
    endpoints: BEHAVIOR.endpoints,
    tables: COVERAGE,
    now: NOW,
  });
  const graph = graphOf([SCOPED, EXPIRED_EP, OPEN, OPS, INVOICES, PAYMENTS, ACCOUNTS]);
  const evaluated = evaluatePolicies({ graph, policies: POLICIES, excuses });
  const behavior = compileBehaviorPolicy({ graph, policy: BEHAVIOR, now: NOW });
  const coverage = evaluateCoveragePolicy(
    COVERAGE,
    [
      { name: 'invoices', operations: ['read'] },
      { name: 'payments', operations: ['read'] },
      { name: 'accounts', operations: ['read'] },
    ],
    [],
    { now: NOW },
  );

  it('an active out-of-scope endpoint has no rule obligations, listed excused with the reason', () => {
    expect(evaluated.obligations.filter((item) => item.resourceId === SCOPED.id)).toEqual([]);
    const excused = evaluated.excused.filter((item) => item.obligation.resourceId === SCOPED.id);
    expect(excused.map((item) => item.obligation.contract)).toEqual(['http:request-observed']);
    expect(excused[0]?.reason).toBe('vendor screen');
    expect(excused[0]?.surface).toBe('endpoint');
  });

  it('an expired endpoint disposition excuses nothing and DISPOSITION_EXPIRED still blocks', () => {
    expect(idsOf(evaluated)).toContain(`${EXPIRED_EP.id ?? ''}:http:request-observed`);
    expect(evaluated.excused.some((item) => item.obligation.resourceId === EXPIRED_EP.id)).toBe(false);
    expect(
      behavior.blocking.some(
        (entry) => entry.cause === 'DISPOSITION_EXPIRED' && entry.resourceId === EXPIRED_EP.id,
      ),
    ).toBe(true);
  });

  it('an undeclared endpoint is unchanged', () => {
    expect(idsOf(evaluated)).toContain(`${OPEN.id ?? ''}:http:request-observed`);
    expect(behavior.blocking.some((entry) => entry.resourceId === OPEN.id && entry.cause === 'ENDPOINT_BEHAVIOR_MISSING')).toBe(
      true,
    );
  });

  it('operational-only does not excuse rule obligations', () => {
    expect(idsOf(evaluated)).toContain(`${OPS.id ?? ''}:http:request-observed`);
    expect(evaluated.excused.some((item) => item.obligation.resourceId === OPS.id)).toBe(false);
  });

  it('an active table disposition excuses persistence:* only, and other tables are unchanged', () => {
    expect(idsOf(evaluated)).not.toContain('tenant.invoices:persistence:read');
    expect(idsOf(evaluated)).toContain('tenant.invoices:crud:read');
    expect(idsOf(evaluated)).toContain('tenant.invoices:audit:noted');
    const excused = evaluated.excused.find((item) => item.obligation.id === 'tenant.invoices:persistence:read');
    expect(excused?.reason).toBe('no writes');
    expect(excused?.surface).toBe('table');
    expect(idsOf(evaluated)).toContain('tenant.accounts:persistence:read');
    expect(idsOf(evaluated)).toContain('tenant.accounts:crud:read');
  });

  it('an expired table disposition excuses nothing and DISPOSITION_EXPIRED still blocks', () => {
    expect(idsOf(evaluated)).toContain('tenant.payments:persistence:read');
    expect(evaluated.excused.some((item) => item.obligation.resourceId === PAYMENTS.id)).toBe(false);
    expect(coverage.blocking.some((finding) => finding.code === 'DISPOSITION_EXPIRED' && finding.table === 'payments')).toBe(
      true,
    );
    expect(coverage.configErrors).toEqual([]);
  });
});
