/**
 * Phase 4 engine tests: the endpoint compiler stage (ADR 0004 D5/D6).
 * Capabilities from facts (methods never decide alone), linkage only
 * through unambiguous evidence, typed blocks for unwired/ambiguous/
 * unresolved outcomes, byte-identical output under input permutation.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyResources,
  evaluatePolicies,
  isEvidenceOnlyKind,
  type ClassificationSignal,
  type ClassifierResourceRef,
  type PolicyFile,
} from '@gateforge/core';
import {
  HTTP_ENDPOINT_KIND,
  type HttpContractFact,
  type HttpMethod,
} from '@gateforge/http-contract';
import { compileEndpointContribution } from '../src/endpoint-compiler.js';

let seq = 100;
function routeFact(
  method: HttpMethod,
  path: string,
  overrides: Partial<Record<string, unknown>> = {},
): HttpContractFact {
  seq += 1;
  return {
    schemaVersion: 1,
    role: 'server-route',
    method,
    normalizedPath: path,
    rawPath: path,
    framework: 'fastapi',
    handlerSymbol: `app.handler_${seq}`,
    source: { file: 'backend/routes.py', line: seq, col: 0 },
    ...overrides,
  };
}

function callFact(
  method: HttpMethod,
  path: string,
  overrides: Partial<Record<string, unknown>> = {},
): HttpContractFact {
  seq += 1;
  return {
    schemaVersion: 1,
    role: 'frontend-call',
    method,
    normalizedPath: path,
    rawPath: path,
    framework: 'fetch',
    callsites: [`frontend/src/api.ts:${seq}`],
    source: { file: 'frontend/src/api.ts', line: seq, col: 2 },
    ...overrides,
  };
}

/** Wraps facts into a contribution the way detector packs emit them. */
function contribution(facts: readonly HttpContractFact[]): {
  detectorId: string;
  detectorVersion: string;
  resources: Array<{ schemaVersion: 1; id: string; kind: string; source: string; location: { file: string; line: number; col: number }; detectorVersion: string; attributes: Record<string, unknown> }>;
  unresolved: never[];
  findings: never[];
  classificationSignals: never[];
} {
  return {
    detectorId: 'test.detector',
    detectorVersion: '1',
    resources: facts.map((fact, index) => ({
      schemaVersion: 1,
      id: `http.contract:test:${index}`,
      kind: 'http.contract',
      source: fact.source.file,
      location: fact.source,
      detectorVersion: '1',
      attributes: { ...fact } as Record<string, unknown>,
    })),
    unresolved: [],
    findings: [],
    classificationSignals: [],
  };
}

describe('endpoint capabilities (facts decide, methods are candidates)', () => {
  it('classifies a corroborated POST as crud-create', () => {
    const route = routeFact('POST', '/api/v1/accounts', {
      handlerSymbol: 'app.create_account',
      requestSchemaSymbols: ['AccountIn'],
    });
    const call = callFact('POST', '/api/v1/accounts');
    const { inventory } = compileEndpointContribution([contribution([route, call])]);
    const endpoint = inventory.endpoints.find((e) => e.canonicalPath === '/api/v1/accounts');
    expect(endpoint?.capabilities).toContain('crud-create');
    expect(endpoint?.frontendConsumed).toBe(true);
    expect(endpoint?.resourceName).toMatch(/^http-post-api-v1-accounts-[0-9a-f]{8}$/);
  });

  it('classifies command paths as workflow-command, never crud-create', () => {
    const route = routeFact('POST', '/api/v1/invoices/{invoice_id}/approve', {
      handlerSymbol: 'app.approve_invoice',
      requestSchemaSymbols: ['ApprovalIn'],
    });
    const call = callFact('POST', '/api/v1/invoices/{}/approve');
    const { inventory } = compileEndpointContribution([contribution([route, call])]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.capabilities).toContain('workflow-command');
    expect(endpoint?.capabilities).not.toContain('crud-create');
  });

  it('classifies health GETs as health-operations, never business crud-read', () => {
    const route = routeFact('GET', '/health/ready', { handlerSymbol: 'app.readiness' });
    const { inventory } = compileEndpointContribution([contribution([route])]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.capabilities).toEqual(['health-operations']);
  });

  it('withholds crud-delete from DELETEs whose semantics have no positive evidence', () => {
    const route = routeFact('DELETE', '/api/v1/accounts/{account_id}');
    const { inventory, contribution: compiled } = compileEndpointContribution([contribution([route])]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.capabilities).not.toContain('crud-delete');
    expect(
      compiled.unresolved.some((entry) => entry.code === 'ENDPOINT_SEMANTICS_UNRESOLVED'),
    ).toBe(true);
  });

  it('accepts the linked model pack delete-semantics signal as positive evidence', () => {
    const route = routeFact('DELETE', '/api/v1/accounts/{account_id}', {
      handlerSymbol: 'app.archive_account',
    });
    const base = contribution([route]);
    const withSemantics = {
      ...base,
      classificationSignals: [
        {
          schemaVersion: 1,
          target: { resourceName: 'accounts' },
          dimension: 'delete-semantics',
          assertion: 'archive',
          basis: 'declaration',
          source: 'gateforge.pack-sqlalchemy',
          location: { file: 'backend/models/account.py', line: 5, col: 0 },
          detector: { id: 'gateforge.pack-sqlalchemy', version: '0.1.0' },
        },
      ] as unknown as typeof base.classificationSignals,
    };
    const { inventory } = compileEndpointContribution([
      base,
      {
        ...contribution([]),
        resources: [
          {
            schemaVersion: 1 as const,
            id: 'sqlalchemy.table:accounts',
            kind: 'sqlalchemy.table',
            source: 'backend/models/account.py',
            location: { file: 'backend/models/account.py', line: 4, col: 0 },
            detectorVersion: '0.1.0',
            attributes: { resourceName: 'accounts' },
          },
        ],
      },
      withSemantics,
    ]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.capabilities).toContain('crud-archive');
    expect(endpoint?.linkedResourceName).toBe('accounts');
  });

  it('unconsumed routes compile too — the inventory is complete', () => {
    const route = routeFact('GET', '/api/v1/reports', { responseSchemaSymbols: ['ReportOut'] });
    const { inventory } = compileEndpointContribution([contribution([route])]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.frontendConsumed).toBe(false);
    expect(endpoint?.capabilities).toContain('crud-read');
  });
});

describe('linkage and blocks', () => {
  it('links only when the derived name matches exactly one business resource', () => {
    const route = routeFact('GET', '/api/v1/accounts/{account_id}', {
      responseSchemaSymbols: ['AccountOut'],
    });
    const business = {
      detectorId: 'test.models',
      detectorVersion: '1',
      resources: [
        {
          schemaVersion: 1 as const,
          id: 'sqlalchemy.table:accounts',
          kind: 'sqlalchemy.table',
          source: 'backend/models/account.py',
          location: { file: 'backend/models/account.py', line: 4, col: 0 },
          detectorVersion: '0.1.0',
          attributes: { resourceName: 'accounts' },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [],
    };
    const { inventory } = compileEndpointContribution([contribution([route]), business as never]);
    expect(inventory.endpoints[0]?.linkedResourceName).toBe('accounts');
    // The compiler binds the linked resource's adapter for the endpoint.
    const signals = compileEndpointContribution([contribution([route]), business as never])
      .contribution.classificationSignals;
    expect(
      signals.some((signal) => (signal as { dimension: string }).dimension === 'adapter-binding'),
    ).toBe(true);
  });

  it('emits typed unwired and ambiguous blocks', () => {
    const wired = routeFact('GET', '/api/v1/accounts');
    const ambiguousA = routeFact('GET', '/billing/{account_id}');
    const ambiguousB = routeFact('GET', '/billing/summary');
    const unwiredCall = callFact('DELETE', '/api/v1/accounts/7');
    const ambiguousCall = callFact('GET', '/billing/{}');
    const { inventory } = compileEndpointContribution([
      contribution([wired, ambiguousA, ambiguousB, unwiredCall, ambiguousCall]),
    ]);
    expect(inventory.unwired.map((block) => block.detail)).toEqual([
      expect.stringContaining('DELETE /api/v1/accounts/7'),
    ]);
    expect(inventory.ambiguous).toHaveLength(1);
    expect(inventory.ambiguous[0]?.candidates).toHaveLength(2);
  });
});

describe('determinism and graph separation', () => {
  it('is byte-identical under input permutation', () => {
    const facts = [
      routeFact('GET', '/api/v1/accounts', { handlerSymbol: 'app.list_accounts', responseSchemaSymbols: ['AccountOut'] }),
      routeFact('POST', '/api/v1/accounts', { requestSchemaSymbols: ['AccountIn'] }),
      routeFact('GET', '/health/ready'),
      callFact('GET', '/api/v1/accounts'),
      callFact('POST', '/api/v1/accounts'),
    ];
    const forward = compileEndpointContribution([contribution(facts)]);
    const reversed = compileEndpointContribution([contribution([...facts].reverse())]);
    expect(JSON.stringify(forward.contribution)).toBe(JSON.stringify(reversed.contribution));
    expect(JSON.stringify(forward.inventory)).toBe(JSON.stringify(reversed.inventory));
  });

  it('emits endpoint resources of the engine-owned endpoint kind', () => {
    const compiled = compileEndpointContribution([contribution([routeFact('GET', '/x')])]);
    for (const resource of compiled.contribution.resources) {
      expect(resource.kind).toBe(HTTP_ENDPOINT_KIND);
      expect(isEvidenceOnlyKind(resource.kind)).toBe(false); // endpoints ARE classified
    }
    expect(compiled.contribution.detectorId).toBe('gateforge.endpoint-compiler');
  });
});

describe('pipeline integration: endpoints classify and keep routes off the table lane', () => {
  it('a consumed endpoint bound to a business resource yields http obligations, not persistence', () => {
    const post = routeFact('POST', '/api/accounts', { requestSchemaSymbols: ['AccountIn'] });
    const call = callFact('POST', '/api/accounts');
    const business = {
      detectorId: 'test.models',
      detectorVersion: '1',
      resources: [
        {
          schemaVersion: 1,
          id: 'sqlalchemy.table:accounts',
          kind: 'sqlalchemy.table',
          source: 'backend/models/account.py',
          location: { file: 'backend/models/account.py', line: 4, col: 0 },
          detectorVersion: '0.1.0',
          attributes: { resourceName: 'accounts', plane: 'tenant' },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [
        {
          schemaVersion: 1,
          target: { resourceName: 'accounts' },
          dimension: 'plane',
          assertion: 'tenant',
          basis: 'code-positive',
          source: 'test.models',
          location: { file: 'backend/models/account.py', line: 4, col: 0 },
          detector: { id: 'test.models', version: '1' },
        },
        {
          schemaVersion: 1,
          target: { resourceName: 'accounts' },
          dimension: 'identity',
          assertion: ['id'],
          basis: 'code-positive',
          source: 'test.models',
          location: { file: 'backend/models/account.py', line: 4, col: 0 },
          detector: { id: 'test.models', version: '1' },
        },
        {
          schemaVersion: 1,
          target: { resourceName: 'accounts' },
          dimension: 'delete-semantics',
          assertion: 'hard',
          basis: 'declaration',
          source: 'test.models',
          location: { file: 'backend/models/account.py', line: 4, col: 0 },
          detector: { id: 'test.models', version: '1' },
        },
        {
          schemaVersion: 1,
          target: { resourceName: 'accounts' },
          dimension: 'adapter-binding',
          assertion: 'accounts',
          basis: 'declaration',
          source: 'test.models',
          location: { file: 'backend/models/account.py', line: 4, col: 0 },
          detector: { id: 'test.models', version: '1' },
        },
      ] as unknown as ClassificationSignal[],
    };
    const compiled = compileEndpointContribution([contribution([post, call]), business as never]);

    // Classify the compiled resources exactly like the pipeline does.
    const resources: ClassifierResourceRef[] = [
      ...compiled.contribution.resources.map((resource) => ({
        name: String((resource as { attributes: Record<string, unknown> }).attributes['resourceName']),
        id: null,
        kind: String((resource as { kind: string }).kind),
        source: String((resource as { source: string }).source),
        location: (resource as { location: { file: string; line: number; col: number } }).location,
        detector: { id: 'gateforge.endpoint-compiler', version: '1' },
        attributes: (resource as { attributes: Record<string, unknown> }).attributes,
      })),
      {
        name: 'accounts',
        id: 'tenant.accounts',
        kind: 'sqlalchemy.table',
        source: 'backend/models/account.py',
        location: { file: 'backend/models/account.py', line: 4, col: 0 },
        detector: { id: 'test.models', version: '1' },
        attributes: { plane: 'tenant' },
      },
    ];
    const signals: ClassificationSignal[] = [
      ...compiled.contribution.classificationSignals,
      ...business.classificationSignals,
    ] as unknown as ClassificationSignal[];
    const result = classifyResources({
      resources,
      signals,
      policy: {
        schemaVersion: 1,
        scanRoots: [],
        trustedInternalEntryPoints: [{ category: 'migration', patterns: [] }],
        internalRules: [],
        declarations: { internality: 'gateforge:internal', archiveState: 'gateforge:archive-state' },
        volatileFields: [],
      },
      adapters: ['accounts'],
      scan: { requestedPaths: [], scannedPaths: [], findings: [], unresolved: [] },
    });

    // Endpoint inherits the tenant plane from the linked table.
    const endpointDecision = result.decisions.find(
      (d) => d.kind === 'http.endpoint' && d.classification !== null,
    );
    expect(endpointDecision?.classification?.plane).toBe('tenant');
    const accountsDecision = result.decisions.find((d) => d.name === 'accounts');
    expect(accountsDecision?.classification?.plane).toBe('tenant');

    // A policy requiring both persistence:* and http:* generates the
    // persistence lane ONLY on the table and the http lane ONLY on the
    // endpoint — routes are never conflated with tables (ADR 0004 D8).
    const policies: PolicyFile = {
      schemaVersion: 1,
      policies: [
        {
          id: 'user-facing-persistence',
          when: { exposure: 'user-facing' },
          require: ['persistence:create', 'http:frontend-request-observed'],
        },
      ],
    };
    const graph = {
      schemaVersion: 1 as const,
      resources: result.decisions.map((decision, index) => ({
        schemaVersion: 1 as const,
        // bind.ts stamps the plane-qualified id from the decision.
        id:
          decision.resourceId ??
          (decision.classification !== null
            ? `${decision.classification.plane}.${decision.name}`
            : null),
        name: decision.name,
        plane: decision.classification?.plane ?? null,
        kind: decision.kind,
        source: decision.source,
        location: decision.location,
        exposure: decision.classification?.exposure ?? null,
        classification: decision.classification,
        classificationTrace: decision.classification,
        detector: { id: 'test', version: '1' },
        attributes: resources[index]?.attributes ?? {},
      })),
      unresolved: [],
      findings: [],
      stale: [],
    };
    const policyResult = evaluatePolicies({ graph: graph as never, policies });
    const endpointObligations = policyResult.obligations.filter((obligation) =>
      obligation.resourceId.startsWith('tenant.http-post-api-accounts'),
    );
    const tableObligations = policyResult.obligations.filter(
      (obligation) => obligation.resourceId === 'tenant.accounts',
    );
    expect(endpointObligations.map((obligation) => obligation.contract)).toEqual([
      'http:frontend-request-observed',
    ]);
    expect(tableObligations.map((obligation) => obligation.contract)).toEqual([
      'http:frontend-request-observed',
      'persistence:create',
    ]);
  });
});
