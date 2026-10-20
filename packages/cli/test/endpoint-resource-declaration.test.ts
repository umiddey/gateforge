/**
 * Declared route→resource links (plan 20261020_1130, item b): a rule of
 * the owner-answers `endpoints:` section may carry `resource:` — the
 * name of the business resource the route serves. REFERENCE.md has
 * told owners to "declare the missing mapping" since the unmatched
 * entry existed; before this change no such key parsed.
 *
 * Semantics, all fail-closed:
 * - a declared name must equal a discovered business resource EXACTLY;
 *   otherwise a typed blocking entry names the rule and the closest
 *   discovered names (`ENDPOINT_RESOURCE_DECLARATION_UNMATCHED`);
 * - matching rules naming DIFFERENT resources are a typed contradiction
 *   and link nothing (`ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION`) —
 *   never first-rule-wins;
 * - a valid declaration links the endpoint INSTEAD of the path-derived
 *   guess: a declared route produces neither
 *   `ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED` nor
 *   `ENDPOINT_RESOURCE_LINK_UNRESOLVED`, so it stops failing the
 *   run-wide complete-scan proof;
 * - capability handling is byte-identical; `capability` becomes
 *   optional only when `resource` is present;
 * - with no `resource` anywhere the output is the 0.17.0 output.
 *
 * The tests drive the REAL compiler (`compileEndpointContribution`)
 * over detector contributions.
 */
import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_CAPABILITY_CONTRADICTION,
  ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED,
  ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION,
  ENDPOINT_RESOURCE_DECLARATION_UNMATCHED,
  ENDPOINT_RESOURCE_LINK_UNRESOLVED,
} from '@gate-forge/http-contract';
import { compileEndpointContribution, type CompileResult } from '../src/endpoint-compiler.js';
import { parseEndpointsConfigDocument } from '../src/endpoint-config.js';
import type { Resource } from '@gate-forge/core';

const TABLE = 'report_logs';
const ROUTER_FILE = 'backend/routes/log_routes.py';

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

/** A by-id route whose path-derived name (`logs`) matches nothing. */
function byIdRouteResource(): Resource {
  return {
    schemaVersion: 1,
    id: 'res:fact',
    kind: 'http.contract',
    source: ROUTER_FILE,
    location: { file: ROUTER_FILE, line: 10, col: 0 },
    detectorVersion: '1',
    attributes: {
      role: 'server-route',
      method: 'GET',
      normalizedPath: '/api/v1/reports/logs/{}',
      rawPath: '/api/v1/reports/logs/{log_id}',
      framework: 'fastapi',
    },
  };
}

function compile(options?: { endpoints?: unknown }): CompileResult {
  return compileEndpointContribution([tableResource(), byIdRouteResource()].map((resource) => ({
    detectorId: 'test.detector',
    detectorVersion: '1',
    resources: [resource],
    unresolved: [],
    findings: [],
    classificationSignals: [],
  })), options);
}

describe('declared route→resource links (`resource:` endpoint rules, item b)', () => {
  it('(b) a declared link clears CANDIDATE_UNMATCHED and links the endpoint', () => {
    const result = compile({
      endpoints: {
        rules: [
          {
            match: 'backend/routes/**',
            resource: TABLE,
            reason: 'the logs route reads report_logs rows by id',
          },
        ],
      },
    });

    const codes = result.contribution.unresolved.map((entry) => entry.code);
    expect(codes).not.toContain(ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED);
    expect(codes).not.toContain(ENDPOINT_RESOURCE_LINK_UNRESOLVED);
    expect(codes).not.toContain(ENDPOINT_RESOURCE_DECLARATION_UNMATCHED);
    expect(codes).not.toContain(ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION);
    const endpoint = result.inventory.endpoints[0];
    expect(endpoint).toBeDefined();
    expect(endpoint?.linkedResourceName).toBe(TABLE);
    const endpointResource = result.contribution.resources.find(
      (resource) => resource.id === 'http.endpoint:GET /api/v1/reports/logs/{}',
    );
    expect(endpointResource?.attributes['linkedResourceName']).toBe(TABLE);
  });

  it('(b) an unknown declared resource is a typed blocking entry naming the rule and the closest names', () => {
    const result = compile({
      endpoints: {
        rules: [
          {
            paths: ['/api/v1/reports/logs/{}'],
            resource: 'log_entries',
            reason: 'owner believes this is the log_entries table',
          },
        ],
      },
    });

    const unmatched = result.contribution.unresolved.filter(
      (entry) => entry.code === ENDPOINT_RESOURCE_DECLARATION_UNMATCHED,
    );
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.detail).toContain('rules[0]');
    expect(unmatched[0]?.detail).toContain('log_entries');
    expect(unmatched[0]?.detail).toContain('report_logs');
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBeNull();
    // A declared route never falls back to the path-derived channel.
    expect(result.contribution.unresolved.map((entry) => entry.code)).not.toContain(
      ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED,
    );
  });

  it('(b) matching rules naming different resources are a typed contradiction and link nothing', () => {
    const result = compile({
      endpoints: {
        rules: [
          { match: 'backend/routes/**', resource: TABLE, reason: 'first review' },
          {
            // `match` (not `handlers`): the fixture route carries no
            // handlerSymbol, so a `handlers` selector could never match
            // it and the disagreement below would never be collected
            // (test-authoring fix, witnessed on the P2(b) red run).
            match: 'backend/routes/**',
            resource: 'log_entries',
            reason: 'second review, disagrees',
          },
        ],
      },
    });

    const contradictions = result.contribution.unresolved.filter(
      (entry) => entry.code === ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION,
    );
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]?.detail).toContain("'report_logs' vs 'log_entries'");
    expect(contradictions[0]?.detail).toContain('rules[0]');
    expect(contradictions[0]?.detail).toContain('rules[1]');
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBeNull();
    expect(result.contribution.unresolved.map((entry) => entry.code)).not.toContain(
      ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED,
    );
  });

  it('(b) capability-only rules are unchanged: capability applies, linkage channel untouched', () => {
    const result = compile({
      endpoints: {
        rules: [
          {
            match: 'backend/routes/**',
            capability: 'search-query',
            reason: 'service-layer delegation',
          },
        ],
      },
    });

    const endpoint = result.inventory.endpoints[0];
    expect(endpoint?.capabilities).toContain('search-query');
    expect(
      endpoint?.capabilityTrace.some(
        (entry) => entry.capability === 'search-query' && entry.rule === 'endpoints:',
      ),
    ).toBe(true);
    expect(endpoint?.linkedResourceName).toBeNull();
    // Linkage evidence is untouched: the by-id route still reports its
    // unmatched candidate.
    expect(result.contribution.unresolved.map((entry) => entry.code)).toContain(
      ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED,
    );
  });

  it('(b) a rule may carry both capability and resource; both apply', () => {
    const result = compile({
      endpoints: {
        rules: [
          {
            match: 'backend/routes/**',
            capability: 'search-query',
            resource: TABLE,
            reason: 'declares what it does and what it serves',
          },
        ],
      },
    });

    expect(result.inventory.endpoints[0]?.capabilities).toContain('search-query');
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBe(TABLE);
  });

  it('(b) with no `resource` anywhere the output is the 0.17.0 output', () => {
    const baseline = JSON.stringify(compile());
    // Absent section and an empty rules array are the same noop.
    expect(JSON.stringify(compile({ endpoints: { rules: [] } }))).toBe(baseline);
    // A capability-only rule that matches nothing changes nothing.
    // (`match` added: a rule with NO selector was never valid — the
    // parser refused it before (b) too; witnessed on the red run.)
    expect(
      JSON.stringify(
        compile({
          endpoints: {
            rules: [
              { match: 'backend/nowhere/**', method: 'DELETE', capability: 'crud-delete', reason: 'never matches' },
            ],
          },
        }),
      ),
    ).toBe(baseline);

    // Pinned literal, captured from the built 0.17.0 dist before the
    // change (github/main c2c7cb43). The ONE intended delta is the
    // ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED detail text, which now names
    // the `resource:` declaration channel — an expectation the intended
    // change (b) alters.
    expect(baseline).toBe(GOLDEN_NO_RESOURCE_EXPECTED);
  });

  it('(b) the parse layer: capability optional only with resource; resource must be a non-empty string', () => {
    expect(() =>
      parseEndpointsConfigDocument(
        { rules: [{ match: 'a/**', reason: 'neither capability nor resource' }] },
        'test',
      ),
    ).toThrow("must carry at least one of 'capability' or 'resource'");
    expect(() =>
      parseEndpointsConfigDocument({ rules: [{ match: 'a/**', resource: '  ', reason: 'r' }] }, 'test'),
    ).toThrow('resource');
    expect(() =>
      parseEndpointsConfigDocument(
        { rules: [{ match: 'a/**', capability: 'no-such-capability', reason: 'r' }] },
        'test',
      ),
    ).toThrow('capability');
    // A resource-only rule parses; a capability+resource rule parses.
    expect(
      parseEndpointsConfigDocument(
        { rules: [{ match: 'a/**', resource: 'logs', reason: 'r' }] },
        'test',
      ).rules[0]?.resource,
    ).toBe('logs');
    expect(
      parseEndpointsConfigDocument(
        { rules: [{ match: 'a/**', capability: 'crud-read', resource: 'logs', reason: 'r' }] },
        'test',
      ).rules[0]?.capability,
    ).toBe('crud-read');
  });

  it('(b) a capability contradiction is still detected when resource-only rules also match', () => {
    const result = compile({
      endpoints: {
        rules: [
          { match: 'backend/routes/**', capability: 'search-query', resource: TABLE, reason: 'a' },
          {
            match: 'backend/routes/**',
            capability: 'auth-session',
            resource: TABLE,
            reason: 'b disagrees on capability only',
          },
        ],
      },
    });

    expect(result.contribution.unresolved.map((entry) => entry.code)).toContain(
      ENDPOINT_CAPABILITY_CONTRADICTION,
    );
    expect(result.contribution.unresolved.map((entry) => entry.code)).not.toContain(
      ENDPOINT_RESOURCE_DECLARATION_CONTRADICTION,
    );
    // Agreeing resources still link even when capabilities contradict.
    expect(result.inventory.endpoints[0]?.linkedResourceName).toBe(TABLE);
  });
});

/**
 * Full compile output of the fixture above, byte-identical to the
 * 0.17.0 dist build, except the ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED
 * detail text which the intended change (b) extends to name the
 * `resource:` declaration channel.
 */
const GOLDEN_NO_RESOURCE_EXPECTED =
  '{"contribution":{"detectorId":"gateforge.endpoint-compiler","detectorVersion":"1","resources":[{"schemaVersion":1,"id":"http.endpoint:GET /api/v1/reports/logs/{}","kind":"http.endpoint","source":"backend/routes/log_routes.py","location":{"file":"backend/routes/log_routes.py","line":10,"col":0},"detectorVersion":"1","attributes":{"resourceName":"http-get-api-v1-reports-logs-param-4c41d7a5","method":"GET","canonicalPath":"/api/v1/reports/logs/{}","identity":"GET /api/v1/reports/logs/{}","rawPaths":["/api/v1/reports/logs/{log_id}"],"frameworks":["fastapi"],"serverSources":["backend/routes/log_routes.py:10:0"],"callSources":[],"mountProvenances":[],"capabilities":[],"capabilityTrace":[],"frontendConsumed":false}}],"unresolved":[{"code":"ENDPOINT_RESOURCE_CANDIDATE_UNMATCHED","detail":"endpoint \'GET /api/v1/reports/logs/{}\' derives resource name \'logs\', which names no discovered business resource; closest discovered names: report_logs (candidates, never links); link it with evidence that names the resource (a response_model or request schema named after it, or a handler named after it), declare the mapping with a `resource:` endpoint rule in the owner-answers document, or leave it unlinked — a name that merely looks close never links an endpoint","location":{"file":"backend/routes/log_routes.py","line":10,"col":0}},{"code":"ENDPOINT_SEMANTICS_UNRESOLVED","detail":"endpoint \'GET /api/v1/reports/logs/{}\' has no positive capability evidence (method alone never decides semantics); add handler/schema/model evidence, an explicit classification, or a capability declaration in the endpoints: section of the owner-answers document","location":{"file":"backend/routes/log_routes.py","line":10,"col":0}}],"findings":[],"classificationSignals":[{"schemaVersion":1,"target":{"resourceName":"http-get-api-v1-reports-logs-param-4c41d7a5"},"dimension":"identity","assertion":["method","path"],"basis":"code-positive","source":"gateforge.endpoint-compiler","location":{"file":"backend/routes/log_routes.py","line":10,"col":0},"detector":{"id":"gateforge.endpoint-compiler","version":"1"}}],"scannedPaths":[]},"inventory":{"facts":[{"schemaVersion":1,"role":"server-route","method":"GET","normalizedPath":"/api/v1/reports/logs/{}","rawPath":"/api/v1/reports/logs/{log_id}","framework":"fastapi","source":{"file":"backend/routes/log_routes.py","line":10,"col":0}}],"endpoints":[{"method":"GET","canonicalPath":"/api/v1/reports/logs/{}","identity":"GET /api/v1/reports/logs/{}","resourceName":"http-get-api-v1-reports-logs-param-4c41d7a5","capabilities":[],"capabilityTrace":[],"linkedResourceName":null,"frontendConsumed":false,"deleteSemantics":null,"routes":[{"schemaVersion":1,"role":"server-route","method":"GET","normalizedPath":"/api/v1/reports/logs/{}","rawPath":"/api/v1/reports/logs/{log_id}","framework":"fastapi","source":{"file":"backend/routes/log_routes.py","line":10,"col":0}}],"calls":[]}],"unwired":[],"ambiguous":[]}}';
