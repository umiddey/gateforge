/**
 * Endpoint plane inheritance (ADR 0004 D5, plan phase 4): an
 * `http.endpoint` resource with unresolved plane inherits the plane of
 * exactly one linked business resource; internal operational endpoints
 * (health) resolve to `global`; missing links stay blocked — never
 * chained, never guessed.
 */
import { describe, expect, it } from 'vitest';
import {
  ClassificationSignalSchema,
  classifyResources,
  type ClassificationPolicy,
  type ClassificationSignal,
  type ClassifierResourceRef,
} from '../src/index.js';

const ENDPOINT_LOC = { file: 'backend/api/accounts.py', line: 30, col: 0 };
const MODEL_LOC = { file: 'backend/models/account.py', line: 10, col: 0 };

function endpointResource(overrides: Partial<ClassifierResourceRef> = {}): ClassifierResourceRef {
  return {
    name: 'http-post-api-accounts-a1b2c3d4',
    id: null,
    kind: 'http.endpoint',
    source: 'backend/api/accounts.py',
    location: ENDPOINT_LOC,
    detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    attributes: { linkedResourceName: 'accounts' },
    ...overrides,
  };
}

function businessResource(overrides: Partial<ClassifierResourceRef> = {}): ClassifierResourceRef {
  return {
    name: 'accounts',
    id: null,
    kind: 'sqlalchemy.table',
    source: 'backend/models/account.py',
    location: MODEL_LOC,
    detector: { id: 'gateforge.pack-sqlalchemy', version: '0.1.0' },
    attributes: {},
    ...overrides,
  };
}

function signal(
  overrides: Partial<ClassificationSignal> & {
    dimension: ClassificationSignal['dimension'];
    assertion: ClassificationSignal['assertion'];
  },
): ClassificationSignal {
  return ClassificationSignalSchema.parse({
    schemaVersion: 1,
    target: { resourceName: 'accounts' },
    basis: 'code-positive',
    source: 'gateforge.pack-sqlalchemy',
    location: MODEL_LOC,
    detector: { id: 'gateforge.pack-sqlalchemy', version: '0.1.0' },
    ...overrides,
  });
}

function endpointSignals(endpointName: string): ClassificationSignal[] {
  return [
    signal({
      target: { resourceName: endpointName },
      dimension: 'identity',
      assertion: ['method', 'path'],
      location: ENDPOINT_LOC,
      source: 'gateforge.endpoint-compiler',
      detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    }),
    signal({
      target: { resourceName: endpointName },
      dimension: 'adapter-binding',
      assertion: 'accounts',
      location: ENDPOINT_LOC,
      source: 'gateforge.endpoint-compiler',
      detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    }),
  ];
}

function policy(overrides: Partial<ClassificationPolicy> = {}): ClassificationPolicy {
  return {
    schemaVersion: 1,
    scanRoots: ['backend/**'],
    trustedInternalEntryPoints: [{ category: 'migration', patterns: [] }],
    internalRules: [],
    declarations: { internality: 'gateforge:internal', archiveState: 'gateforge:archive-state' },
    volatileFields: [],
    ...overrides,
  };
}

function structural(): ClassificationSignal[] {
  return [
    signal({ dimension: 'identity', assertion: ['id'] }),
    signal({ dimension: 'plane', assertion: 'tenant' }),
    signal({ dimension: 'delete-semantics', assertion: 'hard' }),
  ];
}

function runWith(
  resources: ClassifierResourceRef[],
  signals: ClassificationSignal[],
  policyOverrides: Partial<ClassificationPolicy> = {},
) {
  return classifyResources({
    resources,
    signals,
    policy: policy(policyOverrides),
    adapters: ['accounts'],
    scan: { requestedPaths: [], scannedPaths: [], findings: [], unresolved: [] },
  });
}

describe('endpoint plane inheritance', () => {
  it('inherits the plane of the single linked business resource', () => {
    const business = businessResource();
    const endpoint = endpointResource();
    const result = runWith([business, endpoint], [...structural(), ...endpointSignals(endpoint.name)]);
    const endpointDecision = result.decisions.find((d) => d.name === endpoint.name);
    expect(endpointDecision?.classification?.plane).toBe('tenant');
    // The plane-qualified id materializes at graph binding; the decision
    // echoes the input id (null pre-binding).
    expect(endpointDecision?.resourceId).toBeNull();
    expect(endpointDecision?.classification?.rules).toContain('LIFECYCLE_ENDPOINT_HTTP');
    expect(endpointDecision?.blocks).toEqual([]);
  });

  it('operational endpoints resolve plane global without any business link', () => {
    const health = endpointResource({
      name: 'http-get-health-ready-e5f6a7b8',
      attributes: { capabilities: ['health-operations'] },
    });
    const result = runWith([health], [
      ...endpointSignals(health.name).map((s) => ({
        ...s,
        target: { resourceName: health.name },
      })),
    ]);
    const healthDecision = result.decisions.find((d) => d.name === health.name);
    // Derived from the health-operations capability (engine-issued
    // authority signal), not from any business-resource link.
    expect(healthDecision?.classification?.plane).toBe('global');
    expect(healthDecision?.classification?.rules).toContain('PLANE_DETECTOR_EVIDENCE');
  });

  it('stays blocked when the linked resource has no resolved plane', () => {
    const business = businessResource(); // no signals: business decision blocks too
    const endpoint = endpointResource();
    const result = runWith(
      [business, endpoint],
      [endpointSignals(endpoint.name)[0] as ClassificationSignal],
    );
    const endpointDecision = result.decisions.find((d) => d.name === endpoint.name);
    expect(endpointDecision?.classification).toBeNull();
    expect(endpointDecision?.blocks.some((b) => b.code === 'PLANE_UNRESOLVED')).toBe(true);
  });

  it('never chains endpoint-to-endpoint plane inheritance', () => {
    const first = endpointResource({ name: 'http-post-api-accounts-a1b2c3d4' });
    const second = endpointResource({
      name: 'http-post-api-accounts-e5f6a7b8',
      attributes: { linkedResourceName: first.name },
    });
    const result = runWith([first, second], [
      ...endpointSignals(first.name).filter((s) => s.dimension === 'identity'),
      ...endpointSignals(second.name).filter((s) => s.dimension === 'identity'),
    ]);
    expect(result.decisions.find((d) => d.name === second.name)?.classification).toBeNull();
  });
});

describe('endpoints carry no EntityAdapter demand (claims lane); pure probes stay internal', () => {
  /**
   * The endpoint compiler's identity fact for one endpoint (the only
   * signal every compiled endpoint always carries).
   */
  function identitySignalFor(endpointName: string): ClassificationSignal {
    return signal({
      target: { resourceName: endpointName },
      dimension: 'identity',
      assertion: ['method', 'path'],
      location: ENDPOINT_LOC,
      source: 'gateforge.endpoint-compiler',
      detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    });
  }

  function classifyOneEndpoint(
    resource: ClassifierResourceRef,
    signals: ClassificationSignal[],
    adapters: readonly string[],
  ) {
    return classifyResources({
      resources: [resource],
      signals,
      policy: policy(),
      adapters,
      scan: { requestedPaths: [], scannedPaths: [], findings: [], unresolved: [] },
    });
  }

  it('a health probe with an empty adapters directory classifies without ADAPTER_MISSING', () => {
    // The dogfood shape: GET /health (backend/api/ops/endpoints.py) with
    // capability exactly `health-operations`, no business link, and no
    // adapter file. Before the operational exposure lane this blocked as
    // ADAPTER_MISSING despite being an operational probe.
    const health = endpointResource({
      name: 'http-get-health-74fac65f',
      attributes: { capabilities: ['health-operations'] },
    });
    const entry = classifyOneEndpoint(health, [identitySignalFor(health.name)], []).decisions.find(
      (d) => d.name === health.name,
    );
    expect(entry?.blocks).toEqual([]);
    // Plane still comes from the operational rule (engine-issued).
    expect(entry?.classification?.plane).toBe('global');
    expect(entry?.classification?.exposure).toBe('internal');
    // The trace records WHY no adapter is demanded.
    expect(entry?.classification?.rules).toContain('EXPOSURE_OPERATIONAL_PROBE');
    expect(entry?.classification?.evidenceAdapter).toBeUndefined();
  });

  it('a consumed health probe still takes the operational lane, not the adapter demand', () => {
    // The frontend polls /health: the compiler emits a code-positive
    // exposure signal. Consumption must not turn the probe into a
    // user-facing UI-evidence obligation.
    const health = endpointResource({
      name: 'http-get-health-74fac65f',
      attributes: { capabilities: ['health-operations'] },
    });
    const consumed = signal({
      target: { resourceName: health.name },
      dimension: 'exposure',
      assertion: 'frontend-consumed',
      location: ENDPOINT_LOC,
      source: 'gateforge.endpoint-compiler',
      detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    });
    const entry = classifyOneEndpoint(
      health,
      [identitySignalFor(health.name), consumed],
      [],
    ).decisions.find((d) => d.name === health.name);
    expect(entry?.blocks).toEqual([]);
    expect(entry?.classification?.exposure).toBe('internal');
    expect(entry?.classification?.rules).toContain('EXPOSURE_OPERATIONAL_PROBE');
  });

  it('a linked user-facing endpoint classifies WITHOUT an adapter (the claims lane)', () => {
    // FIX (dogfood): demanding a reviewed EntityAdapter for every
    // user-facing endpoint was a category error — endpoints are witnessed
    // through the claims/witness-proxy lane (`http:frontend-request-observed`),
    // not through entity persistence adapters (whose contract is read by
    // id / normalize body / deletion kind — business-entity persistence).
    // The endpoint classifies user-facing cleanly with NO adapter of its
    // own; the mirrored red side for business resources (a user-facing
    // table still demands its adapter) lives in classifier.test.ts.
    const business = businessResource();
    const endpoint = endpointResource(); // linkedResourceName: 'accounts'
    const result = classifyResources({
      resources: [business, endpoint],
      signals: [...structural(), identitySignalFor(endpoint.name)],
      policy: policy(),
      adapters: ['accounts'], // the table binds; the endpoint has no adapter of its own
      scan: { requestedPaths: [], scannedPaths: [], findings: [], unresolved: [] },
    });
    const endpointEntry = result.decisions.find((d) => d.name === endpoint.name);
    expect(endpointEntry?.classification).not.toBeNull();
    expect(endpointEntry?.blocks).toEqual([]);
    expect(endpointEntry?.classification?.exposure).toBe('user-facing');
    expect(endpointEntry?.classification?.evidenceAdapter).toBeUndefined();
    // The decision records WHY no adapter is present: the claims lane.
    expect(endpointEntry?.classification?.evidenceLane).toBe('claims');
  });

  it('a user-facing endpoint classifies clean with an EMPTY adapters directory', () => {
    // The dogfood shape (473/746 ADAPTER_MISSING blocks on endpoints):
    // a plain unlinked endpoint — no capabilities, no business link, a
    // plane from detector evidence, and no adapter file anywhere — must
    // classify user-facing without blocking on an adapter.
    const plain = endpointResource({
      name: 'http-get-api-v1-agent-metrics-e5f6a7b8',
      id: null,
      attributes: {}, // no link, no capabilities
    });
    const plane = signal({
      target: { resourceName: plain.name },
      dimension: 'plane',
      assertion: 'global',
      location: ENDPOINT_LOC,
      source: 'gateforge.endpoint-compiler',
      detector: { id: 'gateforge.endpoint-compiler', version: '1' },
    });
    const entry = classifyOneEndpoint(plain, [identitySignalFor(plain.name), plane], []).decisions.find(
      (d) => d.name === plain.name,
    );
    expect(entry?.blocks).toEqual([]);
    expect(entry?.classification?.exposure).toBe('user-facing');
    expect(entry?.classification?.evidenceAdapter).toBeUndefined();
    expect(entry?.classification?.evidenceLane).toBe('claims');
    // The conservative user-facing default decided the exposure — NOT the
    // operational probe lane (that stays reserved for pure health probes).
    expect(entry?.classification?.rules).toContain('EXPOSURE_DEFAULT_USER_FACING');
    expect(entry?.classification?.rules).not.toContain('EXPOSURE_OPERATIONAL_PROBE');
  });

  it('health-operations plus any other capability stays user-facing, not operational', () => {
    // The operational lane is only for the EXACT probe class: a
    // health-path route whose response model also corroborated crud-read
    // carries a business capability and keeps the full user-facing
    // lattice. Since endpoints are claims-witnessed it no longer demands
    // an adapter, but it must NOT resolve to the operational `internal`
    // posture either — fail closed on the lane, not on invented evidence.
    const status = endpointResource({
      name: 'http-get-status-e5f6a7b8',
      attributes: { capabilities: ['crud-read', 'health-operations'] },
    });
    const entry = classifyOneEndpoint(status, [identitySignalFor(status.name)], []).decisions.find(
      (d) => d.name === status.name,
    );
    expect(entry?.classification).not.toBeNull();
    expect(entry?.blocks).toEqual([]);
    expect(entry?.classification?.exposure).toBe('user-facing');
    expect(entry?.classification?.rules).toContain('EXPOSURE_DEFAULT_USER_FACING');
    expect(entry?.classification?.rules).not.toContain('EXPOSURE_OPERATIONAL_PROBE');
  });
});
