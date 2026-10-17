/**
 * Run-wide exposure-coverage check (red-team round 6, scope rework
 * 2026-10-17): `exposureCoverageHolds` is evaluated ONCE per run over
 * every REQUESTED path a code detector could parse — requested paths
 * inside the pipeline-reported detector input set (`eligiblePaths`, the
 * discovery scope) — never per resource, and never over non-code
 * requested files (README, docs, package manifests, images). Exposure of
 * a table happens in OTHER files (route handlers, API modules), so a
 * per-resource proof scoped to the model's own source would certify
 * 'internal' while exactly the files that could expose the resource went
 * unchecked. Fail-closed is unchanged: no exhaustive rule, an eligible
 * path no exhaustive rule claims, or a path the granting rule's detector
 * did not report scanning still blocks.
 *
 * The three behaviours under test (plan 20261017_1600, Main rework
 * bullet 16:05):
 * (a) broad scanRoots + README/docs requested + an exhaustive rule whose
 *     detector scanned every CODE file → the certificate is reachable;
 * (b) the model file covered but another code file (a route handler)
 *     missing from the granting detector's scannedPaths → fails closed;
 * (c) no exhaustive exposure rule → fails closed.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyResources,
  type ClassifierResourceRef,
  type ClassifierScanInput,
  type ClassifyResourcesInput,
} from '../src/classifier/classify.js';
import type { ClassificationSignal } from '../src/schemas/classification-signal.js';
import type { ClassifierPolicy } from '../src/schemas/scan-config.js';

const MODEL_SOURCE = 'backend/models/meter_reading.py';
const MODEL_LOCATION = { file: MODEL_SOURCE, line: 12, col: 7 };
const BASE_SOURCE = 'backend/models/base.py';
const ROUTE_SOURCE = 'backend/routes/meter_routes.py';
const SQL_DETECTOR = { id: 'gateforge.pack-sqlalchemy', version: '0.15.1' } as const;
const NON_CODE_FILES = ['README.md', 'package.json', 'docs/architecture.md'];

function modelResource(): ClassifierResourceRef {
  return {
    name: 'meter_readings',
    id: 'tenant.meter_readings',
    kind: 'sql.table',
    source: MODEL_SOURCE,
    location: MODEL_LOCATION,
    detector: SQL_DETECTOR,
    attributes: { plane: 'tenant' },
  };
}

/** Identity evidence plus trusted reachability for the model category. */
function modelSignals(): ClassificationSignal[] {
  return [
    {
      schemaVersion: 1,
      target: { resourceName: 'meter_readings' },
      dimension: 'identity',
      assertion: ['id'],
      basis: 'code-positive',
      source: 'gateforge.pack-sqlalchemy',
      location: MODEL_LOCATION,
      detector: SQL_DETECTOR,
    },
    {
      schemaVersion: 1,
      target: { resourceName: 'meter_readings' },
      dimension: 'internality',
      assertion: 'model',
      basis: 'code-positive',
      source: 'gateforge.pack-sqlalchemy',
      location: MODEL_LOCATION,
      detector: SQL_DETECTOR,
    },
  ];
}

/**
 * A scan whose GLOBAL complete-scan attestation holds: every requested
 * path is covered by the rule of a detector that reported scanning it.
 * The requested set deliberately includes non-code files (broad
 * scanRoots); `eligiblePaths` is the discovery scope the pipeline handed
 * the detectors — code files only. `routeScanned: false` models a route
 * handler the granting detector did NOT report scanning (an exposure
 * hole the per-resource scoping of the rejected fix was blind to, because
 * the model's own source was covered).
 */
function completeScan(options?: { routeScanned?: boolean }): ClassifierScanInput {
  const routeScanned = options?.routeScanned ?? true;
  return {
    requestedPaths: [...NON_CODE_FILES, MODEL_SOURCE, BASE_SOURCE, ROUTE_SOURCE],
    eligiblePaths: [MODEL_SOURCE, BASE_SOURCE, ROUTE_SOURCE],
    coverage: [
      {
        detector: 'gateforge.pack-sqlalchemy',
        scannedPaths: [MODEL_SOURCE, BASE_SOURCE, ...(routeScanned ? [ROUTE_SOURCE] : [])],
      },
      { detector: 'gateforge.docs', scannedPaths: [...NON_CODE_FILES] },
    ],
    configuredDetectors: 2,
    successfulDetectors: 2,
    findings: [],
    unresolved: [],
  };
}

function policyWith(exhaustiveExposure: boolean): ClassifierPolicy {
  return {
    schemaVersion: 1,
    scanRoots: ['**/*'],
    coverage: [
      ...(exhaustiveExposure
        ? [
            {
              capability: 'exposure.models',
              detector: 'gateforge.pack-sqlalchemy',
              appliesTo: ['backend/**'],
              exhaustive: true,
            },
          ]
        : []),
      {
        capability: 'models.sqlalchemy',
        detector: 'gateforge.pack-sqlalchemy',
        appliesTo: ['backend/**'],
      },
      {
        capability: 'docs.inventory',
        detector: 'gateforge.docs',
        appliesTo: ['README.md', 'package.json', 'docs/**'],
      },
    ],
    declarations: {},
    volatileFields: [],
    trustedInternalEntryPoints: [{ category: 'model', detector: 'gateforge.pack-sqlalchemy' }],
    internalRules: [
      { match: { resourceKind: 'sql.table' }, reason: 'database tables are internal' },
    ],
    deleteRules: [
      {
        match: 'backend/models/**',
        semantics: 'hard',
        reason: 'tables are rebuildable from migrations',
      },
    ],
  };
}

function classify(policy: ClassifierPolicy, scan: ClassifierScanInput): ClassifyResourcesInput {
  return {
    resources: [modelResource()],
    signals: modelSignals(),
    policy,
    adapters: ['tenant.meter_readings'],
    scan,
  };
}

describe('run-wide exposure coverage (internality certificate reachability)', () => {
  it('(a) grants the certificate with broad scanRoots, non-code requested files, and an exhaustive rule whose detector scanned every code file', () => {
    const result = classifyResources(
      classify(policyWith(true), completeScan()),
    );

    expect(result.invalidSignals).toEqual([]);
    expect(result.unauthorizedSuppressive).toEqual([]);
    expect(result.staleTargets).toEqual([]);

    expect(result.decisions).toHaveLength(1);
    const decision = result.decisions[0];
    expect(decision).toBeDefined();
    expect(decision?.blocks).toEqual([]);
    expect(decision?.classification).not.toBeNull();
    expect(decision?.classification?.exposure).toBe('internal');
    expect(decision?.classification?.rules).toContain('EXPOSURE_INTERNAL_CERTIFICATE');
  });

  it('(b) fails closed when the model file is covered but another code file is missing from the granting detector scannedPaths', () => {
    // The route handler IS requested and detector-eligible; the exposure
    // rule's detector did not report scanning it. The model's own source
    // is fully covered — the rejected per-resource scoping certified
    // 'internal' on exactly this scan, ignoring the route file that
    // could expose the table.
    const result = classifyResources(
      classify(policyWith(true), completeScan({ routeScanned: false })),
    );

    const decision = result.decisions[0];
    expect(decision).toBeDefined();
    expect(decision?.blocks.length).toBeGreaterThan(0);
    expect(decision?.blocks.some((block) => block.code === 'INCOMPLETE_PROOF_SCOPE')).toBe(true);
    expect(decision?.classification?.exposure).toBe('user-facing');
    expect(decision?.classification?.rules).not.toContain('EXPOSURE_INTERNAL_CERTIFICATE');
  });

  it('(c) fails closed when no exhaustive exposure rule exists', () => {
    const result = classifyResources(
      classify(policyWith(false), completeScan()),
    );

    const decision = result.decisions[0];
    expect(decision).toBeDefined();
    const incomplete = decision?.blocks.filter((block) => block.code === 'INCOMPLETE_PROOF_SCOPE');
    expect(incomplete?.length).toBe(1);
    // The detail names the EXHAUSTIVE exposure authority — pinning the
    // exposure-coverage branch, not the complete-scan branch (the scan
    // attestation itself holds in this fixture).
    expect(incomplete?.[0]?.detail).toContain('EXHAUSTIVE exposure');
    expect(decision?.classification?.exposure).toBe('user-facing');
    expect(decision?.classification?.rules).not.toContain('EXPOSURE_INTERNAL_CERTIFICATE');
  });
});
