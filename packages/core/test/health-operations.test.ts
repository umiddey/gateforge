/**
 * Health/ops operational-only legality (plan 2026-10-19 P3).
 *
 * A route the classifier positively marks as health/ops stays legal
 * for `operational-only` when it also carries transport capabilities,
 * as long as it has no business-resource link. The same route with a
 * link, and an ordinary crud route, stay illegal.
 */
import { describe, expect, it } from 'vitest';
import {
  GraphResourceSchema,
  PolicyEvaluationError,
  compileBehaviorPolicy,
  type GraphResource,
  type ResourceGraph,
} from '../src/index.js';
import { isPositivelyClassifiedHealthOperations } from '../src/classifier/classify.js';

const NOW = '2026-10-19T00:00:00.000Z';
const TRANSPORT = ['crud-create', 'file-transfer', 'workflow-command'];

function endpoint(id: string, attributes: Record<string, unknown>): GraphResource {
  return GraphResourceSchema.parse({
    schemaVersion: 1,
    id,
    name: id,
    plane: 'global',
    kind: 'http.endpoint',
    source: 'backend/api/ops/endpoints.py',
    location: { file: 'backend/api/ops/endpoints.py', line: 1, col: 0 },
    exposure: null,
    classification: null,
    classificationTrace: null,
    detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    attributes,
  });
}

function graphOf(resource: GraphResource): ResourceGraph {
  return {
    schemaVersion: 1,
    resources: [resource],
    unresolved: [],
    findings: [],
    stale: [],
  };
}

function compile(resource: GraphResource) {
  return compileBehaviorPolicy({
    graph: graphOf(resource),
    policy: {
      schemaVersion: 1,
      endpoints: [
        {
          resourceId: resource.id ?? '',
          effects: [],
          cases: [],
          disposition: { kind: 'operational-only', reason: 'infra probe' },
        },
      ],
      resources: [],
    },
    now: NOW,
  });
}

describe('operational-only on health/ops routes (plan 2026-10-19 P3)', () => {
  const healthOps = endpoint('global.http-delete-health-drain', {
    method: 'DELETE',
    canonicalPath: '/health/drain',
    capabilities: TRANSPORT,
  });

  it('is legal when a health/ops route also has transport capabilities and no business link', () => {
    expect(isPositivelyClassifiedHealthOperations(healthOps)).toBe(true);
    expect(
      isPositivelyClassifiedHealthOperations(
        endpoint('global.http-post-api-ops-frontend-errors', {
          method: 'POST',
          canonicalPath: '/api/ops/frontend-errors',
          capabilities: ['crud-create'],
        }),
      ),
    ).toBe(true);
    const compiled = compile(healthOps);
    expect(compiled.blocking).toEqual([]);
    expect(compiled.catalog.cases).toHaveLength(1);
    expect(compiled.catalog.cases[0]?.definition.contract).toBe('http:request-observed');
  });

  it('stays illegal on the same route when it has a business link', () => {
    const linked = endpoint('global.http-delete-health-drain', {
      method: 'DELETE',
      canonicalPath: '/health/drain',
      capabilities: TRANSPORT,
      linkedResourceName: 'orders',
    });
    expect(isPositivelyClassifiedHealthOperations(linked)).toBe(false);
    expect(() => compile(linked)).toThrow(PolicyEvaluationError);
    expect(() => compile(linked)).toThrow(/illegal/);
  });

  it('stays illegal on an ordinary crud route', () => {
    const crud = endpoint('tenant.http-post-orders', {
      method: 'POST',
      canonicalPath: '/api/v1/orders',
      capabilities: ['crud-create'],
    });
    expect(isPositivelyClassifiedHealthOperations(crud)).toBe(false);
    expect(() => compile(crud)).toThrow(PolicyEvaluationError);
    expect(() => compile(crud)).toThrow(/illegal/);
  });
});
