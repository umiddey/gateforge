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
import { compileEndpointContribution, extractContractFacts } from '../src/endpoint-compiler.js';

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

describe('detector-specific HTTP fact projection', () => {
  it('accepts FastAPI metadata and projects the shared contract fields', () => {
    const result = extractContractFacts([
      {
        detectorId: 'gateforge.pack-fastapi',
        detectorVersion: '0.1.0',
        resources: [
          {
            schemaVersion: 1,
            id: 'http.contract:backend/routes.py:list_accounts:GET:/api/v1/accounts',
            kind: 'http.contract',
            source: 'backend/routes.py',
            location: { file: 'backend/routes.py', line: 12, col: 0 },
            detectorVersion: '0.1.0',
            attributes: {
              role: 'server-route',
              method: 'GET',
              rawPath: '/accounts',
              normalizedPath: '/api/v1/accounts',
              effectivePath: '/api/v1/accounts',
              framework: 'fastapi',
              handlerSymbol: 'backend.routes:list_accounts',
              requestSchemaSymbols: ['AccountQuery'],
              responseModel: 'AccountOut',
              isAsync: true,
              tags: ['accounts'],
              operationId: 'list_accounts',
              mountProvenance: 'include-chain',
            },
          },
        ],
        unresolved: [],
        findings: [],
        classificationSignals: [],
      },
    ]);
    expect(result.findings).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({
      role: 'server-route',
      method: 'GET',
      normalizedPath: '/api/v1/accounts',
      rawPath: '/api/v1/accounts',
      framework: 'fastapi',
      requestSchemaSymbols: ['AccountQuery'],
      responseSchemaSymbols: ['AccountOut'],
    });
  });
});

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
      // Corroborates the path-derived 'accounts' candidate (plural
      // tolerance: 'accounts' -> 'account' is not needed here; bare
      // 'Accounts' equals the candidate).
      responseSchemaSymbols: ['Accounts'],
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

describe('linkage corroboration (path-name coincidence never links)', () => {
  /** Business-resource-only contribution, as model packs emit it. */
  function businessContribution(
    names: readonly string[],
  ): Record<string, unknown> {
    return {
      detectorId: 'test.models',
      detectorVersion: '1',
      resources: names.map((name, index) => ({
        schemaVersion: 1 as const,
        id: `sqlalchemy.table:${name}`,
        kind: 'sqlalchemy.table',
        source: `backend/models/${name}.py`,
        location: { file: `backend/models/${name}.py`, line: index + 4, col: 0 },
        detectorVersion: '0.1.0',
        attributes: { resourceName: name },
      })),
      unresolved: [],
      findings: [],
      classificationSignals: [],
    };
  }

  it('does NOT link on unique name coincidence alone and emits one typed unresolved entry', () => {
    // Default handler is `app.handler_<n>` (no resource word); no schema
    // symbols. The derived 'accounts' matches exactly one business
    // resource — pure path-name coincidence, so no link forms.
    const route = routeFact('GET', '/api/v1/accounts');
    const compiled = compileEndpointContribution([
      contribution([route]),
      businessContribution(['accounts']) as never,
    ]);
    expect(compiled.inventory.endpoints[0]?.linkedResourceName).toBeNull();
    const linkBlocks = compiled.contribution.unresolved.filter(
      (entry) => entry.code === 'ENDPOINT_RESOURCE_LINK_UNRESOLVED',
    );
    expect(linkBlocks).toHaveLength(1);
    expect(linkBlocks[0]?.detail).toBe(
      "endpoint 'GET /api/v1/accounts' derives resource name 'accounts' but no schema symbol " +
        'or handler-name fact corroborates the link; add schema/model evidence ' +
        "(response/request schema named after the resource) or rely on the model pack's own linkage",
    );
    expect(linkBlocks[0]?.location).toEqual({ file: 'backend/routes.py', line: route.source.line, col: 0 });
    // No adapter-binding signal without an explicit link.
    expect(
      compiled.contribution.classificationSignals.some(
        (signal) => (signal as { dimension: string }).dimension === 'adapter-binding',
      ),
    ).toBe(false);
  });

  it('deduplicates the unresolved link entry per endpoint identity', () => {
    const routeA = routeFact('GET', '/api/v1/accounts');
    const routeB = routeFact('GET', '/api/v1/accounts');
    const compiled = compileEndpointContribution([
      contribution([routeA, routeB]),
      businessContribution(['accounts']) as never,
    ]);
    const identity = 'GET /api/v1/accounts';
    expect(compiled.inventory.endpoints.filter((e) => e.identity === identity)).toHaveLength(1);
    expect(
      compiled.contribution.unresolved.filter((entry) => entry.code === 'ENDPOINT_RESOURCE_LINK_UNRESOLVED'),
    ).toHaveLength(1);
  });

  it('corroborates via handler name with singular plural tolerance', () => {
    // `create_account` carries 'account' as a whole snake word; candidate
    // 'accounts' normalizes to singular 'account' — corroboration holds
    // with zero schema symbols.
    const route = routeFact('GET', '/api/v1/accounts', { handlerSymbol: 'app.create_account' });
    const compiled = compileEndpointContribution([
      contribution([route]),
      businessContribution(['accounts']) as never,
    ]);
    expect(compiled.inventory.endpoints[0]?.linkedResourceName).toBe('accounts');
    expect(
      compiled.contribution.unresolved.some((entry) => entry.code === 'ENDPOINT_RESOURCE_LINK_UNRESOLVED'),
    ).toBe(false);
  });

  it('does NOT corroborate when the word only appears inside a larger word', () => {
    // 'myaccount_manager' contains the loose substring 'account_' but
    // 'account' is never delimited by '_' or string bounds — whole-word
    // (snake-segment) matching rejects it; coincidence stays unlinked.
    const route = routeFact('GET', '/api/v1/accounts', { handlerSymbol: 'app.myaccount_manager' });
    const compiled = compileEndpointContribution([
      contribution([route]),
      businessContribution(['accounts']) as never,
    ]);
    expect(compiled.inventory.endpoints[0]?.linkedResourceName).toBeNull();
    expect(
      compiled.contribution.unresolved.some((entry) => entry.code === 'ENDPOINT_RESOURCE_LINK_UNRESOLVED'),
    ).toBe(true);
  });

  it('corroborates via request schema symbol with suffix strip and plural tolerance', () => {
    // 'AccountIn' -> last segment 'accountin' -> strip 'in' -> 'account'
    // == singular('accounts') — request-side schema evidence suffices.
    const route = routeFact('POST', '/api/accounts', {
      requestSchemaSymbols: ['AccountIn'],
      handlerSymbol: 'app.handle', // no resource word; schema does the work
    });
    const compiled = compileEndpointContribution([
      contribution([route]),
      businessContribution(['accounts']) as never,
    ]);
    expect(compiled.inventory.endpoints[0]?.linkedResourceName).toBe('accounts');
    expect(
      compiled.contribution.unresolved.some((entry) => entry.code === 'ENDPOINT_RESOURCE_LINK_UNRESOLVED'),
    ).toBe(false);
    const signals = compiled.contribution.classificationSignals;
    expect(
      signals.some((signal) => (signal as { dimension: string }).dimension === 'adapter-binding'),
    ).toBe(true);
  });

  it('stays byte-identical under input permutation with corroborated and coincidence-only endpoints', () => {
    const business = businessContribution(['accounts', 'invoices']);
    const facts = [
      routeFact('GET', '/api/v1/accounts', { handlerSymbol: 'app.list_accounts' }), // handler-corroborated
      routeFact('GET', '/api/v1/invoices', { responseSchemaSymbols: ['InvoiceDto'] }), // schema-corroborated
      routeFact('DELETE', '/api/v1/invoices/{invoice_id}'), // coincidence-only
      callFact('GET', '/api/v1/accounts'),
    ];
    const forward = compileEndpointContribution([contribution(facts), business as never]);
    const reversed = compileEndpointContribution([
      contribution([...facts].reverse()),
      business as never,
    ]);
    expect(JSON.stringify(forward.contribution)).toBe(JSON.stringify(reversed.contribution));
    expect(JSON.stringify(forward.inventory)).toBe(JSON.stringify(reversed.inventory));
    // And the coincident DELETE stays unlinked while the others link.
    expect(forward.inventory.endpoints.find((e) => e.method === 'DELETE')?.linkedResourceName).toBeNull();
    expect(forward.inventory.endpoints.find((e) => e.canonicalPath === '/api/v1/accounts')?.linkedResourceName).toBe(
      'accounts',
    );
    expect(forward.inventory.endpoints.find((e) => e.canonicalPath === '/api/v1/invoices')?.linkedResourceName).toBe(
      'invoices',
    );
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
