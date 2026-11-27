/**
 * Side-effect links (plan 20261127_1305, Gap 1): a rule of the owner-answers
 * `endpoints:` section may carry `writes:` — a list of business resource
 * names the route WRITES as a side effect without serving them. It is
 * distinct from `resource:` (single-valued, drives adapter binding and DELETE
 * semantics), so a `writes` rule must never change those.
 *
 * Semantics, all fail-closed:
 * - each name must equal a discovered business resource EXACTLY; otherwise
 *   `ENDPOINT_RESOURCE_DECLARATION_UNMATCHED` names the rule and the name;
 * - matching rules union their names; the endpoint carries the sorted,
 *   deduplicated list as `attributes.sideEffectResourceNames`, and only when
 *   non-empty (no `writes` anywhere = the same output as before);
 * - `linkedResourceName` and the adapter-binding signals are unchanged.
 *
 * The tests drive the REAL compiler (`compileEndpointContribution`) and, for
 * S5, the REAL classifier (`classifyResources`) over its output.
 */
import { describe, expect, it } from 'vitest';
import { ENDPOINT_RESOURCE_DECLARATION_UNMATCHED } from '@gate-forge/http-contract';
import { compileEndpointContribution, type CompileResult } from '../src/endpoint-compiler.js';
import { parseEndpointsConfigDocument } from '../src/endpoint-config.js';
import {
  classifyResources,
  type ClassificationSignal,
  type ClassifierPolicy,
  type ClassifierResourceRef,
  type Resource,
} from '@gate-forge/core';

const LEDGER_FILE = 'backend/models/orphan_ledger.py';
const KEYS_FILE = 'backend/models/request_keys.py';
const AUDIT_FILE = 'backend/models/audit_marks.py';
const ROUTER_FILE = 'backend/routes/job_routes.py';
const ENDPOINT_ID = 'http.endpoint:POST /api/v1/jobs/{}';

function tableResource(name: string, source: string): Resource {
  return {
    schemaVersion: 1,
    id: `res:${name}`,
    kind: 'sql.table',
    source,
    location: { file: source, line: 5, col: 0 },
    detectorVersion: '1',
    attributes: { resourceName: name, plane: 'tenant' },
  };
}

/** A by-id POST route whose path-derived name (`jobs`) matches nothing. */
function routeResource(): Resource {
  return {
    schemaVersion: 1,
    id: 'res:route',
    kind: 'http.contract',
    source: ROUTER_FILE,
    location: { file: ROUTER_FILE, line: 10, col: 0 },
    detectorVersion: '1',
    attributes: {
      role: 'server-route',
      method: 'POST',
      normalizedPath: '/api/v1/jobs/{}',
      rawPath: '/api/v1/jobs/{job_id}',
      framework: 'fastapi',
    },
  };
}

function compile(options?: { endpoints?: unknown }): CompileResult {
  return compileEndpointContribution(
    [
      tableResource('orphan_ledger', LEDGER_FILE),
      tableResource('request_keys', KEYS_FILE),
      tableResource('audit_marks', AUDIT_FILE),
      routeResource(),
    ].map((resource) => ({
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

function endpointAttributes(result: CompileResult): Record<string, unknown> {
  const endpoint = result.contribution.resources.find((resource) => resource.id === ENDPOINT_ID);
  expect(endpoint).toBeDefined();
  return endpoint?.attributes ?? {};
}

function parseRule(rule: Record<string, unknown>) {
  return parseEndpointsConfigDocument({ rules: [{ match: 'a/**', ...rule }] }, 'test');
}

describe('side-effect links (`writes:` endpoint rules, Gap 1)', () => {
  it('S1 the parse layer: writes is a non-empty, duplicate-free list of non-empty strings with a reason', () => {
    expect(() => parseRule({ writes: 'request_keys', reason: 'r' })).toThrow('writes');
    expect(() => parseRule({ writes: [], reason: 'r' })).toThrow('writes');
    expect(() => parseRule({ writes: ['  '], reason: 'r' })).toThrow('writes');
    expect(() => parseRule({ writes: [42], reason: 'r' })).toThrow('writes');
    expect(() => parseRule({ writes: ['request_keys', 'request_keys'], reason: 'r' })).toThrow('writes');
    expect(() => parseRule({ writes: ['request_keys'] })).toThrow('reason');

    // A writes-only rule parses: `writes` alone satisfies the rule's
    // "at least one of" check, and it does not need capability or resource.
    expect(parseRule({ writes: ['request_keys'], reason: 'r' }).rules[0]).toMatchObject({
      writes: ['request_keys'],
    });
  });

  it('S2 a writes name matching no business resource is ENDPOINT_RESOURCE_DECLARATION_UNMATCHED, naming the rule and the name', () => {
    const result = compile({
      endpoints: {
        rules: [{ match: 'backend/routes/**', writes: ['no_such_table'], reason: 'owner typo' }],
      },
    });

    const unmatched = result.contribution.unresolved.filter(
      (entry) => entry.code === ENDPOINT_RESOURCE_DECLARATION_UNMATCHED,
    );
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]?.detail).toContain('rules[0]');
    expect(unmatched[0]?.detail).toContain('no_such_table');
    expect(endpointAttributes(result)['sideEffectResourceNames']).toBeUndefined();
  });

  it('S3 matching rules union their writes sorted and deduplicated, and leave linkedResourceName and signals unchanged', () => {
    const withWrites = compile({
      endpoints: {
        rules: [
          { match: 'backend/routes/**', capability: 'crud-create', writes: ['request_keys'], reason: 'a' },
          {
            match: 'backend/routes/**',
            capability: 'crud-create',
            writes: ['audit_marks', 'request_keys'],
            reason: 'b',
          },
        ],
      },
    });
    const withoutWrites = compile({
      endpoints: {
        rules: [
          { match: 'backend/routes/**', capability: 'crud-create', reason: 'a' },
          { match: 'backend/routes/**', capability: 'crud-create', reason: 'b' },
        ],
      },
    });

    expect(endpointAttributes(withWrites)['sideEffectResourceNames']).toEqual(['audit_marks', 'request_keys']);
    expect(withWrites.inventory.endpoints[0]?.linkedResourceName).toBe(
      withoutWrites.inventory.endpoints[0]?.linkedResourceName,
    );
    expect(withWrites.contribution.classificationSignals).toEqual(withoutWrites.contribution.classificationSignals);
  });

  it('S4 with no writes anywhere the endpoint carries no sideEffectResourceNames key', () => {
    const result = compile({
      endpoints: { rules: [{ match: 'backend/routes/**', capability: 'crud-create', reason: 'a' }] },
    });

    expect('sideEffectResourceNames' in endpointAttributes(result)).toBe(false);
  });

  it('S5 end to end: a hidden table written by a route, with no behavior declaration, is INCOMPLETE_PROOF_SCOPE naming the endpoint, not HIDDEN_RESOURCE_UNLINKED', () => {
    const compiled = compile({
      endpoints: {
        rules: [{ match: 'backend/routes/**', capability: 'crud-create', writes: ['audit_marks'], reason: 'writes audit' }],
      },
    });
    const endpoint = compiled.contribution.resources.find((resource) => resource.id === ENDPOINT_ID);
    expect(endpoint).toBeDefined();

    const table: ClassifierResourceRef = {
      kind: 'sql.table',
      id: null,
      name: 'audit_marks',
      source: AUDIT_FILE,
      location: { file: AUDIT_FILE, line: 5, col: 0 },
      detector: { id: 'gateforge.pack-sqlalchemy', version: '0.2.0' },
      attributes: { plane: 'tenant' },
    };
    // The compiler's Resource shape is a structural superset of the classifier's ref.
    const writer = endpoint as unknown as ClassifierResourceRef;
    const signals = [
      {
        schemaVersion: 1,
        target: { resourceName: 'audit_marks' },
        dimension: 'identity',
        assertion: ['id'],
        basis: 'code-positive',
        source: 'gateforge.pack-sqlalchemy',
        location: { file: AUDIT_FILE, line: 5, col: 0 },
        detector: { id: 'gateforge.pack-sqlalchemy', version: '0.2.0' },
      },
    ] as unknown as ClassificationSignal[];
    const policy = {
      schemaVersion: 1,
      scanRoots: ['**/*'],
      coverage: [],
      declarations: {},
      volatileFields: [],
      trustedInternalEntryPoints: [],
      internalRules: [],
      deleteRules: [{ match: 'backend/models/**', semantics: 'hard', reason: 'fixture' }],
      hiddenRules: [{ match: { resourceName: 'audit_marks' }, reason: 'audit marks are never shown to users' }],
    } as unknown as ClassifierPolicy;
    const result = classifyResources({
      resources: [table, writer],
      signals,
      policy,
      adapters: [],
      scan: {
        requestedPaths: [AUDIT_FILE, ROUTER_FILE],
        eligiblePaths: [AUDIT_FILE, ROUTER_FILE],
        coverage: [
          { detector: 'gateforge.pack-sqlalchemy', scannedPaths: [AUDIT_FILE] },
          { detector: 'gateforge.compiler', scannedPaths: [ROUTER_FILE] },
        ],
        configuredDetectors: 2,
        successfulDetectors: 2,
        findings: [],
        unresolved: [],
      } as unknown as Parameters<typeof classifyResources>[0]['scan'],
      behaviorDeclaredEndpoints: [],
    });

    const decision = result.decisions.find((entry) => entry.name === 'audit_marks');
    expect(decision).toBeDefined();
    const blocks = decision?.blocks ?? [];
    expect(blocks.map((block) => String(block.code))).not.toContain('HIDDEN_RESOURCE_UNLINKED');
    const incomplete = blocks.find((block) => block.code === 'INCOMPLETE_PROOF_SCOPE');
    expect(incomplete?.detail).toContain(ENDPOINT_ID);
  });
});
