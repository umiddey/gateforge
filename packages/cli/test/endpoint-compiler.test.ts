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
  withTempRepo,
  type ClassificationPolicy,
  type ClassificationResult,
  type ClassificationSignal,
  type ClassifierResourceRef,
  type PolicyFile,
} from '@gate-forge/core';
import {
  HTTP_ENDPOINT_KIND,
  type HttpContractFact,
  type HttpMethod,
} from '@gate-forge/http-contract';
import {
  compileEndpointContribution,
  extractContractFacts,
  type CompileResult,
} from '../src/endpoint-compiler.js';

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

/** A business-resource-only contribution, as model packs emit it. */
function businessTable(
  name: string,
): {
  detectorId: string;
  detectorVersion: string;
  resources: Array<{ schemaVersion: 1; id: string; kind: string; source: string; location: { file: string; line: number; col: number }; detectorVersion: string; attributes: Record<string, unknown> }>;
  unresolved: never[];
  findings: never[];
  classificationSignals: never[];
} {
  return {
    detectorId: 'test.models',
    detectorVersion: '1',
    resources: [
      {
        schemaVersion: 1,
        id: `sqlalchemy.table:${name}`,
        kind: 'sqlalchemy.table',
        source: `backend/models/${name}.py`,
        location: { file: `backend/models/${name}.py`, line: 4, col: 0 },
        detectorVersion: '1',
        attributes: { resourceName: name },
      },
    ],
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

  it('classifies PUT command paths as workflow-command, never crud-update', () => {
    // Capability rules compose: without the crud-update exclusion this
    // PUT carries BOTH workflow-command and crud-update (commands beat
    // methods, plan §5.4 — the command capability must win exclusively).
    const route = routeFact('PUT', '/api/v1/invoices/{invoice_id}/approve', {
      handlerSymbol: 'app.approve_invoice',
      requestSchemaSymbols: ['ApprovalIn'],
    });
    const { inventory } = compileEndpointContribution([contribution([route])]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.capabilities).toContain('workflow-command');
    expect(endpoint?.capabilities).not.toContain('crud-update');
  });

  it('classifies command handlers on PUT as workflow-command, never crud-update', () => {
    // Same exclusion keyed on the HANDLER suffix: `invoice_approve`
    // corroborates the path-derived 'invoices' candidate, so the endpoint
    // is even linked — the command capability still excludes the method
    // fallback.
    const route = routeFact('PUT', '/api/v1/invoices/{invoice_id}', {
      handlerSymbol: 'app.invoice_approve',
      requestSchemaSymbols: ['ApprovalIn'],
    });
    const business = businessTable('invoices');
    const { inventory } = compileEndpointContribution([contribution([route]), business as never]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.capabilities).toContain('workflow-command');
    expect(endpoint?.capabilities).not.toContain('crud-update');
    expect(endpoint?.linkedResourceName).toBe('invoices');
  });

  it('classifies a plain corroborated PUT as crud-update', () => {
    // Red-side anchor for the exclusion: without a command suffix in the
    // path or handler, the schema+link-corroborated PUT IS crud-update.
    const route = routeFact('PUT', '/api/v1/invoices/{invoice_id}', {
      requestSchemaSymbols: ['InvoiceIn'],
    });
    const business = businessTable('invoices');
    const { inventory } = compileEndpointContribution([contribution([route]), business as never]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.capabilities).toContain('crud-update');
    expect(endpoint?.capabilities).not.toContain('workflow-command');
    expect(endpoint?.linkedResourceName).toBe('invoices');
  });

  it('classifies health GETs as health-operations, never business crud-read', () => {
    const route = routeFact('GET', '/health/ready', { handlerSymbol: 'app.readiness' });
    const { inventory } = compileEndpointContribution([contribution([route])]);
    const endpoint = inventory.endpoints[0];
    expect(endpoint?.capabilities).toEqual(['health-operations']);
  });

  it('classifies only GENUINE infrastructure probes as health-operations (dogfood regression)', () => {
    // The old rule matched probe-sounding words at ANY depth, so business
    // sub-resources were classified operational-global and silently
    // exempted from adapters/obligations (a dogfood enforcement hole).
    // The operational shape is now segment-exact probe words on routes of
    // depth <= 2 (plus the bare root); `readiness`/`status` are NOT probe
    // words, and depth > 2 never qualifies — deep business routes stay in
    // the full user-facing lattice.
    const businessShapes = [
      '/api/v1/agent-metrics', // AI-token business metrics
      '/api/v1/operating-costs/buildings/{}/meter-readings/readiness', // business readiness state
      '/api/v1/operating-costs/settlements/{}/readiness', // business readiness state
      '/admin/imports/task/{}/status', // business job status
      '/admin/clients/{}/health', // per-client business sub-resource
      '/api/v1/health', // depth 3: business nesting, not a root probe
    ];
    for (const path of businessShapes) {
      const { inventory } = compileEndpointContribution([contribution([routeFact('GET', path)])]);
      expect(inventory.endpoints[0]?.capabilities, path).not.toContain('health-operations');
    }
    const probeShapes = ['/', '/health', '/health/live', '/ready', '/metrics', '/health/drain'];
    for (const path of probeShapes) {
      const { inventory } = compileEndpointContribution([contribution([routeFact('GET', path)])]);
      expect(inventory.endpoints[0]?.capabilities, path).toContain('health-operations');
    }
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

  it('joins a slotted call to its exact-shape route despite literal siblings', () => {
    // LITERAL PRECEDENCE (phase 3 refinement): the call's own `{}` slot
    // mirrored by the parameter route's `{}` slot is a LITERAL-tier match
    // (zero generality consumed beyond the call's own shape), while
    // relaxing the call slot onto the literal `summary` is only
    // parameter-tier. The literal tier shadows the parameter tier, so the
    // call JOINS `/billing/{account_id}` — the pre-phase-3
    // FRONTEND_ROUTE_AMBIGUOUS outcome for this shape is gone (mirrors
    // join.test.ts 'literal precedence').
    const wired = routeFact('GET', '/api/v1/accounts');
    const paramRoute = routeFact('GET', '/billing/{account_id}', { normalizedPath: '/billing/{}' });
    const literalSibling = routeFact('GET', '/billing/summary');
    const unwiredCall = callFact('DELETE', '/api/v1/accounts/7');
    const slottedCall = callFact('GET', '/billing/{}');
    const { inventory } = compileEndpointContribution([
      contribution([wired, paramRoute, literalSibling, unwiredCall, slottedCall]),
    ]);
    // The only typed block left is the genuinely unwired call.
    expect(inventory.ambiguous).toEqual([]);
    expect(inventory.unwired.map((block) => block.detail)).toEqual([
      expect.stringContaining('DELETE /api/v1/accounts/7'),
    ]);
    // The slotted call joined the parameterized route — the raw path
    // proves WHICH route fact joined.
    const joined = inventory.endpoints.find((e) => e.identity === 'GET /billing/{}');
    expect(joined?.frontendConsumed).toBe(true);
    expect(joined?.calls.map((c) => c.rawPath)).toEqual(['/billing/{}']);
    expect(joined?.routes.map((r) => r.rawPath)).toEqual(['/billing/{account_id}']);
    // The literal sibling still compiles — unconsumed.
    expect(
      inventory.endpoints.find((e) => e.identity === 'GET /billing/summary')?.frontendConsumed,
    ).toBe(false);
  });

  it('still blocks parameter-tier ambiguity — one literal call, two absorbing routes', () => {
    // The documented AMBIGUOUS case under literal precedence: BOTH
    // candidates exercised slot generality (the route `{}` absorbed the
    // call literal `x`; the trailing `{*}` absorbed it too), so no literal
    // tier exists and the engine refuses to guess — the block lists every
    // distinct candidate (mirrors join.test.ts's parameter-tier red probe).
    const paramRoute = routeFact('GET', '/billing/{account_id}', { normalizedPath: '/billing/{}' });
    const wildcardRoute = routeFact('GET', '/billing/{*}');
    const literalCall = callFact('GET', '/billing/x');
    const { inventory } = compileEndpointContribution([
      contribution([paramRoute, wildcardRoute, literalCall]),
    ]);
    // The routes still compile into the inventory (unconsumed).
    expect(inventory.endpoints.map((e) => e.identity)).toEqual([
      'GET /billing/{*}',
      'GET /billing/{}',
    ]);
    expect(inventory.ambiguous).toHaveLength(1);
    expect(inventory.ambiguous[0]?.candidates).toEqual(['GET /billing/{*}', 'GET /billing/{}']);
    expect(inventory.unwired).toEqual([]);
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

describe('dash-path name-form normalization (kebab route segments link snake_case tables)', () => {
  it('links a dash-path DELETE to its snake_case table and classifies hard delete', () => {
    // `/email-accounts/{id}` derives the snake_case candidate
    // 'email_accounts', which equals the discovered table name; the
    // handler 'destroy_email_account' corroborates (whole snake word
    // '_email_account') AND carries hard-delete semantics, so the DELETE
    // classifies instead of grading classification-blocked forever.
    const route = routeFact('DELETE', '/api/v1/email-accounts/{email_account_id}', {
      handlerSymbol: 'app.destroy_email_account',
    });
    const compiled = compileEndpointContribution([
      contribution([route]),
      businessTable('email_accounts') as never,
    ]);
    const endpoint = compiled.inventory.endpoints[0];
    expect(endpoint?.linkedResourceName).toBe('email_accounts');
    expect(endpoint?.capabilities).toContain('crud-delete');
    expect(
      compiled.contribution.unresolved.some(
        (entry) =>
          entry.code === 'ENDPOINT_RESOURCE_LINK_UNRESOLVED' ||
          entry.code === 'ENDPOINT_SEMANTICS_UNRESOLVED',
      ),
    ).toBe(false);
  });

  it('stays unlinked when the normalized candidate lacks corroboration (fail-closed)', () => {
    // Normalization repairs the NAME FORM only — it never fabricates the
    // corroboration fact; default handler `app.handler_<n>` carries no
    // resource word, so the link still needs explicit evidence.
    const route = routeFact('DELETE', '/api/v1/email-accounts/{email_account_id}');
    const compiled = compileEndpointContribution([
      contribution([route]),
      businessTable('email_accounts') as never,
    ]);
    expect(compiled.inventory.endpoints[0]?.linkedResourceName).toBeNull();
    const linkBlocks = compiled.contribution.unresolved.filter(
      (entry) => entry.code === 'ENDPOINT_RESOURCE_LINK_UNRESOLVED',
    );
    expect(linkBlocks).toHaveLength(1);
    // The typed block reports the NORMALIZED candidate form.
    expect(linkBlocks[0]?.detail).toContain("derives resource name 'email_accounts'");
  });

  it('mints no identity when the normalized candidate matches no resource', () => {
    const route = routeFact('DELETE', '/api/v1/ghost-accounts/{id}', {
      handlerSymbol: 'app.destroy_ghost_account',
    });
    const compiled = compileEndpointContribution([
      contribution([route]),
      businessTable('email_accounts') as never,
    ]);
    expect(compiled.inventory.endpoints[0]?.linkedResourceName).toBeNull();
    expect(
      compiled.contribution.unresolved.some(
        (entry) => entry.code === 'ENDPOINT_RESOURCE_LINK_UNRESOLVED',
      ),
    ).toBe(false);
  });

  it('keeps dash-path and plain-path endpoints byte-identical under permutation', () => {
    const business = {
      detectorId: 'test.models',
      detectorVersion: '1',
      resources: [
        {
          schemaVersion: 1 as const,
          id: 'sqlalchemy.table:email_accounts',
          kind: 'sqlalchemy.table',
          source: 'backend/models/email_account.py',
          location: { file: 'backend/models/email_account.py', line: 4, col: 0 },
          detectorVersion: '0.1.0',
          attributes: { resourceName: 'email_accounts' },
        },
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
    const facts = [
      routeFact('DELETE', '/api/v1/email-accounts/{email_account_id}', {
        handlerSymbol: 'app.destroy_email_account',
      }),
      routeFact('GET', '/api/v1/accounts', { handlerSymbol: 'app.list_accounts' }),
    ];
    const forward = compileEndpointContribution([contribution(facts), business as never]);
    const reversed = compileEndpointContribution([
      contribution([...facts].reverse()),
      business as never,
    ]);
    expect(JSON.stringify(forward.contribution)).toBe(JSON.stringify(reversed.contribution));
    expect(JSON.stringify(forward.inventory)).toBe(JSON.stringify(reversed.inventory));
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

describe('endpoint plane config channel (.gateforge/planes.json, plan phase 5)', () => {
  const PLANE_POLICY: ClassificationPolicy = {
    schemaVersion: 1,
    scanRoots: [],
    trustedInternalEntryPoints: [{ category: 'migration', patterns: [] }],
    internalRules: [],
    declarations: { internality: 'gateforge:internal', archiveState: 'gateforge:archive-state' },
    volatileFields: [],
  };

  /** A POST /api/v1/accounts router fact living under the v1 router tree. */
  function accountsRoute(): HttpContractFact {
    return routeFact('POST', '/api/v1/accounts', {
      requestSchemaSymbols: ['AccountIn'],
      handlerSymbol: 'app.create_account',
      source: { file: 'backend/api/v1/accounts.py', line: 12, col: 0 },
    });
  }

  /** A pure operational probe under the ops tree. */
  function healthRoute(): HttpContractFact {
    return routeFact('GET', '/health/ready', {
      source: { file: 'backend/api/ops/health.py', line: 40, col: 0 },
    });
  }

  /** A business table contribution + classifier ref + signals, as model packs emit them. */
  function businessFixture(
    name: string,
    plane: 'tenant' | 'master' | null,
  ): {
    contribution: unknown;
    ref: ClassifierResourceRef;
    signals: ClassificationSignal[];
  } {
    const location = { file: `backend/models/${name}.py`, line: 4, col: 0 };
    const signal = (dimension: string, assertion: unknown): Record<string, unknown> => ({
      schemaVersion: 1,
      target: { resourceName: name },
      dimension,
      assertion,
      basis: 'code-positive',
      source: 'test.models',
      location,
      detector: { id: 'test.models', version: '1' },
    });
    const signals = [
      signal('identity', ['id']),
      signal('delete-semantics', 'hard'),
      signal('adapter-binding', name),
    ] as unknown as ClassificationSignal[];
    return {
      contribution: {
        detectorId: 'test.models',
        detectorVersion: '1',
        resources: [
          {
            schemaVersion: 1,
            id: `sqlalchemy.table:${name}`,
            kind: 'sqlalchemy.table',
            source: location.file,
            location,
            detectorVersion: '1',
            attributes: plane === null ? { resourceName: name } : { resourceName: name, plane },
          },
        ],
        unresolved: [],
        findings: [],
        classificationSignals: signals,
      },
      ref: {
        name,
        id: null,
        kind: 'sqlalchemy.table',
        source: location.file,
        location,
        detector: { id: 'test.models', version: '1' },
        attributes: plane === null ? {} : { plane },
      },
      signals,
    };
  }

  /** Maps compiled resources into classifier refs exactly like the pipeline does. */
  function endpointRefs(compiled: CompileResult): ClassifierResourceRef[] {
    return compiled.contribution.resources.map((resource) => ({
      name: String((resource as { attributes: Record<string, unknown> }).attributes['resourceName']),
      id: null,
      kind: String((resource as { kind: string }).kind),
      source: String((resource as { source: string }).source),
      location: (resource as { location: { file: string; line: number; col: number } }).location,
      detector: { id: 'gateforge.endpoint-compiler', version: '1' },
      attributes: (resource as { attributes: Record<string, unknown> }).attributes,
    }));
  }

  /** Runs the compiled contribution (plus optional business fixture) through the classifier. */
  function classifyCompiled(
    compiled: CompileResult,
    business: ReturnType<typeof businessFixture> | null,
    adapters: readonly string[],
  ): ClassificationResult {
    return classifyResources({
      resources: [
        ...endpointRefs(compiled),
        ...(business !== null ? [business.ref] : []),
      ],
      signals: [
        ...(compiled.contribution.classificationSignals as unknown as ClassificationSignal[]),
        ...(business?.signals ?? []),
      ],
      policy: PLANE_POLICY,
      adapters: [...adapters],
      scan: { requestedPaths: [], scannedPaths: [], findings: [], unresolved: [] },
    });
  }

  const planeSignalsOf = (compiled: CompileResult): Array<Record<string, unknown>> =>
    compiled.contribution.classificationSignals.filter(
      (signal) => (signal as { dimension?: string }).dimension === 'plane',
    ) as Array<Record<string, unknown>>;

  it('an endpoint match rule applies its plane and qualifies the id', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({
          rules: [
            { match: 'backend/api/v1/**', plane: 'tenant', reason: 'tenant middleware requires a subdomain' },
          ],
        }),
      });
      const compiled = compileEndpointContribution([contribution([accountsRoute()])], { cwd: repo.root });
      const resourceName = compiled.inventory.endpoints[0]?.resourceName ?? '';

      // Exactly one plane signal, on the config channel, at the router source.
      const planeSignals = planeSignalsOf(compiled);
      expect(planeSignals).toHaveLength(1);
      expect(planeSignals[0]).toMatchObject({
        target: { resourceName },
        dimension: 'plane',
        assertion: 'tenant',
        basis: 'declaration',
        source: 'gateforge.endpoint-compiler:config',
        location: { file: 'backend/api/v1/accounts.py' },
      });
      expect(compiled.contribution.unresolved).toEqual([]);

      // The classifier resolves the plane from it; the endpoint binds its
      // own-name adapter so the user-facing default stays resolvable.
      const result = classifyCompiled(compiled, null, [resourceName]);
      const decision = result.decisions.find((entry) => entry.kind === 'http.endpoint');
      expect(decision?.classification?.plane).toBe('tenant');
      expect(decision?.blocks).toEqual([]);
      // The id the graph binds is plane-qualified from this decision.
      expect(`${decision?.classification?.plane}.${decision?.name}`).toBe(`tenant.${resourceName}`);
    });
  });

  it('two matching rules that disagree block as PLANE_RULE_CONTRADICTION with no plane evidence', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({
          rules: [
            { match: 'backend/api/v1/**', plane: 'tenant', reason: 'router-level tenant rule' },
            { match: 'backend/api/v1/accounts.py', plane: 'master', reason: 'accounts is master control-plane' },
          ],
        }),
      });
      const compiled = compileEndpointContribution([contribution([accountsRoute()])], { cwd: repo.root });

      const contradictions = compiled.contribution.unresolved.filter(
        (entry) => entry.code === 'PLANE_RULE_CONTRADICTION',
      );
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0]?.detail).toContain('master vs tenant');
      expect(contradictions[0]?.detail).toContain('router-level tenant rule');
      expect(contradictions[0]?.detail).toContain('accounts is master control-plane');
      expect(contradictions[0]?.location.file).toBe('backend/api/v1/accounts.py');
      // No plane evidence on a conflict — never first-match-wins.
      expect(planeSignalsOf(compiled)).toEqual([]);

      // The endpoint stays plane-unresolved in the classifier too.
      const result = classifyCompiled(compiled, null, []);
      const decision = result.decisions.find((entry) => entry.kind === 'http.endpoint');
      expect(decision?.classification).toBeNull();
      expect(decision?.blocks.some((block) => block.code === 'PLANE_UNRESOLVED')).toBe(true);
    });
  });

  it('an agreeing linked-resource plane resolves alongside the config plane', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({
          rules: [{ match: 'backend/api/**', plane: 'tenant', reason: 'tenant middleware requires a subdomain' }],
        }),
      });
      const business = businessFixture('accounts', 'tenant');
      const compiled = compileEndpointContribution(
        [contribution([accountsRoute()]), business.contribution as never],
        { cwd: repo.root },
      );

      // Agreement adds no mirror signal: one config assertion only.
      const planeSignals = planeSignalsOf(compiled);
      expect(planeSignals).toHaveLength(1);
      expect(planeSignals[0]).toMatchObject({
        assertion: 'tenant',
        source: 'gateforge.endpoint-compiler:config',
      });

      const result = classifyCompiled(compiled, business, ['accounts']);
      const decision = result.decisions.find((entry) => entry.kind === 'http.endpoint');
      expect(decision?.classification?.plane).toBe('tenant');
      expect(decision?.blocks).toEqual([]);
    });
  });

  it('a contradicting linked-resource plane surfaces both assertions and blocks PLANE_CONTRADICTION', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({
          rules: [{ match: 'backend/api/**', plane: 'tenant', reason: 'tenant middleware requires a subdomain' }],
        }),
      });
      const business = businessFixture('accounts', 'master');
      const compiled = compileEndpointContribution(
        [contribution([accountsRoute()]), business.contribution as never],
        { cwd: repo.root },
      );

      // Both channels are emitted: the config rule AND the linked table's
      // plane (mirrored so the classifier sees both — the config channel
      // must never silently override inheritance).
      const planeSignals = planeSignalsOf(compiled);
      expect(planeSignals).toHaveLength(2);
      expect(planeSignals.map((signal) => signal['source']).sort()).toEqual([
        'gateforge.endpoint-compiler:config',
        'gateforge.endpoint-compiler:linked-resource',
      ]);
      const mirror = planeSignals.find(
        (signal) => signal['source'] === 'gateforge.endpoint-compiler:linked-resource',
      );
      expect(mirror).toMatchObject({
        assertion: 'master',
        location: { file: 'backend/models/accounts.py' },
      });

      const result = classifyCompiled(compiled, business, ['accounts']);
      const decision = result.decisions.find((entry) => entry.kind === 'http.endpoint');
      expect(decision?.classification).toBeNull();
      const contradiction = decision?.blocks.find((block) => block.code === 'PLANE_CONTRADICTION');
      expect(contradiction?.detail).toContain('master, tenant');
      expect(contradiction?.locations.map((location) => location.file).sort()).toEqual([
        'backend/api/v1/accounts.py',
        'backend/models/accounts.py',
      ]);
    });
  });

  it('a config plane contradicting the operational global rule blocks; agreement resolves', () => {
    const rules = (plane: string): string =>
      JSON.stringify({
        rules: [{ match: 'backend/api/**', plane, reason: 'ops routers are declared explicitly' }],
      });

    withTempRepo({}, (repo) => {
      repo.writeFiles({ '.gateforge/planes.json': rules('tenant') });
      const compiled = compileEndpointContribution([contribution([healthRoute()])], { cwd: repo.root });
      const planeSignals = planeSignalsOf(compiled);
      expect(planeSignals.map((signal) => [signal['source'], signal['assertion']]).sort()).toEqual([
        ['gateforge.endpoint-compiler:config', 'tenant'],
        ['gateforge.endpoint-compiler:operational', 'global'],
      ]);
      const result = classifyCompiled(compiled, null, []);
      const decision = result.decisions.find((entry) => entry.kind === 'http.endpoint');
      expect(decision?.classification).toBeNull();
      expect(decision?.blocks.some((block) => block.code === 'PLANE_CONTRADICTION')).toBe(true);
    });

    withTempRepo({}, (repo) => {
      repo.writeFiles({ '.gateforge/planes.json': rules('global') });
      const compiled = compileEndpointContribution([contribution([healthRoute()])], { cwd: repo.root });
      expect(planeSignalsOf(compiled)).toHaveLength(1);
      const result = classifyCompiled(compiled, null, []);
      const decision = result.decisions.find((entry) => entry.kind === 'http.endpoint');
      expect(decision?.classification?.plane).toBe('global');
      expect(decision?.blocks).toEqual([]);
    });
  });

  it('tables rules never apply to endpoints', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({
          rules: [{ tables: ['accounts'], plane: 'tenant', reason: 'a table rule' }],
        }),
      });
      const compiled = compileEndpointContribution([contribution([accountsRoute()])], { cwd: repo.root });
      expect(planeSignalsOf(compiled)).toEqual([]);
      expect(compiled.contribution.unresolved).toEqual([]);
    });
  });

  it('absence of the config file is byte-identical to the channel being absent', () => {
    const facts = [
      accountsRoute(),
      healthRoute(),
      callFact('POST', '/api/v1/accounts'),
    ];
    withTempRepo({}, (repo) => {
      const withoutFile = compileEndpointContribution([contribution(facts)]);
      const withEmptyRepo = compileEndpointContribution([contribution(facts)], { cwd: repo.root });
      expect(JSON.stringify(withEmptyRepo.contribution)).toBe(JSON.stringify(withoutFile.contribution));
      expect(JSON.stringify(withEmptyRepo.inventory)).toBe(JSON.stringify(withoutFile.inventory));
    });
  });

  it('a merged identity contributed by multiple router files is plane-qualified only when EVERY contributor is covered', () => {
    // External-review regression (duplicate-source plane bug): the same
    // method+path served from two router files must never silently
    // inherit the one covered file's plane.
    const routeIn = (file: string) =>
      routeFact('GET', '/api/accounts', { source: { file, line: 10, col: 0 } });

    withTempRepo({}, (repo) => {
      // PARTIAL coverage: only backend/a.py matches a rule.
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({
          rules: [{ match: 'backend/a.py', plane: 'tenant', reason: 'covered router' }],
        }),
      });
      const compiled = compileEndpointContribution(
        [contribution([routeIn('backend/a.py'), routeIn('backend/b.py')])],
        { cwd: repo.root },
      );
      expect(
        planeSignalsOf(compiled).filter((signal) => signal['source'] === 'gateforge.endpoint-compiler:config'),
      ).toEqual([]);
      const partial = compiled.contribution.unresolved.filter((u) => u.code === 'PLANE_RULE_CONTRADICTION');
      expect(partial).toHaveLength(1);
      expect(partial[0]?.detail).toContain('cover only 1');
      expect(partial[0]?.detail).toContain("'backend/b.py'");
    });

    withTempRepo({}, (repo) => {
      // FULL agreeing coverage → the config plane applies.
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({
          rules: [{ match: 'backend/**', plane: 'tenant', reason: 'covered routers' }],
        }),
      });
      const compiled = compileEndpointContribution(
        [contribution([routeIn('backend/a.py'), routeIn('backend/b.py')])],
        { cwd: repo.root },
      );
      const configSignals = planeSignalsOf(compiled).filter(
        (signal) => signal['source'] === 'gateforge.endpoint-compiler:config',
      );
      expect(configSignals).toHaveLength(1);
      expect(configSignals[0]?.['assertion']).toBe('tenant');
      // The plane channel is clean; any remaining unresolved entry is the
      // unrelated semantics debt of a bare GET (no schema/link), not a
      // plane contradiction.
      expect(
        compiled.contribution.unresolved.filter((u) => u.code === 'PLANE_RULE_CONTRADICTION'),
      ).toEqual([]);
    });

    withTempRepo({}, (repo) => {
      // Contributors covered but DISAGREEING → cross-file contradiction.
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({
          rules: [
            { match: 'backend/a.py', plane: 'tenant', reason: 'a surface' },
            { match: 'backend/b.py', plane: 'master', reason: 'b surface' },
          ],
        }),
      });
      const compiled = compileEndpointContribution(
        [contribution([routeIn('backend/a.py'), routeIn('backend/b.py')])],
        { cwd: repo.root },
      );
      expect(
        planeSignalsOf(compiled).filter((signal) => signal['source'] === 'gateforge.endpoint-compiler:config'),
      ).toEqual([]);
      const contradictions = compiled.contribution.unresolved.filter(
        (u) => u.code === 'PLANE_RULE_CONTRADICTION',
      );
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0]?.detail).toContain('disagree');
      expect(contradictions[0]?.detail).toContain("'tenant'");
      expect(contradictions[0]?.detail).toContain("'master'");
    });
  });

  it('a malformed planes document throws (fail closed)', () => {
    withTempRepo({}, (repo) => {
      // Missing required `reason` — the human review artifact.
      repo.writeFiles({
        '.gateforge/planes.json': JSON.stringify({ rules: [{ match: 'a/**', plane: 'tenant' }] }),
      });
      expect(() =>
        compileEndpointContribution([contribution([accountsRoute()])], { cwd: repo.root }),
      ).toThrow(/invalid planes config.*reason/s);

      // Unknown top-level key — a typo'd document must not scan with
      // partial trust.
      repo.writeFiles({ '.gateforge/planes.json': '{"ruls": []}' });
      expect(() =>
        compileEndpointContribution([contribution([accountsRoute()])], { cwd: repo.root }),
      ).toThrow(/invalid planes config.*unknown key/s);

      // Not JSON at all.
      repo.writeFiles({ '.gateforge/planes.json': 'not json' });
      expect(() =>
        compileEndpointContribution([contribution([accountsRoute()])], { cwd: repo.root }),
      ).toThrow();
    });
  });
});

describe('endpoint capability config channel (.gateforge/endpoints.json)', () => {
  /**
   * The motivating service-delegation shape: a GET whose handler
   * delegates to a service module — no schema symbols, no linkage
   * evidence, path matches no capability rule. Detector facts alone can
   * never prove what it does.
   */
  function analyticsRoute(): HttpContractFact {
    return routeFact('GET', '/analytics/logs', {
      handlerSymbol: 'app.api.analytics:get_analytics_logs',
      source: { file: 'backend/api/v1/analytics.py', line: 44, col: 0 },
    });
  }

  /** A DELETE route for declared delete-semantics coverage. */
  function deleteRoute(): HttpContractFact {
    return routeFact('DELETE', '/api/v1/accounts/{account_id}', {
      handlerSymbol: 'app.api.accounts:remove_account',
      source: { file: 'backend/api/v1/accounts.py', line: 60, col: 0 },
    });
  }

  it('without the config file, service delegation stays ENDPOINT_SEMANTICS_UNRESOLVED', () => {
    withTempRepo({}, (repo) => {
      const compiled = compileEndpointContribution([contribution([analyticsRoute()])], { cwd: repo.root });
      const unresolved = compiled.contribution.unresolved.filter(
        (entry) => entry.code === 'ENDPOINT_SEMANTICS_UNRESOLVED',
      );
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.detail).toContain('no positive capability evidence');
      expect(compiled.inventory.endpoints[0]?.capabilities).toEqual([]);
    });
  });

  it('a declared capability resolves service delegation and suppresses the unresolved block', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/endpoints.json': JSON.stringify({
          rules: [
            {
              handlers: ['get_analytics_*'],
              capability: 'crud-read',
              reason: 'delegates to analytics_service.read; declared by the service owner',
            },
          ],
        }),
      });
      const compiled = compileEndpointContribution([contribution([analyticsRoute()])], { cwd: repo.root });
      expect(compiled.contribution.unresolved).toEqual([]);
      const endpoint = compiled.inventory.endpoints[0];
      expect(endpoint?.capabilities).toEqual(['crud-read']);
      expect(endpoint?.capabilityTrace).toContainEqual({
        capability: 'crud-read',
        rule: 'endpoints.json',
        evidence: 'declared: delegates to analytics_service.read; declared by the service owner',
      });
    });
  });

  it('a declared capability composes with detected capabilities without duplication', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/endpoints.json': JSON.stringify({
          rules: [
            { paths: ['/analytics/logs'], capability: 'crud-read', reason: 'read surface' },
            { match: 'backend/api/v1/**', capability: 'crud-read', reason: 'api reads' },
          ],
        }),
      });
      const compiled = compileEndpointContribution([contribution([analyticsRoute()])], { cwd: repo.root });
      const endpoint = compiled.inventory.endpoints[0];
      expect(endpoint?.capabilities).toEqual(['crud-read']);
      // Both agreeing rules ride the trace; one capability stands.
      expect(endpoint?.capabilityTrace.filter((entry) => entry.rule === 'endpoints.json')).toHaveLength(2);
    });
  });

  it('two rules asserting different capabilities block as ENDPOINT_CAPABILITY_CONTRADICTION', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/endpoints.json': JSON.stringify({
          rules: [
            { paths: ['/analytics/**'], capability: 'crud-read', reason: 'directory-level read rule' },
            { handlers: ['get_analytics_*'], capability: 'search-query', reason: 'analytics logs are a query surface' },
          ],
        }),
      });
      const compiled = compileEndpointContribution([contribution([analyticsRoute()])], { cwd: repo.root });
      const contradictions = compiled.contribution.unresolved.filter(
        (entry) => entry.code === 'ENDPOINT_CAPABILITY_CONTRADICTION',
      );
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0]?.detail).toContain('crud-read vs search-query');
      expect(contradictions[0]?.detail).toContain('directory-level read rule');
      expect(contradictions[0]?.detail).toContain('analytics logs are a query surface');
      // Fail closed: NO declared capability is applied on a conflict.
      expect(compiled.inventory.endpoints[0]?.capabilities).toEqual([]);
      // And the endpoint still fail-closes on semantics (no evidence).
      expect(
        compiled.contribution.unresolved.some((entry) => entry.code === 'ENDPOINT_SEMANTICS_UNRESOLVED'),
      ).toBe(true);
    });
  });

  it('a declared crud-archive resolves DELETE semantics without model evidence', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/endpoints.json': JSON.stringify({
          rules: [
            {
              match: 'backend/api/v1/accounts.py',
              method: 'DELETE',
              capability: 'crud-archive',
              reason: 'removes set archived_at via the service; soft delete by design',
            },
          ],
        }),
      });
      const compiled = compileEndpointContribution([contribution([deleteRoute()])], { cwd: repo.root });
      const endpoint = compiled.inventory.endpoints[0];
      expect(endpoint?.capabilities).toContain('crud-archive');
      expect(endpoint?.deleteSemantics).toBe('archive');
      expect(endpoint?.capabilityTrace).toContainEqual({
        capability: 'crud-archive',
        rule: 'DELETE_DECLARED',
        evidence: 'declared delete semantics: removes set archived_at via the service; soft delete by design',
      });
      expect(
        compiled.contribution.unresolved.some((entry) => entry.code === 'ENDPOINT_SEMANTICS_UNRESOLVED'),
      ).toBe(false);
    });
  });

  it('method-scoped rules never leak across methods', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/endpoints.json': JSON.stringify({
          rules: [
            { paths: ['/api/v1/accounts/**'], method: 'DELETE', capability: 'crud-archive', reason: 'delete surface only' },
          ],
        }),
      });
      // A GET on the same item path: the DELETE-scoped rule does not apply.
      const getRoute = routeFact('GET', '/api/v1/accounts/{account_id}', {
        handlerSymbol: 'app.api.accounts:get_account',
        source: { file: 'backend/api/v1/accounts.py', line: 70, col: 0 },
      });
      const compiled = compileEndpointContribution([contribution([getRoute])], { cwd: repo.root });
      const endpoint = compiled.inventory.endpoints[0];
      expect(endpoint?.capabilities).toEqual([]);
      expect(endpoint?.deleteSemantics).toBeNull();
      expect(
        compiled.contribution.unresolved.some((entry) => entry.code === 'ENDPOINT_CAPABILITY_CONTRADICTION'),
      ).toBe(false);
    });
  });

  it('a malformed document throws (fail closed), like the planes channel', () => {
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/endpoints.json': JSON.stringify({
          rules: [{ paths: ['/x'], capability: 'nonsense-capability', reason: 'typo\'d vocabulary' }],
        }),
      });
      expect(() =>
        compileEndpointContribution([contribution([analyticsRoute()])], { cwd: repo.root }),
      ).toThrow(/capability must be one of/);
    });
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/endpoints.json': JSON.stringify({
          rules: [{ capability: 'crud-read', reason: 'unconstrained: no selector' }],
        }),
      });
      expect(() =>
        compileEndpointContribution([contribution([analyticsRoute()])], { cwd: repo.root }),
      ).toThrow(/at least one of/);
    });
    withTempRepo({}, (repo) => {
      repo.writeFiles({
        '.gateforge/endpoints.json': JSON.stringify({
          rules: [{ paths: ['analytics/logs'], capability: 'crud-read', reason: 'missing leading slash' }],
        }),
      });
      expect(() =>
        compileEndpointContribution([contribution([analyticsRoute()])], { cwd: repo.root }),
      ).toThrow(/must start with '\//);
    });
  });
});
