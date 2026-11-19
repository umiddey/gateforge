/**
 * `noResource: true` on an `endpoints:` rule: the owner's explicit answer
 * that a route serves no business resource. Block A pins what the existing
 * options can and cannot do (unchanged by this key). Block B pins the new
 * key. Both drive the REAL compiler (`compileEndpointContribution`), as the
 * sibling `endpoint-resource-declaration.test.ts` does.
 */
import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED,
  ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION,
  ENDPOINT_RESOURCE_DECLARATION_UNMATCHED,
} from '@gate-forge/http-contract';
import { GraphResourceSchema, compileBehaviorPolicy, type Resource } from '@gate-forge/core';
import { compileEndpointContribution, type CompileResult } from '../src/endpoint-compiler.js';
import { parseEndpointsConfigDocument } from '../src/endpoint-config.js';
import { renderEndpointInventory } from '../src/endpoint-report.js';

const TABLE = 'report_logs';
const ROUTER_FILE = 'backend/routes/log_routes.py';
const ROUTE = '/api/v1/reports/logs/{}';
const ENDPOINT_ID = `http.endpoint:GET ${ROUTE}`;
const REASON = 'the route is a read-only probe with no business table';

function tableResource(): Resource {
  return {
    schemaVersion: 1,
    id: 'res:table',
    kind: 'sql.table',
    source: 'backend/models/report_logs.py',
    location: { file: 'backend/models/report_logs.py', line: 5, col: 0 },
    detectorVersion: '1',
    attributes: { resourceName: TABLE, plane: 'tenant' },
  };
}

/** A by-id server route whose path-derived name matches nothing by default. */
function routeResource(normalizedPath: string): Resource {
  return {
    schemaVersion: 1,
    id: `res:route:${normalizedPath}`,
    kind: 'http.contract',
    source: ROUTER_FILE,
    location: { file: ROUTER_FILE, line: 10, col: 0 },
    detectorVersion: '1',
    attributes: {
      role: 'server-route',
      method: 'GET',
      normalizedPath,
      rawPath: normalizedPath.replace('{}', '{log_id}'),
      framework: 'fastapi',
    },
  };
}

function compile(options?: { endpoints?: unknown }, route = ROUTE): CompileResult {
  return compileEndpointContribution(
    [tableResource(), routeResource(route)].map((resource) => ({
      detectorId: 'test.detector',
      detectorVersion: '1',
      resources: [resource],
      unresolved: [],
      findings: [],
      classificationSignals: [],
    })),
    options,
  );
}

function codesOf(result: CompileResult): string[] {
  return result.contribution.unresolved.map((entry) => entry.code);
}

function endpointResourceOf(result: CompileResult) {
  return result.contribution.resources.find((resource) => resource.id === ENDPOINT_ID);
}

describe('existing options cannot resolve it', () => {
  it('a1: with no rule the route reports CANDIDATE_UNMATCHED and links nothing', () => {
    const result = compile();
    expect(codesOf(result)).toContain(ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED);
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBeNull();
  });

  it('a2: a capability-only rule does not clear CANDIDATE_UNMATCHED', () => {
    const result = compile({
      endpoints: { rules: [{ paths: [ROUTE], capability: 'crud-read', reason: REASON }] },
    });
    expect(codesOf(result)).toContain(ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED);
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBeNull();
  });

  it('a3: a resource naming no discovered table is DECLARATION_UNMATCHED and links nothing', () => {
    const result = compile({
      endpoints: { rules: [{ paths: [ROUTE], resource: 'no_such_table', reason: REASON }] },
    });
    expect(codesOf(result)).toContain(ENDPOINT_RESOURCE_DECLARATION_UNMATCHED);
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBeNull();
  });

  it('a4: a resource rule scoped to another method does not match the route', () => {
    const result = compile({
      endpoints: {
        rules: [{ paths: [ROUTE], method: 'POST', resource: TABLE, reason: REASON }],
      },
    });
    expect(codesOf(result)).toContain(ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED);
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBeNull();
  });
});

describe('noResource declaration', () => {
  const declared = { paths: [ROUTE], noResource: true, reason: REASON };

  it('b1: a route declared noResource gets no unresolved entry, no link, and keeps its identity', () => {
    const result = compile({ endpoints: { rules: [declared] } });
    const codes = codesOf(result);
    expect(codes).not.toContain(ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED);
    expect(codes).not.toContain(ENDPOINT_RESOURCE_DECLARATION_UNMATCHED);
    expect(codes).not.toContain(ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION);
    const endpoint = result.inventory.endpoints[0];
    expect(endpoint?.identity).toBe(compile().inventory.endpoints[0]?.identity);
    expect(endpoint?.linkedResourceName).toBeNull();
    expect(endpoint?.noResource).toEqual({ rule: 0, reason: REASON });
    expect(JSON.stringify(result.contribution)).not.toContain('adapter-binding');
    expect(endpointResourceOf(result)?.attributes['noResource']).toEqual({
      rule: 0,
      reason: REASON,
    });
  });

  it('b2: a noResource endpoint is still a graph endpoint and keeps blocking ENDPOINT_BEHAVIOR_MISSING', () => {
    const resource = endpointResourceOf(compile({ endpoints: { rules: [declared] } }));
    if (resource === undefined) throw new Error('endpoint resource missing');
    const graphResource = GraphResourceSchema.parse({
      schemaVersion: 1,
      id: resource.id,
      name: resource.id,
      plane: 'global',
      kind: resource.kind,
      source: resource.source,
      location: resource.location,
      exposure: null,
      classification: null,
      classificationTrace: null,
      detector: { id: 'gateforge.endpoint-compiler', version: '1' },
      attributes: resource.attributes,
    });
    const compiled = compileBehaviorPolicy({
      graph: { schemaVersion: 1, resources: [graphResource], unresolved: [], findings: [], stale: [] },
      policy: { schemaVersion: 1, endpoints: [], resources: [] },
      now: '2026-11-19T00:00:00.000Z',
    });
    expect(JSON.stringify(compiled.blocking)).toContain('ENDPOINT_BEHAVIOR_MISSING');
  });

  it('b3: noResource on a route the table serves is one CONTRADICTION naming rules[0]', () => {
    const served = '/api/v1/report_logs/{}';
    const result = compile(
      { endpoints: { rules: [{ paths: [served], noResource: true, reason: REASON }] } },
      served,
    );
    const contradictions = result.contribution.unresolved.filter(
      (entry) => entry.code === ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION,
    );
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.detail).toContain('rules[0]');
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBeNull();
    expect(result.inventory.endpoints[0]?.noResource).toBeUndefined();
  });

  it('b4: a noResource rule and a resource rule on one route are one CONTRADICTION and link nothing', () => {
    const result = compile({
      endpoints: {
        rules: [
          { paths: [ROUTE], noResource: true, reason: REASON },
          { paths: [ROUTE], resource: TABLE, reason: 'owner reads report_logs rows by id' },
        ],
      },
    });
    const contradictions = result.contribution.unresolved.filter(
      (entry) => entry.code === ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION,
    );
    expect(contradictions).toHaveLength(1);
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBeNull();
  });

  it('b5: the parser accepts only a literal true and refuses it beside resource', () => {
    expect(() =>
      parseEndpointsConfigDocument(
        { rules: [{ paths: [ROUTE], noResource: true, reason: REASON }] },
        'test',
      ),
    ).not.toThrow();
    expect(() =>
      parseEndpointsConfigDocument(
        { rules: [{ paths: [ROUTE], capability: 'crud-read', noResource: true, reason: REASON }] },
        'test',
      ),
    ).not.toThrow();
    for (const value of [false, 'yes', 1]) {
      expect(() =>
        parseEndpointsConfigDocument(
          { rules: [{ paths: [ROUTE], noResource: value, reason: REASON }] },
          'test',
        ),
      ).toThrow('rules[0].noResource must be the literal true (omit the key otherwise)');
    }
    expect(() =>
      parseEndpointsConfigDocument(
        { rules: [{ paths: [ROUTE], noResource: true, resource: TABLE, reason: REASON }] },
        'test',
      ),
    ).toThrow(
      "rules[0] carries both 'resource' and 'noResource' (a route serves the declared resource or none)",
    );
    expect(() =>
      parseEndpointsConfigDocument({ rules: [{ paths: [ROUTE], reason: REASON }] }, 'test'),
    ).toThrow(
      "rules[0] must carry at least one of 'capability' or 'resource', or 'noResource: true'",
    );
    expect(() =>
      parseEndpointsConfigDocument(
        { rules: [{ paths: [ROUTE], noResource: true, reason: '  ' }] },
        'test',
      ),
    ).toThrow('rules[0].reason must be a non-empty string');
  });

  it('b6: the endpoint report names the rule and reason; no declaration renders as before', () => {
    const rendered = renderEndpointInventory(compile({ endpoints: { rules: [declared] } }).inventory);
    expect(rendered).toContain('noResource=rules[0]');
    expect(rendered).toContain(REASON);
    const baseline = renderEndpointInventory(compile().inventory);
    expect(baseline).not.toContain('noResource');
    expect(renderEndpointInventory(compile({ endpoints: { rules: [] } }).inventory)).toBe(baseline);
  });
});
