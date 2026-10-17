/**
 * Scoped exposure-coverage check (red-team round 6, scope fix 2026-10-17):
 * `exposureCoverageHolds` is evaluated over the paths the DECISION rests
 * on (the resource's own source path), never over every requested path —
 * with broad scan roots the requested set includes README/docs/package
 * files no code detector parses, which made the internality certificate
 * unreachable for any repo with wide `scanRoots`. Fail-closed is
 * unchanged: no exhaustive rule, an unrequested proof path, or a path the
 * granting rule's detector did not report scanning still blocks.
 *
 * The three behaviours under test (plan 20261017_1600):
 * (a) broad scanRoots + non-code requested files + an exhaustive rule
 *     covering the model files → the certificate is reachable;
 * (b) a model file inside the rule's appliesTo but missing from the
 *     detector's scannedPaths → fails closed;
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
 * path is covered by the rule of the detector that scanned it. The
 * requested set deliberately includes non-code files (broad scanRoots).
 */
function completeScan(options?: { modelScanned?: boolean; requestModel?: boolean }): ClassifierScanInput {
  const requestModel = options?.requestModel ?? true;
  const modelScanned = options?.modelScanned ?? true;
  return {
    requestedPaths: [
      ...NON_CODE_FILES,
      ...(requestModel ? [MODEL_SOURCE] : []),
      'backend/models/base.py',
    ],
    coverage: [
      {
        detector: 'gateforge.pack-sqlalchemy',
        scannedPaths: [
          ...(modelScanned ? [MODEL_SOURCE] : []),
          'backend/models/base.py',
        ],
      },
      { detector: 'gateforge.docs', scannedPaths: [...NON_CODE_FILES] },
    ],
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
              appliesTo: ['backend/models/**'],
              exhaustive: true,
            },
          ]
        : []),
      {
        capability: 'models.sqlalchemy',
        detector: 'gateforge.pack-sqlalchemy',
        appliesTo: ['backend/models/**'],
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

describe('scoped exposure coverage (internality certificate reachability)', () => {
  it('(a) grants the certificate with broad scanRoots, non-code requested files, and an exhaustive rule covering the model files', () => {
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

  it('(b) fails closed when a model file inside appliesTo is missing from the detector scannedPaths', () => {
    const result = classifyResources(
      classify(policyWith(true), completeScan({ modelScanned: false })),
    );

    const decision = result.decisions[0];
    expect(decision).toBeDefined();
    const incomplete = decision?.blocks.filter((block) => block.code === 'INCOMPLETE_PROOF_SCOPE');
    expect(incomplete).toHaveLength(1);
    expect(decision?.classification?.exposure).toBe('user-facing');
    expect(decision?.classification?.rules).toContain('EXPOSURE_DEFAULT_USER_FACING');
  });

  it('(c) fails closed when no exhaustive exposure rule exists', () => {
    const result = classifyResources(
      classify(policyWith(false), completeScan()),
    );

    const decision = result.decisions[0];
    expect(decision).toBeDefined();
    const incomplete = decision?.blocks.filter((block) => block.code === 'INCOMPLETE_PROOF_SCOPE');
    expect(incomplete).toHaveLength(1);
    expect(incomplete?.[0]?.detail).toContain('no EXHAUSTIVE exposure.* coverage rule covers');
    expect(decision?.classification?.exposure).toBe('user-facing');
  });
});
