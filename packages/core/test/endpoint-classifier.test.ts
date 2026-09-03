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
