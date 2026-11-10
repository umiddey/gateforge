/**
 * Transport obligations on `internal` routes are graded (plan
 * 20261109_1030 P1).
 *
 * A route the classifier marks `internal` (here: an unlinked `/ops/*`
 * path) still receives `http:request-observed` /
 * `http:response-status-ok` from the unmodified starter transport
 * policy, and the behavior compiler's operational-only lane emits the
 * same transport case. The verdict engine graded EVERY contract on an
 * internal resource `invalid` before reading any evidence, so those
 * rows could never pass. The rule is scoped instead: only
 * `crud:`/`persistence:` contracts are invalid on internal resources
 * (ADR 0003 D3); transport obligations grade like any other route —
 * `missing` until the same witnessed exchange satisfies them.
 */
import { describe, expect, it } from 'vitest';
import {
  GraphResourceSchema,
  compileBehaviorPolicy,
  evaluateObligation,
  evaluatePolicies,
  type GraphResource,
  type ResourceGraph,
} from '../src/index.js';

const NOW = '2026-11-10T00:00:00.000Z';
const RESOURCE_ID = 'global.http-get-ops-alerts-noise-report';
const REQUEST_ID = `${RESOURCE_ID}:http:request-observed`;
const STATUS_ID = `${RESOURCE_ID}:http:response-status-ok`;
const PERSISTENCE_READ_ID = `${RESOURCE_ID}:persistence:read`;

/** The unmodified `gateforge init` starter transport policy. */
const STARTER = {
  schemaVersion: 1 as const,
  policies: [
    {
      id: 'frontend-consumed-endpoints-transport-only',
      when: { kind: 'http.endpoint', consumed: true },
      require: ['http:request-observed', 'http:response-status-ok'],
    },
  ],
};

/** The starter plus a persistence policy that MATCHES the internal route. */
const WITH_PERSISTENCE = {
  schemaVersion: 1 as const,
  policies: [
    ...STARTER.policies,
    {
      id: 'user-facing-persistence',
      when: { exposure: 'internal' },
      require: [
        'persistence:create',
        'persistence:read',
        'persistence:update',
        'persistence:delete',
      ],
    },
  ],
};

/** An unlinked `/ops/*` route: internal by the classifier's path rule. */
function resource(attributes: Record<string, unknown>): GraphResource {
  return GraphResourceSchema.parse({
    schemaVersion: 1,
    id: RESOURCE_ID,
    name: 'http-get-ops-alerts-noise-report',
    plane: 'global',
    kind: 'http.endpoint',
    source: 'backend/api/ops/endpoints.py',
    location: { file: 'backend/api/ops/endpoints.py', line: 1, col: 0 },
    exposure: 'internal',
    classification: {
      exposure: 'internal',
      plane: 'global',
      lifecycle: { create: false, read: true, update: false, delete: false },
      primaryKey: ['method', 'path'],
    },
    classificationTrace: null,
    detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    attributes,
  });
}

function graphOf(resources: GraphResource[]): ResourceGraph {
  return { schemaVersion: 1, resources, unresolved: [], findings: [], stale: [] };
}

describe('internal routes carry transport obligations like any route (plan 20261109_1030)', () => {
  const route = resource({
    method: 'GET',
    canonicalPath: '/ops/alerts/noise-report',
    frontendConsumed: true,
  });
  const graph = graphOf([route]);
  const classification = route.classification;

  it('T1 guard: the starter policy emits exactly the two transport obligations', () => {
    const result = evaluatePolicies({ graph, policies: STARTER });
    expect(result.obligations.map((obligation) => obligation.id)).toEqual([REQUEST_ID, STATUS_ID]);
  });

  it('T1 guard: a matched persistence policy still emits no persistence obligation', () => {
    const result = evaluatePolicies({ graph, policies: WITH_PERSISTENCE });
    expect(result.obligations.map((obligation) => obligation.id)).toEqual([REQUEST_ID, STATUS_ID]);
  });

  it('T2: a transport claim on the internal route assesses valid', () => {
    const result = evaluatePolicies({
      graph,
      policies: STARTER,
      claims: [{ schemaVersion: 1, obligationId: REQUEST_ID, testId: 't1' }],
    });
    const assessment = result.claims.find((entry) => entry.claim.obligationId === REQUEST_ID);
    expect(assessment?.status).toBe('valid');
  });

  it('T3 guard: a persistence claim stays invalid, cited to ADR 0003 D3', () => {
    const result = evaluatePolicies({
      graph,
      policies: STARTER,
      claims: [{ schemaVersion: 1, obligationId: PERSISTENCE_READ_ID, testId: 't1' }],
    });
    const assessment = result.claims.find(
      (entry) => entry.claim.obligationId === PERSISTENCE_READ_ID,
    );
    expect(assessment?.status).toBe('invalid');
    expect(assessment?.reason).toContain('is internal');
    expect(assessment?.reason).toContain('ADR 0003 D3');
  });

  it('T4: transport obligations grade missing without evidence, never invalid-internal', () => {
    for (const obligation of evaluatePolicies({ graph, policies: STARTER }).obligations) {
      const outcome = evaluateObligation(obligation, {
        claims: [{ schemaVersion: 1, obligationId: obligation.id, testId: 't1' }],
        records: [],
        waivers: [],
        classification,
        now: NOW,
      });
      expect(outcome.verdict).toBe('missing');
      expect(outcome.reason).not.toContain('is internal');
    }
  });

  it('T5: the operational-only transport case grades missing, not invalid', () => {
    const behavior = compileBehaviorPolicy({
      graph,
      policy: {
        schemaVersion: 1,
        resources: [],
        endpoints: [
          {
            resourceId: RESOURCE_ID,
            effects: [],
            cases: [],
            disposition: { kind: 'operational-only', reason: 'ops probe' },
          },
        ],
      },
      now: NOW,
    });
    const obligation = behavior.obligations.find((entry) => entry.id === REQUEST_ID);
    if (obligation === undefined) throw new Error('operational-only transport obligation missing');
    const outcome = evaluateObligation(obligation, {
      claims: [{ schemaVersion: 1, obligationId: REQUEST_ID, testId: 't1' }],
      records: [],
      waivers: [],
      classification,
      behavior: {
        catalog: behavior.catalog,
        requirements: behavior.catalog.requirements,
        authorityProfileDigest: null,
      },
      now: NOW,
    });
    expect(outcome.verdict).toBe('missing');
    expect(outcome.reason).not.toContain('is internal');
  });

  it('T6 guard: a hand-built persistence obligation stays invalid on the internal route', () => {
    const outcome = evaluateObligation(
      {
        schemaVersion: 1,
        id: PERSISTENCE_READ_ID,
        resourceId: RESOURCE_ID,
        contract: 'persistence:read',
        policyId: 'user-facing-persistence',
        lifecycle: { create: false, read: true, update: false, delete: false },
      },
      {
        claims: [{ schemaVersion: 1, obligationId: PERSISTENCE_READ_ID, testId: 't1' }],
        records: [],
        waivers: [],
        classification,
        now: NOW,
      },
    );
    expect(outcome.verdict).toBe('invalid');
    expect(outcome.reason).toContain('is internal');
  });
});
